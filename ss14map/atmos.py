"""GridAtmosphere generation (equivalent of the `fixgridatmos` command for a saved file)."""

MIXES = {
    "air": {"volume": "2500", "temperature": "293.15",
            "moles": {"Oxygen": "21.824879", "Nitrogen": "82.10312"}},
    "freezer": {"volume": "2500", "temperature": "235",
                "moles": {"Oxygen": "27.225372", "Nitrogen": "102.419266"}},
    "vacuum": {"volume": "2500", "temperature": "293.15", "moles": {}},
}

# Marker prototypes that force a tile mixture (the engine removes them on fixgridatmos)
MARKERS = {
    "AtmosFixFreezerMarker": "freezer",
    "AtmosFixVacuumMarker": "vacuum",
    "AtmosFixBlockerMarker": "vacuum",
}

DIRS = {"North": (0, 1), "South": (0, -1), "East": (1, 0), "West": (-1, 0)}


def _blocked_dirs(airtight, rot):
    """Return set of world directions (dx, dy) the entity blocks, or 'all'."""
    if not airtight or airtight == "All":
        return "all"
    import math
    steps = int(round(rot / (math.pi / 2))) % 4
    out = set()
    for d in airtight.split(","):
        d = d.strip()
        if d not in DIRS:
            continue
        dx, dy = DIRS[d]
        for _ in range(steps):  # rotate CCW: (x, y) -> (-y, x)
            dx, dy = -dy, dx
        out.add((dx, dy))
    return out


def exposed_tiles(doc, protos):
    """Flood fill from space; returns set of (x, y) floor tiles connected to space."""
    tiles = {(t[0], t[1]) for t in doc["tiles"]}
    if not tiles:
        return set()
    summ = protos.summary if protos else {}
    full, edges = set(), {}
    for e in doc["entities"]:
        s = summ.get(e["proto"])
        if not s or "airtight" not in s:
            continue
        x, y = int(e["x"] // 1), int(e["y"] // 1)
        b = _blocked_dirs(s["airtight"], float(e.get("rot") or 0))
        if b == "all":
            full.add((x, y))
        else:
            edges.setdefault((x, y), set()).update(b)
    pts = tiles | full | set(edges)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    minx, maxx, miny, maxy = min(xs) - 1, max(xs) + 1, min(ys) - 1, max(ys) + 1
    seen = set()
    stack = []
    for x in range(minx, maxx + 1):
        for y in (miny, maxy):
            stack.append((x, y))
    for y in range(miny, maxy + 1):
        for x in (minx, maxx):
            stack.append((x, y))
    stack = [p for p in stack if p not in tiles and p not in full]
    seen.update(stack)
    exposed = set()
    while stack:
        x, y = stack.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = (x + dx, y + dy)
            if n in seen or not (minx <= n[0] <= maxx and miny <= n[1] <= maxy):
                continue
            if n in full:
                continue
            if (dx, dy) in edges.get((x, y), ()) or (-dx, -dy) in edges.get(n, ()):
                continue
            seen.add(n)
            if n in tiles:
                exposed.add(n)
            stack.append(n)
    return exposed


def build_grid_atmosphere(doc, protos, opts):
    default = opts.get("mix", "air")
    exposed_vacuum = opts.get("exposedVacuum", True)
    tile_mix = {}
    for x, y, name, *_ in doc["tiles"]:
        tile_mix[(x, y)] = default
    if exposed_vacuum:
        for p in exposed_tiles(doc, protos):
            tile_mix[p] = "vacuum"
    for e in doc["entities"]:
        m = MARKERS.get(e["proto"])
        if m:
            p = (int(e["x"] // 1), int(e["y"] // 1))
            if p in tile_mix:
                tile_mix[p] = m
    order = [default] + sorted(set(tile_mix.values()) - {default})
    index = {m: i for i, m in enumerate(order)}
    chunks = {}
    for (x, y), m in tile_mix.items():
        cx, cy = x // 4, y // 4
        bit = (x - cx * 4) + (y - cy * 4) * 4
        ch = chunks.setdefault(f"{cx},{cy}", {})
        i = index[m]
        ch[i] = ch.get(i, 0) | (1 << bit)
    tiles_out = {}
    for key in sorted(chunks, key=lambda k: tuple(int(v) for v in k.split(","))):
        tiles_out[key] = {str(i): str(v) for i, v in sorted(chunks[key].items())}
    unique = []
    for m in order:
        mix = MIXES[m]
        d = {"volume": mix["volume"]}
        d["temperature"] = mix["temperature"]
        d["moles"] = dict(mix["moles"]) if mix["moles"] else {}
        unique.append(d)
    return {"type": "GridAtmosphere", "version": "2",
            "data": {"tiles": tiles_out, "uniqueMixes": unique, "chunkSize": "4"}}
