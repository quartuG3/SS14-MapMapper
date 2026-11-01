"""Environment check used by run_mapper.bat.

python -m ss14map.check deps     exit 1 if Python is too old or packages are missing
python -m ss14map.check config   exit 1 if conf.toml is missing or invalid
"""
import importlib
import sys

# import name -> pip name (see requirements.txt)
PACKAGES = {"yaml": "pyyaml", "PIL": "pillow", "numpy": "numpy"}


def check_deps():
    if sys.version_info < (3, 11):
        print(f"[check] нужен Python 3.11+, установлен {sys.version.split()[0]}")
        return 1
    missing = []
    for mod, pip_name in PACKAGES.items():
        try:
            importlib.import_module(mod)
        except ImportError:
            missing.append(pip_name)
    if missing:
        print("[check] не установлены пакеты: " + ", ".join(missing))
        return 1
    print("[check] Python и пакеты: OK")
    return 0


def check_config():
    from ss14map.config import ConfigError, read_conf
    try:
        data = read_conf()
    except ConfigError as e:
        print("[check] " + str(e))
        return 1
    print(f"[check] conf.toml: OK ({data['repo']}, порт {data['port']})")
    return 0


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what == "deps":
        sys.exit(check_deps())
    if what == "config":
        sys.exit(check_config())
    sys.exit(check_deps() or check_config())
