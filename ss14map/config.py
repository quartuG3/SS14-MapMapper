"""Reads conf.toml and exposes repository paths."""
import os
import tomllib

TOOL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Config:
    def __init__(self, conf_path=None):
        conf_path = conf_path or os.path.join(TOOL_DIR, "conf.toml")
        with open(conf_path, "rb") as f:
            raw = f.read().decode("utf-8-sig")
        data = tomllib.loads(_fix_backslashes(raw))
        self.repo = os.path.normpath(data["path"])
        self.port = int(data.get("port", 8714))
        self.locale = data.get("locale", "ru-RU")
        self.resources = os.path.join(self.repo, "Resources")
        self.prototypes = os.path.join(self.resources, "Prototypes")
        self.textures = os.path.join(self.resources, "Textures")
        self.cache_dir = os.path.join(TOOL_DIR, ".cache")
        self.autosave_dir = os.path.join(TOOL_DIR, ".autosave")
        self.prefab_dir = os.path.join(TOOL_DIR, "prefabs")
        for d in (self.cache_dir, self.autosave_dir, self.prefab_dir):
            os.makedirs(d, exist_ok=True)
        if not os.path.isdir(self.resources):
            raise SystemExit(f"Resources folder not found: {self.resources}")

    def res_path(self, rel):
        """Resolve a path relative to Resources/ and make sure it stays inside the repo."""
        rel = rel.replace("\\", "/").lstrip("/")
        full = os.path.normpath(os.path.join(self.resources, rel))
        if not full.startswith(os.path.normpath(self.resources)):
            raise ValueError("path escapes Resources")
        return full


def _fix_backslashes(text):
    # conf.toml uses unquoted Windows paths like path=C:\Users\...; make it valid TOML.
    out = []
    for line in text.splitlines():
        s = line.strip()
        if "=" in s and not s.startswith("#"):
            k, v = s.split("=", 1)
            v = v.strip()
            if not (v.startswith('"') or v.startswith("'") or v.startswith("[") or v.replace(".", "").isdigit()
                    or v in ("true", "false")):
                v = "'" + v + "'"
            line = f"{k.strip()} = {v}"
        out.append(line)
    return "\n".join(out)
