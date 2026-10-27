#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const LAWS = new Set(['edit', 'append', 'keep']);
const OPENER_PREFIX = '<!-- will/';
const CLOSER_PREFIX = '<!-- /will';
const CLOSER_EXACT = '<!-- /will -->';
const CLOSE_SUFFIX = ' -->';
const INTENT_MAX_SCALARS = 512;
const UNSPACED_OPENER_PREFIX = '<!--will/';
const UNSPACED_CLOSER_PREFIX = '<!--/will';

function splitLines(buf) {
  const lines = [];
  const n = buf.length;
  let lineStart = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0x0A || buf[i] === 0x0D) {
      const contentEnd = i;
      if (buf[i] === 0x0D && buf[i + 1] === 0x0A) i++;
      lines.push({ start: lineStart, contentEnd, lineEnd: i + 1 });
      lineStart = i + 1;
    }
  }
  if (lineStart < n || n === 0) {
    lines.push({ start: lineStart, contentEnd: n, lineEnd: n });
  }
  return lines;
}

function findInvalidUtf8(buf) {
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const b0 = buf[i];
    if (b0 <= 0x7f) { i += 1; continue; }
    let need, min, cp;
    if ((b0 & 0xe0) === 0xc0) { need = 1; min = 0x80; cp = b0 & 0x1f; }
    else if ((b0 & 0xf0) === 0xe0) { need = 2; min = 0x800; cp = b0 & 0x0f; }
    else if ((b0 & 0xf8) === 0xf0) { need = 3; min = 0x10000; cp = b0 & 0x07; }
    else return { offset: i, length: 1 };
    if (i + need >= n) return { offset: i, length: n - i };
    let ok = true;
    for (let k = 1; k <= need; k++) {
      const bk = buf[i + k];
      if ((bk & 0xc0) !== 0x80) { ok = false; break; }
      cp = (cp << 6) | (bk & 0x3f);
    }
    if (!ok) return { offset: i, length: 1 };
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      return { offset: i, length: need + 1 };
    }
    i += need + 1;
  }
  return null;
}

function scalarCount(s) { return [...s].length; }

export function parse(bytesInput) {
  const buf = Buffer.isBuffer(bytesInput) ? bytesInput : Buffer.from(bytesInput);

  const bad = findInvalidUtf8(buf);
  if (bad) {
    return {
      regions: [],
      faults: [{ mode: 'invalid_utf8', line: null, byteSpan: [bad.offset, bad.offset + bad.length] }],
      faulted: true,
    };
  }

  const rawLines = splitLines(buf);
  const faults = [];
  const regions = [];
  let open = null;

  for (let idx = 0; idx < rawLines.length; idx++) {
    const { start, contentEnd, lineEnd } = rawLines[idx];
    const lineSpan = [start, lineEnd];
    const text = buf.slice(start, contentEnd).toString('utf8');

    if (text.startsWith(CLOSER_PREFIX)) {
      if (text !== CLOSER_EXACT) {
        faults.push({ mode: 'malformed_marker', line: idx, byteSpan: lineSpan });
        continue;
      }
      if (!open) {
        faults.push({ mode: 'unpaired_marker', line: idx, byteSpan: lineSpan });
        continue;
      }
      regions.push({
        index: regions.length,
        law: open.law,
        intent: open.intent,
        opener: { line: open.line, byteSpan: open.span },
        closer: { line: idx, byteSpan: lineSpan },
        governedSpan: [open.span[1], start],
      });
      open = null;
      continue;
    }

    if (!text.startsWith(OPENER_PREFIX)) {
      if (text.startsWith(UNSPACED_OPENER_PREFIX) || text.startsWith(UNSPACED_CLOSER_PREFIX)) {
        faults.push({ mode: 'malformed_marker', line: idx, byteSpan: lineSpan });
      }
      continue;
    }

    const afterPrefix = text.slice(OPENER_PREFIX.length);
    const versionGap = afterPrefix.indexOf(' ');
    const version = versionGap === -1 ? afterPrefix : afterPrefix.slice(0, versionGap);
    if (version !== '1') {
      faults.push({ mode: 'unknown_version', line: idx, byteSpan: lineSpan });
      continue;
    }
    if (!text.endsWith(CLOSE_SUFFIX)) {
      faults.push({ mode: 'malformed_marker', line: idx, byteSpan: lineSpan });
      continue;
    }
    const middle = text.slice(OPENER_PREFIX.length, text.length - CLOSE_SUFFIX.length);
    const sp = middle.indexOf(' ');
    if (sp === -1) {
      faults.push({ mode: 'malformed_marker', line: idx, byteSpan: lineSpan });
      continue;
    }
    const rest = middle.slice(sp + 1);
    const lawWord = (/^[^:\s]*/.exec(rest))[0];
    if (!lawWord) {
      faults.push({ mode: 'malformed_marker', line: idx, byteSpan: lineSpan });
      continue;
    }
    let intent;
    if (rest === lawWord) {
      intent = undefined;
    } else if (rest.startsWith(lawWord + ': ')) {
      intent = rest.slice(lawWord.length + 2);
    } else {
      faults.push({ mode: 'malformed_marker', line: idx, byteSpan: lineSpan });
      continue;
    }
    if (!LAWS.has(lawWord)) {
      faults.push({ mode: 'unknown_law', line: idx, byteSpan: lineSpan });
      continue;
    }
    if (intent !== undefined) {
      if (intent.length === 0) {
        faults.push({ mode: 'malformed_marker', line: idx, byteSpan: lineSpan });
        continue;
      }
      if (intent.includes('--')) {
        faults.push({ mode: 'malformed_marker', line: idx, byteSpan: lineSpan });
        continue;
      }
      if (scalarCount(intent) > INTENT_MAX_SCALARS) {
        faults.push({ mode: 'intent_over_bound', line: idx, byteSpan: lineSpan });
        continue;
      }
    }
    if (open) {
      faults.push({ mode: 'unpaired_marker', line: idx, byteSpan: lineSpan });
      continue;
    }
    open = { law: lawWord, intent: intent ?? null, line: idx, span: lineSpan };
  }
  if (open) faults.push({ mode: 'unpaired_marker', line: open.line, byteSpan: open.span });

  faults.sort((a, b) => a.byteSpan[0] - b.byteSpan[0]);

  return { regions, faults, faulted: faults.length > 0 };
}

