"""YAML loading/dumping that round-trips SS14 map files.

All scalars are loaded as strings (BaseLoader) so nothing is reinterpreted, and custom tags
(`!type:Foo`) become {"$tag": "!type:Foo", "$v": value}. The dumper writes the same block style
the engine produces (sequences not indented under their key).
"""
import json
import yaml

Loader = getattr(yaml, "CBaseLoader", yaml.BaseLoader)
TAG = "$tag"
VAL = "$v"


def _tagged(loader, suffix, node):
    if isinstance(node, yaml.MappingNode):
        v = loader.construct_mapping(node, deep=True)
    elif isinstance(node, yaml.SequenceNode):
        v = loader.construct_sequence(node, deep=True)
    else:
        v = loader.construct_scalar(node)
    return {TAG: node.tag, VAL: v}


yaml.add_multi_constructor("!", _tagged, Loader=Loader)


def load(text):
    return yaml.load(text, Loader=Loader)


def load_file(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        return load(f.read())


def is_tagged(v):
    return isinstance(v, dict) and TAG in v and VAL in v and len(v) == 2


_SPECIAL_START = set("!&*?|>%@`\"'#,[]{}")


def fmt_scalar(s):
    if s is None:
        return "null"
    if not isinstance(s, str):
        if isinstance(s, bool):
            return "True" if s else "False"
        s = str(s)
    if s == "":
        return '""'
    if "\n" in s or "\r" in s or "\t" in s or any(ord(c) < 32 for c in s):
        return json.dumps(s, ensure_ascii=False)
    need = (
        s[0] in _SPECIAL_START
        or s[0] == " " or s[-1] == " "
        or s == "-" or s.startswith("- ") or s.startswith(": ") or s == ":" or s.startswith("? ")
        or ": " in s or " #" in s or s.endswith(":")
        or s in ("~",) or s.startswith(("...", "---"))  # document markers
    )
    if not need:
        return s
    return "'" + s.replace("'", "''") + "'"


def fmt_key(k):
    return fmt_scalar(k if isinstance(k, str) else str(k))


class _FoldedDumper(yaml.SafeDumper):
    pass


_FoldedDumper.add_representer(str, lambda d, s: d.represent_scalar("tag:yaml.org,2002:str", s, style=">" if "\n" in s else None))


def folded(s, col):
    """Multi-line text as a folded block (">", ">-", ">2-"...) like the engine writes paper texts:
    [header, *lines] with the lines indented for a key at column `col`. None when the text can't be
    a block (tabs, trailing spaces, control characters) and has to stay a quoted string."""
    if any(c in s for c in "\r\x85  ﻿"):
        return None
    try:
        text = yaml.dump({"k": s}, Dumper=_FoldedDumper, allow_unicode=True, width=10 ** 9)
    except yaml.YAMLError:
        return None
    if not text.startswith("k: >"):
        return None  # PyYAML fell back to a quoted style
    try:
        if load(text) != {"k": s}:
            return None
    except yaml.YAMLError:
        return None
    lines = text[:-1].split("\n")
    if lines[-1] == "...":
        lines.pop()
    pad = " " * col
    return [lines[0][3:]] + [pad + ln if ln else "" for ln in lines[1:]]


def dump(obj, doc_end=False):
    out = []
    if isinstance(obj, dict):
        _emit_mapping(obj, 0, out)
    elif isinstance(obj, list):
        _emit_seq(obj, 0, out)
    else:
        out.append(fmt_scalar(obj))
    if doc_end:
        out.append("...")
    return "\n".join(out) + "\n"


def _emit_mapping(d, indent, out, first_prefix=None):
    pad = " " * indent
    first = True
    for k, v in d.items():
        lead = first_prefix if (first and first_prefix is not None) else pad
        first = False
        _emit_kv(lead + fmt_key(k) + ":", v, indent, out)


def _emit_kv(head, v, indent, out):
    if is_tagged(v):
        tag, inner = v[TAG], v[VAL]
        if isinstance(inner, dict):
            if not inner:
                out.append(f"{head} {tag} {{}}")
            else:
                out.append(f"{head} {tag}")
                _emit_mapping(inner, indent + 2, out)
        elif isinstance(inner, list):
            if not inner:
                out.append(f"{head} {tag} []")
            else:
                out.append(f"{head} {tag}")
                _emit_seq(inner, indent, out)
        elif inner in ("", None):
            out.append(f"{head} {tag}")
        else:
            out.append(f"{head} {tag} {fmt_scalar(inner)}")
    elif isinstance(v, dict):
        if not v:
            out.append(head + " {}")
        else:
            out.append(head)
            _emit_mapping(v, indent + 2, out)
    elif isinstance(v, list):
        if not v:
            out.append(head + " []")
        else:
            out.append(head)
            _emit_seq(v, indent, out)
    else:
        blk = folded(v, indent) if isinstance(v, str) and "\n" in v else None
        if blk:
            out.append(head + " " + blk[0])
            out.extend(blk[1:])
        else:
            out.append(head + " " + fmt_scalar(v))


def _emit_seq(lst, indent, out, first_prefix=None):
    pad = " " * indent
    for i, item in enumerate(lst):
        lead = first_prefix if (i == 0 and first_prefix is not None) else pad
        _emit_item(item, indent, lead, out)


def _emit_item(item, indent, lead, out):
    if is_tagged(item):
        tag, inner = item[TAG], item[VAL]
        if isinstance(inner, dict) and inner:
            out.append(f"{lead}- {tag}")
            _emit_mapping(inner, indent + 2, out)
        elif isinstance(inner, list) and inner:
            out.append(f"{lead}- {tag}")
            _emit_seq(inner, indent + 2, out)
        elif isinstance(inner, dict):
            out.append(f"{lead}- {tag} {{}}")
        elif isinstance(inner, list):
            out.append(f"{lead}- {tag} []")
        elif inner in ("", None):
            out.append(f"{lead}- {tag}")
        else:
            out.append(f"{lead}- {tag} {fmt_scalar(inner)}")
    elif isinstance(item, dict):
        if not item:
            out.append(lead + "- {}")
        else:
            _emit_mapping(item, indent + 2, out, first_prefix=lead + "- ")
    elif isinstance(item, list):
        if not item:
            out.append(lead + "- []")
        else:
            _emit_seq(item, indent + 2, out, first_prefix=lead + "- ")
    else:
        out.append(lead + "- " + fmt_scalar(item))
