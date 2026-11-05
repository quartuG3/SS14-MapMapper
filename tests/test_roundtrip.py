"""Round-trip test: load every map file from the repo, save it unchanged, compare.

Run: python tests/test_roundtrip.py [limit] [filter]
Covers grid files and whole maps (stations, format 6 and 7); files with several grids are also
re-saved with another grid selected for editing. Differences in `time:`, multi-line text scalars
(folded `>-` blocks become quoted strings) and old chunk versions (v1/v6 -> v7, like the engine) are expected and ignored.
"""
import difflib
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ss14map import gridfile  # noqa: E402
from ss14map.config import Config  # noqa: E402

IGNORE = ("time:", "content:", "message:", "version: 6", "version: 7", "tiles:", "entityCount:")


def check(src, grid=None):
    doc = json.loads(json.dumps(gridfile.load(src, grid=grid)))  # through JSON like the web client
    out = gridfile.save(doc)
    diff = [l for l in difflib.unified_diff(src.splitlines(), out.splitlines(), lineterm="", n=0)
            if l[:1] in "+-" and not l.startswith(("+++", "---"))]
    diff = [l for l in diff if not any(k in l for k in IGNORE) and l.strip("+- ")]
    # tile chunks: compare decoded tiles of every grid instead of base64 text
    back = gridfile.load(out, grid=doc["gridUid"])
    tiles_ok = sorted(map(tuple, back["tiles"])) == sorted(map(tuple, doc["tiles"]))
    grids_ok = [(g["uid"], g["tiles"]) for g in back["gridList"]] == [(g["uid"], g["tiles"]) for g in doc["gridList"]]
    return doc, diff, tiles_ok and grids_ok


def main():
    cfg = Config()
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 10 ** 9
    flt = sys.argv[2].lower() if len(sys.argv) > 2 else ""
    files = []
    for root in ("SharedMaps", "Maps"):
        files += sorted(glob.glob(os.path.join(cfg.resources, root, "**", "*.yml"), recursive=True))
    files = [f for f in files if flt in f.lower()][:limit]
    bad = n = 0
    for f in files:
        with open(f, encoding="utf-8-sig", newline="") as fh:
            src = fh.read()
        if not src.lstrip().startswith("meta:"):
            continue
        n += 1
        rel = os.path.relpath(f, cfg.resources)
        try:
            doc, diff, ok = check(src)
            runs = [(doc["gridUid"], diff, ok)]
            others = [g["uid"] for g in doc["gridList"] if g["uid"] != doc["gridUid"]]
            if others:
                _, d2, ok2 = check(src, others[0])
                runs.append((others[0], d2, ok2))
        except Exception as e:  # noqa
            bad += 1
            print(f"FAIL {rel}  {type(e).__name__}: {e}")
            continue
        for grid, d, ok in runs:
            status = "OK " if ok and len(d) <= 4 else "DIFF"
            if status != "OK ":
                bad += 1
            print(f"{status} {rel} grid={grid}/{len(doc['gridList'])}  diff-lines={len(d)} tiles={'ok' if ok else 'MISMATCH'}")
            if status != "OK " and "-v" in sys.argv:
                print("\n".join(d[:12]))
    print(f"\n{n} map files, {bad} runs with notable differences")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
