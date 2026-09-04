#!/usr/bin/env python3
"""Will/1 — a second, independent host of the Markdown text binding.

Written from WILL-1.md and VECTORS.json alone (Python 3.11, no dependencies). It implements the
two conformance functions the standard names:

    parse(doc: bytes) -> {"regions": [...], "faults": [...], "faulted": bool}
    evaluate(before: bytes, splices, path) -> {"outcome": "applied" | "refused" | "invalid", ...}

and speaks the adapter protocol the reference reader publishes for foreign implementations:
NDJSON fixtures on stdin (one vector per line, `expect` absent), `{id, kind, result}` NDJSON on
stdout — so the two hosts can be driven over the same fixtures and diffed.

    python3 will.py parse <file>|-
    python3 will.py evaluate <before>|- <splices.json> [--authoring]
    python3 will.py check <vectors.json>        # exact, key for key, against VECTORS.json
    python3 will.py --adapter                   # NDJSON in, NDJSON out

Coordinates are UTF-8 byte offsets, zero-based, half-open; lines and regions are zero-based.
"""
from __future__ import annotations

import base64
import json
import sys

LAWS = ("edit", "append", "keep")
INTENT_BOUND = 512  # Unicode scalar values, never bytes

OPENER_PREFIX = b"<!-- will/"
CLOSER_PREFIX = b"<!-- /will"
OPENER_UNSPACED = b"<!--will/"
CLOSER_UNSPACED = b"<!--/will"
CLOSER_EXACT = b"<!-- /will -->"


# ------------------------------------------------------------------------------------------------
# Strict UTF-8
# ------------------------------------------------------------------------------------------------

def _announced_length(lead: int) -> int:
    """The sequence length a lead byte announces by its high bits: 2 for C0..DF, 3 for E0..EF,
    4 for F0..F7; a byte that announces nothing (a stray continuation byte, F8..FF) is 1."""
    if 0xC0 <= lead <= 0xDF:
        return 2
    if 0xE0 <= lead <= 0xEF:
        return 3
    if 0xF0 <= lead <= 0xF7:
        return 4
    return 1


def _scalar_ok(seq: bytes) -> bool:
    """True iff `seq` is one well-formed UTF-8 sequence for a scalar value: no overlong form, no
    surrogate, nothing past U+10FFFF, every trailing byte a continuation byte."""
    n = len(seq)
    b = seq[0]
    if n == 1:
        return b < 0x80
    if any(not (0x80 <= c <= 0xBF) for c in seq[1:]):
        return False
    if n == 2:
        return 0xC2 <= b <= 0xDF
    if n == 3:
        if not (0xE0 <= b <= 0xEF):
            return False
        second = seq[1]
        if b == 0xE0 and second < 0xA0:
            return False  # overlong
        if b == 0xED and second > 0x9F:
            return False  # a surrogate
        return True
    if n == 4:
        if not (0xF0 <= b <= 0xF4):
            return False
        second = seq[1]
        if b == 0xF0 and second < 0x90:
            return False  # overlong
        if b == 0xF4 and second > 0x8F:
            return False  # past U+10FFFF
        return True
    return False


def first_invalid_utf8(data: bytes):
    """Return None when `data` is strict UTF-8, else the [start, end) byte span of the FIRST
    malformed sequence; reading stops there, as the standard says. The standard names the fault
    and its position but not the span's end; two hosts converged on this rule: the span is the
    length the lead byte announces, clipped to the end of the document; a sequence of that length
    whose trailing bytes are all continuation-shaped faults whole (an overlong form, a surrogate,
    a value past U+10FFFF); a sequence broken by a byte that is not a continuation byte faults on
    the lead byte alone."""
    i, n = 0, len(data)
    while i < n:
        b = data[i]
        if b < 0x80:
            i += 1
            continue
        length = _announced_length(b)
        if length == 1:
            return [i, i + 1]
        if i + length > n:
            return [i, n]
        seq = data[i:i + length]
        if _scalar_ok(seq):
            i += length
            continue
        if all(0x80 <= c <= 0xBF for c in seq[1:]):
            return [i, i + length]
        return [i, i + 1]
    return None


# ------------------------------------------------------------------------------------------------
# Lines
# ------------------------------------------------------------------------------------------------

def split_lines(data: bytes):
    """Yield (start, content_end, line_end) per line. LF and CRLF terminate a line; a lone CR is
    content. The final line may have no terminator, in which case content_end == line_end == len."""
    out = []
    start = 0
    n = len(data)
    i = 0
    while i < n:
        if data[i] == 0x0A:
            content_end = i
            if i > start and data[i - 1] == 0x0D:
                content_end = i - 1
            out.append((start, content_end, i + 1))
            start = i + 1
        i += 1
    if start < n:
        out.append((start, n, n))
    return out


