"""Indexes entity / tile / decal / vessel prototypes from the repository and resolves inheritance."""
import glob
import math
import os
import pickle
import re
import time

from . import yamlio
from .ftl import Ftl

CACHE_VERSION = 16

DRAW_DEPTH = {
    "LowFloors": -20, "ThickPipe": -19, "ThickWire": -18, "ThinPipeAlt2": -17, "ThinPipeAlt1": -16, "ThinPipe": -15, "ThinWire": -14,
    "BelowFloor": -13, "FloorTiles": -12, "FloorObjects": -11, "Puddles": -10, "HighFloorObjects": -5,
    "DeadMobs": -4, "SmallMobs": -3, "Walls": -2, "WallTops": -1, "Objects": 0, "SmallObjects": 1,
    "WallMountedItems": 2, "Items": 3, "BelowMobs": 4, "Mobs": 5, "OverMobs": 6, "Doors": 7,
    "BlastDoors": 8, "Overdoors": 9, "Effects": 10, "Ghosts": 11, "Overlays": 12,
}

# PipeDirection flags as used in the editor: N=1, S=2, E=4, W=8 (same bits as WireVisDirFlags)
PIPE_DIRS = {
    "None": 0, "North": 1, "South": 2, "East": 4, "West": 8,
    "Longitudinal": 3, "Lateral": 12,
    "NWBend": 9, "NEBend": 5, "SWBend": 10, "SEBend": 6,
    "TNorth": 13, "TSouth": 14, "TEast": 7, "TWest": 11,
    "Fourway": 15, "All": 15,
}

# Disposal tube connections at rotation 0 (entity facing south), same bits as PIPE_DIRS. Junction-like tubes
# list their exits as angles: 0 = South, 90 = East, 180 = North, -90 = West (DisposalTubeSystem).
DISPOSAL_KINDS = (
    # (component, kind, mask) -- checked in order, the first present component wins
    ("DisposalSignalRouter", "signal", None),
    ("DisposalRouter", "router", None),
    ("DisposalJunction", "junction", None),
    ("DisposalTagger", "tagger", 1 | 2),
    ("DisposalTransit", "transit", 1 | 2),
    ("DisposalBend", "bend", 2 | 8),
    ("DisposalEntry", "entry", 2),
)
ANGLE_DIR = {0: 2, 90: 4, 180: 1, 270: 8}

KEEP_COMPS = (
    "Sprite", "Icon", "IconSmooth", "CableVisualizer", "AtmosPipeLayers", "AtmosPipeColor",
    "NodeContainer", "Airtight", "StaticPrice", "ApcPowerReceiver", "PowerSupplier", "Battery",
    "Thruster", "PlacementReplacement", "SubFloorHide", "Cable", "Physics",
)

KIND_RE = re.compile(r"(hv|mv|lv)cable_", re.I)


def _norm_name(v):
    return v if isinstance(v, str) else ""


def _as_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [v]