function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && aEnd > bStart; }

function isValidBase64(s) {
  return typeof s === 'string' && Buffer.from(s, 'base64').toString('base64') === s;
}

function spliceInsertOk(s) {
  if ((s.insert === undefined) === (s.insertBase64 === undefined)) return false;
  if (s.insertBase64 !== undefined) return isValidBase64(s.insertBase64);
  return typeof s.insert === 'string' ? s.insert.isWellFormed() : Buffer.isBuffer(s.insert);
}

class JSONNumber { constructor(source) { this.source = source; } }
function offsetKey(value) {
  const source = value instanceof JSONNumber ? value.source : Number.isInteger(value) ? BigInt(value).toString() : null;
  if (source === null) return null;
  const [, sign, whole, fraction = '', exponent = '0'] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  const digits = (whole + fraction).replace(/^0+/, ''), significant = digits.replace(/0+$/, '');
  if (!digits) return [0n, ''];
  const width = BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length);
  return sign || width < BigInt(significant.length) ? null : [width, significant];
}
const compareOffsets = (a, b) => a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
const offsetNumber = ([width, significant]) => Number(significant.padEnd(Number(width), '0') || 0);

function normalizeSplice(s) {
  const insert = s.insertBase64 !== undefined
    ? Buffer.from(s.insertBase64, 'base64')
    : (Buffer.isBuffer(s.insert) ? s.insert : Buffer.from(s.insert, 'utf8'));
  return { start: offsetNumber(offsetKey(s.start)), end: offsetNumber(offsetKey(s.end)), insert };
}

function validateSplices(buf, splices) {
  if (!Array.isArray(splices)) {
    return { ok: false, rule: 'malformed_splice' };
  }
  const limit = offsetKey(buf.length);
  for (const s of splices) {
    if (s === null || s === undefined) {
      return { ok: false, rule: 'malformed_splice' };
    }
    const start = offsetKey(s.start), end = offsetKey(s.end);
    if (!start || !end || compareOffsets(start, end) > 0 || !spliceInsertOk(s)) {
      return { ok: false, rule: 'malformed_splice' };
    }
    if (compareOffsets(end, limit) > 0) {
      return { ok: false, rule: 'out_of_range_splice' };
    }
  }
  const normalized = splices.map(normalizeSplice);
  const sorted = [...normalized].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let prevStart = -1;
  for (const s of sorted) {
    if (s.start === prevStart) return { ok: false, rule: 'overlapping_splices' };
    if (s.start < cursor) return { ok: false, rule: 'overlapping_splices' };
    cursor = s.end;
    prevStart = s.start;
  }
  return { ok: true, splices: normalized };
}

function applySplices(buf, splices) {
  const sorted = [...splices].sort((a, b) => a.start - b.start);
  const parts = [];
  let cursor = 0;
  for (const s of sorted) {
    parts.push(buf.slice(cursor, s.start));
    parts.push(s.insert);
    cursor = s.end;
  }
  parts.push(buf.slice(cursor));
  return Buffer.concat(parts);
}