# ------------------------------------------------------------------------------------------------
# Marker grammar — recognition is Will's own, at column zero, over exact bytes
# ------------------------------------------------------------------------------------------------

def classify_line(content: bytes):
    """Return one of:
         ("content",)
         ("opener", law, intent_or_None)
         ("closer",)
         ("fault", mode)
    for the bytes of one line (terminator excluded). Only column-zero lines inside the reserved
    namespace (`<!-- will/`, `<!-- /will`, and their unspaced near-misses) are ever markers or
    faults; everything else is content."""
    if content.startswith(OPENER_PREFIX):
        return classify_opener(content)
    if content.startswith(CLOSER_PREFIX):
        return ("closer",) if content == CLOSER_EXACT else ("fault", "malformed_marker")
    if content.startswith(OPENER_UNSPACED) or content.startswith(CLOSER_UNSPACED):
        return ("fault", "malformed_marker")
    return ("content",)


def _token(data: bytes, stop_at_colon: bool = False) -> bytes:
    """The maximal run of bytes that are not ASCII whitespace (and, for the law word, not the
    colon that introduces an intent)."""
    end = 0
    while end < len(data):
        ch = data[end]
        if ch in (0x20, 0x09, 0x0A, 0x0B, 0x0C, 0x0D) or (stop_at_colon and ch == 0x3A):
            break
        end += 1
    return data[:end]


def classify_opener(content: bytes):
    rest = content[len(OPENER_PREFIX):]
    # 1. The version token, then exactly one space. The version check runs first and stops the
    #    line (PARSE-FAULT-PRECEDENCE-VERSION); an empty token is an unknown version. The grammar's
    #    one separator is the ASCII space, so the version is everything up to the first space: a
    #    tab inside it makes an unknown version, the same reading as the reference host.
    version = rest.split(b" ", 1)[0]
    if version != b"1":
        return ("fault", "unknown_version")
    rest = rest[len(version):]
    if not rest.startswith(b" "):
        return ("fault", "malformed_marker")
    rest = rest[1:]
    # 2. The law word: a non-empty token. "An unknown law word" presupposes a word; a marker with
    #    no law word at all is malformed, not unknown.
    law = _token(rest, stop_at_colon=True)
    rest = rest[len(law):]
    # 3. The shape around the word: either ` -->` closes the marker at once, or `: ` introduces a
    #    verbatim intent that runs to the ` -->` at the very end of the line. A token that neither
    #    separator follows is no law word at all — the marker is malformed, whatever the token says.
    if rest == b" -->":
        intent_bytes = None
    elif rest.startswith(b": ") and rest[2:].endswith(b" -->"):
        intent_bytes = rest[2:-4]
    else:
        return ("fault", "malformed_marker")
    if len(law) == 0:
        return ("fault", "malformed_marker")
    if law not in (b"edit", b"append", b"keep"):
        return ("fault", "unknown_law")
    if intent_bytes is None:
        return ("opener", law.decode("ascii"), None)
    if len(intent_bytes) == 0 or b"--" in intent_bytes:
        return ("fault", "malformed_marker")
    intent = intent_bytes.decode("utf-8")  # the document already decoded strictly
    if len(intent) > INTENT_BOUND:
        return ("fault", "intent_over_bound")
    return ("opener", law.decode("ascii"), intent)


# ------------------------------------------------------------------------------------------------
# parse
# ------------------------------------------------------------------------------------------------

def parse(doc: bytes) -> dict:
    bad = first_invalid_utf8(doc)
    if bad is not None:
        return {"regions": [], "faults": [{"mode": "invalid_utf8", "line": None, "byteSpan": bad}],
                "faulted": True}
    regions = []
    faults = []
    pending = None  # (line_index, span, law, intent)
    for line_index, (start, content_end, line_end) in enumerate(split_lines(doc)):
        kind = classify_line(doc[start:content_end])
        span = [start, line_end]
        if kind[0] == "content":
            continue
        if kind[0] == "fault":
            faults.append({"mode": kind[1], "line": line_index, "byteSpan": span})
            continue
        if kind[0] == "opener":
            if pending is not None:
                # A second opener before the first pair's closer: the fault attaches to the second;
                # the first stays pending and pairs with the first real closer.
                faults.append({"mode": "unpaired_marker", "line": line_index, "byteSpan": span})
                continue
            pending = (line_index, span, kind[1], kind[2])
            continue
        # closer
        if pending is None:
            faults.append({"mode": "unpaired_marker", "line": line_index, "byteSpan": span})
            continue
        o_line, o_span, law, intent = pending
        regions.append({
            "index": len(regions),
            "law": law,
            "intent": intent,
            "opener": {"line": o_line, "byteSpan": o_span},
            "closer": {"line": line_index, "byteSpan": span},
            "governedSpan": [o_span[1], span[0]],
        })
        pending = None
    if pending is not None:
        o_line, o_span, _, _ = pending
        faults.append({"mode": "unpaired_marker", "line": o_line, "byteSpan": o_span})
    faults.sort(key=lambda f: f["byteSpan"][0])
    return {"regions": regions, "faults": faults, "faulted": len(faults) > 0}


