"""SS14 Shuttle Mapper — local web editor for Frontier-based shuttles.

Run:  python mapper.py            (opens http://localhost:8714)
      python mapper.py --no-browser
"""
import gzip
import json
import mimetypes
import os
import re
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from ss14map import gridfile, yamlio
from ss14map.atmos import exposed_tiles
from ss14map.config import PRESET_KINDS, TOOL_DIR, USER_PREFIX, Config
from ss14map.prototypes import ProtoIndex
from ss14map.sprites import SpriteBank, parse_color, png_bytes, tint as tint_image

WEB_DIR = os.path.join(TOOL_DIR, "web")
MAP_ROOTS = ("SharedMaps", "Maps")

cfg = Config()
protos = ProtoIndex(cfg)
bank = SpriteBank(cfg, protos)
_payload_cache = {}
# sprites are cached by the browser for an hour; a new server run gets new image URLs
RENDER_VERSION = str(int(time.time()))


def protos_payload():
    if "p" not in _payload_cache:
        data = json.dumps(dict(protos.client_payload(), renderVersion=RENDER_VERSION), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        _payload_cache["p"] = gzip.compress(data, 5)
    return _payload_cache["p"]


def map_info(full):
    """{category, format} of a map file from its header, or None when it is not a map."""
    try:
        with open(full, encoding="utf-8-sig", errors="replace") as f:
            head = f.read(400)
    except OSError:
        return None
    if not head.lstrip().startswith("meta:") or "format:" not in head:
        return None
    cat = re.search(r"^\s+category:\s*(\w+)", head, re.M)
    fmt = re.search(r"^\s+format:\s*(\d+)", head, re.M)
    # format 6 files have no category: those are whole maps (stations)
    return {"cat": cat.group(1) if cat else "Map", "format": int(fmt.group(1)) if fmt else 0}


def list_maps():
    """Every grid and map file of the build (grids, stations, format 6 and 7) plus the user's shuttles."""
    out = []
    for root in MAP_ROOTS:
        base = os.path.join(cfg.resources, root)
        for dirpath, _, files in os.walk(base):
            for fn in files:
                if not fn.endswith(".yml"):
                    continue
                full = os.path.join(dirpath, fn)
                info = map_info(full)
                if not info:
                    continue
                rel = os.path.relpath(full, cfg.resources).replace("\\", "/")
                out.append({"path": rel, "size": os.path.getsize(full), **info})
    out.sort(key=lambda m: m["path"].lower())
    return out


def list_user_maps():
    out = []
    for dirpath, _, files in os.walk(cfg.user_dir):
        for fn in files:
            full = os.path.join(dirpath, fn)
            info = fn.endswith(".yml") and map_info(full)
            if not info:
                continue
            rel = os.path.relpath(full, cfg.user_dir).replace("\\", "/")
            out.append({"path": USER_PREFIX + rel, "size": os.path.getsize(full), "mtime": os.path.getmtime(full), **info})
    out.sort(key=lambda m: -m["mtime"])
    return out


def user_file_name(name):
    name = os.path.basename(str(name).replace("\\", "/"))
    name = re.sub(r"\.ya?ml$", "", name, flags=re.I)
    name = re.sub(r"[^\w\-а-яА-ЯёЁ ().]", "_", name).strip(" .") or "shuttle"
    return name + ".yml"


def vessel_for(map_rel):
    """Find vessel prototypes whose shuttlePath points at this map."""
    res = []
    if map_rel.startswith(USER_PREFIX):
        return res
    target = "/" + map_rel.replace("\\", "/").lstrip("/")
    for v in protos.vessels.values():
        if str(v.get("shuttlePath", "")).lower() == target.lower():
            res.append(v)
    return res


_enum_cache = {}


def vessel_enums():
    """Parse VesselSize / VesselClass / VesselEngine / ShipyardConsoleUiKey from the repo C# sources,
    plus values actually used by vessel prototypes."""
    if _enum_cache:
        return _enum_cache
    names = ("VesselSize", "VesselClass", "VesselEngine", "ShipyardConsoleUiKey")
    found = {n: [] for n in names}
    rx = re.compile(r"enum\s+(" + "|".join(names) + r")\b[^{]*\{(.*?)\}", re.S)
    for root in ("Content.Shared", "Content.Server", "Content.Client"):
        base = os.path.join(cfg.repo, root)
        for dirpath, _, files in os.walk(base):
            for fn in files:
                if not fn.endswith(".cs"):
                    continue
                try:
                    with open(os.path.join(dirpath, fn), encoding="utf-8-sig", errors="replace") as f:
                        text = f.read()
                except OSError:
                    continue
                if "enum Vessel" not in text and "enum ShipyardConsoleUiKey" not in text:
                    continue
                for m in rx.finditer(text):
                    body = re.sub(r"//[^\n]*|/\*.*?\*/|\[[^\]]*\]", "", m.group(2), flags=re.S)
                    for item in body.split(","):
                        item = item.strip().split("=")[0].strip()
                        if re.fullmatch(r"[A-Za-z_]\w*", item) and item not in found[m.group(1)]:
                            found[m.group(1)].append(item)
    used = {"category": set(), "group": set(), "class": set(), "engine": set()}
    for v in protos.vessels.values():
        for k in used:
            val = v.get(k)
            for x in (val if isinstance(val, list) else [val]):
                if isinstance(x, str) and x:
                    used[k].add(x)
    def merge(enum_vals, extra):
        low = {x.lower() for x in enum_vals}
        return [x for x in enum_vals if x != "All"] + sorted(x for x in extra if x.lower() not in low)
    _enum_cache.update({
        "category": merge(found["VesselSize"], used["category"]),
        "group": merge(found["ShipyardConsoleUiKey"], used["group"]),
        "class": merge(found["VesselClass"], used["class"]),
        "engine": merge(found["VesselEngine"], used["engine"]),
    })
    return _enum_cache


def preset_path(kind, name):
    if kind not in PRESET_KINDS:
        raise ValueError(f"unknown preset kind {kind!r}")
    name = re.sub(r"[^\w\-а-яА-ЯёЁ ()]", "_", str(name)).strip() or "preset"
    return os.path.join(cfg.preset_dir, kind, name + ".json")


def palette_path(name):
    name = re.sub(r"[^\w\-а-яА-ЯёЁ ()]", "_", str(name)).strip() or "palette"
    return os.path.join(cfg.palette_dir, name + ".json")


def list_palettes():
    out = []
    for fn in sorted(os.listdir(cfg.palette_dir), key=str.lower):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(cfg.palette_dir, fn), encoding="utf-8-sig") as f:
                out.append({"file": fn[:-5], "data": json.load(f)})
        except (OSError, ValueError) as e:
            out.append({"file": fn[:-5], "error": str(e)})
    return out


