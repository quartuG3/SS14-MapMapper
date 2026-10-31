"""Conversion between SS14 grid map files (format 7) and the editor document model.

Document model (JSON-friendly):
{
  "meta": {...}, "head": {maps, grids, orphans, nullspace}, "tilemap": {id: name},
  "gridUid": "1", "gridEnt": {"uid": "1", "components": [...]},  # MapGrid/DecalGrid tiles stripped
  "tiles": [[x, y, name, flags, variant, rotmir], ...],
  "entities": [{"uid", "proto", "x", "y", "rot", "tf": {...}, "comps": [...]}, ...],  # children of the grid
  "others": [{"uid", "proto", "components": [...]}, ...],                           # everything else
  "decals": [{"id", "color", "angle", "z", "cleanable", "x", "y"}, ...],
  "eol": "\r\n" | "\n"
}
"""
import base64
import datetime
import math
import struct

import numpy as np

from . import yamlio
from .atmos import build_grid_atmosphere

CHUNK = 16
TILE_STRUCT = struct.Struct("<iBBB")


def _f(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def parse_rot(v):
    if not isinstance(v, str):
        return 0.0
    s = v.strip()
    if s.endswith("rad"):
        return _f(s[:-3])
    if s.endswith("deg"):
        return math.radians(_f(s[:-3]))
    return _f(s)


def fmt_float(v):
    """Format like C# float.ToString() (shortest float32 round-trip): 5.5, -0.5, 3, 3.6667624."""
    v = float(np.float32(v))
    if v == int(v) and abs(v) < 1e9:
        return str(int(v))
    r = np.format_float_positional(np.float32(v), unique=True, trim="-")
    return r


def fmt_pos(x, y, raw=None):
    if isinstance(raw, str) and "," in raw:
        try:
            rx, ry = [float(v) for v in raw.split(",")]
            if abs(rx - x) < 1e-6 and abs(ry - y) < 1e-6:
                return raw
        except ValueError:
            pass
    return f"{fmt_float(x)},{fmt_float(y)}"


def fmt_rot(r):
    return f"{repr(float(r))} rad"


def normalize_angle(r):
    r = math.fmod(r, 2 * math.pi)
    if r > math.pi + 1e-9:
        r -= 2 * math.pi
    if r <= -math.pi + 1e-9:
        r += 2 * math.pi
    # snap near-cardinal values to the canonical doubles the engine writes
    for c in (0.0, math.pi / 2, math.pi, -math.pi / 2):
        if abs(r - c) < 1e-6:
            return c
    if abs(abs(r) - math.pi) < 1e-6:
        return math.pi
    return r


# ---------------------------------------------------------------------------- load
def load(text, migrations=None):
    eol = "\r\n" if "\r\n" in text[:4000] else "\n"
    data = yamlio.load(text)
    comments = _top_comments(text)
    if not isinstance(data, dict) or "entities" not in data:
        raise ValueError("not an SS14 map file")
    meta = data.get("meta", {})
    tilemap = data.get("tilemap", {}) or {}
    grids = data.get("grids") or []
    grid_uid = str(grids[0]) if grids else None

    proto_of = {}
    ents = {}
    order = {}
    for group in data.get("entities") or []:
        proto = group.get("proto", "")
        for e in group.get("entities") or []:
            uid = str(e.get("uid"))
            ents[uid] = e
            proto_of[uid] = proto
            order[uid] = len(order)

    if grid_uid is None:
        # pick the entity with MapGrid
        for uid, e in ents.items():
            if any(c.get("type") == "MapGrid" for c in e.get("components", [])):
                grid_uid = uid
                break
    if grid_uid is None:
        raise ValueError("map has no grid")

    grid_ent = ents[grid_uid]
    tiles, grid_comps, decals, chunk_order = [], [], [], []
    for c in grid_ent.get("components", []):
        t = c.get("type")
        if t == "MapGrid":
            for key, ch in (c.get("chunks") or {}).items():
                chunk_order.append(str(ch.get("ind", key)))
                cx, cy = [int(v) for v in str(ch.get("ind", key)).split(",")]
                version = int(ch.get("version", 7))
                raw = base64.b64decode(ch.get("tiles", ""))
                tiles.extend(_decode_chunk(raw, cx, cy, version, tilemap))
            c2 = {k: v for k, v in c.items() if k != "chunks"}
            grid_comps.append(c2)
        elif t == "DecalGrid":
            decals = _decode_decals(c)
            grid_comps.append({"type": "DecalGrid", "$decals": True})
        else:
            grid_comps.append(c)

    migrated = {}
    entities, others = [], []
    for uid, e in ents.items():
        if uid == grid_uid:
            continue
        proto = proto_of[uid]
        if migrations and proto in migrations:
            new = migrations[proto]
            migrated[proto] = new
            if new is None:
                continue
            proto = new
        comps = e.get("components") or []
        tf = next((c for c in comps if c.get("type") == "Transform"), None)
        ex = {k: v for k, v in e.items() if k not in ("uid", "components")}
        korder = list(e.keys()) if ex else None
        if tf is not None and str(tf.get("parent")) == grid_uid:
            x, y = [_f(v) for v in str(tf.get("pos", "0,0")).split(",")]
            ent = {
                "uid": uid, "proto": proto, "x": x, "y": y, "rot": parse_rot(tf.get("rot")), "ord": order[uid],
                "tf": {k: v for k, v in tf.items() if k not in ("type",)},
                "comps": [c for c in comps if c.get("type") != "Transform"],
            }
            ti = comps.index(tf)
            if ti:
                ent["tfIndex"] = ti
            if ex:
                ent["ex"] = ex
                ent["korder"] = korder
            entities.append(ent)
        else:
            o = {"uid": uid, "proto": proto, "components": comps, "ord": order[uid]}
            if ex:
                o["ex"] = ex
                o["korder"] = korder
            others.append(o)

    head = {k: data.get(k) for k in ("maps", "grids", "orphans", "nullspace") if k in data}
    proto_order = [g.get("proto", "") for g in data.get("entities") or []]
    doc = {
        "meta": meta, "head": head, "tilemap": {str(k): v for k, v in tilemap.items()},
        "gridUid": grid_uid, "gridEnt": {"uid": grid_uid, "components": grid_comps},
        "tiles": tiles, "entities": entities, "others": others, "decals": decals, "eol": eol,
        "migrated": migrated, "chunkOrder": chunk_order, "protoOrder": proto_order, "gridOrd": order.get(grid_uid, -1), "comments": comments,
    }
    return doc


def _top_comments(text):
    """Column-0 comment blocks keyed by the line that follows them (e.g. "- proto: Foo")."""
    out = {}
    pending = []
    for line in text.splitlines():
        if line.startswith("#"):
            pending.append(line)
            continue
        if pending:
            if line.strip():
                out.setdefault(line.rstrip(), []).extend(pending)
            pending = []
    if pending:
        out.setdefault("", []).extend(pending)
    return out


def _restore_comments(text, comments):
    if not comments:
        return text
    out = []
    for line in text.split("\n"):
        c = comments.get(line.rstrip())
        if c:
            out.extend(c)
            comments = {k: v for k, v in comments.items() if k != line.rstrip()}  # attach once
        out.append(line)
    if comments.get(""):
        out[-1:-1] = comments[""]
    return "\n".join(out)


def _decode_chunk(raw, cx, cy, version, tilemap):
    out = []
    size = 7 if version >= 7 else 6 if version >= 6 else 4
    n = len(raw) // size
    for i in range(min(n, CHUNK * CHUNK)):
        off = i * size
        if size == 7:
            tid, flags, variant, rm = TILE_STRUCT.unpack_from(raw, off)
        elif size == 6:
            tid, flags, variant = struct.unpack_from("<iBB", raw, off)
            rm = 0
        else:
            tid, flags, variant = struct.unpack_from("<HBB", raw, off)
            rm = 0
        name = tilemap.get(str(tid), tilemap.get(tid))
        if name is None or name == "Space":
            continue
        y, x = divmod(i, CHUNK)
        out.append([cx * CHUNK + x, cy * CHUNK + y, name, flags, variant, rm])
    return out


def _decode_decals(comp):
    out = []
    coll = (comp.get("chunkCollection") or {})
    nodes = coll.get("nodes") or []
    for n in nodes:
        node = n.get("node") or {}
        for duid, pos in (n.get("decals") or {}).items():
            x, y = [_f(v) for v in str(pos).split(",")]
            out.append({
                "uid": int(_f(duid, -1)), "raw": pos, "node": node,
                "id": node.get("id"),
                "color": node.get("color"),
                "angle": parse_rot(node.get("angle")) if node.get("angle") else 0.0,
                "z": int(_f(node.get("zIndex"), 0)),
                "cleanable": str(node.get("cleanable", "False")).lower() == "true",
                "x": x, "y": y,
            })
    return out


# ---------------------------------------------------------------------------- save
def save(doc, protos=None, regen_atmos=False, atmos_opts=None):
    tilemap = {str(k): v for k, v in (doc.get("tilemap") or {}).items()}
    name_to_id = {}
    for k, v in tilemap.items():
        name_to_id.setdefault(v, int(k))
    used = {"Space"} | {t[2] for t in doc["tiles"]}
    next_id = max([int(k) for k in tilemap] + [-1]) + 1
    for name in sorted(used):
        if name not in name_to_id:
            name_to_id[name] = next_id
            next_id += 1
    new_tilemap = {str(i): n for n, i in name_to_id.items()}

    chunks = _encode_chunks(doc["tiles"], name_to_id, doc.get("chunkOrder") or [])

    grid_uid = str(doc["gridUid"])
    valid_uids = {grid_uid} | {str(e["uid"]) for e in doc["entities"]} | {str(o["uid"]) for o in doc["others"]}
    if doc.get("head"):
        for m in doc["head"].get("maps") or []:
            valid_uids.add(str(m))

    grid_comps = []
    has_atmos = False
    for c in doc["gridEnt"]["components"]:
        t = c.get("type")
        if t == "MapGrid":
            c2 = {}
            for k, v in c.items():
                c2[k] = v
                if k == "type":
                    c2["chunks"] = chunks
            if "chunks" not in c2:
                c2["chunks"] = chunks
            grid_comps.append(c2)
        elif t == "DecalGrid":
            grid_comps.append(_encode_decals(doc.get("decals") or []))
        elif t == "GridAtmosphere":
            has_atmos = True
            if regen_atmos:
                grid_comps.append(build_grid_atmosphere(doc, protos, atmos_opts or {}))
            else:
                grid_comps.append(c)
        else:
            grid_comps.append(c)
    if regen_atmos and not has_atmos:
        grid_comps.append(build_grid_atmosphere(doc, protos, atmos_opts or {}))

    groups = {}
    grid_proto = doc.get("gridProto", "")
    groups.setdefault(grid_proto, []).append({"uid": int(grid_uid) if grid_uid.isdigit() else grid_uid,
                                              "components": grid_comps, "ord": doc.get("gridOrd", -1)})
    for m_uid in (doc.get("head") or {}).get("maps") or []:
        pass
    for e in doc["entities"]:
        tf = dict(e.get("tf") or {})
        tf_out = {"type": "Transform"}
        rot_in = float(e.get("rot") or 0.0)
        rot = normalize_angle(rot_in)
        raw_rot = tf.get("rot")
        if isinstance(raw_rot, str) and abs(parse_rot(raw_rot) - rot_in) < 1e-9:
            rot_str = raw_rot
        elif rot != 0.0:
            rot_str = fmt_rot(rot)
        else:
            rot_str = None
        wrote_rot = wrote_pos = False
        # keep original key order, update values
        for k, v in tf.items():
            if k == "type":
                continue
            if k == "rot":
                if rot_str:
                    tf_out["rot"] = rot_str
                wrote_rot = True
            elif k == "pos":
                if not wrote_rot and rot_str:
                    tf_out["rot"] = rot_str
                    wrote_rot = True
                tf_out["pos"] = fmt_pos(e["x"], e["y"], v)
                wrote_pos = True
            elif k == "parent":
                if not wrote_pos:
                    if not wrote_rot and rot_str:
                        tf_out["rot"] = rot_str
                        wrote_rot = True
                    tf_out["pos"] = fmt_pos(e["x"], e["y"])
                    wrote_pos = True
                tf_out["parent"] = grid_uid
            else:
                tf_out[k] = v
        if not wrote_rot and rot_str:
            tf_out["rot"] = rot_str
        if not wrote_pos:
            tf_out["pos"] = fmt_pos(e["x"], e["y"])
        tf_out["parent"] = grid_uid
        comps = [_scrub(c, valid_uids) for c in e.get("comps") or []]
        comps.insert(min(int(e.get("tfIndex") or 0), len(comps)), tf_out)
        groups.setdefault(e["proto"], []).append({"uid": _uid_val(e["uid"]), "components": comps,
                                                  "ex": e.get("ex"), "ord": e.get("ord"), "korder": e.get("korder")})
    for o in doc["others"]:
        comps = [_scrub(c, valid_uids) for c in o.get("components") or []]
        groups.setdefault(o.get("proto", ""), []).append({"uid": _uid_val(o["uid"]), "components": comps,
                                                          "ex": o.get("ex"), "ord": o.get("ord"), "korder": o.get("korder")})

    def uid_key(x):
        # keep the original file order; new entities go after, by uid
        u = x["uid"]
        o = x.get("ord")
        return (0 if o is not None else 1, o if o is not None else 0,
                (0, int(u)) if str(u).isdigit() else (1, str(u)))

    entities = []
    for proto in _group_order(groups, doc.get("protoOrder") or []):
        ents = sorted(groups[proto], key=uid_key)
        entities.append({"proto": proto, "entities": [_entity_out(x) for x in ents]})

    count = sum(len(g["entities"]) for g in entities)
    meta = dict(doc.get("meta") or {})
    meta.setdefault("format", "7")
    meta.setdefault("category", "Grid")
    meta["time"] = datetime.datetime.now().strftime("%m/%d/%Y %H:%M:%S")
    meta["entityCount"] = str(count)
    out = {"meta": meta}
    head = doc.get("head") or {}
    out["maps"] = head.get("maps", [])
    out["grids"] = head.get("grids", [grid_uid])
    out["orphans"] = head.get("orphans", [grid_uid])
    out["nullspace"] = head.get("nullspace", [])
    out["tilemap"] = new_tilemap
    out["entities"] = entities
    text = yamlio.dump(out, doc_end=True)
    text = _restore_comments(text, doc.get("comments") or {})
    eol = doc.get("eol") or "\n"
    if eol != "\n":
        text = text.replace("\n", eol)
    return text


def _group_order(groups, original):
    """Keep the original group order (minimal diffs); new groups go to their sorted position."""
    sk = lambda p: (p != "", p.lower(), p)  # noqa: E731
    known = [p for p in dict.fromkeys(original) if p in groups]
    seen = set(known)
    new = sorted((p for p in groups if p not in seen), key=sk)
    out, i = [], 0
    for p in known:
        while i < len(new) and sk(new[i]) < sk(p):
            out.append(new[i])
            i += 1
        out.append(p)
    return out + new[i:]


def _uid_val(u):
    return str(u)


def _entity_out(x):
    ex = x.get("ex") or {}
    order = x.get("korder") or (["uid"] + list(ex) + ["components"])
    out = {}
    for k in order:
        if k == "uid":
            out["uid"] = str(x["uid"])
        elif k == "components":
            out["components"] = x["components"]
        elif k in ex:
            out[k] = ex[k]
    for k, v in ex.items():
        out.setdefault(k, v)
    out.setdefault("uid", str(x["uid"]))
    out.setdefault("components", x["components"])
    return out


def _encode_chunks(tiles, name_to_id, order):
    space = name_to_id["Space"]
    by_chunk = {}
    for key in order:
        cx, cy = [int(v) for v in key.split(",")]
        by_chunk[(cx, cy)] = {}
    for x, y, name, flags, variant, rm in tiles:
        cx, cy = x // CHUNK, y // CHUNK
        by_chunk.setdefault((cx, cy), {})[(x - cx * CHUNK, y - cy * CHUNK)] = (name_to_id[name], flags, variant, rm)
    out = {}
    for (cx, cy) in by_chunk:
        cells = by_chunk[(cx, cy)]
        buf = bytearray(CHUNK * CHUNK * 7)
        for i in range(CHUNK * CHUNK):
            y, x = divmod(i, CHUNK)
            v = cells.get((x, y), (space, 0, 0, 0))
            TILE_STRUCT.pack_into(buf, i * 7, int(v[0]), int(v[1]) & 255, int(v[2]) & 255, int(v[3]) & 255)
        key = f"{cx},{cy}"
        out[key] = {"ind": key, "tiles": base64.b64encode(bytes(buf)).decode("ascii"), "version": "7"}
    return out


def _node_key(n):
    return (n.get("color"), n.get("id"), round(parse_rot(n.get("angle")) if n.get("angle") else 0.0, 9),
            int(_f(n.get("zIndex"), 0)), str(n.get("cleanable", "False")).lower() == "true")


def _encode_decals(decals):
    nodes = {}
    for i, d in enumerate(decals):
        k = (d.get("color"), d.get("id"), round(float(d.get("angle") or 0.0), 9), int(d.get("z") or 0),
             bool(d.get("cleanable")))
        nodes.setdefault(k, []).append(d)
    out_nodes = []
    taken = set()
    for d in decals:
        u = d.get("uid")
        if isinstance(u, int) and u >= 0 and u not in taken:
            taken.add(u)
        else:
            d["uid"] = None
    nxt = max(taken) + 1 if taken else 0
    for d in decals:
        if d["uid"] is None:
            d["uid"] = nxt
            nxt += 1
    for k in nodes:
        color, did, angle, z, clean = k
        node = {}
        if angle:
            node["angle"] = fmt_rot(normalize_angle(angle))
        if clean:
            node["cleanable"] = "True"
        if color:
            node["color"] = color
        node["id"] = did
        if z:
            node["zIndex"] = str(z)
        raw = nodes[k][0].get("node")
        if isinstance(raw, dict) and _node_key(raw) == k:
            node = raw
        dd = {}
        for d in nodes[k]:
            dd[str(d["uid"])] = fmt_pos(d["x"], d["y"], d.get("raw"))
        out_nodes.append({"node": node, "decals": dd})
    return {"type": "DecalGrid", "chunkCollection": {"version": "2", "nodes": out_nodes}}


# Fields (by component type) that hold entity uids; dangling references are removed on save.
_UID_LISTS = {
    "DeviceList": ["devices"],
    "DeviceNetwork": ["deviceLists", "configurators"],
    "DeviceLinkSink": ["links"],
}


def _scrub(c, valid):
    t = c.get("type")
    if t in _UID_LISTS:
        c = dict(c)
        for f in _UID_LISTS[t]:
            if isinstance(c.get(f), list):
                c[f] = [u for u in c[f] if str(u) in valid]
        return c
    if t == "DeviceLinkSource" and isinstance(c.get("linkedPorts"), dict):
        c = dict(c)
        c["linkedPorts"] = {k: v for k, v in c["linkedPorts"].items() if str(k) in valid}
        return c
    if t == "ContainerContainer" and isinstance(c.get("containers"), dict):
        c = dict(c)
        conts = {}
        for name, cont in c["containers"].items():
            if yamlio.is_tagged(cont) and isinstance(cont[yamlio.VAL], dict):
                body = dict(cont[yamlio.VAL])
                if isinstance(body.get("ents"), list):
                    body["ents"] = [u for u in body["ents"] if str(u) in valid]
                if body.get("ent") not in (None, "null", "") and str(body.get("ent")) not in valid:
                    body["ent"] = "null"
                cont = {yamlio.TAG: cont[yamlio.TAG], yamlio.VAL: body}
            conts[name] = cont
        c["containers"] = conts
        return c
    return c


# ---------------------------------------------------------------------------- new
GRID_TEMPLATE = """
- type: MetaData
  name: grid
- type: Transform
  pos: 0,0
  parent: invalid
- type: MapGrid
- type: Broadphase
- type: Physics
  bodyStatus: InAir
  fixedRotation: False
  bodyType: Dynamic
- type: Fixtures
  fixtures: {}
- type: OccluderTree
- type: SpreaderGrid
  spreadQueues:
    Smoke: []
    Puddle: []
    Kudzu: []
    MetalFoam: []
- type: Shuttle
  dampingModifier: 2.5
  bodyModifier: 2.5
- type: GridPathfinding
- type: Gravity
  gravityShakeSound: !type:SoundPathSpecifier
    path: /Audio/Effects/alert.ogg
- type: DecalGrid
- type: GridAtmosphere
- type: GasTileOverlay
- type: RadiationGridResistance
- type: ImplicitRoof
- type: ThermalSignature
- type: ExplosionAirtightGrid
"""


def new_doc(name="grid", engine_version="277.0.0"):
    comps = yamlio.load(GRID_TEMPLATE)
    comps[0]["name"] = name
    return {
        "meta": {"format": "7", "category": "Grid", "engineVersion": engine_version, "forkId": "",
                 "forkVersion": "", "time": "", "entityCount": "1"},
        "head": {"maps": [], "grids": ["1"], "orphans": ["1"], "nullspace": []},
        "tilemap": {"0": "Space"},
        "gridUid": "1", "gridEnt": {"uid": "1", "components": comps},
        "tiles": [], "entities": [], "others": [], "decals": [], "eol": "\r\n", "migrated": {},
        "regenAtmos": True,
    }