# ------------------------------------------------------------------------------------------------
# evaluate
# ------------------------------------------------------------------------------------------------

def _invalid(rule):
    return {"outcome": "invalid", "reason": "precondition", "rule": rule}


def _refused(rule, **fields):
    out = {"outcome": "refused", "reason": "document_law", "rule": rule}
    out.update(fields)
    return out


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _offset(v):
    """An offset is a non-negative integer; a JSON number with an integral value counts (JSON
    does not distinguish 1 from 1.0), a boolean or a fraction does not."""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v if v >= 0 else None
    if isinstance(v, float) and v.is_integer() and v >= 0:
        return int(v)
    return None


def normalise_splices(splices, length):
    """Return (list_of_(start, end, insert_bytes)) or an `invalid` result. Each splice's shape and
    range are judged in the order given, then overlap among all of them — the shape of the question
    is judged before any law is consulted."""
    if not isinstance(splices, list):
        return _invalid("malformed_splice")
    out = []
    for s in splices:
        if not isinstance(s, dict):
            return _invalid("malformed_splice")
        start, end = _offset(s.get("start")), _offset(s.get("end"))
        if start is None or end is None or end < start:
            return _invalid("malformed_splice")
        if "insertBase64" in s:
            if not isinstance(s["insertBase64"], str):
                return _invalid("malformed_splice")
            try:
                insert = base64.b64decode(s["insertBase64"], validate=True)
            except (ValueError, TypeError):
                return _invalid("malformed_splice")
        elif "insert" in s:
            if not isinstance(s["insert"], str):
                return _invalid("malformed_splice")
            insert = s["insert"].encode("utf-8", "surrogatepass")
        else:
            return _invalid("malformed_splice")
        if end > length:
            return _invalid("out_of_range_splice")
        out.append((start, end, insert))
    ordered = sorted(out, key=lambda t: (t[0], t[1]))
    for a, b in zip(ordered, ordered[1:]):
        # Two splices overlap when they share a byte, or when they begin at the same offset (two
        # insertions at one point declare no order between themselves).
        if b[0] < a[1] or b[0] == a[0]:
            return _invalid("overlapping_splices")
    return (out, ordered)


def apply_splices(before: bytes, ordered):
    pieces = []
    cursor = 0
    for start, end, insert in ordered:
        pieces.append(before[cursor:start])
        pieces.append(insert)
        cursor = end
    pieces.append(before[cursor:])
    return b"".join(pieces)


def _touches(splice, span):
    """A non-empty splice touches a span when the two intervals intersect; a zero-width splice
    touches it only when it lands strictly inside (the byte immediately before a marker and the
    byte immediately after its terminator both stay reachable)."""
    start, end, _ = splice
    a, b = span
    if end > start:
        return start < b and end > a
    return a < start < b


def _strip_one_terminator(content: bytes) -> bytes:
    if content.endswith(b"\r\n"):
        return content[:-2]
    if content.endswith(b"\n"):
        return content[:-1]
    return content


