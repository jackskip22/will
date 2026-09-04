# Will/1 host (Go) — third independent reader

A Markdown text-binding host written from `WILL-1.md` and `VECTORS.json` alone.
No other Will implementation was opened while the 97 vectors were being made
to pass. After `check` reported `97 pass / 0 fail`, the reference adapter and
the second host were used as black boxes (stdin NDJSON in, `{id,kind,result}`
out) to exercise probes and generated fixtures.

## Build

Go 1.23, standard library only:

```
export PATH=/tmp/gotool/go/bin:$PATH
export GOROOT=/tmp/gotool/go
export GOPATH=/tmp/gopath
export GOCACHE=/tmp/gocache
export GOTOOLCHAIN=local
go build -o will-host will.go
```

The `artifacts/` tree is a fuse mount that drops the execute bit, so the
checked binary used during this job lived at `/tmp/will-host`. The copy in
this directory is the same bytes.

## CLI

```
will-host check VECTORS.json
    # prints `97 pass / 0 fail` and exits 0; non-zero on any failure
    # exact, key-for-key both directions

will-host parse <file>|-
    # {"faulted", "faults", "regions"}

will-host evaluate <file.md>|- <act.json> [--authoring]
    # act.json is {"path","splices"} or a bare splices array
    # (bare array defaults path to working; --authoring overrides)

will-host --adapter
    # NDJSON fixtures on stdin, {id, kind, result} NDJSON on stdout
```

`check` of `/tmp/will-spec-only/VECTORS.json`: **97 pass / 0 fail**.

## How it was built from the spec alone

1. Read `WILL-1.md` (641 lines) and every row of `VECTORS.json` (97 vectors).
2. Implemented recognition, pairing, UTF-8, splices, and the three outcome
   families in one Go file.
3. Iterated on `check` until it printed `97 pass / 0 fail` without consulting
   any other implementation.
4. After that freeze, drove `reference/will.mjs --adapter` and
   `second-host/will.py --adapter` as black boxes over the 97 vectors,
   `probes.ndjson` (317), and 6,000 generated fixtures (differential.py's
   generator, seeds 1 and 2).

Grammar as this host reads the standard (settled against the vectors; the
probes confirmed the edges the vectors do not name):

- A column-zero line beginning `<!-- will/` or `<!--will/` is an opener or a
  fault; `<!-- /will` or `<!--/will` is a closer or a fault. Unspaced forms
  are always `malformed_marker`. Off column zero is content.
- Lines end at LF or CRLF; a lone CR is content. A marker's `byteSpan` is
  the whole line including its terminator. The governed interval runs from
  immediately after the opener's terminator to the closer's first byte.
- Version is judged first: the token after `<!-- will/` that runs until the
  first ASCII space, or the rest of the line. Anything other than `1`
  (including the empty token in `<!-- will/ keep -->`) is `unknown_version`
  and stops the line.
- Then the comment must close at a `-->` that is the end of the line, and
  the law token must be followed by ` -->` or `: <intent> -->`. That *shape*
  is judged before the law word. A missing word is `malformed_marker`; a
  well-shaped word that is not `edit|append|keep` is `unknown_law`; empty
  intent or `--` inside intent is `malformed_marker`; more than 512 Unicode
  scalar values is `intent_over_bound`.
- Pairing: a second opener while one is pending faults on the second; a
  closer with nothing pending faults; a pending opener at EOF faults;
  malformed / unknown-version / unknown-law / over-bound lines take no part
  in pairing. Successfully paired regions are still disclosed when the
  document is faulted.
- `evaluate` preconditions, in order: unknown path; splices not a list;
  each splice's shape then range in array order; then overlap (including two
  inserts at the same offset). Missing or JSON-null `path` defaults to
  `working`; the empty string `""` is `unknown_path`. An authoring path then
  applies without document-law judgment.
- Working path: a faulted `before` with a non-empty transaction is
  `before_faulted`; a splice that overlaps a marker span (zero-width on the
  interior, not at either edge) is `marker_span_touched` and names the first
  touched region in document order; a result that itself faults is
  `result_faulted` with those faults; a clean result whose marker sequence
  is not the before sequence is `marker_sequence_mismatch`; then each
  region's law over governed bytes — `keep` byte-identical, `append` the old
  bytes excluding the single terminator before the closer as an exact prefix
  of the new, `edit` unrestricted.

## Adapter, differential, probes

The reference `--adapter` consumes NDJSON fixtures on stdin; it does **not**
spawn a foreign argv. This host speaks the same protocol.

| suite | result |
|---|---|
| 97 vectors, `check`, exact key-for-key | 97 / 0 |
| 97 vectors through `--adapter` vs reference, exact | 97 / 97, 0 disagreements |
| 97 vectors through `--adapter` vs `expect`, subset | 97 / 97 |
| `probes.ndjson` (317) vs reference and second-host | 317 / 317 all three agree |
| generated, seed 1, 3000 + 97 vectors vs both | 0 disagreements |
| generated, seed 2, 3000 vs reference | 3000 / 3000 agree |

Logs: `check.log`, `adapter.log`, `differential.log`, `probes.md`.

## Did you look at will.mjs / will.py? Where?

**No source of either.** Honestly:

- *Before* 97/0: only `/tmp/will-spec-only/WILL-1.md` and
  `/tmp/will-spec-only/VECTORS.json`.
- *After* 97/0, as the job permits:
  - `node reference/will.mjs --help` (adapter protocol description).
  - `reference/will.mjs --adapter` and `second-host/will.py --adapter` as
    black boxes over fixtures.
  - `second-host/differential.py` and `second-host/probes.ndjson` (explicitly
    allowed).
  - `second-host/README.md` for the published adapter CLI shape
    (`evaluate … [--authoring]`, `--adapter`). That file describes the
    second host's grammar reading; it was not used to write the first 97/0
    implementation. After 97/0, probe disagreements were resolved from the
    spec's words plus the probe *fixtures* (inputs and the two hosts'
    outputs), never by opening `will.py` or `will.mjs`.

I never opened `reference/will.mjs` or `second-host/will.py`.