function markersSurvive(beforeBytes, afterBytes, before, after, splices) {
  if (before.length !== after.length) return false;
  const sorted = [...splices].sort((a, b) => a.start - b.start);
  let next = 0, shift = 0;
  for (let index = 0; index < before.length; index++) {
    for (const kind of ['opener', 'closer']) {
      const from = before[index][kind].byteSpan, to = after[index][kind].byteSpan;
      while (next < sorted.length && sorted[next].end <= from[0]) {
        const splice = sorted[next++];
        shift += splice.insert.length - (splice.end - splice.start);
      }
      if (to[0] !== from[0] + shift || to[1] !== from[1] + shift ||
          !beforeBytes.subarray(from[0], from[1]).equals(afterBytes.subarray(to[0], to[1]))) return false;
    }
  }
  return true;
}

function stripOneTrailingTerminator(buf) {
  const n = buf.length;
  if (n === 0) return buf;
  if (buf[n - 1] === 0x0a) {
    if (n >= 2 && buf[n - 2] === 0x0d) return buf.slice(0, n - 2);
    return buf.slice(0, n - 1);
  }
  if (buf[n - 1] === 0x0d) return buf.slice(0, n - 1);
  return buf;
}

export function evaluate(beforeBytesInput, spliceInputs, path = 'working') {
  const beforeBytes = Buffer.isBuffer(beforeBytesInput) ? beforeBytesInput : Buffer.from(beforeBytesInput);
  const rawSplices = spliceInputs;

  if (path !== 'authoring' && path !== 'working') {
    return { outcome: 'invalid', reason: 'precondition', rule: 'unknown_path' };
  }

  const shape = validateSplices(beforeBytes, rawSplices);
  if (!shape.ok) {
    return { outcome: 'invalid', reason: 'precondition', rule: shape.rule };
  }
  const splices = shape.splices;

  if (path === 'authoring') return { outcome: 'applied' };

  const b = parse(beforeBytes);
  if (b.faulted) {
    if (splices.length === 0) return { outcome: 'applied' };
    return { outcome: 'refused', reason: 'document_law', rule: 'before_faulted', faults: b.faults };
  }

  let touched = null;
  for (const s of splices) {
    for (const r of b.regions) {
      if (overlaps(s.start, s.end, r.opener.byteSpan[0], r.opener.byteSpan[1])
        || overlaps(s.start, s.end, r.closer.byteSpan[0], r.closer.byteSpan[1])) {
        if (touched === null || r.index < touched.index) touched = r;
      }
    }
  }
  if (touched !== null) {
    return { outcome: 'refused', reason: 'document_law', rule: 'marker_span_touched', region: touched.index, law: touched.law };
  }

  const afterBytes = applySplices(beforeBytes, splices);
  const a = parse(afterBytes);
  if (a.faulted) {
    return { outcome: 'refused', reason: 'document_law', rule: 'result_faulted', faults: a.faults };
  }

  if (!markersSurvive(beforeBytes, afterBytes, b.regions, a.regions, splices)) {
    return { outcome: 'refused', reason: 'document_law', rule: 'marker_sequence_mismatch' };
  }

  for (let k = 0; k < b.regions.length; k++) {
    const rb = b.regions[k], ra = a.regions[k];
    const govB = beforeBytes.slice(rb.governedSpan[0], rb.governedSpan[1]);
    const govA = afterBytes.slice(ra.governedSpan[0], ra.governedSpan[1]);
    if (rb.law === 'keep') {
      if (Buffer.compare(govB, govA) !== 0) {
        return { outcome: 'refused', reason: 'document_law', rule: 'law_violated', region: k, law: 'keep' };
      }
    } else if (rb.law === 'append') {
      const core = stripOneTrailingTerminator(govB);
      const candidate = stripOneTrailingTerminator(govA);
      const isPrefix = candidate.length >= core.length && Buffer.compare(core, candidate.slice(0, core.length)) === 0;
      if (!isPrefix) {
        return { outcome: 'refused', reason: 'document_law', rule: 'law_violated', region: k, law: 'append' };
      }
    }
  }

  return { outcome: 'applied' };
}