class ProtoIndex:
    def __init__(self, cfg, log=print):
        self.cfg = cfg
        self.log = log
        self.raw_entities = {}
        self.tiles = {}
        self.decals = {}
        self.vessels = {}
        self.categories = {}
        self.ports = {"source": {}, "sink": {}}
        self.entity_files = {}
        self.locale = {}
        self.resolved = {}
        self.migrations = {}
        self.ftl = Ftl(cfg)  # full locale, loaded on first use (descriptions, paper texts, stamp names)
        self._load()

    # ------------------------------------------------------------------ loading
    def _files(self):
        files = glob.glob(os.path.join(self.cfg.prototypes, "**", "*.yml"), recursive=True)
        engine = os.path.join(self.cfg.repo, "RobustToolbox", "Resources", "EnginePrototypes")
        return files + glob.glob(os.path.join(engine, "**", "*.yml"), recursive=True)

    def _locale_files(self):
        return [f for lang in dict.fromkeys(("en-US", self.cfg.locale))
                for f in glob.glob(os.path.join(self.cfg.resources, "Locale", lang, "**", "*.ftl"), recursive=True)]

    def _signature(self, files):
        # locale files count too: entity / tile names come from them
        files = files + self._locale_files()
        mt = 0.0
        for f in files:
            try:
                mt = max(mt, os.path.getmtime(f))
            except OSError:
                pass
        return (CACHE_VERSION, self.cfg.locale, len(files), round(mt, 3))

    def _load(self):
        t0 = time.time()
        files = self._files()
        sig = self._signature(files)
        cache = os.path.join(self.cfg.cache_dir, "protos.pkl")
        if os.path.exists(cache):
            try:
                with open(cache, "rb") as f:
                    data = pickle.load(f)
                if data.get("sig") == sig:
                    self.__dict__.update(data["state"])
                    self.log(f"[protos] loaded from cache in {time.time() - t0:.1f}s "
                             f"({len(self.summary)} entities, {len(self.tiles)} tiles)")
                    return
            except Exception as e:  # noqa
                self.log(f"[protos] cache invalid: {e}")
        self.log(f"[protos] parsing {len(files)} prototype files (first run, ~1 min)...")
        errors = 0
        for path in files:
            rel = os.path.relpath(path, self.cfg.prototypes).replace("\\", "/")
            try:
                docs = yamlio.load_file(path)
            except Exception:
                errors += 1
                continue
            if not isinstance(docs, list):
                continue
            for d in docs:
                if not isinstance(d, dict):
                    continue
                t = d.get("type")
                pid = d.get("id")
                if not isinstance(pid, str):
                    continue
                if t == "entity":
                    self.raw_entities[pid] = d
                    self.entity_files[pid] = rel
                elif t == "tile":
                    self.tiles[pid] = d
                elif t == "decal":
                    self.decals[pid] = d
                elif t in ("sourcePort", "sinkPort"):
                    self.ports["source" if t == "sourcePort" else "sink"][pid] = {
                        "id": pid, "name": _norm_name(d.get("name")),
                        "defaultLinks": [x for x in _as_list(d.get("defaultLinks")) if isinstance(x, str)],
                    }
                elif t == "entityCategory":
                    self.categories[pid] = {
                        "hide": str(d.get("hideSpawnMenu", "false")).lower() == "true",
                        "inherit": str(d.get("inheritable", "true")).lower() != "false",
                    }
                elif t == "vessel":
                    d = dict(d)
                    d["_file"] = rel
                    self.vessels[pid] = d
        self._load_locale()
        self._load_migrations()
        self.summary = {}
        self.render_info = {}
        for pid in self.raw_entities:
            try:
                self._summarize(pid)
            except Exception as e:  # noqa
                errors += 1
        self.tile_summary = {tid: self._tile_summary(tid) for tid in self.tiles}
        self.decal_summary = {did: self._decal_summary(did) for did in self.decals}
        self.resolved = {}
        state = {k: getattr(self, k) for k in (
            "raw_entities", "tiles", "decals", "vessels", "entity_files", "locale", "summary",
            "render_info", "tile_summary", "decal_summary", "migrations", "categories", "ports")}
        with open(cache, "wb") as f:
            pickle.dump({"sig": sig, "state": state}, f, protocol=pickle.HIGHEST_PROTOCOL)
        self.log(f"[protos] indexed in {time.time() - t0:.1f}s ({len(self.summary)} entities, "
                 f"{len(self.tiles)} tiles, {len(self.decals)} decals, {errors} errors)")

    def _load_locale(self):
        # full Fluent parse: many names are references ("ent-APCBasic = { ent-BaseAPC }") or multi-line
        prefixes = ("ent-", "tiles-", "tile-", "signal-port-name-", "dock-label-")
        loc = {}
        for lang in dict.fromkeys(("en-US", self.cfg.locale)):
            out = {}
            for k in self.ftl.lang(lang):
                if "." not in k and k.startswith(prefixes):
                    v = (self.ftl.get(k, lang=lang) or "").strip()
                    if v and "{" not in v:
                        out[k] = v
            loc[lang] = out
        self.locale = loc

    def _load_migrations(self):
        mig = {}
        for name in ("migration.yml", "nf_migration.yml", "mono_migration.yml"):
            path = os.path.join(self.cfg.resources, name)
            if not os.path.exists(path):
                continue
            try:
                data = yamlio.load_file(path)
            except Exception:
                continue
            if isinstance(data, dict):
                for k, v in data.items():
                    if isinstance(k, str):
                        mig[k] = v if isinstance(v, str) and v not in ("null", "") else None
        self.migrations = mig

    # ------------------------------------------------------------------ resolving
    def resolve(self, pid, _stack=None):
        if pid in self.resolved:
            return self.resolved[pid]
        raw = self.raw_entities.get(pid)
        if raw is None:
            return None
        _stack = _stack or set()
        if pid in _stack:
            return None
        _stack.add(pid)
        out = {"components": {}}
        for parent in _as_list(raw.get("parent")):
            p = self.resolve(parent, _stack)
            if not p:
                continue
            for k, v in p.items():
                if k == "components":
                    for ct, cv in v.items():
                        if ct in out["components"]:
                            merged = dict(out["components"][ct])
                            merged.update(cv)
                            out["components"][ct] = merged
                        else:
                            out["components"][ct] = dict(cv)
                elif k == "categories":
                    inh = [c for c in _as_list(v) if self.categories.get(c, {}).get("inherit", True)]
                    out["categories"] = list(dict.fromkeys(_as_list(out.get("categories")) + inh))
                elif k not in ("abstract", "id", "parent", "suffix"):
                    out[k] = v
        for k, v in raw.items():
            if k == "components":
                for c in _as_list(v):
                    if not isinstance(c, dict) or "type" not in c:
                        continue
                    ct = c["type"]
                    data = {kk: vv for kk, vv in c.items() if kk != "type"}
                    if ct in out["components"]:
                        merged = dict(out["components"][ct])
                        merged.update(data)
                        out["components"][ct] = merged
                    else:
                        out["components"][ct] = data
            elif k == "categories":
                out["categories"] = list(dict.fromkeys(_as_list(out.get("categories")) + _as_list(v)))
            elif k not in ("parent", "type"):
                out[k] = v
        if "abstract" not in raw:
            out.pop("abstract", None)
        self.resolved[pid] = out
        return out

    def _loc_name(self, pid, fallback):
        # like the engine's entity loc data: the first prototype up the parent chain that has an
        # "ent-<id>" string, unless a prototype on the way sets its own name in yaml
        def find(lang):
            d = self.locale.get(lang, {})
            queue, seen = [pid], set()
            while queue:
                p = queue.pop(0)
                if p in seen:
                    continue
                seen.add(p)
                if "ent-" + p in d:
                    return d["ent-" + p]
                raw = self.raw_entities.get(p) or {}
                if "name" in raw:
                    return None
                queue += [x for x in _as_list(raw.get("parent")) if isinstance(x, str)]
            return None
        return find("en-US") or fallback, find(self.cfg.locale)

    def _summarize(self, pid):
        r = self.resolve(pid)
        if r is None or str(r.get("abstract", "")).lower() == "true":
            return
        comps = r["components"]
        rel = self.entity_files.get(pid, "")
        parts = [p for p in rel.split("/")[:-1] if not p.startswith("_") or p in ("_NF", "_Mono")]
        parts = [p for p in parts if p not in ("_NF", "_Mono", "Entities")]
        category = "/".join(parts[:2]) if parts else "Other"
        sprite = comps.get("Sprite", {})
        dd = DRAW_DEPTH.get(_norm_name(sprite.get("drawdepth")), 0)
        if "Door" in comps:
            # DoorSystem sets the draw depth from the door state; mapped doors are closed
            dd = DRAW_DEPTH.get(_norm_name(comps["Door"].get("closedDrawDepth")), DRAW_DEPTH["Doors"])
        cats = [c for c in _as_list(r.get("categories")) if isinstance(c, str)]
        name, ru = self._loc_name(pid, _norm_name(r.get("name")))
        s = {
            "id": pid,
            "name": name,
            "suffix": _norm_name(r.get("suffix")),
            "cat": category,
            "dd": dd,
        }
        if ru:
            s["ru"] = ru
        if any(self.categories.get(c, {}).get("hide") for c in cats) or "HideSpawnMenu" in cats:
            s["hidden"] = 1
        if "DoNotMap" in cats:
            s["donotmap"] = 1
        if "Sprite" not in comps:
            s["nosprite"] = 1
        sm = comps.get("IconSmooth")
        if sm:
            s["sm"] = {"key": _norm_name(sm.get("key")), "mode": _norm_name(sm.get("mode")) or "Corners",
                       "base": _norm_name(sm.get("base"))}
        fp = _footprint(comps.get("Fixtures"))
        if fp:
            s["fp"] = fp
        cv = comps.get("CableVisualizer")
        if cv:
            prefix = _norm_name(cv.get("statePrefix"))
            m = KIND_RE.match(prefix)
            s["cable"] = (m.group(1).upper() if m else prefix)
        nc = comps.get("NodeContainer")
        if nc and isinstance(nc.get("nodes"), dict):
            dirs = 0
            haspipe = False
            for node in nc["nodes"].values():
                body = node.get(yamlio.VAL) if yamlio.is_tagged(node) else node
                tag = node.get(yamlio.TAG, "") if yamlio.is_tagged(node) else ""
                if not isinstance(body, dict):
                    continue
                if "PipeNode" in tag or "pipeDirection" in body:
                    haspipe = True
                    dirs |= PIPE_DIRS.get(_norm_name(body.get("pipeDirection")), 0)
            if haspipe:
                s["pipe"] = dirs
        disp = _disposal(comps)
        if disp:
            s["disp"], s["dispKind"] = disp
        if "AtmosPipeLayers" in comps:
            s["pipeLayers"] = 1
            pl = norm_pipe_layer(comps["AtmosPipeLayers"].get("pipeLayer"))
            if pl != "Primary":
                s["pipeLayer"] = pl
        apc = comps.get("AtmosPipeColor")
        if apc and isinstance(apc.get("color"), str):
            s["pipeColor"] = apc["color"]
        if "SubFloorHide" in comps:
            s["subfloor"] = 1
            vis = [x for x in _as_list(comps["SubFloorHide"].get("visibleLayers")) if isinstance(x, str)]
            if vis:
                s["sfv"] = 1  # some layers stay visible when the floor covers it (vent / pump bodies)
        con = comps.get("Construction")
        if pid.startswith("AtmosDeviceFan") or (isinstance(con, dict) and _norm_name(con.get("graph")).startswith("AtmosDeviceFan")):
            s["fan"] = 1
        blip = _radar_blip(comps)
        if blip:
            s["blip"] = blip
        dock = comps.get("Docking")
        if dock is not None:
            s["dock"] = {"color": _norm_name(dock.get("highlightedRadarColor")) or "Magenta"}
            if _norm_name(dock.get("name")):
                s["dock"]["name"] = _norm_name(dock.get("name"))
        gem = comps.get("GridEdgeMarker")
        if gem is not None:
            b, e = _fnums(gem.get("begin", "")), _fnums(gem.get("end", ""))
            if len(b) == 2 and len(e) == 2:
                s["edgeMark"] = b + e
        if "Paper" in comps:
            s["paper"] = 1
        st = comps.get("Stamp")
        if st is not None:
            # StampComponent defaults; stampedName is a locale key (or plain text in old maps)
            s["stamp"] = {"name": _norm_name(st.get("stampedName")) or "stamp-component-stamped-name-default",
                          "color": _norm_name(st.get("stampedColor")) or "#BB3232",
                          "state": _norm_name(st.get("stampState")) or "paper_stamp-generic"}
            if str(st.get("reapply", "")).lower() == "true":
                s["stamp"]["reapply"] = 1
        sse = comps.get("ShipShieldEmitter")
        if sse is not None:
            s["shield"] = _norm_name(sse.get("shieldColor")) or "White"
        air = comps.get("Airtight")
        if air is not None:
            bd = air.get("airBlockedDirection")
            s["airtight"] = _norm_name(bd) if isinstance(bd, str) else "All"
            if isinstance(bd, list):
                s["airtight"] = ",".join(x for x in bd if isinstance(x, str))
        pr = comps.get("PlacementReplacement")
        if pr:
            s["replace"] = _norm_name(pr.get("key"))
        sp = comps.get("StaticPrice")
        if sp and _num(sp.get("price")) is not None:
            s["price"] = _num(sp.get("price"))
        rcv = comps.get("ApcPowerReceiver")
        if rcv is not None:
            s["load"] = _num(rcv.get("powerLoad"), 5.0)
        sup = comps.get("PowerSupplier")
        if sup is not None:
            s["supply"] = _num(sup.get("supplyRate"), 0.0)
        dls = comps.get("DeviceLinkSource")
        if dls is not None and _as_list(dls.get("ports")):
            s["srcPorts"] = [x for x in _as_list(dls.get("ports")) if isinstance(x, str)]
        dlk = comps.get("DeviceLinkSink")
        if dlk is not None and _as_list(dlk.get("ports")):
            s["sinkPorts"] = [x for x in _as_list(dlk.get("ports")) if isinstance(x, str)]
        phys = comps.get("Physics")
        if phys is not None and _norm_name(phys.get("bodyType")) == "Static":
            s["static"] = 1
        thr = comps.get("Thruster")
        if thr is not None:
            s["thruster"] = {"type": _norm_name(thr.get("thrusterType")) or "Linear",
                             "thrust": _num(thr.get("baseThrust"), _num(thr.get("thrust"), 100.0))}
        ctypes = set(comps.keys())
        flags = [t for t in ("Item", "Apc", "GravityGenerator", "ShuttleConsole", "SpawnPoint", "Door",
                             "Airlock", "Docking", "CableTerminal", "PowerNetworkBattery", "Gyroscope",
                             "ApcPowerProvider", "AtmosDevice", "AirAlarm", "FireAlarm", "Window",
                             "Occluder", "IFF", "FTLDrive", "Fixtures", "DeviceList", "DeviceNetwork",
                             "DeviceLinkSource", "DeviceLinkSink", "EntityStorage", "Storage", "ItemSlots",
                             "Firelock", "AirSensor", "Anchorable", "AmeController", "AmeShield", "DisposalUnit") if t in ctypes]
        if flags:
            s["c"] = flags
        sprite_info = {k: sprite.get(k) for k in ("sprite", "state", "layers", "texture", "noRot", "offset",
                                                     "color", "visible", "scale", "rotation", "snapCardinals")
                       if k in sprite}
        rinfo = {"sprite": sprite_info}
        if "Icon" in comps:
            rinfo["icon"] = {k: comps["Icon"].get(k) for k in ("sprite", "state")}
        if sm:
            rinfo["sm"] = s["sm"]
        door = comps.get("Door")
        if door is not None and _norm_name(door.get("state")):
            rinfo["door"] = _norm_name(door.get("state"))
        if cv:
            rinfo["cablePrefix"] = _norm_name(cv.get("statePrefix"))
        anchored = _anchored_states(comps.get("GenericVisualizer"))
        if anchored:
            rinfo["anchored"] = anchored
        apl = comps.get("AtmosPipeLayers")
        if apl and isinstance(apl.get("spriteLayersRsiPaths"), dict):
            rinfo["pipeLayers"] = apl["spriteLayersRsiPaths"]
            rinfo["defaultPipeLayer"] = norm_pipe_layer(apl.get("pipeLayer"))
        if apl and isinstance(apl.get("spriteRsiPaths"), dict):
            # base RSI per pipe layer (pump bodies shift with the layer), see SharedAtmosPipeLayersSystem
            rinfo["pipeRsi"] = {norm_pipe_layer(k): v for k, v in apl["spriteRsiPaths"].items() if isinstance(v, str)}
            rinfo["defaultPipeLayer"] = norm_pipe_layer(apl.get("pipeLayer"))
        sfh = comps.get("SubFloorHide")
        if sfh and s.get("sfv"):
            rinfo["sfVisible"] = [x for x in _as_list(sfh.get("visibleLayers")) if isinstance(x, str)]
        esv = comps.get("EntityStorageVisuals")
        if esv is not None:
            # EntityStorageVisualizerSystem, closed state: base layer state, door layer state or hidden door
            rinfo["storage"] = {"base": _norm_name(esv.get("stateBaseClosed")), "door": _norm_name(esv.get("stateDoorClosed"))}
        self.summary[pid] = s
        self.render_info[pid] = rinfo

    def _tile_summary(self, tid):
        t = self.tiles[tid]
        name = _norm_name(t.get("name"))
        en = self.locale.get("en-US", {}).get(name, name)
        ru = self.locale.get(self.cfg.locale, {}).get(name)
        s = {
            "id": tid, "name": en, "sprite": _norm_name(t.get("sprite")),
            "variants": int(_num(t.get("variants"), 1) or 1),
            "subfloor": str(t.get("isSubfloor", "false")).lower() == "true",
            "baseTurf": _norm_name(t.get("baseTurf")),
            "rotmir": str(t.get("allowRotationMirror", "false")).lower() == "true",
        }
        verts = [_fnums(v) for v in _as_list(t.get("vertices"))]
        verts = [[round(v[0], 3), round(v[1], 3)] for v in verts if len(v) == 2]
        if len(verts) >= 3:
            # partial tile shape (wedges, corners, half-tilts): the editor rotates/mirrors these by geometry
            s["verts"] = verts
            parent = t.get("parent")
            s["fam"] = _norm_name(parent[0] if isinstance(parent, list) and parent else parent) or ""
        if ru:
            s["ru"] = ru
        if tid == "Space":
            s["space"] = True
        return s

    def _decal_summary(self, did):
        d = self.decals[did]
        spr = d.get("sprite")
        out = {"id": did, "tags": [x for x in _as_list(d.get("tags")) if isinstance(x, str)]}
        if isinstance(spr, dict):
            out["rsi"] = _norm_name(spr.get("sprite"))
            out["state"] = _norm_name(spr.get("state"))
            out["texture"] = _norm_name(spr.get("texture"))
        out["snap"] = str(d.get("snapCardinals", "false")).lower() == "true"
        if str(d.get("showMenu", "true")).lower() == "false":
            out["hidden"] = True
        return out

    def client_payload(self):
        return {
            "entities": list(self.summary.values()),
            "tiles": list(self.tile_summary.values()),
            "decals": list(self.decal_summary.values()),
            "migrations": self.migrations,
            "dockLabels": {k: v for lang in ("en-US", self.cfg.locale) for k, v in self.locale.get(lang, {}).items()
                           if k.startswith("dock-label-")},
            "ports": {kind: [self._port(kind, v) for v in m.values()] for kind, m in self.ports.items()},
            "stampNames": self.stamp_names(),
        }

    # ------------------------------------------------------------------ texts
    def stamp_names(self):
        """Locale text of every stamp-component-stamped-name-* key (what the paper shows on a stamp)."""
        self.ftl._load()
        keys = {k for d in self.ftl._langs for k in d if k.startswith("stamp-component-stamped-name-")}
        keys |= {s["stamp"]["name"] for s in self.summary.values() if "stamp" in s}
        return {k: v for k in sorted(keys) if (v := self.ftl.get(k)) is not None}

    def ent_text(self, pid):
        """Name and description an entity shows in game (locale first, prototype fields as fallback)."""
        r = self.resolve(pid)
        if r is None:
            return None
        name = self.ftl.get("ent-" + pid)
        desc = self.ftl.get("ent-" + pid + ".desc")
        return {"name": name if name is not None else _norm_name(r.get("name")),
                "desc": desc if desc is not None else _norm_name(r.get("description"))}

    def paper_templates(self):
        """Paper prototypes that come with a written text (forms, memos): [{id, name}]."""
        out = []
        for pid, s in self.summary.items():
            if "paper" not in s:
                continue
            c = ((self.resolve(pid) or {}).get("components", {}).get("Paper") or {}).get("content")
            if isinstance(c, str) and c.strip():
                out.append({"id": pid, "name": s.get("ru") or s.get("name") or pid})
        return sorted(out, key=lambda x: x["name"].lower())

    def paper_info(self, pid):
        """Default text and look of a paper prototype (PaperComponent / PaperVisualsComponent)."""
        r = self.resolve(pid)
        if r is None:
            return None
        comps = r["components"]
        paper = comps.get("Paper") or {}
        content = paper.get("content") if isinstance(paper.get("content"), str) else ""
        if content and "\n" not in content.strip():
            # PaperSystem.OnMapInit runs the text through Loc.GetString: prototypes use locale keys
            loc = self.ftl.get(content.strip())
            if loc is not None:
                content = loc
        vis = comps.get("PaperVisuals")
        out = {"content": content, "contentSize": int(_num(paper.get("contentSize"), 6000) or 6000),
               "visuals": {k: v for k, v in (vis or {}).items() if isinstance(v, str)} if vis is not None else None}
        spr = comps.get("Sprite") or {}
        out["rsi"] = _norm_name(spr.get("sprite"))
        return out

    def _port(self, kind, v):
        loc = self.locale.get(self.cfg.locale, {}).get(v["name"]) or self.locale.get("en-US", {}).get(v["name"])
        return {**v, "name": loc or v["id"]}