def list_presets(kind):
    if kind not in PRESET_KINDS:
        raise ValueError(f"unknown preset kind {kind!r}")
    base = os.path.join(cfg.preset_dir, kind)
    out = []
    for fn in sorted(os.listdir(base), key=str.lower):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(base, fn), encoding="utf-8-sig") as f:
                out.append({"file": fn[:-5], "data": json.load(f)})
        except (OSError, ValueError) as e:
            out.append({"file": fn[:-5], "error": str(e)})
    return out


def pipeline_path(name):
    name = re.sub(r"\.js$", "", os.path.basename(str(name).replace("\\", "/")), flags=re.I)
    name = re.sub(r"[^\w\-а-яА-ЯёЁ ()]", "_", name).strip() or "pipeline"
    return os.path.join(cfg.pipeline_dir, name + ".js")


def list_pipelines():
    out = []
    for fn in sorted(os.listdir(cfg.pipeline_dir), key=str.lower):
        full = os.path.join(cfg.pipeline_dir, fn)
        if fn.endswith(".js") and os.path.isfile(full):
            out.append({"file": fn[:-3], "size": os.path.getsize(full), "mtime": os.path.getmtime(full)})
    return out


RES_TEXT_EXT = (".yml", ".yaml", ".ftl", ".txt", ".json", ".toml")


