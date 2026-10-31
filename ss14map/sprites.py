"""RSI loading and entity sprite composition (Pillow)."""
import io
import json
import math
import os
import threading
from functools import lru_cache

from PIL import Image, ImageChops

# RSI direction indices: S=0 N=1 E=2 W=3
# entity rotation steps (CCW, 0 = south facing): 0=S 1=E 2=N 3=W
STEP_TO_RSI = [0, 2, 1, 3]
RSI_TO_STEP = {0: 0, 2: 1, 1: 2, 3: 3}

# DirectionOffset applied to an RSI direction (see RobustToolbox SpriteComponent.OffsetRsiDir)
OFFSET_CW = {0: 3, 3: 1, 1: 2, 2: 0}
OFFSET_CCW = {0: 2, 2: 1, 1: 3, 3: 0}
OFFSET_FLIP = {0: 1, 1: 0, 2: 3, 3: 2}

# Layers that visualizers keep hidden in the default (unpowered, closed, unwelded) state.
STATE_HIDDEN_MAPS = {
    "enum.WeldableLayers.BaseWelded", "enum.DoorVisualLayers.BaseBolted",
    "enum.DoorVisualLayers.BaseEmergencyAccess", "enum.WiresVisualLayers.MaintenancePanel",
    "enum.ElectrifiedLayers.HUD", "enum.ElectrifiedLayers.Sparks", "enum.StorageVisualLayers.Welded",
    "enum.MaterialStorageVisualLayers.Inserting",
}

NAMED_COLORS = {
    "white": (255, 255, 255, 255), "black": (0, 0, 0, 255), "red": (255, 0, 0, 255),
    "green": (0, 128, 0, 255), "lime": (0, 255, 0, 255), "blue": (0, 0, 255, 255),
    "yellow": (255, 255, 0, 255), "orange": (255, 165, 0, 255), "purple": (128, 0, 128, 255),
    "cyan": (0, 255, 255, 255), "magenta": (255, 0, 255, 255), "gray": (128, 128, 128, 255),
    "grey": (128, 128, 128, 255), "brown": (165, 42, 42, 255), "pink": (255, 192, 203, 255),
    "lightgreen": (144, 238, 144, 255), "darkgreen": (0, 100, 0, 255), "transparent": (0, 0, 0, 0),
}


def parse_color(c):
    if not isinstance(c, str) or not c:
        return None
    c = c.strip()
    if c.startswith("#"):
        h = c[1:]
        try:
            if len(h) == 6:
                return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)
            if len(h) == 8:
                return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16))
            if len(h) == 3:
                return tuple(int(x * 2, 16) for x in h) + (255,)
        except ValueError:
            return None
        return None
    return NAMED_COLORS.get(c.lower())


def tint(img, color):
    if not color or color == (255, 255, 255, 255):
        return img
    layer = Image.new("RGBA", img.size, color)
    return ImageChops.multiply(img, layer)


def parse_vec(v):
    if not isinstance(v, str):
        return 0.0, 0.0
    try:
        a, b = v.split(",")
        return float(a), float(b)
    except ValueError:
        return 0.0, 0.0


