# The second host

`will.py` is a second, independent implementation of the Will/1 Markdown text binding: Python 3.11,
no dependencies, written from `WILL-1.md` and `VECTORS.json` alone. It exists because the standard
says it must — *"Experimental until a second independent implementation passes the shared
vectors"* — and a claim like that is earned only by a reader who never looked at the first one.

```
python3 second-host/will.py check VECTORS.json      # exact, key for key → 98 pass / 0 fail
python3 second-host/will.py parse <file>|-           # {"regions", "faults", "faulted"}
python3 second-host/will.py evaluate <before>|- <splices.json> [--authoring]
python3 second-host/will.py --adapter                # NDJSON fixtures in, {id, kind, result} out
python3 second-host/differential.py [--seed N] [--count N]
```

## The adapter protocol, and what was compared

The reference reader publishes `--adapter` for foreign implementations: one fixture per line on
stdin (a vector with its `expect` removed), one `{id, kind, result}` per line on stdout. `will.py
--adapter` speaks the same protocol, so the two hosts can be driven over identical fixtures and
diffed without either reading the other:

1. **The 98 normative vectors** — `will.py check` compares exactly, key for key (the reference's
   own standard for itself); through the adapter, every result was also compared as a **subset** of
   `expect` with the reference's exported `deepEqualSubset` (the leniency the reference grants a
   foreign host) and, object for object, against the reference's own adapter output. All three:
   98/98 at the eighth issue — 97/97 at the seventh, 96/96 at the sixth, 92/92 when this host was first written; the six vectors since are the three settled grammar readings (the bare version, the missing law word, the tab inside a version token), the non-list splices value, the first-named region at a two-marker touch, and the act judged whole.
2. **6,000 generated fixtures** (`differential.py`, seeds 1 and 2) — documents assembled from marker
   lines, near-misses, prose, both terminators and multibyte text, with random splices on every path.
   After the grammar edges below were settled: **0 disagreements**.
3. **Hand-written probes** (`probes.ndjson`, rendered in `PROBES.md`) at the exact places the vectors
   are silent: the byte span of an `invalid_utf8` fault over a lead × tail grid, the law and version
   tokens, precondition precedence, the authoring path over faulted input, which region a refusal
   names. The two disagreements that once stood (the grammar readings) were settled at the fifth issue by
   one sentence each and two vectors; rerun at the seventh issue: 317 of 317 agree, 0 disagree.

## What this author looked at, and where

`reference/will.mjs` was never opened. It was run as a black box: `--help` (the adapter's
description), `--adapter`, `check`, and its exported `deepEqualSubset` imported by a comparison
script. One stack trace escaped it when a generated fixture carried a non-array `splices` — it named
`caseToSplices` and `runAdapter` with two line numbers, which is the whole of what this author saw of
its internals (that crash is a finding of its own, in the report). The session lineage that wrote
this host also produced the canonical Will project on 2026-09-02; no bytes of the reference were in
its working context when this file was written, and the differential above, not a recollection, is
what shows the two readers agree.

## The grammar, as this host reads the standard

- A line is content unless, at column zero, it begins `<!-- will/` or `<!-- /will` (or their unspaced
  near-misses, which are always faults). Lines end at LF or CRLF; a lone CR is content; a marker's
  span is its whole line, terminator included; the governed span runs from after the opener's
  terminator to the closer's first byte.
- An opener is `<!-- will/1 <law> -->` or `<!-- will/1 <law>: <intent> -->` with the whole line
  consumed. Tokens are maximal runs of non-whitespace bytes (the law word also stops at a colon).
  Judged in this order: the version token (anything but `1` is `unknown_version` and stops the line);
  the shape around the law token (` -->` or `: … -->` must follow it, else `malformed_marker`); the
  law word (empty is `malformed_marker`; not one of the three is `unknown_law`); the intent (empty or
  containing `--` is `malformed_marker`; more than 512 scalar values is `intent_over_bound`).
- Pairing: a second opener before a closer faults on the second opener; a closer with nothing
  pending faults; an opener pending at the end faults; malformed lines take no part in pairing.
  Regions are reported even when the document is faulted (diagnostic disclosure).
- `evaluate`: the path first (`unknown_path`), then each splice's shape and range in the order
  given, then overlap (two splices sharing a byte, or two beginning at the same offset), then the
  authoring path applies without judgment; a working path refuses a faulted `before`, refuses any
  splice touching a marker's span (a zero-width splice strictly inside it counts; one at either
  edge does not), judges the result's decoding and the result's own faults, then the marker
  sequence, then each region's law over its governed bytes — `keep` byte-identical, `append` the
  old bytes an exact prefix of the new with the single terminator before the closer excluded from
  both sides.
