# Will

Mark the text an agent may change. The marks stay in the file; a guard refuses edits that break them.

- `edit`: text may change. Unmarked text is editable.
- `append`: add only at the end; keep existing text in order.
- `keep`: leave the text unchanged.

Add this line to `AGENTS.md` or `CLAUDE.md`:

> Keep Will marks and `keep` text unchanged; add only at the end of `append`.

```text
 <!-- will/1 keep -->
 The approved sentence.
 <!-- /will -->
```

The example is indented so this README has no live mark. In Markdown, marks start at column zero.
Unreadable marks keep the whole file. Other text files use whole-line comments; DOCX, PDF, and Google Docs
have their own carriers. Marks guide an agent; the program applying an edit must enforce them.

## Check a change

```sh
node guard.mjs before.js after.js --file source.js
node guard.mjs before.js --splices edits.json --file source.js
```

The command returns JSON: `applied`, `refused`, or `invalid`. A refusal names the law, region, opener line,
rule, and how to recover. Lines count from 1; regions from 0. Exit codes are 0, 1, and 2 respectively.
The command checks the proposal and does not write either file. The host authorizes and applies the same
checked bytes. Use a trusted installation outside the agent's writable files.

An edit file is an array of `{start, end, insert}` splices against the unchanged original; offsets count UTF-8
bytes. `insertBase64` can supply exact bytes instead of `insert`. Empty deletion content must be explicit.
The CLI rejects invalid UTF-8 and preserves numeric spellings, so a fractional offset cannot round into permission.

```js
import {guard} from './guard.mjs';
const result = guard(beforeBytes, [{start: 6, end: 6, insert: ' More.'}], {file: 'notes.txt'});
```

`will.mjs` is the reference reader and evaluator: Node.js 22.23.4 or later, no dependencies.
`parse`, `evaluate`, `diffSplices`, and `compare` take strings or `Uint8Array` bytes. `evaluate` defaults to
`working` and never writes. Keep `will.d.mts` beside it. `exactJSON` preserves numeric lexemes for the evaluator;
its decoded values are still unvalidated input.

Snapshot comparison infers one allowed sequence of edits between unchanged marker lines. It cannot prove which
write actually happened: moving or replacing a pair can be indistinguishable from allowed edits around it.
Use `evaluate` or `guard` with the actual splices when the host witnesses them. An identical marker replacement
is refused on that path, even though identical before/after snapshots show no change.

## Check sealed text without an original

```sh
node will.mjs seal notes.md > sealed.md
node will.mjs verify sealed.md
```

`seal(bytes)` returns a copy with seals on unsealed `keep` and `append` regions. It is an **authoring** operation:
the host must authorize it. `verifySeals(bytes)` reports each region as `intact`, `changed`, or `unsealed`, with a
reason when it cannot verify it. Neither operation changes Will's laws or the result of `parse` or `evaluate`.

A seal is the final item in the opener's existing intent:

```text
 <!-- will/1 keep: Do not change this. [seal/1 sha256-128:2:2b054f4b13229641acc4cdb9fa46a4ea] -->
 A
 <!-- /will -->
```

The example is indented to quote it. Its governed bytes are `A` and LF. The suffix is
`[seal/1 sha256-128:<length>:<digest>]`: a canonical decimal byte length and 32 lowercase hexadecimal digits.
It follows the person's unchanged words with one space, or is the whole intent. The complete intent must still
fit Will/1's 512-scalar limit. Older readers see ordinary intent, with the same law and region.

The digest is the first 128 bits of SHA-256 over the UTF-8 header
`will/1 seal/1 sha256-128\0<law>\0<length>\0`, followed by the covered bytes. Here `\0` denotes one zero byte.
`keep` covers the complete governed interval. `append` covers the initial interval except its final LF, CRLF,
or CR; the stored length identifies that prefix after additions. Verification also excludes the current carrier
terminator so it cannot replace an old content newline. Nothing normalizes line endings, Unicode, spaces, or
Markdown. The opener, closer, surrounding text, and a later append tail are outside the fingerprint.

Seals detect accidental or careless text changes, **not authenticity**. An independent accidental match has
probability about 2^-128; this is not a collision-free guarantee. Someone who rewrites the seal can hide a change.
A document alone cannot reveal a removed seal or marker, or prove when, where, or by whom it was sealed.
Use witnessed edits or before/after comparison to enforce the law, including additions made after a seal.