BLIP_SHAPES = ("Circle", "Square", "GridAlignedBox", "Triangle", "Star", "Diamond", "Hexagon", "Arrow", "Ring")


def _blip_config(d, base=None):
    """BlipConfig (RadarMessages.cs) with the legacy radarColor / scale / shape fields of RadarBlipComponent."""
    cfg = dict(base or {"color": "OrangeRed", "shape": "Circle", "bounds": [-0.5, -0.5, 0.5, 0.5], "zoom": False, "rot": False})
    if not isinstance(d, dict):
        return cfg
    if _norm_name(d.get("color")):
        cfg["color"] = d["color"]
    if _norm_name(d.get("radarColor")):
        cfg["color"] = d["radarColor"]
    shape = _norm_name(d.get("shape"))
    if shape:
        cfg["shape"] = next((s for s in BLIP_SHAPES if s.lower() == shape.lower()), "Circle")
    b = _fnums(d.get("bounds", ""))
    if len(b) == 4:
        cfg["bounds"] = b
    sc = _num(d.get("scale"))
    if sc is not None:
        cfg["bounds"] = [-sc * 1.5, -sc * 1.5, sc * 1.5, sc * 1.5]
    if "respectZoom" in d:
        cfg["zoom"] = str(d["respectZoom"]).lower() == "true"
    if "rotate" in d:
        cfg["rot"] = str(d["rotate"]).lower() == "true"
    return cfg