function lineSpans(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a || (buf[i] === 0x0d && buf[i + 1] !== 0x0a)) { out.push([start, i + 1]); start = i + 1; }
  }
  if (start < buf.length) out.push([start, buf.length]);
  return out;
}
const LCS_CELLS = 16e6;
export function diffSplices(beforeInput, afterInput) {
  const before = Buffer.from(beforeInput), after = Buffer.from(afterInput);
  const bl = lineSpans(before), al = lineSpans(after);
  const key = (buf, [s, e]) => buf.toString('latin1', s, e);
  const bk = bl.map(span => key(before, span)), ak = al.map(span => key(after, span));
  let head = 0;
  while (head < bk.length && head < ak.length && bk[head] === ak[head]) head++;
  let tail = 0;
  while (tail < bk.length - head && tail < ak.length - head && bk[bk.length - 1 - tail] === ak[ak.length - 1 - tail]) tail++;
  const n = bk.length - head - tail, m = ak.length - head - tail;
  const pairs = [];
  if (n && m && n * m <= LCS_CELLS) {
    const w = m + 1, table = new Uint32Array((n + 1) * w);
    const weight = line => line.startsWith(OPENER_PREFIX) || line.startsWith(CLOSER_PREFIX) ? w : 1;
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] = bk[head + i] === ak[head + j] ? table[(i + 1) * w + j + 1] + weight(bk[head + i]) : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
    for (let i = 0, j = 0; i < n && j < m;) {
      if (bk[head + i] === ak[head + j]) { pairs.push([head + i, head + j]); i++; j++; }
      else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i++;
      else j++;
    }
  }
  pairs.push([bk.length - tail, ak.length - tail]);
  const splices = [];
  const offset = (spans, i, size) => i < spans.length ? spans[i][0] : size;
  let bi = head, ai = head;
  for (const [pb, pa] of pairs) {
    if (pb > bi || pa > ai) {
      const start = offset(bl, bi, before.length), end = offset(bl, pb, before.length);
      const inserted = after.subarray(offset(al, ai, after.length), offset(al, pa, after.length));
      splices.push({start, end, insertBase64: inserted.toString('base64')});
    }
    bi = pb + 1; ai = pa + 1;
  }
  return splices;
}
export function compare(beforeInput, afterInput) {
  return evaluate(beforeInput, diffSplices(beforeInput, afterInput));
}

function pullRequest(base) {
  const git = (...args) => execFileSync('git', args, { maxBuffer: 1 << 30 });
  const listed = git('diff', '--name-status', '-z', '-M', base, 'HEAD', '--', '*.md', '*.markdown').toString('utf8').split('\0');
  let refused = 0;
  const say = (file, line, words) => { refused++; process.stdout.write('::error file=' + file + (line ? ',line=' + line : '') + '::' + words + '\n'); };
  for (let i = 0; i < listed.length - 1;) {
    const status = listed[i++], from = listed[i++], to = status[0] === 'R' || status[0] === 'C' ? listed[i++] : from;
    if (status[0] === 'A' || status[0] === 'C') continue;
    const before = git('show', base + ':' + from);
    if (status[0] === 'D') {
      const parsed = parse(before);
      if (parsed.faulted || parsed.regions.some(r => r.law !== 'edit')) say(from, 0, 'this file kept or appended regions and was removed');
      continue;
    }
    const verdict = compare(before, git('show', 'HEAD:' + to));
    if (verdict.outcome === 'applied') continue;
    const region = Number.isInteger(verdict.region) ? parse(before).regions[verdict.region] : null;
    const words = verdict.rule === 'law_violated' ? (verdict.law === 'keep' ? 'a region marked keep was changed' : 'a region marked append was changed other than at its end')
      : verdict.rule === 'before_faulted' ? 'the base version\'s markers cannot be read exactly, so the whole file is keep'
      : 'the will markers were changed (' + verdict.rule + ')';
    say(to, region ? region.opener.line + 1 : 0, words);
  }
  if (!refused) process.stdout.write('will: every changed Markdown file keeps its will\n');
  return refused ? 1 : 0;
}


function requestBytes(v, name) {
  const plain = Object.hasOwn(v, name), encoded = Object.hasOwn(v, name + 'Base64');
  if (plain === encoded) throw new Error('supply exactly one of ' + name + ' and ' + name + 'Base64');
  if (plain && typeof v[name] === 'string' && v[name].isWellFormed()) return Buffer.from(v[name], 'utf8');
  if (encoded && isValidBase64(v[name + 'Base64'])) return Buffer.from(v[name + 'Base64'], 'base64');
  throw new Error(name + ' is not a scalar string or canonical Base64');
}
function runRequest(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('request must be an object');
  if (Object.hasOwn(v, 'id') && !(typeof v.id === 'string' && v.id.isWellFormed())) throw new Error('id must be a scalar string');
  if (v.kind === 'parse') return parse(requestBytes(v, 'doc'));
  if (v.kind !== 'evaluate') throw new Error('kind must be parse or evaluate');
  const before = requestBytes(v, 'before');
  if (!Object.hasOwn(v, 'path')) throw new Error('path is required');
  return evaluate(before, v.splices, v.path);
}
const exactJSON = text => JSON.parse(text, (key, value, context) =>
  typeof value === 'number' && !/^-?\d{1,15}$/.test(context.source) ? new JSONNumber(context.source) : value);