`seal` preserves intact seals exactly; it never advances an append seal or repairs a changed one. It throws
before returning any bytes for faulty markers, unusable seals, mismatches, or intent overflow. A person who
intends a fresh seal must explicitly remove the old suffix. Verification leaves damaged or unsupported tags
`unsealed` with a reason; it never adds a Will grammar fault. The CLI exits 1 for changed text, faulty markers,
or a present unusable tag. Exit 0 can include regions with no seal; it means no mismatch was detected.

DOCX and PDF carry the same opener text in their existing native marker carrier. This seal proves only an exact
UTF-8 text stream, not Word structure, relationships, PDF geometry, or appearance. Verify it only when that exact
governed stream is recoverable. Conversion that changes the stream breaks the seal even if the words look the
same. A converter must disclose that loss, or verify the source and explicitly create a new target seal; it must
never silently repair the old fingerprint. Will's separate preserve-or-report-loss conversion rule still applies.

## Check sealed passages

Lists sealed passages across a file or tree, with their locations and whether their sealed bytes changed.

```sh
node approval.mjs notes.md
node approval.mjs path/to/project
```

Each JSON line names `file`, `region`, `line`, `law`, and `status` (`intact` or `changed`). Lines start at 1;
regions start at 0. Exit 0 means no changed or unreadable seal was found; 1 means changed text; 2 means an
incomplete report. Errors go to stderr. An empty report means no seals were found. An append seal covers
only its recorded prefix. Seals prove neither identity nor permission and cannot reveal removed seals without
an original inventory.

Tree scans visit regular UTF-8 files in path order and skip `.git`, binary files, and symbolic links.
A single-file request never silently skips its target. Markdown keeps its original binding.

## Publish without marks

```sh
node will.mjs strip private.md > public.md
```

`strip(bytes, options)` returns `{bytes, removed}`: a copy without recognized marker lines and their line
endings. Every other byte stays unchanged. `removed` counts marker lines. The command writes the copy to stdout
and the count to stderr; faulty input exits 1 without writing a partial copy. Strip is an authorized publishing
step: keep the marked source, and publish only the returned copy. It removes intent and seals with the marks.

The filename selects Markdown or text binding. For another binding, use `--binding markdown` or `--binding text`;
stdin defaults to Markdown. Code can pass `{binding: 'text'}`. A changed seal does not prevent an intentional strip;
unreadable marks do. The result carries no Will protection.

## Before an agent writes

