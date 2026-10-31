"""Round-trip test: load every grid map from the repo, save it unchanged, compare.

Run: python tests/test_roundtrip.py [limit]
Differences in `time:`, multi-line text scalars (folded `>-` blocks become quoted strings) and
old chunk versions (v6 -> v7) are expected and ignored.
"""
import difflib
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ss14map import gridfile  # noqa: E402
from ss14map.config import Config  # noqa: E402

IGNORE = ("time:", "content:", "message:", "version: 6", "tiles:")


def main():
    cfg = Config()
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 10 ** 9
    files = sorted(glob.glob(os.path.join(cfg.resources, "SharedMaps", "**", "*.yml"), recursive=True))[:limit]
    bad = 0
    for f in files:
        with open(f, encoding="utf-8-sig", newline="") as fh:
            src = fh.read()
        if "category: Grid" not in src[:400]:
            continue
        doc = json.loads(json.dumps(gridfile.load(src)))  # through JSON like the web client
        out = gridfile.save(doc)
        diff = [l for l in difflib.unified_diff(src.splitlines(), out.splitlines(), lineterm="", n=0)
                if l[:1] in "+-" and not l.startswith(("+++", "---"))]
        diff = [l for l in diff if not any(k in l for k in IGNORE) and l.strip("+- ")]
        # tile chunks: compare decoded tiles instead of base64 text
        tiles_ok = sorted(map(tuple, gridfile.load(out)["tiles"])) == sorted(map(tuple, doc["tiles"]))
        status = "OK " if tiles_ok and len(diff) <= 4 else "DIFF"
        if status != "OK ":
            bad += 1
        print(f"{status} {os.path.relpath(f, cfg.resources)}  diff-lines={len(diff)} tiles={'ok' if tiles_ok else 'MISMATCH'}")
    print(f"\n{len(files)} files, {bad} with notable differences")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