function deepEqualStrict(got, want) {
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) return false;
    return want.every((w, i) => deepEqualStrict(got[i], w));
  }
  if (want !== null && typeof want === 'object') {
    if (got === null || typeof got !== 'object' || Array.isArray(got)) return false;
    const wantKeys = Object.keys(want);
    const gotKeys = Object.keys(got);
    if (wantKeys.length !== gotKeys.length) return false;
    return wantKeys.every((k) => Object.prototype.hasOwnProperty.call(got, k) && deepEqualStrict(got[k], want[k]));
  }
  return got === want;
}

function checkCase(v) {
  let got;
  try { got = runRequest(v); } catch (error) { got = 'unreadable request: ' + error.message; }
  return { ok: deepEqualStrict(got, v.expect), got };
}

function runCheck(vectorsPath) {
  const spec = exactJSON(readFileSync(vectorsPath, 'utf8'));
  let pass = 0, fail = 0;
  const failures = [];
  for (const v of spec.vectors) {
    const result = checkCase(v);
    if (result.ok) pass++;
    else { fail++; failures.push(`FAIL ${v.id}: got ${JSON.stringify(result.got)}`); }
  }

  for (const f of failures) console.error(f);
  console.log(`${pass} pass / ${fail} fail (fully judgeable: no unverified column)`);
  return fail === 0 ? 0 : 1;
}

export function checkVectors(spec) {
  if (typeof spec === 'string') spec = exactJSON(spec);
  const failures = [];
  for (const v of spec.vectors) {
    const result = checkCase(v);
    if (!result.ok) failures.push({id: v.id, got: result.got});
  }
  return {total: spec.vectors.length, failures};
}

async function runAdapter() {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let failed = false, pending = Buffer.alloc(0);
  const answer = (line) => {
    let response;
    try {
      const v = exactJSON(decoder.decode(line));
      response = { kind: v.kind, result: runRequest(v), ...(Object.hasOwn(v, 'id') ? { id: v.id } : {}) };
    } catch {
      failed = true;
      response = { error: 'invalid_request' };
    }
    process.stdout.write(JSON.stringify(response) + '\n');
  };
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]);
    for (let end; (end = pending.indexOf(0x0a)) >= 0; pending = pending.subarray(end + 1)) answer(pending.subarray(0, end));
  }
  if (pending.length) answer(pending);
  process.exitCode = failed ? 1 : 0;
}

function readBytesArg(pathArg) {
  return pathArg === '-' ? readFileSync(0) : readFileSync(pathArg);
}

const argv = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (argv[0] === 'parse' && argv[1]) {
    console.log(JSON.stringify(parse(readBytesArg(argv[1])), null, 2));
  } else if (argv[0] === 'evaluate' && argv[1] && argv[2]) {
    const path = argv.includes('--authoring') ? 'authoring' : 'working';
    const before = readBytesArg(argv[1]);
    const splices = exactJSON(readFileSync(argv[2], 'utf8'));
    console.log(JSON.stringify(evaluate(before, splices, path), null, 2));
  } else if (argv[0] === 'check' && argv[1]) {
    process.exit(runCheck(argv[1]));
  } else if (argv[0] === 'compare' && argv[1] && argv[2]) {
    const verdict = compare(readBytesArg(argv[1]), readBytesArg(argv[2]));
    console.log(JSON.stringify(verdict, null, 2));
    process.exit(verdict.outcome === 'applied' ? 0 : 1);
  } else if (argv[0] === 'pr' && argv[1]) {
    process.exit(pullRequest(argv[1]));
  } else if (argv[0] === '--adapter') {
    await runAdapter();
  } else {
    console.error(
      'usage: will.mjs parse <file>|- | evaluate <before>|- <splices.json> [--authoring] | ' +
      'check <vectors.json> | compare <before> <after> | pr <base-commit> | --adapter\n' +
      '  "-" reads fd 0 (stdin) portably.\n' +
      '  check compares this reference implementation against vectors.json exactly, key for ' +
      'key — a stray field is a failure, never ignored.\n' +
      '  --adapter reads one vector-shaped JSON request per line and writes one response per line (README).'
    );
    process.exit(2);
  }
}