def _radar_blip(comps):
    """The blip a mapped (on-grid) entity shows on mass scanners: gridConfig if set, else config."""
    rb = comps.get("RadarBlip")
    if rb is None:
        ts = comps.get("ToggleableSignature")
        if not isinstance(ts, dict) or str(ts.get("enabled", "false")).lower() != "true":
            return None
        rb = ts.get("blip") if isinstance(ts.get("blip"), dict) else {}
    if not isinstance(rb, dict) or str(rb.get("enabled", "true")).lower() == "false" \
            or str(rb.get("requireNoGrid", "false")).lower() == "true":
        return None
    cfg = _blip_config(rb.get("config"))
    cfg = _blip_config(rb, cfg)  # legacy fields on the component itself
    if isinstance(rb.get("gridConfig"), dict):
        cfg = _blip_config(rb["gridConfig"])
    return cfg


def _disposal(comps):
    """(mask at rotation 0, kind) for disposal tubes; broken tubes (no DisposalTube) get mask 0."""
    if "DisposalTube" not in comps:
        con = comps.get("Construction")
        if isinstance(con, dict) and _norm_name(con.get("graph")) == "DisposalPipe":
            return 0, "broken"
        return None
    for comp, kind, mask in DISPOSAL_KINDS:
        if comp not in comps:
            continue
        if mask is None:
            # routers inherit the junction exits when they do not list their own
            degrees = _as_list(comps[comp].get("degrees")) or _as_list((comps.get("DisposalJunction") or {}).get("degrees"))
            mask = 0
            for d in degrees:
                a = _num(d)
                if a is not None:
                    mask |= ANGLE_DIR.get(int(round(a)) % 360, 0)
        return mask, kind
    return None


