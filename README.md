# Will — the document's word to whatever agent comes next

A document is edited by two hands: the person holding it, and a software
agent working beside them. The agent is transient; the person's wishes
must travel **with the document**, or they govern nothing.

Will is a standard for exactly that. A person says, in their own
words, "keep this exactly as legal approved it," "only add to this log,"
"this section can evolve — don't lose its voice." Their editor writes it
invisibly into the document's own text layer, and from then on it reaches
whatever agent reads the file next — no registry, no sidecar, no account.

> Will is the person's word hidden in the document's own text: this
> region may be edited, only added to, or kept — plus whatever they want
> the next agent to know. Whoever receives the document's text receives
> the will with it.

Three words carried in the document itself — `edit`, `append`, `keep` —
plus one optional line of intent: the reason. A host judges every act it
performs against the shared vectors (`VECTORS.json`); an act that does
not match every vector's outcome is not a conformant host.

Tested on a real computer, against real software: in **Microsoft Word**,
hidden text survives ordinary editing, Save As, the clipboard, and cloud
storage transit (Document Inspector's "Remove All" is the removal path,
and it is total). In **Adobe Acrobat**, a marker written in text
rendering mode 3 survives Acrobat's own full rewrite on Save As,
Ghostscript's `pdfwrite`, and qpdf relinearisation (browser
print-to-PDF destroys it; Acrobat's own Sanitize tool is paywalled
behind Acrobat Pro). In **Google Docs**, the importer strips the
carrier: a Word document with every marker intact imports into Google
Docs and re-exports as DOCX with none — the one named exception, stated
as fact. Numbers and the acceptance battery: `WILL-1.md`'s DOCX and PDF
binding sections; `examples/README.md`.

## The whole standard in one screen

```text
region     a piece of this document, identified by the format's own binding
law        edit | append | keep
intent?    the person's words about what matters here — one line
```

A marker is an exact whole line at column zero:

```text
 <!-- will/1 keep: approved wording from counsel -->
 The approved sentence.
 <!-- /will -->
```

(indented here one space to quote it — an indented marker is content).
Unmarked content is `edit`. Regions never overlap. One act reaching
several regions is judged as the conjunction of every region's own law —
never a single "strictest law governs" verdict across the whole act.
Intent is **untrusted, region-scoped document data** — it grants no tool,
no authority, no reach, whatever it says. A hand working under a will
never rewrites it, never touches a marker's own bytes even to write them
back unchanged; the host declares which of its paths may (Will
authenticates nobody). What cannot be read exactly is never guessed: a
malformed will faults the whole document closed, and the disclosed
reason names the fault mode, byte span included.

Three laws for the host. Natural language for the model. Native carriage
for the document. Nothing else.

## Will's words, and the words that are not Will's

Will's outcome family is exactly three words — `applied`, `refused`
(with the document-law reason), `invalid` (the request could not be
read) — and its law fact is four names on every disclosure: `law`,
`region`, `intent` where the range lies within one region, and `rule`. A
host that implements Will from `VECTORS.json` alone must be able to
speak all of that, and no more.

Two neighbouring things speak similar words without being Will: a host's
own evidence law (admitting a change only against the exact bytes a hand
was shown, and naming its own outcomes — a moved target, a held
proposal — beside Will's, never as a synonym for one of Will's), and a
host's review posture (how it sequences an agent's writes against a
person's review). Both are the host's own contract. Path
classification — which of a host's paths are authoring and which are
working — is the host's entire security model; Will authenticates
nobody by design. The document carries the word; the host carries the
path and the evidence.

## In this repository

- **`WILL-1.md`** — the specification: the core, three text-layer
  bindings (Markdown — the reference binding; DOCX and PDF — locked),
  and one named exception (Google Docs — an API carrier, no text layer).
- **`VECTORS.json`** — normative machine truth: full outcomes, ordered
  faults with byte spans, region byte spans, for every case. Byte-
  sensitive inputs (invalid UTF-8, CRLF, exact offsets) travel as base64.
  **`VECTORS.md`** is its generated human projection — where the two
  disagree, the JSON governs.
- **`reference/will.mjs`** — the reference host: a zero-dependency
  byte-precise reader and pure evaluator, one file. `node
  reference/will.mjs check VECTORS.json` runs the whole suite.
- **`second-host/will.py`** — the second, independent host (Python,
  no dependencies), written from `WILL-1.md` and `VECTORS.json` alone:
  98/98 exact, and agrees with the reference on 6,000 generated
  documents.
- **`third-host/will.go`** — the third, independent host (Go, standard
  library only), written by a third party from the spec and vectors
  alone: 98/98 exact, 317/317 hand-written probes, 0 disagreements over
  6,000 generated fixtures.
- **`skill/SKILL.md`** — drop-in conduct guidance for any agent platform
  that reads skills.
- **`examples/`** — willed documents, one per file binding with a
  text-layer carrier, regenerated fresh with reproducible commands and
  sha256 hashes — see `examples/README.md`.
- **`.github/workflows/conformance.yml`** — CI: the vectors must pass,
  and a lint that fails if any Markdown file in this repository other
  than `examples/willed.md` carries a live Will region or fault, so a
  quoted example can never silently start governing this repository's
  own text.

## The adapter protocol

Any implementation, not only the reference one, can be run through the
same fixtures: `node reference/will.mjs --adapter` reads one JSON case
per line on stdin (the same shape as a `VECTORS.json` vector) and writes
one `{ id, kind, result }` line per case to stdout. An implementation in
any language that speaks this NDJSON shape over the same cases can be
diffed against the reference output or checked directly against
`VECTORS.json` — no shared runtime, no shared library, just the same
bytes in and the same normalized result out.

## Status

Will/1 is **final (2026-09-03)**; the wire namespace is `will/1`. The
corpus is 98 vectors, consumed whole and pinned by sha256; all three
hosts pass all 98.

What Will is not: access control, DRM, encryption, signing, provenance,
identity, a prompt, a policy language, or a registry. No widely adopted
convention lets ordinary documents carry a small, in-band, cross-format
edit law and natural-language intent for their own regions, readable by
the next agent with no infrastructure at all. That is the square Will
fills — and it is deliberately small enough to keep.

## License

This repository is MIT. Implementations retain their own licenses.
Copyright (c) 2026 Jack Skipworth.