class RSI:
    def __init__(self, path):
        self.path = path
        with open(os.path.join(path, "meta.json"), encoding="utf-8-sig") as f:
            meta = json.load(f)
        size = meta.get("size", {"x": 32, "y": 32})
        self.w, self.h = int(size["x"]), int(size["y"])
        self.states = {}
        for st in meta.get("states", []):
            delays = st.get("delays")
            frames = len(delays[0]) if delays and delays[0] else 1
            self.states[st["name"]] = {"dirs": int(st.get("directions", 1)), "frames": frames}
        self._img = {}

    def has(self, state):
        return state in self.states

    def frame(self, state, rsi_dir=0):
        st = self.states.get(state)
        if st is None:
            return None
        if st["dirs"] == 1:
            rsi_dir = 0
        elif rsi_dir >= st["dirs"]:
            rsi_dir = 0
        img = self._img.get(state)
        if img is None:
            p = os.path.join(self.path, state + ".png")
            if not os.path.exists(p):
                return None
            img = Image.open(p).convert("RGBA")
            self._img[state] = img
        cols = max(1, img.width // self.w)
        idx = rsi_dir * st["frames"]
        x = (idx % cols) * self.w
        y = (idx // cols) * self.h
        if y + self.h > img.height:
            x, y = 0, 0
        return img.crop((x, y, x + self.w, y + self.h))


class SpriteBank:
    def __init__(self, cfg, protos):
        self.cfg = cfg
        self.protos = protos
        self._rsi = {}
        self._lock = threading.Lock()
        self._cache = {}

    def rsi(self, rel):
        if not rel:
            return None
        rel = rel.replace("\\", "/").lstrip("/")
        if rel.startswith("Textures/"):
            rel = rel[len("Textures/"):]
        r = self._rsi.get(rel)
        if r is None and rel not in self._rsi:
            path = os.path.join(self.cfg.textures, rel)
            try:
                r = RSI(path) if os.path.isdir(path) else None
            except Exception:
                r = None
            self._rsi[rel] = r
        return r

    def texture(self, rel):
        rel = rel.replace("\\", "/").lstrip("/")
        path = os.path.join(self.cfg.resources, rel) if rel.startswith("Textures/") else os.path.join(
            self.cfg.textures, rel)
        if os.path.isfile(path):
            try:
                return Image.open(path).convert("RGBA")
            except Exception:
                return None
        return None

    # ---------------------------------------------------------------- composition
    def compose(self, pid, step=0, smooth=None, color=None, pipe_layer=None):
        """Return (Image, ox, oy) where (ox, oy) is the pixel of the entity origin, or None."""
        key = (pid, step, smooth, color, pipe_layer)
        with self._lock:
            if key in self._cache:
                return self._cache[key]
            res = self._compose(pid, step, smooth, color, pipe_layer)
            if len(self._cache) > 20000:
                self._cache.clear()
            self._cache[key] = res
            return res

    def _compose(self, pid, step, smooth, color, pipe_layer):
        info = self.protos.render_info.get(pid)
        if info is None:
            return None
        sp = info.get("sprite") or {}
        base_rsi = sp.get("sprite")
        # "<smooth>|<map>,<map>" : extra map keys that the client asks to show (e.g. AME core)
        show_maps = set()
        if isinstance(smooth, str) and "|" in smooth:
            smooth, extra_maps = smooth.split("|", 1)
            show_maps = {m for m in extra_maps.split(",") if m}
        layers = []
        if isinstance(sp.get("layers"), list):
            for l in sp["layers"]:
                if isinstance(l, dict):
                    layers.append(dict(l))
        # the engine uses the top-level state/texture only when no layers are given
        if not layers and (sp.get("state") or sp.get("texture")):
            layers.append({"state": sp.get("state"), "texture": sp.get("texture")})
        if not layers:
            layers.append({})  # layer 0 placeholder (IconSmooth / cable visualizers set its state)

        rsi_dir = STEP_TO_RSI[step % 4]
        sm = info.get("sm")
        extra = []
        if smooth and sm:
            mode = sm.get("mode") or "Corners"
            base = sm.get("base") or ""
            if mode == "Corners":
                try:
                    ne, nw, sw, se = [int(x) for x in smooth.split(",")]
                except ValueError:
                    ne = nw = sw = se = 0
                extra = [
                    {"state": f"{base}{se}", "dir": rsi_dir},
                    {"state": f"{base}{ne}", "dir": OFFSET_CCW[rsi_dir]},
                    {"state": f"{base}{nw}", "dir": OFFSET_FLIP[rsi_dir]},
                    {"state": f"{base}{sw}", "dir": OFFSET_CW[rsi_dir]},
                ]
            elif mode in ("CardinalFlags", "Diagonal", "DiagonalNF"):
                layers[0] = dict(layers[0])
                layers[0]["state"] = f"{base}{smooth}"
                layers[0].pop("texture", None)
        elif sm and (sm.get("mode") or "Corners") == "Corners" and not any(l.get("state") for l in layers):
            base = sm.get("base") or ""
            extra = [{"state": f"{base}0", "dir": d} for d in
                     (rsi_dir, OFFSET_CCW[rsi_dir], OFFSET_FLIP[rsi_dir], OFFSET_CW[rsi_dir])]
        elif sm and sm.get("mode") in ("CardinalFlags", "Diagonal", "DiagonalNF") and not layers[0].get("state"):
            layers[0]["state"] = f"{sm.get('base') or ''}0"
        prefix = info.get("cablePrefix")
        if prefix:
            layers[0] = dict(layers[0])
            layers[0]["state"] = f"{prefix}{smooth if smooth not in (None, '') else 0}"
            layers[0].pop("texture", None)

        no_rot = str(sp.get("noRot", "false")).lower() == "true"
        # snapCardinals: the entity matrix drops the cardinal rotation, only the RSI direction changes
        if str(sp.get("snapCardinals", "false")).lower() == "true":
            no_rot = True
        door_open = info.get("door") == "Open"
        sprite_color = parse_color(sp.get("color"))
        pipe_paths = info.get("pipeLayers") or {}
        ent_color = parse_color(color) if color else None
        sox, soy = parse_vec(sp.get("offset"))

        pieces = []  # (img, cx, cy) cx, cy = pixel offset of image center relative to entity origin
        for l in layers + extra:
            maps = l.get("map") if isinstance(l.get("map"), list) else []
            if show_maps.intersection(maps):
                pass
            elif str(l.get("visible", "true")).lower() == "false" or STATE_HIDDEN_MAPS.intersection(maps):
                continue
            if door_open:
                if "enum.DoorVisualLayers.BaseUnlit" in maps:
                    continue
                if "enum.DoorVisualLayers.Base" in maps:
                    r = self.rsi(l.get("sprite") or base_rsi)
                    if r is not None and r.has("open"):
                        l = dict(l, state="open")
            img = None
            rsi_rel = l.get("sprite") or base_rsi
            if pipe_layer and pipe_paths and pipe_layer != info.get("defaultPipeLayer", "Primary"):
                for mk in maps:
                    if mk in pipe_paths and isinstance(pipe_paths[mk], dict) and pipe_layer in pipe_paths[mk]:
                        rsi_rel = pipe_paths[mk][pipe_layer]
            rotate_deg = 0
            if l.get("texture"):
                img = self.texture(l["texture"])
                if img is not None and not no_rot:
                    rotate_deg = step * 90
            elif l.get("state"):
                rsi = self.rsi(rsi_rel)
                if rsi is None or not rsi.has(l["state"]):
                    continue
                st = rsi.states[l["state"]]
                if "dir" in l:
                    img = rsi.frame(l["state"], l["dir"])
                elif st["dirs"] > 1:
                    img = rsi.frame(l["state"], rsi_dir)
                else:
                    img = rsi.frame(l["state"], 0)
                    if not no_rot:
                        rotate_deg = step * 90
            if img is None:
                continue
            c = parse_color(l.get("color"))
            if c:
                img = tint(img, c)
            if sprite_color:
                img = tint(img, sprite_color)
            if ent_color and ("enum.PipeVisualLayers.Pipe" in maps or "enum.PipeColorVisuals.Color" in maps
                              or not maps and info.get("pipeLayers")):
                img = tint(img, ent_color)
            lox, loy = parse_vec(l.get("offset"))
            ox, oy = (lox + sox), (loy + soy)
            if rotate_deg:
                img = img.rotate(rotate_deg, expand=True)
            if not no_rot and step % 4:
                # layer and sprite offsets live in entity space and rotate with it,
                # also for directional states (the RSI direction only swaps the frame)
                for _ in range(step % 4):
                    ox, oy = -oy, ox  # 90 degrees CCW
            pieces.append((img, ox * 32, -oy * 32))
        if not pieces:
            return None
        minx = min(cx - im.width / 2 for im, cx, cy in pieces)
        miny = min(cy - im.height / 2 for im, cx, cy in pieces)
        maxx = max(cx + im.width / 2 for im, cx, cy in pieces)
        maxy = max(cy + im.height / 2 for im, cx, cy in pieces)
        minx, miny = math.floor(min(minx, -16)), math.floor(min(miny, -16))
        maxx, maxy = math.ceil(max(maxx, 16)), math.ceil(max(maxy, 16))
        out = Image.new("RGBA", (maxx - minx, maxy - miny), (0, 0, 0, 0))
        for im, cx, cy in pieces:
            x = int(round(cx - im.width / 2 - minx))
            y = int(round(cy - im.height / 2 - miny))
            out.alpha_composite(im, (x, y))
        return out, -minx, -miny

    def icon(self, pid):
        key = ("icon", pid)
        with self._lock:
            if key in self._cache:
                return self._cache[key]
        info = self.protos.render_info.get(pid) or {}
        res = None
        ic = info.get("icon")
        if ic and ic.get("state"):
            rsi = self.rsi(ic.get("sprite") or (info.get("sprite") or {}).get("sprite"))
            if rsi and rsi.has(ic["state"]):
                img = rsi.frame(ic["state"], 0)
                if img is not None:
                    res = (img, img.width // 2, img.height // 2)
        if res is None:
            res = self.compose(pid, 0)
        with self._lock:
            self._cache[key] = res
        return res

    def tile(self, tid, variant=0):
        key = ("tile", tid, variant)
        with self._lock:
            if key in self._cache:
                return self._cache[key]
        ts = self.protos.tile_summary.get(tid)
        res = None
        if ts and ts.get("sprite"):
            img = self.texture(ts["sprite"])
            if img is not None:
                size = img.height
                n = max(1, img.width // size)
                v = variant % n
                res = img.crop((v * size, 0, v * size + size, size))
                if size != 32:
                    res = res.resize((32, 32), Image.NEAREST)
        with self._lock:
            self._cache[key] = res
        return res

    def decal(self, did, color=None):
        key = ("decal", did, color)
        with self._lock:
            if key in self._cache:
                return self._cache[key]
        d = self.protos.decal_summary.get(did)
        res = None
        if d:
            if d.get("texture"):
                res = self.texture(d["texture"])
            elif d.get("rsi"):
                rsi = self.rsi(d["rsi"])
                if rsi and rsi.has(d.get("state")):
                    res = rsi.frame(d["state"], 0)
            if res is not None and color:
                c = parse_color(color)
                if c:
                    res = tint(res, c)
        with self._lock:
            self._cache[key] = res
        return res


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
