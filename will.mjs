#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const LAWS = new Set(['edit', 'append', 'keep']);
const OPENER_PREFIX = '<!-- will/';
const CLOSER_PREFIX = '<!-- /will';
const CLOSER_EXACT = '<!-- /will -->';
const CLOSE_SUFFIX = ' -->';
const INTENT_MAX_SCALARS = 512;
const UNSPACED_OPENER_PREFIX = '<!--will/';
const UNSPACED_CLOSER_PREFIX = '<!--/will';

function* markerLines(buf) {
  let cursor = 0, line = 0;
  for (let at; (at = buf.indexOf('will', cursor)) >= 0;) {
    let start = cursor;
    for (let i = cursor; i < at; i++) {
      if (buf[i] === 0x0d || buf[i] === 0x0a) {
        if (buf[i] === 0x0d && buf[i + 1] === 0x0a) i++;
        start = i + 1;
        line++;
      }
    }
    let contentEnd = at;
    while (contentEnd < buf.length && buf[contentEnd] !== 0x0a && buf[contentEnd] !== 0x0d) contentEnd++;
    let lineEnd = contentEnd;
    if (lineEnd < buf.length) lineEnd += buf[lineEnd] === 0x0d && buf[lineEnd + 1] === 0x0a ? 2 : 1;
    yield {start, contentEnd, lineEnd, line};
    cursor = lineEnd;
    if (lineEnd > contentEnd) line++;
  }
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

export function bindingForFile(file) {
  if (typeof file !== 'string') throw new TypeError('file must be a string');
  return /\.(?:md|markdown)$/i.test(file) ? 'markdown' : 'text';
}
function bindingOf(options) {
  if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options)))
    throw new TypeError('options must name a binding');
  const binding = options === undefined || !('binding' in options) ? 'markdown' : options.binding;
  if (binding !== 'markdown' && binding !== 'text') throw new TypeError('unknown binding');
  return binding;
}
const horizontalSpace = c => c === ' ' || c === '\t';
const COMMENT_CARRIERS = [['<!--','-->'],['/*','*/'],['//',''],['--',''],['#',''],[';',''],['%','']];
function markerLine(raw, binding) {
  if (binding === 'markdown') return {text: raw, start: 5, end: raw.length - 4, malformed: false};
  if (!raw.includes('will/') && !raw.includes('/will')) return {text:'',malformed:false};
  let start = 0, end = raw.length, close = '';
  while (horizontalSpace(raw[start])) start++;
  while (end > start && horizontalSpace(raw[end - 1])) end--;
  for (const [prefix, suffix] of COMMENT_CARRIERS) {
    if (!raw.startsWith(prefix,start)) continue;
    start += prefix.length; close = suffix; break;
  }
  while (start < end && horizontalSpace(raw[start])) start++;
  if (!raw.startsWith('will/',start) && !raw.startsWith('/will',start)) return {text:'',malformed:false};
  let malformed = false;
  if (close) {
    if (raw.slice(0,end).endsWith(close)) end -= close.length;
    else malformed = true;
    while (end > start && horizontalSpace(raw[end - 1])) end--;
  }
  const payload = raw.slice(start,end);
  if (close && payload.includes(close)) malformed = true;
  return {text:'<!-- ' + payload + ' -->',start,end,malformed};
}