def _anchored_states(gv):
    """Sprite states the GenericVisualizer shows for an anchored disposal tube: {layer map key: state}."""
    if not isinstance(gv, dict) or not isinstance(gv.get("visuals"), dict):
        return None
    out = {}
    for key, layers in gv["visuals"].items():
        if "DisposalTubeVisuals" not in str(key) or not isinstance(layers, dict):
            continue
        for mk, states in layers.items():
            st = states.get("Anchored") if isinstance(states, dict) else None
            if isinstance(st, dict) and _norm_name(st.get("state")):
                out[mk] = st["state"]
    return out or None


def norm_pipe_layer(v):
    v = str(v or "Primary")
    return {"0": "Primary", "1": "Secondary", "2": "Tertiary"}.get(v, v)


def _fnums(v):
    try:
        return [float(x) for x in str(v).split(",")]
    except ValueError:
        return []


def _footprint(fixtures):
    """Centre of the tiles covered by the hard fixtures, relative to the entity's own tile centre
    (entity space, unrotated). None for one-tile entities. Multi-tile machines such as large thrusters
    sit on one corner tile, so mirroring has to mirror this centre rather than the origin."""
    if not isinstance(fixtures, dict) or not isinstance(fixtures.get("fixtures"), dict):
        return None
    xs, ys = [], []
    for fx in fixtures["fixtures"].values():
        if not isinstance(fx, dict) or str(fx.get("hard", "true")).lower() == "false":
            continue
        shape = fx.get("shape")
        body = shape.get(yamlio.VAL) if yamlio.is_tagged(shape) else shape
        tag = shape.get(yamlio.TAG, "") if yamlio.is_tagged(shape) else ""
        if not isinstance(body, dict):
            continue
        if "Aabb" in tag or "bounds" in body:
            b = _fnums(body.get("bounds", ""))
            if len(b) == 4:
                xs += [b[0], b[2]]
                ys += [b[1], b[3]]
        elif "vertices" in body:
            for v in _as_list(body.get("vertices")):
                c = _fnums(v)
                if len(c) == 2:
                    xs.append(c[0])
                    ys.append(c[1])
        elif "Circle" in tag:
            c = _fnums(body.get("position", "0,0")) or [0.0, 0.0]
            r = _num(body.get("radius"), 0.5)
            if len(c) == 2:
                xs += [c[0] - r, c[0] + r]
                ys += [c[1] - r, c[1] + r]
    if not xs:
        return None
    eps = 0.45  # a tile counts only when the fixtures cover at least ~half of it (ignores small overhangs)
    def centre(lo, hi):
        a, b = math.floor(lo + 0.5 + eps), math.floor(hi + 0.5 - eps)
        return (a + b) / 2 if b >= a else 0.0
    cx, cy = centre(min(xs), max(xs)), centre(min(ys), max(ys))
    return [cx, cy] if cx or cy else None


def _num(v, default=None):
    try:
        f = float(v)
        if math.isfinite(f):
            return f
    except (TypeError, ValueError):
        pass
    return default