def proto_raw(kind, pid):
    """A prototype as written in its file (not merged with parents): {id, type, file, data, parents}."""
    if kind == "entity":
        d = protos.raw_entities.get(pid)
        file = protos.entity_files.get(pid)
    elif kind == "vessel":
        d = protos.vessels.get(pid)
        file = d and d.get("_file")
        d = d and {k: v for k, v in d.items() if k != "_file"}
    elif kind == "tile":
        d, file = protos.tiles.get(pid), None
    elif kind == "decal":
        d, file = protos.decals.get(pid), None
    else:
        raise ValueError(f"unknown prototype type {kind!r}")
    if d is None:
        return None
    chain, seen = [], set()
    if kind == "entity":
        stack = [x for x in (d.get("parent") if isinstance(d.get("parent"), list) else [d.get("parent")]) if isinstance(x, str)]
        while stack:  # every ancestor, nearest first
            p = stack.pop(0)
            if p in seen:
                continue
            seen.add(p)
            chain.append(p)
            pd = protos.raw_entities.get(p) or {}
            stack += [x for x in (pd.get("parent") if isinstance(pd.get("parent"), list) else [pd.get("parent")]) if isinstance(x, str)]
    return {"id": pid, "type": kind, "file": file and "Prototypes/" + file, "data": d, "parents": chain}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if "/api/sprite" in self.path or "/api/tile" in self.path or "/api/icon" in self.path \
                or "/api/decal" in self.path or self.path.startswith("/js/") or self.path.startswith("/css"):
            return
        sys.stderr.write("[http] " + (fmt % args) + "\n")

    # ------------------------------------------------------------------ helpers
    def _send(self, code, body, ctype="application/json; charset=utf-8", headers=None, gz=False):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if "Cache-Control" not in (headers or {}):
            self.send_header("Cache-Control", "no-cache")
        if gz:
            self.send_header("Content-Encoding", "gzip")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def _err(self, msg, code=400):
        self._json({"error": msg}, code)

    def _image(self, res):
        if res is None:
            self._send(204, b"", "image/png")
            return
        if isinstance(res, tuple):
            img, ox, oy = res
        else:
            img, ox, oy = res, res.width // 2, res.height // 2
        self._send(200, png_bytes(img), "image/png",
                   {"X-Origin": f"{ox},{oy}", "Access-Control-Expose-Headers": "X-Origin",
                    "Cache-Control": "max-age=3600"})

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        if self.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8")) if raw else {}

    # ------------------------------------------------------------------ routes
    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/" or u.path == "/index.html":
                return self._static("index.html")
            if not u.path.startswith("/api/"):
                return self._static(u.path.lstrip("/"))
            route = u.path[5:]
            if route == "protos":
                return self._send(200, protos_payload(), gz=True)
            if route == "config":
                return self._json({"repo": cfg.repo, "locale": cfg.locale})
            if route == "maps":
                return self._json(list_maps())
            if route == "usermaps":
                return self._json(list_user_maps())
            if route == "map":
                path = cfg.map_path(q["path"])
                with open(path, encoding="utf-8-sig", newline="") as f:
                    text = f.read()
                doc = gridfile.load(text, protos.migrations if q.get("migrate", "1") == "1" else None, q.get("grid") or None)
                doc["path"] = q["path"]
                doc["vessels"] = vessel_for(q["path"])
                data = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                return self._send(200, gzip.compress(data, 5), gz=True)
            if route == "new":
                return self._json(gridfile.new_doc(q.get("name", "grid")))
            if route == "sprite":
                res = bank.compose(q["p"], int(q.get("d", 0)) % 4, q.get("s") or None, q.get("c") or None,
                                   q.get("l") or None, q.get("h") == "1")
                return self._image(res)
            if route == "icon":
                return self._image(bank.icon(q["p"]))
            if route == "tile":
                return self._image(bank.tile(q["id"], int(q.get("v", 0))))
            if route == "decal":
                return self._image(bank.decal(q["id"], q.get("c") or None))
            if route == "rsistate":
                rsi = bank.rsi(q["rsi"])
                return self._image(rsi.frame(q["state"], 0) if rsi and rsi.has(q["state"]) else None)
            if route == "res":
                return self._resource(q["path"], q.get("tint") or None)
            if route == "papertemplates":
                return self._json(protos.paper_templates())
            if route == "paper":
                info = protos.paper_info(q["p"])
                if info is None:
                    return self._err("unknown prototype", 404)
                rsi = bank.rsi(info["rsi"]) or bank.rsi("Objects/Misc/bureaucracy.rsi")
                # stamp marks a paper sprite can show (PaperVisualLayers.Stamp uses the paper's own RSI)
                info["stampStates"] = sorted(s for s in (rsi.states if rsi else {}) if s.startswith("paper_stamp-"))
                info["rsi"] = info["rsi"] if bank.rsi(info["rsi"]) else "Objects/Misc/bureaucracy.rsi"
                return self._json(info)
            if route == "enums":
                return self._json(vessel_enums())
            if route == "vessels":
                return self._json(list(protos.vessels.values()))
            if route == "prefabs":
                out = []
                for fn in sorted(os.listdir(cfg.prefab_dir)):
                    if fn.endswith(".json"):
                        with open(os.path.join(cfg.prefab_dir, fn), encoding="utf-8") as f:
                            out.append(json.load(f))
                return self._json(out)
            if route == "presets":
                return self._json(list_presets(q["kind"]))
            if route == "palettes":
                return self._json(list_palettes())
            if route == "pipelines":
                return self._json(list_pipelines())
            if route == "pipeline":
                with open(pipeline_path(q["name"]), encoding="utf-8-sig") as f:
                    return self._send(200, f.read(), "text/javascript; charset=utf-8")
            if route == "protoraw":
                res = proto_raw(q.get("type", "entity"), q["id"])
                return self._json(res) if res else self._err("unknown prototype", 404)
            if route == "protoresolved":
                res = protos.resolve(q["id"])
                return self._json(res) if res else self._err("unknown prototype", 404)
            if route == "restext":
                full = cfg.res_path(q["path"])
                if not full.lower().endswith(RES_TEXT_EXT) or not os.path.isfile(full):
                    return self._err("not found", 404)
                with open(full, encoding="utf-8-sig", errors="replace") as f:
                    return self._send(200, f.read(), "text/plain; charset=utf-8")
            if route == "autosave":
                p = os.path.join(cfg.autosave_dir, "autosave.json")
                if not os.path.exists(p):
                    return self._send(204, b"")
                with open(p, "rb") as f:
                    return self._send(200, f.read())
            return self._err("unknown route", 404)
        except KeyError as e:
            return self._err(f"missing parameter {e}")
        except FileNotFoundError as e:
            return self._err(str(e), 404)
        except Exception as e:  # noqa
            traceback.print_exc()
            return self._err(f"{type(e).__name__}: {e}", 500)

    def do_POST(self):
        u = urlparse(self.path)
        try:
            body = self._body()
            route = u.path[5:] if u.path.startswith("/api/") else ""
            if route == "save":
                doc = body["doc"]
                text = gridfile.save(doc, protos, regen_atmos=bool(body.get("regenAtmos")),
                                     atmos_opts=body.get("atmos") or {})
                rel = body.get("path")
                if body.get("write", True):
                    if not rel or not rel.endswith(".yml"):
                        return self._err("path must end with .yml")
                    full = cfg.map_path(rel)
                    os.makedirs(os.path.dirname(full), exist_ok=True)
                    with open(full, "w", encoding="utf-8", newline="") as f:
                        f.write(text)
                    return self._json({"ok": True, "path": rel, "bytes": len(text)})
                return self._send(200, text, "text/yaml; charset=utf-8")
            if route == "enttext":
                return self._json({pid: protos.ent_text(pid) for pid in body["ids"][:20000]})
            if route == "yaml/dump":
                return self._json({"text": yamlio.dump(body["obj"])})
            if route == "yaml/load":
                return self._json({"obj": yamlio.load(body["text"])})
            if route == "exposed":
                return self._json({"tiles": sorted(exposed_tiles(body["doc"], protos))})
            if route == "writefile":
                rel = body["path"]
                if not re.search(r"\.(yml|txt|png)$", rel):
                    return self._err("only .yml/.txt allowed")
                full = cfg.res_path(rel)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "w", encoding="utf-8", newline="") as f:
                    f.write(body["text"])
                return self._json({"ok": True, "path": rel})
            if route == "prefab":
                name = re.sub(r"[^\w\-а-яА-ЯёЁ ]", "_", body["name"]).strip() or "prefab"
                with open(os.path.join(cfg.prefab_dir, name + ".json"), "w", encoding="utf-8") as f:
                    json.dump(body, f, ensure_ascii=False)
                return self._json({"ok": True})
            if route == "prefab/delete":
                name = re.sub(r"[^\w\-а-яА-ЯёЁ ]", "_", body["name"]).strip()
                p = os.path.join(cfg.prefab_dir, name + ".json")
                if os.path.exists(p):
                    os.remove(p)
                return self._json({"ok": True})
            if route == "preset":
                p = preset_path(body["kind"], body["name"])
                with open(p, "w", encoding="utf-8") as f:
                    json.dump(body["data"], f, ensure_ascii=False, indent=1)
                return self._json({"ok": True, "file": os.path.basename(p)[:-5]})
            if route == "preset/delete":
                p = preset_path(body["kind"], body["name"])
                if os.path.exists(p):
                    os.remove(p)
                return self._json({"ok": True})
            if route == "upload":
                # a shuttle file from the user's computer -> shuttles/<name>.yml
                text = body["text"]
                if text.startswith("\ufeff"):
                    text = text[1:]
                try:
                    doc = gridfile.load(text)
                except Exception as e:  # noqa
                    return self._err(f"{body.get('name')}: это не файл карты SS14 ({type(e).__name__}: {e})")
                name = user_file_name(body.get("name") or "shuttle")
                full = os.path.join(cfg.user_dir, name)
                if os.path.exists(full) and not body.get("overwrite"):
                    return self._json({"exists": True, "path": USER_PREFIX + name}, 409)
                with open(full, "w", encoding="utf-8", newline="") as f:
                    f.write(text)
                return self._json({"ok": True, "path": USER_PREFIX + name, "grids": len(doc["gridList"]),
                                   "tiles": len(doc["tiles"]), "entities": len(doc["entities"])})
            if route == "usermap/delete":
                full = cfg.map_path(body["path"])
                if not body["path"].startswith(USER_PREFIX):
                    return self._err("only files of the user folder can be deleted")
                if os.path.exists(full):
                    os.remove(full)
                return self._json({"ok": True})
            if route == "palette":
                p = palette_path(body["name"])
                with open(p, "w", encoding="utf-8") as f:
                    json.dump(body["data"], f, ensure_ascii=False, indent=1)
                old = body.get("old")
                if old and palette_path(old) != p and os.path.exists(palette_path(old)):
                    os.remove(palette_path(old))  # renamed
                return self._json({"ok": True, "file": os.path.basename(p)[:-5]})
            if route == "palette/delete":
                p = palette_path(body["name"])
                if os.path.exists(p):
                    os.remove(p)
                return self._json({"ok": True})
            if route == "locraw":
                # raw Fluent values of keys and their attributes ("ent-X", "ent-X.desc") in one language
                d = protos.ftl.lang(body["lang"])
                want = set(body["keys"])
                return self._json({k: v for k, v in d.items() if k in want or k.split(".", 1)[0] in want})
            if route == "pipeline":
                full = pipeline_path(body["name"])
                if os.path.exists(full) and not body.get("overwrite"):
                    return self._json({"exists": True, "file": os.path.basename(full)[:-3]}, 409)
                with open(full, "w", encoding="utf-8", newline="") as f:
                    f.write(body["text"])
                return self._json({"ok": True, "file": os.path.basename(full)[:-3]})
            if route == "pipeline/delete":
                full = pipeline_path(body["name"])
                if os.path.exists(full):
                    os.remove(full)
                return self._json({"ok": True})
            if route == "autosave":
                with open(os.path.join(cfg.autosave_dir, "autosave.json"), "w", encoding="utf-8") as f:
                    json.dump(body, f, ensure_ascii=False)
                return self._json({"ok": True})
            return self._err("unknown route", 404)
        except KeyError as e:
            return self._err(f"missing field {e}")
        except Exception as e:  # noqa
            traceback.print_exc()
            return self._err(f"{type(e).__name__}: {e}", 500)

    def _resource(self, rel, tint=None):
        """A texture or font of the build (paper backgrounds, stamp border, NotoSans); png can be tinted."""
        rel = rel.replace("\\", "/").lstrip("/")
        full = os.path.normpath(os.path.join(cfg.resources, rel))
        ext = os.path.splitext(full)[1].lower()
        if not rel.startswith(("Textures/", "Fonts/")) or ext not in (".png", ".ttf", ".otf") \
                or not full.startswith(os.path.normpath(cfg.resources) + os.sep) or not os.path.isfile(full):
            return self._err("not found", 404)
        if ext == ".png" and tint:
            img = bank.texture(rel)
            c = parse_color(tint)
            return self._image(tint_image(img, c) if img is not None and c else img)
        with open(full, "rb") as f:
            ctype = {".png": "image/png", ".ttf": "font/ttf", ".otf": "font/otf"}[ext]
            self._send(200, f.read(), ctype, {"Cache-Control": "max-age=3600"})

    def _static(self, rel):
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            return self._err("not found", 404)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        headers = None
        if full.endswith(".js"):
            ctype = "text/javascript; charset=utf-8"
        if rel.replace("\\", "/") == "js/pipeline-worker.js":
            # the sandbox of user pipelines: no network, only the blob module of the pipeline itself
            headers = {"Content-Security-Policy": "default-src 'none'; script-src blob:"}
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype, headers)


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets several processes listen on one port at once, and requests then land on
    # a random (possibly stale) instance. Take the port exclusively so a second start fails loudly instead.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt":
            import socket
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    sys.stdout.reconfigure(line_buffering=True)
    try:
        srv = Server(("127.0.0.1", cfg.port), Handler)
    except OSError as e:
        raise SystemExit(f"[mapper] порт {cfg.port} занят ({e.strerror or e}). Скорее всего маппер уже запущен: "
                         f"закройте его окно или укажите другой port в conf.toml.")
    url = f"http://localhost:{cfg.port}/"
    print(f"[mapper] repo: {cfg.repo}")
    print(f"[mapper] listening on {url}")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
