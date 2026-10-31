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
from ss14map.config import TOOL_DIR, Config
from ss14map.prototypes import ProtoIndex
from ss14map.sprites import SpriteBank, png_bytes

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


def list_maps():
    out = []
    for root in MAP_ROOTS:
        base = os.path.join(cfg.resources, root)
        for dirpath, _, files in os.walk(base):
            for fn in files:
                if not fn.endswith(".yml"):
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    with open(full, encoding="utf-8-sig", errors="replace") as f:
                        head = f.read(400)
                except OSError:
                    continue
                if "category: Grid" not in head:
                    continue
                rel = os.path.relpath(full, cfg.resources).replace("\\", "/")
                out.append({"path": rel, "size": os.path.getsize(full)})
    out.sort(key=lambda m: m["path"].lower())
    return out


def vessel_for(map_rel):
    """Find vessel prototypes whose shuttlePath points at this map."""
    res = []
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
            if route == "map":
                path = cfg.res_path(q["path"])
                with open(path, encoding="utf-8-sig", newline="") as f:
                    text = f.read()
                doc = gridfile.load(text, protos.migrations if q.get("migrate", "1") == "1" else None)
                doc["path"] = q["path"]
                doc["vessels"] = vessel_for(q["path"])
                data = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                return self._send(200, gzip.compress(data, 5), gz=True)
            if route == "new":
                return self._json(gridfile.new_doc(q.get("name", "grid")))
            if route == "sprite":
                res = bank.compose(q["p"], int(q.get("d", 0)) % 4, q.get("s") or None, q.get("c") or None,
                                   q.get("l") or None)
                return self._image(res)
            if route == "icon":
                return self._image(bank.icon(q["p"]))
            if route == "tile":
                return self._image(bank.tile(q["id"], int(q.get("v", 0))))
            if route == "decal":
                return self._image(bank.decal(q["id"], q.get("c") or None))
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
                    full = cfg.res_path(rel)
                    os.makedirs(os.path.dirname(full), exist_ok=True)
                    with open(full, "w", encoding="utf-8", newline="") as f:
                        f.write(text)
                    return self._json({"ok": True, "path": rel, "bytes": len(text)})
                return self._send(200, text, "text/yaml; charset=utf-8")
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

    def _static(self, rel):
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            return self._err("not found", 404)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".js"):
            ctype = "text/javascript; charset=utf-8"
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)


def main():
    sys.stdout.reconfigure(line_buffering=True)
    srv = ThreadingHTTPServer(("127.0.0.1", cfg.port), Handler)
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