def evaluate(before: bytes, splices, path="working") -> dict:
    # A question that names no path is asked of the working hand — the bound one; only a path
    # that names something else is an unknown path.
    if path is None:
        path = "working"
    if path not in ("working", "authoring"):
        return _invalid("unknown_path")
    normalised = normalise_splices(splices, len(before))
    if isinstance(normalised, dict):
        return normalised
    given, ordered = normalised
    if path == "authoring":
        return {"outcome": "applied"}
    if not ordered:
        return {"outcome": "applied"}

    parsed = parse(before)
    if parsed["faulted"]:
        return _refused("before_faulted", faults=parsed["faults"])

    # 1. The will itself is outside a working path's reach: any splice touching a marker's own
    #    span is refused, byte-identical rewrites and moves included. The act is judged whole: every
    #    region any splice touches is gathered, and the one refusal names the first of them in
    #    document order, never the caller's first splice.
    touched = None
    for splice in given:
        for region in parsed["regions"]:
            if _touches(splice, region["opener"]["byteSpan"]) or _touches(splice, region["closer"]["byteSpan"]):
                if touched is None or region["index"] < touched["index"]:
                    touched = region
    if touched is not None:
        return _refused("marker_span_touched", region=touched["index"], law=touched["law"])

    # 2. The result is judged too: it must still decode, and it must carry the same will.
    after = apply_splices(before, ordered)
    bad = first_invalid_utf8(after)
    if bad is not None:
        return _refused("result_faulted", faults=[{"mode": "invalid_utf8", "line": None, "byteSpan": bad}])
    reparsed = parse(after)
    if reparsed["faulted"]:
        return _refused("result_faulted", faults=reparsed["faults"])
    if not _same_will(parsed["regions"], reparsed["regions"]):
        return _refused("marker_sequence_mismatch")

    # 3. Every region a splice reaches satisfies its own law over its governed bytes.
    for region, new_region in zip(parsed["regions"], reparsed["regions"]):
        g0, g1 = region["governedSpan"]
        old = before[g0:g1]
        new = after[new_region["governedSpan"][0]:new_region["governedSpan"][1]]
        law = region["law"]
        if law == "keep":
            if old != new:
                return _refused("law_violated", region=region["index"], law=law)
        elif law == "append":
            if not _strip_one_terminator(new).startswith(_strip_one_terminator(old)):
                return _refused("law_violated", region=region["index"], law=law)
    return {"outcome": "applied"}


def _same_will(a, b):
    if len(a) != len(b):
        return False
    for x, y in zip(a, b):
        if x["law"] != y["law"] or x["intent"] != y["intent"]:
            return False
    return True


# ------------------------------------------------------------------------------------------------
# Fixtures, the adapter protocol, and `check`
# ------------------------------------------------------------------------------------------------

def _doc_bytes(fixture, text_key, b64_key):
    if b64_key in fixture and fixture[b64_key] is not None:
        return base64.b64decode(fixture[b64_key])
    value = fixture.get(text_key)
    if not isinstance(value, str):
        value = "" if value is None else str(value)
    return value.encode("utf-8", "surrogatepass")


def run_fixture(fixture: dict) -> dict:
    kind = fixture.get("kind")
    if kind == "parse":
        return parse(_doc_bytes(fixture, "doc", "docBase64"))
    if kind == "evaluate":
        return evaluate(_doc_bytes(fixture, "before", "beforeBase64"),
                        fixture.get("splices"), fixture.get("path"))
    raise ValueError("unknown fixture kind: %r" % (kind,))


def adapter(inp, out):
    for line in inp:
        line = line.strip()
        if not line:
            continue
        fixture = json.loads(line)
        result = run_fixture(fixture)
        out.write(json.dumps({"id": fixture.get("id"), "kind": fixture.get("kind"), "result": result},
                             ensure_ascii=False) + "\n")
        out.flush()


def check(vectors_path: str) -> int:
    spec = json.load(open(vectors_path, encoding="utf-8"))
    passed = failed = 0
    for vector in spec["vectors"]:
        got = run_fixture(vector)
        if got == vector["expect"]:
            passed += 1
        else:
            failed += 1
            print("FAIL %s (%s)\n  got    %s\n  expect %s" % (
                vector["id"], vector["kind"], json.dumps(got, ensure_ascii=False),
                json.dumps(vector["expect"], ensure_ascii=False)))
    print("%d pass / %d fail" % (passed, failed))
    return 0 if failed == 0 else 1


def _read(path: str) -> bytes:
    if path == "-":
        return sys.stdin.buffer.read()
    with open(path, "rb") as f:
        return f.read()


def main(argv) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    cmd = argv[0]
    if cmd == "--adapter":
        adapter(sys.stdin, sys.stdout)
        return 0
    if cmd == "parse" and len(argv) == 2:
        print(json.dumps(parse(_read(argv[1])), ensure_ascii=False))
        return 0
    if cmd == "evaluate" and len(argv) >= 3:
        before = _read(argv[1])
        splices = json.loads(_read(argv[2]).decode("utf-8"))
        path = "authoring" if "--authoring" in argv[3:] else "working"
        print(json.dumps(evaluate(before, splices, path), ensure_ascii=False))
        return 0
    if cmd == "check" and len(argv) == 2:
        return check(argv[1])
    print(__doc__.strip(), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