export function parse(bytesInput, options) {
  const binding = bindingOf(options);
  const buf = Buffer.isBuffer(bytesInput) ? bytesInput : Buffer.from(bytesInput);

  const bad = isUtf8(buf) ? null : findInvalidUtf8(buf);
  if (bad) {
    return {
      regions: [],
      faults: [{ mode: 'invalid_utf8', line: null, byteSpan: [bad.offset, bad.offset + bad.length] }],
      faulted: true,
    };
  }

  const faults = [];
  const regions = [];
  let open = null;

  for (const {start,contentEnd,lineEnd,line:idx} of markerLines(buf)) {
    const lineSpan = [start, lineEnd];
    const marker = markerLine(buf.toString('utf8',start,contentEnd),binding);
    const text = marker.text;

    if (text.startsWith(CLOSER_PREFIX)) {
      if (text !== CLOSER_EXACT || marker.malformed) {
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
    if (!text.endsWith(CLOSE_SUFFIX) || marker.malformed) {
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
  return typeof s.insert === 'string' ? s.insert.isWellFormed() : s.insert instanceof Uint8Array;
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

export function evaluate(beforeBytesInput, spliceInputs, path = 'working', options) {
  const beforeBytes = Buffer.isBuffer(beforeBytesInput) ? beforeBytesInput : Buffer.from(beforeBytesInput);
  const rawSplices = spliceInputs;

  if (path !== 'authoring' && path !== 'working') {
    return { outcome: 'invalid', reason: 'precondition', rule: 'unknown_path' };
  }
  try { bindingOf(options); }
  catch { return {outcome:'invalid',reason:'precondition',rule:'unknown_binding'}; }

  const shape = validateSplices(beforeBytes, rawSplices);
  if (!shape.ok) {
    return { outcome: 'invalid', reason: 'precondition', rule: shape.rule };
  }
  const splices = shape.splices;

  if (path === 'authoring') return { outcome: 'applied' };

  const b = parse(beforeBytes,options);
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
  const a = parse(afterBytes,options);
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

function commonBytes(a,b,tail=false) {
  let lo=0,hi=Math.min(a.length,b.length)+1;
  while(lo+1<hi) {
    const mid=Math.floor((lo+hi)/2);
    const same=tail ? a.subarray(a.length-mid).equals(b.subarray(b.length-mid)) : a.subarray(0,mid).equals(b.subarray(0,mid));
    if(same)lo=mid;else hi=mid;
  }
  return lo;
}
function changedGap(before,after,bs,be,as,ae) {
  let old=before.subarray(bs,be),next=after.subarray(as,ae);
  if(old.equals(next)) return null;
  const prefix=commonBytes(old,next);
  old=old.subarray(prefix);next=next.subarray(prefix);
  const suffix=commonBytes(old,next,true);
  return {start:bs+prefix,end:be-suffix,insertBase64:next.subarray(0,next.length-suffix).toString('base64')};
}
export function diffSplices(beforeInput,afterInput,options) {
  bindingOf(options);
  const before=Buffer.isBuffer(beforeInput)?beforeInput:Buffer.from(beforeInput);
  const after=Buffer.isBuffer(afterInput)?afterInput:Buffer.from(afterInput);
  const whole=changedGap(before,after,0,before.length,0,after.length);
  if(!whole) return [];
  const b=parse(before,options),a=parse(after,options);
  if(b.faulted || a.faulted || b.regions.length!==a.regions.length) return [whole];
  const anchors=[];
  for(let i=0;i<b.regions.length;i++) for(const kind of ['opener','closer']) {
    const from=b.regions[i][kind].byteSpan,to=a.regions[i][kind].byteSpan;
    if(!before.subarray(...from).equals(after.subarray(...to))) return [whole];
    anchors.push([from,to]);
  }
  anchors.push([[before.length,before.length],[after.length,after.length]]);
  const splices=[];let bs=0,as=0;
  for(const [from,to] of anchors) {
    const gap=changedGap(before,after,bs,from[0],as,to[0]);
    if(gap)splices.push(gap);
    bs=from[1];as=to[1];
  }
  return splices;
}
export function compare(beforeInput, afterInput, options) {
  const before=Buffer.isBuffer(beforeInput) ? beforeInput : Buffer.from(beforeInput);
  const after=Buffer.isBuffer(afterInput) ? afterInput : Buffer.from(afterInput);
  if (before.equals(after)) return evaluate(before,[],'working',options);
  const gap=changedGap(before,after,0,before.length,0,after.length);
  const fast=evaluate(before,[gap],'working',options);
  return fast.rule === 'marker_span_touched'
    ? evaluate(before,diffSplices(before,after,options),'working',options) : fast;
}

const SEAL_DOMAIN = 'will/1 seal/1 sha256-128\0';
function documentBytes(input) {
  if (typeof input === 'string' ? !input.isWellFormed() : !(input instanceof Uint8Array))
    throw new TypeError('document must be a scalar string or Uint8Array');
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}
function sealDigest(law, bytes) {
  return createHash('sha256').update(SEAL_DOMAIN + law + '\0' + bytes.length + '\0')
    .update(bytes).digest('hex').slice(0, 32);
}
function readSeal(intent) {
  const at = (intent ?? '').indexOf('[seal/');
  if (at < 0) return {present: false};
  const bad = reason => ({present: true, reason});
  if ((at && intent[at - 1] !== ' ') || intent.indexOf('[seal/', at + 1) >= 0) return bad('malformed_seal');
  const match = /^\[seal\/([^ ]+) ([^:]+):([^:]+):([^\]]*)\]$/.exec(intent.slice(at));
  if (!match) return bad('malformed_seal');
  const [, version, algorithm, count, digest] = match;
  if (version !== '1' || algorithm !== 'sha256-128') return bad('unsupported_seal');
  if (!/^(?:0|[1-9][0-9]*)$/.test(count) || !Number.isSafeInteger(Number(count)) || !/^[0-9a-f]{32}$/.test(digest))
    return bad('malformed_seal');
  return {present: true, bytes: Number(count), digest};
}
function verifyParsedSeals(buf, parsed) {
  const regions = parsed.regions.map(region => {
    const result = {region: region.index, law: region.law};
    const unsealed = reason => ({...result, status: 'unsealed', reason});
    if (parsed.faulted) return unsealed('document_faulted');
    const seal = readSeal(region.intent);
    if (!seal.present) return unsealed('absent');
    if (seal.reason) return unsealed(seal.reason);
    if (region.law === 'edit') return unsealed('unsupported_law');
    const governed = buf.subarray(...region.governedSpan);
    const content = region.law === 'append' ? stripOneTrailingTerminator(governed) : governed;
    const changed = reason => ({...result, status: 'changed', reason, sealedBytes: seal.bytes});
    if (content.length < seal.bytes || (region.law === 'keep' && content.length !== seal.bytes))
      return changed('length_mismatch');
    if (sealDigest(region.law, content.subarray(0, seal.bytes)) !== seal.digest) return changed('digest_mismatch');
    return {...result, status: 'intact', sealedBytes: seal.bytes};
  });
  return {faulted: parsed.faulted, faults: parsed.faults, regions};
}

export function verifySeals(bytesInput, options) {
  const buf = documentBytes(bytesInput);
  return verifyParsedSeals(buf, parse(buf,options));
}

export function seal(bytesInput, options) {
  const buf = documentBytes(bytesInput), parsed = parse(buf,options);
  const fail = (code, region) => {
    throw Object.assign(new Error(code.replaceAll('_', ' ') + (region === undefined ? '' : ' in region ' + region)),
      {code, ...(region === undefined ? {} : {region})});
  };
  if (parsed.faulted) fail('faulted_document');
  const checks = verifyParsedSeals(buf, parsed).regions, splices = [];
  for (const region of parsed.regions) {
    const check = checks[region.index];
    if (check.status === 'intact') continue;
    if (check.status === 'changed') fail('changed_seal', region.index);
    if (check.reason !== 'absent') fail(check.reason, region.index);
    if (region.law === 'edit') continue;
    const governed = buf.subarray(...region.governedSpan);
    const content = region.law === 'append' ? stripOneTrailingTerminator(governed) : governed;
    const tag = '[seal/1 sha256-128:' + content.length + ':' + sealDigest(region.law, content) + ']';
    const intent = region.intent === null ? tag : region.intent + ' ' + tag;
    if (scalarCount(intent) > INTENT_MAX_SCALARS) fail('intent_over_bound', region.index);
    const [start, end] = region.opener.byteSpan;
    const raw = stripOneTrailingTerminator(buf.subarray(start,end)).toString('utf8');
    const carrier = markerLine(raw,bindingOf(options));
    splices.push({start, end: start + stripOneTrailingTerminator(buf.subarray(start, end)).length,
      insert: Buffer.from(raw.slice(0,carrier.start) + 'will/1 ' + region.law + ': ' + intent + raw.slice(carrier.end))});
  }
  return applySplices(buf, splices);
}

export function strip(bytesInput, options) {
  const buf = documentBytes(bytesInput), parsed = parse(buf, options);
  if (parsed.faulted) throw Object.assign(new Error('faulted document'), {code: 'faulted_document'});
  const splices = parsed.regions.flatMap(({opener, closer}) => [opener, closer].map(({byteSpan: [start, end]}) =>
    ({start, end, insert: Buffer.alloc(0)})));
  return {bytes: applySplices(buf, splices), removed: splices.length};
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
  const options = v.binding === undefined ? undefined : {binding:v.binding};
  bindingOf(options);
  if (v.kind === 'parse') return parse(requestBytes(v, 'doc'),options);
  if (v.kind === 'verify') return verifySeals(requestBytes(v, 'doc'),options);
  if (v.kind === 'seal' || v.kind === 'strip') {
    const doc = requestBytes(v, 'doc');
    try {
      if (v.kind === 'seal') return {docBase64: seal(doc,options).toString('base64')};
      const result = strip(doc,options);
      return {docBase64: result.bytes.toString('base64'), removed: result.removed};
    }
    catch (error) {
      if (!error.code) throw error;
      return {error: error.code, ...(error.region === undefined ? {} : {region: error.region})};
    }
  }
  if (v.kind !== 'evaluate') throw new Error('kind must be parse or evaluate');
  const before = requestBytes(v, 'before');
  if (!Object.hasOwn(v, 'path')) throw new Error('path is required');
  return evaluate(before, v.splices, v.path,options);
}
export const exactJSON = text => JSON.parse(text, (key, value, context) =>
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
  for (const v of [...spec.vectors, ...(spec.sealVectors ?? []), ...(spec.textVectors ?? []), ...(spec.stripVectors ?? [])]) {
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
  const failures = [], vectors = [...spec.vectors, ...(spec.sealVectors ?? []), ...(spec.textVectors ?? []), ...(spec.stripVectors ?? [])];
  for (const v of vectors) {
    const result = checkCase(v);
    if (!result.ok) failures.push({id: v.id, got: result.got});
  }
  return {total: vectors.length, failures};
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
const fileOptions = file => {
  const at=argv.indexOf('--binding');
  if(at===-1) return {binding:file==='-' ? 'markdown' : bindingForFile(file)};
  const binding=argv[at+1];
  if(argv.indexOf('--binding',at+1)!==-1 || (binding!=='markdown' && binding!=='text'))
    throw new TypeError('--binding needs exactly one value: markdown or text');
  return {binding};
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (argv[0] === 'parse' && argv[1]) {
    console.log(JSON.stringify(parse(readBytesArg(argv[1]),fileOptions(argv[1])), null, 2));
  } else if (argv[0] === 'seal' && argv[1]) {
    try { process.stdout.write(seal(readBytesArg(argv[1]),fileOptions(argv[1]))); }
    catch (error) { console.error('will: ' + error.message); process.exitCode = 1; }
  } else if (argv[0] === 'strip' && argv[1]) {
    try {
      const result = strip(readBytesArg(argv[1]),fileOptions(argv[1]));
      process.stdout.write(result.bytes);
      console.error(JSON.stringify({removed: result.removed}));
    } catch (error) { console.error('will: ' + error.message); process.exitCode = 1; }
  } else if (argv[0] === 'verify' && argv[1]) {
    const result = verifySeals(readBytesArg(argv[1]),fileOptions(argv[1]));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.faulted || result.regions.some(r => r.status === 'changed' ||
      (r.status === 'unsealed' && r.reason !== 'absent')) ? 1 : 0;
  } else if (argv[0] === 'evaluate' && argv[1] && argv[2]) {
    const path = argv.includes('--authoring') ? 'authoring' : 'working';
    const before = readBytesArg(argv[1]);
    const splices = exactJSON(readFileSync(argv[2], 'utf8'));
    console.log(JSON.stringify(evaluate(before, splices, path,fileOptions(argv[1])), null, 2));
  } else if (argv[0] === 'check' && argv[1]) {
    process.exit(runCheck(argv[1]));
  } else if (argv[0] === 'compare' && argv[1] && argv[2]) {
    const verdict = compare(readBytesArg(argv[1]), readBytesArg(argv[2]),fileOptions(argv[1]));
    console.log(JSON.stringify(verdict, null, 2));
    process.exit(verdict.outcome === 'applied' ? 0 : 1);
  } else if (argv[0] === '--adapter') {
    await runAdapter();
  } else {
    console.error(
      'usage: will.mjs parse <file>|- | evaluate <before>|- <splices.json> [--authoring] | ' +
      'check <vectors.json> | compare <before> <after> | seal <file>|- | verify <file>|- | strip <file>|- | --adapter\n' +
      '  "-" reads fd 0 (stdin) portably.\n' +
      '  check compares this reference implementation against vectors.json exactly, key for ' +
      'key — a stray field is a failure, never ignored.\n' +
      '  --adapter reads one vector-shaped JSON request per line and writes one response per line (README).'
    );
    process.exit(2);
  }
}
