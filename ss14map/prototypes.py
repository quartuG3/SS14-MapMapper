"""Indexes entity / tile / decal / vessel prototypes from the repository and resolves inheritance."""
import glob
import math
import os
import pickle
import re
import time

from . import yamlio

CACHE_VERSION = 10

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
        self._load()

    # ------------------------------------------------------------------ loading
    def _files(self):
        files = glob.glob(os.path.join(self.cfg.prototypes, "**", "*.yml"), recursive=True)
        engine = os.path.join(self.cfg.repo, "RobustToolbox", "Resources", "EnginePrototypes")
        return files + glob.glob(os.path.join(engine, "**", "*.yml"), recursive=True)

    def _signature(self, files):
        mt = 0.0
        for f in files:
            try:
                mt = max(mt, os.path.getmtime(f))
            except OSError:
                pass
        return (CACHE_VERSION, len(files), round(mt, 3))

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
        loc = {}
        for lang in ("en-US", self.cfg.locale):
            base = os.path.join(self.cfg.resources, "Locale", lang)
            for path in glob.glob(os.path.join(base, "**", "*.ftl"), recursive=True):
                try:
                    with open(path, encoding="utf-8-sig") as f:
                        for line in f:
                            if not line or line[0] in " \t#.-\n":
                                continue
                            if "=" not in line:
                                continue
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip()
                            if not v or "{" in v:
                                continue
                            if k.startswith(("ent-", "tiles-", "tile-", "signal-port-name-")):
                                loc.setdefault(lang, {})[k] = v
                except OSError:
                    pass
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
        ru = self.locale.get(self.cfg.locale, {}).get("ent-" + pid)
        en = self.locale.get("en-US", {}).get("ent-" + pid)
        return en or fallback, ru

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
                             "Firelock", "AirSensor", "Anchorable", "AmeController", "AmeShield") if t in ctypes]
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
        apl = comps.get("AtmosPipeLayers")
        if apl and isinstance(apl.get("spriteLayersRsiPaths"), dict):
            rinfo["pipeLayers"] = apl["spriteLayersRsiPaths"]
            rinfo["defaultPipeLayer"] = norm_pipe_layer(apl.get("pipeLayer"))
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
            "ports": {kind: [self._port(kind, v) for v in m.values()] for kind, m in self.ports.items()},
        }

    def _port(self, kind, v):
        loc = self.locale.get(self.cfg.locale, {}).get(v["name"]) or self.locale.get("en-US", {}).get(v["name"])
        return {**v, "name": loc or v["id"]}


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
