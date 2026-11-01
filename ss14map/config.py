"""Reads conf.toml and exposes repository paths."""
import os
import re
import tomllib

TOOL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONF_PATH = os.path.join(TOOL_DIR, "conf.toml")
CONF_EXAMPLE = os.path.join(TOOL_DIR, "conf.example.toml")
PRESET_KINDS = ("symmetry", "random")  # subfolders of presets/


class ConfigError(Exception):
    pass


def read_conf(conf_path=None):
    """Parse and validate conf.toml. Raises ConfigError with a human-readable message."""
    conf_path = conf_path or CONF_PATH
    if not os.path.isfile(conf_path):
        raise ConfigError(f"Не найден {conf_path}. Скопируйте conf.example.toml в conf.toml и укажите путь к репозиторию.")
    with open(conf_path, "rb") as f:
        raw = f.read().decode("utf-8-sig")
    try:
        data = tomllib.loads(_fix_backslashes(raw))
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"conf.toml: ошибка синтаксиса: {e}")
    if not str(data.get("path", "")).strip():
        raise ConfigError("conf.toml: не задан path (корень репозитория сборки).")
    repo = os.path.normpath(os.path.expandvars(os.path.expanduser(str(data["path"]).strip())))
    if not os.path.isdir(repo):
        raise ConfigError(f"conf.toml: папка репозитория не существует: {repo}")
    for sub in ("Resources", os.path.join("Resources", "Prototypes")):
        if not os.path.isdir(os.path.join(repo, sub)):
            raise ConfigError(f"conf.toml: в {repo} нет папки {sub}. Укажите корень репозитория SS14.")
    try:
        port = int(data.get("port", 8714))
    except (TypeError, ValueError):
        raise ConfigError(f"conf.toml: port должен быть числом, а не {data.get('port')!r}")
    if not 1 <= port <= 65535:
        raise ConfigError(f"conf.toml: port вне диапазона 1–65535: {port}")
    locale = data.get("locale", "ru-RU")
    if not isinstance(locale, str) or not locale:
        raise ConfigError("conf.toml: locale должен быть строкой, например \"ru-RU\".")
    return {"repo": repo, "port": port, "locale": locale}


class Config:
    def __init__(self, conf_path=None):
        try:
            data = read_conf(conf_path)
        except ConfigError as e:
            raise SystemExit(str(e))
        self.repo = data["repo"]
        self.port = data["port"]
        self.locale = data["locale"]
        self.resources = os.path.join(self.repo, "Resources")
        self.prototypes = os.path.join(self.resources, "Prototypes")
        self.textures = os.path.join(self.resources, "Textures")
        self.cache_dir = os.path.join(TOOL_DIR, ".cache")
        self.autosave_dir = os.path.join(TOOL_DIR, ".autosave")
        self.prefab_dir = os.path.join(TOOL_DIR, "prefabs")
        self.preset_dir = os.path.join(TOOL_DIR, "presets")
        for d in (self.cache_dir, self.autosave_dir, self.prefab_dir,
                  *(os.path.join(self.preset_dir, k) for k in PRESET_KINDS)):
            os.makedirs(d, exist_ok=True)

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
                v = re.split(r"\s+#", v, 1)[0].strip()  # drop trailing comment
                v = "'" + v + "'"
            line = f"{k.strip()} = {v}"
        out.append(line)
    return "\n".join(out)