The [Claude Code PreToolUse hook](https://code.claude.com/docs/en/hooks#pretooluse-input) accepts `Write` and `Edit`.
Keep `will.mjs`, `guard.mjs`, and `hook.mjs` together in a trusted directory. Add the `hooks` entry from
[`claude-hook.json`](claude-hook.json) to your settings and replace its script path. Use Claude Code v2.1.295 or later:
[`onFailure: "block"`](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails) also stops writes when
the hook cannot start or times out. Test an attempted change to a kept passage after installation.

`Edit` supplies the exact replacements, including `replace_all`; ambiguous matches are refused. `Write` compares
snapshots. A new file has no previous Will. The hook only vetoes a write; it never grants host permission and never
writes the file itself. Read failures and malformed requests are refused. Symbolic links use the target's binding.
Files with multiple hard links are refused because aliases can select different bindings. Preserve the canonical
file and have its author resolve the extra links before retrying.

This hook covers those two tools. Shell commands, other tools, and external programs do not pass through it. Keep
the hook and its settings outside the agent's writable scope. Serialize writes to each file and do not combine this
hook with one that rewrites the tool input: the check cannot lock the host's later write or see another hook's
replacement. A host that owns its write transaction should call `guard` immediately before committing the same
checked bytes. Other harnesses can use that API with their documented before-write interface.

## At commit and pull request

`node git-check.mjs staged` checks `HEAD` against an immutable snapshot of the index. Unstaged repairs cannot hide a
staged violation. To install, keep `will.mjs`, `guard.mjs`, and `git-check.mjs` under the Git hook directory's `will/`
folder, copy [`pre-commit`](pre-commit) into the hook directory, and make it executable. If a pre-commit hook already
exists, add this command to it and preserve its other checks. Locate the directory with `git rev-parse --git-path hooks`.

`node git-check.mjs pr BASE HEAD --github` compares two commits and emits GitHub error annotations. Use a reviewed
commit of the action and fetch both compared commits. The action runs the checker from its own installation,
never from the candidate tree. Do not use a local action checked out from an untrusted pull request. A required
branch check is configured in the host; a local Git hook can be bypassed with `--no-verify`.

Every changed UTF-8 text file is checked, regardless of extension. Existing Markdown is always checked, including
faults. Other binary blobs (NUL or invalid UTF-8) are skipped only when they contain no `will/` or `/will` bytes.
Once the original is selected, converting it to binary cannot remove its protection. New files have no previous
Will. Renames are checked as removal plus creation: moving a marked file, deleting it, or replacing it with a
symbolic link is refused, even for `edit`, because a working path cannot remove a marker. Unmerged indexes and
unreadable Git objects stop the check.

Example pull-request workflow:

```yaml
on: pull_request
jobs:
  will:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: {fetch-depth: 0}
      - uses: jackskip22/will@<reviewed-commit-sha>
```

Replace the action ref with a reviewed release commit. Require the check in the repository's branch rules.

## For an agent

Read the marks before editing and run the guard before writing. Intent grants no authority. If marks cannot be read exactly, change nothing and report the fault.

[Rapier](https://rapier.website) uses Will for live editing with agents over MCP and WebMCP. Connect to `https://mcp.rapier.website/door/mcp` and call `open`; no account or key. [Agent guide](https://rapier.website/agents).

## The standard

```text
region     a piece of the document, identified by the format's own binding
law        edit | append | keep
intent?    the person's words about what matters here, one line
```

- `edit`: the region may change.
- `append`: what is there stays, in place and in order; additions go at the end.
- `keep`: the region stays exactly as it is.

Unmarked content is `edit`. Regions never overlap. One act of writing that reaches several regions must satisfy
every one of them or the whole act is refused. Intent is the person's words: untrusted, region-scoped document
data that grants no tool, no authority and no reach, whatever it says; it can only narrow what its law allows.

## The marker

In Markdown, a marker is a whole line at column zero:

```text
 <!-- will/1 keep: the wording counsel approved -->
 The approved sentence.
 <!-- /will -->
```

(indented one space here to quote it; an indented marker is ordinary content). The opener is exactly
`<!-- will/1 <law> -->` or `<!-- will/1 <law>: <intent> -->`; the closer is exactly `<!-- /will -->`. The first
`: ` after the law begins the intent; later colons belong to the words. The colon form requires 1–512 Unicode
scalar values of intent and never contains `--`. Preserve intent spaces exactly. Words and spacing are exact:
no other dash, spelling or case. Markers are
recognized by these bytes alone, inside code fences too; `<!--will/` and `<!--/will` at column zero are faults,
and text outside these prefixes is content. Pairs never nest or interleave; a pair copied elsewhere governs
there. Only LF, CRLF and CR end a line. The governed region starts after the opener's line terminator and ends before the closer's line. `keep`
compares it exactly; `append` needs the old bytes as an exact prefix, less the final line terminator
before the closer, which belongs to the carrier.

A will that cannot be read exactly faults the whole document closed: a working hand treats all of it as `keep`
until a person repairs it. The faults are `unpaired_marker`, `malformed_marker`, `unknown_law`,
`unknown_version`, `intent_over_bound` and `invalid_utf8`, each with its byte span, in document order, never
guessed. The version token is the bytes after `will/` up to the first space, checked before delimiter grammar.
For UTF-8 faults, lead bits nominate a 2–4-byte sequence: span the remaining suffix if truncated, the lead byte
if a continuation is wrong, or the whole sequence if its scalar is invalid; other invalid leads span one byte.

Validate the whole document as strict UTF-8 before scanning markers. An invalid sequence returns one
`invalid_utf8` fault, at the first such sequence, and no regions. For marker lines, check the version, delimiter
and separator grammar, the law, then intent. The law token is nonempty and contains no colon or any of these
scalars: U+0009–000D, U+0020, U+00A0, U+1680, U+2000–200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
After the token, the remaining text before ` -->` is empty or starts with exactly `: `. Missing tokens or bad
separators are `malformed_marker`. Any other token than `edit`, `append` or `keep` is `unknown_law` before
inspecting intent, including empty intent. For a known law, empty intent or `--` is `malformed_marker`, then
more than 512 scalars is `intent_over_bound`. U+0085, U+2028 and U+2029 inside intent are data, not line endings.

Keep one pending valid opener. A second opener faults as `unpaired_marker` without replacing it. A valid closer
completes the pending pair, or faults if there is none. A malformed line never opens or closes a pair. Fault
any opener still pending at EOF. Keep completed regions even when other lines fault; sort faults by span start.

### Parse result

Parse returns `{faulted, faults, regions}`. `faulted` is true exactly when `faults` is nonempty. Byte spans are
zero-based, half-open `[start, end)` offsets into the original bytes; line and region indexes are zero-based.
Marker spans and marker-fault spans include the complete line and its terminator, if present.

| Value | Fields |
| --- | --- |
| Fault | `mode`, `line` (`null` for invalid UTF-8), `byteSpan` |
| Region | `index`, `law`, `intent` (`null` when absent), `opener`, `closer`, `governedSpan` |
| Opener or closer | `line`, `byteSpan` |

## Other text files

The `text` binding recognizes a whole line whose content is a Will opener or closer, with optional comment
punctuation and ASCII spaces or tabs around it. It needs no language parser. The forms are:

| Carrier | Opener | Closer |
| --- | --- | --- |
| Plain text | `will/1 keep` | `/will` |
| Hash | `# will/1 keep` | `# /will` |
| Slash | `// will/1 keep` | `// /will` |
| Dash | `-- will/1 keep` | `-- /will` |
| Semicolon | `; will/1 keep` | `; /will` |
| Percent | `% will/1 keep` | `% /will` |
| Block | `/* will/1 keep */` | `/* /will */` |
| HTML comment | `<!-- will/1 keep -->` | `<!-- /will -->` |

Use punctuation valid in the file's language; the reader does not make a comment legal in a format that forbids
comments. A block carrier must open and close on that one line. An unclosed marker-shaped block line faults.
Multi-line comments and strings do not change recognition: a supported whole-line mark inside either is still
live. Lines starting with `*`, quoted strings, and inline mentions are ordinary content. To quote a mark in text,
put prose or a backtick before it; indentation alone does not quote it. Pairs can use different carriers.

After removing the carrier and its outer horizontal padding, the same exact version, law, intent, and pairing
grammar applies. Padding is not intent. Marker byte spans include the original indentation, punctuation,
padding, and line terminator; a worker cannot rewrite any of them. The same UTF-8 faults and byte laws apply.
This explicit namespace makes an inline discussion of Will inert without guessing the file's syntax.

`.md` and `.markdown`, in any case, keep the Markdown binding above, including column zero and indentation as
quotation. APIs default to Markdown; pass `{binding: 'text'}` as the last argument for another text file.
`evaluate` keeps `working` or `authoring` as its third argument. `bindingForFile(path)` selects the binding.
The file commands select by the before-file's name; `--binding markdown` or `--binding text` overrides it.
Stdin defaults to Markdown. The text vectors and seals use the same reference reader, not a second parser.

## The host

A host declares which of its paths are the person's own (authoring) and which are a hand's (working). A working
path never writes a marker, moves one or writes one back unchanged. It judges each act by the exact bytes
replaced, against the source as it stood, and answers with one of three words: `applied`; `refused` with the
document-law reason; `invalid` when the question itself could not be read. Every range disclosure names the same four
facts: `law`, `region`, `intent` (when the range lies within one region) and `rule`. Will authenticates nobody
and grants nothing: the document carries the word, the host carries the path.

### Evaluate an act

Evaluate takes the before-document bytes, a list of splices `{start, end, insert}`, and `working` or `authoring`.
Each splice replaces `[start, end)` with explicit bytes, including an explicit empty value for deletion. Offsets
are nonnegative integers into the unchanged before-document, with `start <= end <= byteLength`. Validate input
before consulting document law: check the path, binding, list, then each supplied item's shape and range in input
order. Sort splices by source offset; refuse overlapping replacements or any two splices with the same start.
An insertion at a preceding replacement's end is allowed. Never derive narrower splices from the resulting text.

A valid authoring act and an empty splice list return `{outcome: "applied"}`. For any other working act, use
this order and stop at the first refusal:

| Check | `rule` on refusal | Additional fields |
| --- | --- | --- |
| Parse the before-document. | `before_faulted` | `faults` |
| Check replaced ranges against original marker spans. | `marker_span_touched` | `region`, `law` |
| Apply all splices and parse the result. | `result_faulted` | `faults` |
| Require the same ordered sequence of markers. | `marker_sequence_mismatch` | None |
| Compare corresponding governed regions. | `law_violated` | `region`, `law` |

A nonempty replacement touches a marker when their half-open spans intersect. An insertion touches a marker
only strictly inside its span; either endpoint is excluded. Allowed surrounding edits may shift markers'
positions. Each original marker `[a, b)` must remain the same marker at `[a + d, b + d)`, where `d` is the sum
of `insert.byteLength - (end - start)` for splices with `end <= a`. Compare these surviving marker bytes and
positions in order. Identical copies elsewhere cannot replace originals hidden by surrounding edits.
Name the first touched or violated region in document order, regardless of the caller's splice order.
For `keep`, compare the complete governed bytes. For `append`, remove
one final LF, CRLF or CR from each governed byte string, then require the old string as an exact prefix of the
new one. `edit` imposes no governed-byte comparison.

An applied decision contains only `outcome`. A refusal contains `outcome: "refused"`, `reason: "document_law"`,
`rule`, and only the additional fields in the table. Invalid input contains `outcome: "invalid"`,
`reason: "precondition"`, and one rule: `unknown_path`, `unknown_binding`, `malformed_splice`, `out_of_range_splice`, or
`overlapping_splices`. A malformed splice list, item, offset or missing/non-byte insertion is `malformed_splice`;
an end beyond the document is `out_of_range_splice`. Intent never changes these mechanical decisions.

## Other carriers

| Format | Carrier |
| --- | --- |
| DOCX | Each marker is one paragraph of a single hidden run with a hidden paragraph mark; the whole paragraphs between the pair are governed. |
| PDF | Each marker is one text object that draws no ink: text render mode 3, or text set in an embedded font whose glyphs enclose no area; on its own baseline between visible lines, with a lossless ToUnicode mapping. Reading order is by position (page, then y, then x), never the order of the stream. A reader takes the marker's ASCII frame and law from any text layer, and the intent exactly only where the layer keeps its scalars (ActualText honored). |
| Google Docs | The named exception: named ranges under a `will/1` naming convention; the importer strips a text carrier. |

Conversion that is aware of Will preserves it, says WILL LOST, or refuses; it never drops a marker silently.

## Conformance

`vectors.json` holds the normative machine truth: every parse and every evaluation, faults with their
byte spans included. `will.mjs` is the reference reader and evaluator, one file, no dependencies:

```sh
node will.mjs check vectors.json       # this reference against the vectors
node will.mjs --adapter < cases.ndjson # any implementation over the same cases
```

The optional `sealVectors`, `textVectors`, and `stripVectors` arrays test seals, other text bindings, and publishing
copies. The JavaScript `check` command and `checkVectors` run all four arrays. Markdown conformance hosts need only
the unchanged `vectors` array.

The independent Python and Go hosts cover the Markdown cases.
Run each host from this repository's root:

| Host | Requirements | Run Markdown vectors |
| --- | --- | --- |
| [Python](hosts/python/) | Python 3.11+ | `python3 hosts/python/will.py check vectors.json` |
| [Go](hosts/go/) | Go 1.22+ | `(cd hosts/go && go run ./cmd/will check ../../vectors.json)` |

The Python and Go hosts cover the original Markdown vectors. Both commands compare complete result objects, including omitted versus null fields, and exit nonzero on a
mismatch. The workflow runs the reference and both independent hosts on every push and pull request. It also
checks both real adapter processes against the vectors and the malformed-byte and request-recovery cases in
`hosts/adapter-vectors.json`.

### Adapters

Replace `check vectors.json` with `--adapter` to read one JSON request per input line and write one response
per output line, in order. A request uses the vector shape without `expect`: `kind: "parse"` with `doc` or
`docBase64`; or `kind: "evaluate"` with `before` or `beforeBase64`, `splices`, and `path`. Each splice uses
`insert` or `insertBase64`. Supply exactly one spelling for each byte field. Plain fields are Unicode scalar
strings encoded as UTF-8; Base64 fields use canonical, padded standard Base64 and can carry invalid UTF-8 bytes.
The response is `{kind, result}`, with the normalized parse or evaluation result. An optional scalar string `id`
is echoed as `id`; it never affects evaluation.
Numeric offsets retain their exact JSON value: integral decimal or exponent forms are integers, fractional
values are malformed, and integers beyond the document's byte length are out of range.

The JavaScript adapter accepts an optional `binding: "markdown" | "text"` on each request. It also accepts
`kind: "verify"`, `kind: "seal"`, or `kind: "strip"` with `doc` or `docBase64`. Verification returns its report.
Sealing returns `{docBase64}` or `{error, region?}`; stripping returns `{docBase64, removed}` or `{error}`.
Other Will/1 adapters need not implement these optional requests.

Blank lines, malformed JSON, an unknown kind, a nonstring `id`, a missing path or an invalid document byte
field returns `{"error":"invalid_request"}`.
Processing continues with the next line; the process exits nonzero if any request was unreadable. Invalid
splice inputs use the evaluation precondition decision. Neither adapter reads `expect` to produce a result.

Will/1 is final; the wire namespace is `will/1`. MIT.
