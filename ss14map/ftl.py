"""Fluent (.ftl) locale strings: multi-line values, attributes (ent-Foo.desc) and simple placeables.

Loaded lazily on first use: entity descriptions, default paper texts and stamp names are looked up
here instead of being kept in the prototype cache.
"""
import glob
import os
import re
import threading

ENTRY = re.compile(r"^(-?[A-Za-z][\w-]*)[ \t]*=[ \t]?(.*)$")
ATTR = re.compile(r"^[ \t]+\.([A-Za-z][\w-]*)[ \t]*=[ \t]?(.*)$")
STRING = re.compile(r'^"((?:[^"\\]|\\.)*)"$')
REF = re.compile(r"^(-?[A-Za-z][\w-]*)(?:\.([A-Za-z][\w-]*))?$")


def parse(text, out):
    """Adds "key" and "key.attr" -> raw value (placeables unresolved) to out."""
    base = None
    cur = None  # [key, inline, block lines]

    def flush():
        if not cur:
            return
        key, inline, lines = cur
        while lines and not lines[-1].strip():
            lines.pop()
        ind = min((len(ln) - len(ln.lstrip(" ")) for ln in lines if ln.strip()), default=0)
        block = "\n".join(ln[ind:] for ln in lines)
        out[key] = inline + ("\n" if inline and block else "") + block

    for raw in text.splitlines():
        if not raw.strip():
            if cur:
                cur[2].append("")
            continue
        if raw[0] == "#":
            flush()
            cur = base = None
            continue
        if raw[0] not in " \t":
            flush()
            m = ENTRY.match(raw)
            base = m.group(1) if m else None
            cur = [base, m.group(2).rstrip(), []] if m else None
            continue
        m = ATTR.match(raw)
        if m and base:
            flush()
            cur = [base + "." + m.group(1), m.group(2).rstrip(), []]
            continue
        if cur:
            cur[2].append(raw.rstrip())
    flush()


def _placeables(s):
    """Yields (start, end, inner) of top-level { ... } blocks."""
    depth = 0
    start = 0
    quoted = False
    i = 0
    while i < len(s):
        c = s[i]
        if quoted:
            if c == "\\":
                i += 1
            elif c == '"':
                quoted = False
        elif c == '"' and depth:
            quoted = True
        elif c == "{":
            if depth == 0:
                start = i
            depth += 1
        elif c == "}" and depth:
            depth -= 1
            if depth == 0:
                yield start, i + 1, s[start + 1:i]
        i += 1


def _default_variant(inner):
    """Text of the *[default] variant of a select expression."""
    m = re.search(r"\*\[[^\]]*\][ \t]*", inner)
    if not m:
        return ""
    rest = inner[m.end():]
    nxt = re.search(r"\n[ \t]*\*?\[", rest)
    return (rest[:nxt.start()] if nxt else rest).strip()


class Ftl:
    def __init__(self, cfg):
        self.cfg = cfg
        self._langs = None
        self.names = list(dict.fromkeys((cfg.locale, "en-US")))
        self._lock = threading.Lock()

    def _load(self):
        with self._lock:
            if self._langs is not None:
                return
            langs = []
            for lang in self.names:
                d = {}
                base = os.path.join(self.cfg.resources, "Locale", lang)
                for path in glob.glob(os.path.join(base, "**", "*.ftl"), recursive=True):
                    try:
                        with open(path, encoding="utf-8-sig") as f:
                            parse(f.read(), d)
                    except (OSError, UnicodeDecodeError):
                        pass
                langs.append(d)
            self._langs = langs

    def lang(self, name):
        """Raw entries of one language ({} if it is not loaded)."""
        self._load()
        return self._langs[self.names.index(name)] if name in self.names else {}

    def raw(self, key, lang=None):
        self._load()
        if lang is not None:
            v = self.lang(lang).get(key)
            if v is not None:
                return v
        for d in self._langs:
            if key in d:
                return d[key]
        return None

    def get(self, key, _depth=0, lang=None):
        """Resolved string of "key" or "key.attr" (lang if given, then locale, then en-US), None if missing."""
        v = self.raw(key, lang)
        if v is None or _depth > 8:
            return v
        return self.resolve(v, _depth, lang)

    def resolve(self, v, _depth=0, lang=None):
        out = []
        pos = 0
        for a, b, inner in _placeables(v):
            out.append(v[pos:a])
            pos = b
            t = inner.strip()
            m = STRING.match(t)
            if m:
                out.append(m.group(1).encode("latin-1", "backslashreplace").decode("unicode_escape")
                           if "\\" in m.group(1) else m.group(1))
            elif "->" in t:
                out.append(self.resolve(_default_variant(t), _depth + 1, lang))
            elif REF.match(t):
                ref = self.get(t, _depth + 1, lang)
                out.append(ref if ref is not None else "{ " + t + " }")
            else:
                out.append("{" + inner + "}")  # variables and functions stay as written
        out.append(v[pos:])
        return "".join(out)
