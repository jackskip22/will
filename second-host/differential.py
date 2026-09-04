#!/usr/bin/env python3
"""Differential: this host against the reference reader over the same fixtures, through the
adapter protocol both publish (NDJSON in, {id, kind, result} NDJSON out).

    python3 second-host/differential.py [--seed N] [--count N] [--out disagreements.json]

Run from the repository root. Two fixture sets are driven through BOTH hosts and compared
exactly, object for object:
  1. the 92 normative vectors (also compared to each vector's own `expect`);
  2. generated fixtures — documents assembled from marker lines, near-misses, prose, both line
     terminators and multibyte text, with random splices (zero-width, marker-touching, in-region,
     out-of-range, overlapping) on both paths — where the spec's words, not the vectors, decide.
Every disagreement is printed with its fixture, grouped by a signature, so each can be judged: a
defect in this host, or a sentence of the standard that two careful readers read differently.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import random
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VECTORS = os.path.join(ROOT, "VECTORS.json")
REFERENCE = ["node", os.path.join(ROOT, "reference", "will.mjs"), "--adapter", VECTORS]
SECOND = [sys.executable, os.path.join(HERE, "will.py"), "--adapter"]


def run_host(cmd, fixtures):
    payload = "".join(json.dumps(f, ensure_ascii=False) + "\n" for f in fixtures)
    proc = subprocess.run(cmd, input=payload.encode("utf-8"), capture_output=True, timeout=600)
    if proc.returncode != 0:
        raise SystemExit("%s exited %d:\n%s" % (cmd[1], proc.returncode, proc.stderr.decode("utf-8", "replace")[:2000]))
    out = {}
    for line in proc.stdout.decode("utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            out[row["id"]] = row["result"]
    return out


# ------------------------------------------------------------------------------------------------
# Generated fixtures
# ------------------------------------------------------------------------------------------------

LINES = [
    "<!-- will/1 keep -->", "<!-- will/1 append -->", "<!-- will/1 edit -->",
    "<!-- will/1 keep: as counsel approved -->", "<!-- will/1 append: chronological entries only -->",
    "<!-- will/1 edit: keep the voice -->", "<!-- /will -->",
    "<!-- will/2 keep -->", "<!-- will/1 Keep -->", "<!-- will/1 keep:x -->", "<!-- will/1 keep: -->",
    "<!-- will/1 keep:  -->", "<!-- will/1 keep --> x", "<!-- will/1 keep -->  ", "<!--will/1 keep -->",
    "<!--/will -->", "<!-- /will extra -->", "<!-- /will-->", "<!-- will/1 keep: a -- b -->",
    "<!-- will/1 keep: x --> y -->", " <!-- will/1 keep -->", " <!-- /will -->", "<!-- willing -->",
    "<!-- willed keep -->", "<!-- xwill -->", "<!-- will/1 keep: 漢字 -->", "<!-- will/1  keep -->",
    "<!-- will/1 keep  -->", "<!-- will/1 keep: tone: voice -->", "<!-- will/1 append: x -->",
    "<!-- will/ keep -->", "<!-- will/1 -->", "<!-- will/1 kee -->", "<!-- will/10 keep -->",
    "Body.", "A", "", "- entry", "prose 漢字 😀 prose", "```", "  indented", "\t<!-- will/1 keep -->",
    "text <!-- will/1 keep -->", "<!-- /will --> ", "<!-- will/1 keep: x -->\r",
]
TERMINATORS = ["\n", "\n", "\n", "\r\n"]


def gen_doc(rng):
    n = rng.randint(0, 7)
    parts = []
    for _ in range(n):
        parts.append(rng.choice(LINES) + rng.choice(TERMINATORS))
    if rng.random() < 0.15 and parts:
        parts[-1] = parts[-1].rstrip("\r\n")  # a final line without a terminator
    return "".join(parts)


def gen_bytes_doc(rng):
    doc = gen_doc(rng).encode("utf-8")
    r = rng.random()
    if r < 0.05 and doc:
        k = rng.randrange(len(doc) + 1)
        doc = doc[:k] + bytes([rng.choice([0xFF, 0xC0, 0xED, 0xF5, 0xE0, 0x80])]) + doc[k:]
    elif r < 0.08 and doc:
        k = rng.randrange(len(doc) + 1)
        doc = doc[:k] + b"\xed\xa0\x80" + doc[k:]
    elif r < 0.10:
        doc = b"\xef\xbb\xbf" + doc
    return doc


def gen_splices(rng, length):
    n = rng.choice([0, 1, 1, 1, 2, 2, 3])
    splices = []
    for _ in range(n):
        r = rng.random()
        if length == 0 or r < 0.2:
            start = rng.randint(0, max(length, 0))
            end = start
        else:
            start = rng.randint(0, length)
            end = rng.randint(start, min(length, start + rng.choice([0, 1, 3, 8, 40, length])))
        if rng.random() < 0.04:
            end = min(length + rng.randint(1, 5), end + 7)  # out of range
        if rng.random() < 0.03:
            start, end = end + 1, start  # malformed
        insert = rng.choice(["", "X", "new line\n", "<!-- will/1 keep -->\n", "<!-- /will -->\n",
                             "- next entry\n", "漢字", "😀", "\r\n", "A\n", "/", "will/1"])
        s = {"start": start, "end": end}
        if rng.random() < 0.05:
            s["insertBase64"] = base64.b64encode(rng.choice([b"\xff", b"DQo=", b"", b"ok"])).decode()
        elif rng.random() < 0.03:
            s["insert"] = rng.choice([None, 0, False, {}, []])
        else:
            s["insert"] = insert
        splices.append(s)
    if rng.random() < 0.02:
        # Malformed ELEMENTS only. A non-array `splices` (null, a string, an object) is a separate
        # finding: the reference's adapter loader (`caseToSplices`) throws on it before evaluate()
        # is reached, which ends the whole adapter run — reported to the reference's stewards,
        # not generated here, so the differential can complete.
        splices = rng.choice([[None], [1], ["x"], [[]]])
    return splices


def generated_fixtures(seed, count):
    rng = random.Random(seed)
    out = []
    for i in range(count):
        doc = gen_bytes_doc(rng)
        kind = "parse" if rng.random() < 0.35 else "evaluate"
        fid = "GEN-%d-%s" % (i, kind[0])
        if kind == "parse":
            out.append({"id": fid, "kind": "parse", "docBase64": base64.b64encode(doc).decode()})
        else:
            path = rng.choice(["working", "working", "working", "authoring", "reviewing"])
            out.append({"id": fid, "kind": "evaluate", "beforeBase64": base64.b64encode(doc).decode(),
                        "splices": gen_splices(rng, len(doc)), "path": path})
    return out


def signature(fixture, a, b):
    """A short key that groups disagreements by their shape rather than their bytes."""
    def s(r):
        if not isinstance(r, dict):
            return str(type(r))
        if fixture["kind"] == "parse":
            return "faults=%s regions=%d" % ([f["mode"] for f in r.get("faults", [])], len(r.get("regions", [])))
        return "%s/%s/%s" % (r.get("outcome"), r.get("reason"), r.get("rule"))
    return "reference[%s] vs second[%s]" % (s(a), s(b))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--count", type=int, default=3000)
    ap.add_argument("--out", default=os.path.join(HERE, "disagreements.json"))
    args = ap.parse_args()

    spec = json.load(open(VECTORS, encoding="utf-8"))
    vectors = [{k: v for k, v in vec.items() if k != "expect"} for vec in spec["vectors"]]
    expect = {vec["id"]: vec["expect"] for vec in spec["vectors"]}
    fixtures = vectors + generated_fixtures(args.seed, args.count)
    by_id = {f["id"]: f for f in fixtures}

    ref = run_host(REFERENCE, fixtures)
    sec = run_host(SECOND, fixtures)

    # 1. The vectors, against expect, both hosts.
    ref_ok = sum(1 for v in vectors if ref.get(v["id"]) == expect[v["id"]])
    sec_ok = sum(1 for v in vectors if sec.get(v["id"]) == expect[v["id"]])
    print("vectors: reference %d/%d equal to expect; second host %d/%d equal to expect" % (
        ref_ok, len(vectors), sec_ok, len(vectors)))

    # 2. Every fixture, host against host, exact.
    groups = {}
    for f in fixtures:
        a, b = ref.get(f["id"]), sec.get(f["id"])
        if a != b:
            groups.setdefault(signature(f, a, b), []).append((f, a, b))
    total = sum(len(v) for v in groups.values())
    print("generated: %d fixtures; disagreements %d in %d shapes" % (len(fixtures) - len(vectors), total, len(groups)))
    report = []
    for sig, rows in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        f, a, b = rows[0]
        print("\n== %s  (%d)" % (sig, len(rows)))
        print("   fixture", json.dumps(f, ensure_ascii=False)[:400])
        print("   reference", json.dumps(a, ensure_ascii=False)[:300])
        print("   second   ", json.dumps(b, ensure_ascii=False)[:300])
        report.append({"signature": sig, "count": len(rows),
                       "examples": [{"fixture": r[0], "reference": r[1], "second": r[2]} for r in rows[:5]]})
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump({"seed": args.seed, "count": args.count, "disagreements": total, "shapes": report}, fh,
                  ensure_ascii=False, indent=1)
    print("\nwritten", args.out)
    return 0 if total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
