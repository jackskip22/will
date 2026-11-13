// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parse, seal, strip, verifySeals} from './will.mjs';
import {guard} from './guard.mjs';

const reader = fileURLToPath(new URL('./will.mjs', import.meta.url));
const {stripVectors} = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const source = v => Buffer.from(v.docBase64, 'base64');

test('strip returns a publishing copy', () => assert.equal(typeof strip, 'function'));
for (const v of stripVectors) test(v.id + ' API', () => {
  const bytes = source(v), original = Buffer.from(bytes);
  if (v.expect.error) assert.throws(() => strip(bytes), error => error.code === v.expect.error);
  else {
    const result = strip(bytes);
    assert.ok(Buffer.isBuffer(result.bytes));
    assert.equal(result.bytes.toString('base64'), v.expect.docBase64);
    assert.equal(result.removed, v.expect.removed);
    assert.deepEqual(parse(result.bytes), {regions: [], faults: [], faulted: false});
    if (result.bytes.length) result.bytes[0] ^= 1;
  }
  assert.deepEqual(bytes, original);
});
test('strip refuses a non-scalar string', () => assert.throws(() => strip('\ud800'), TypeError));

for (const id of ['ALL-LAWS-MULTIPLE', 'UNMARKED-EXACT', 'SEALED', 'CHANGED-SEAL-INTENTIONAL',
  'MIXED-TERMINATORS', 'ATOMIC-LATE-FAULT', 'ATOMIC-LATE-INVALID-UTF8']) test(id + ' strip CLI', () => {
  const v = stripVectors.find(v => v.id === 'STRIP-' + id);
  const result = spawnSync(process.execPath, [reader, 'strip', '-'], {input: source(v)});
  assert.equal(result.status, v.expect.error ? 1 : 0);
  if (v.expect.error) assert.equal(result.stdout.length, 0);
  else {
    assert.equal(result.stdout.toString('base64'), v.expect.docBase64);
    assert.deepEqual(JSON.parse(result.stderr.toString()), {removed: v.expect.removed});
  }
});
test('adapter returns the stripped copy and marker count', () => {
  const v = stripVectors.find(v => v.id === 'STRIP-KEEP');
  const result = spawnSync(process.execPath, [reader, '--adapter'], {input: JSON.stringify(v) + '\n', encoding: 'utf8'});
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {kind: 'strip', result: v.expect, id: v.id});
});

test('text seals, enforcement, and strip preserve every carrier and line ending', () => {
  for (const [open, close] of [['', ''], ['# ', ''], ['// ', ''], ['-- ', ''], ['; ', ''], ['% ', ''],
    ['/* ', ' */'], ['<!-- ', ' -->']]) for (const eol of ['\n', '\r\n', '\r']) {
    const before = Buffer.from(`Outside.${eol}\t${open}will/1 keep${close}\t${eol}Café 🌿${eol}\t${open}/will${close}\t`);
    const sealed = seal(before, {binding: 'text'});
    assert.equal(verifySeals(sealed, {binding: 'text'}).regions[0].status, 'intact');
    assert.equal(guard(sealed, Buffer.from(sealed.toString().replace('Café', 'Tea')), {binding: 'text'}).outcome, 'refused');
    const result = strip(sealed, {binding: 'text'});
    assert.deepEqual(result, {bytes: Buffer.from(`Outside.${eol}Café 🌿${eol}`), removed: 2});
  }
});
test('an intact append seal does not permit rewriting a later addition', () => {
  const sealed = seal('// will/1 append\r\nFirst.\r\n// /will\r\n', {binding: 'text'});
  const current = Buffer.from(sealed.toString().replace('First.\r\n', 'First.\r\nSecond.\r\n'));
  const proposed = Buffer.from(current.toString().replace('Second.', 'Third.'));
  assert.equal(guard(sealed, current, {binding: 'text'}).outcome, 'applied');
  assert.equal(verifySeals(proposed, {binding: 'text'}).regions[0].status, 'intact');
  assert.equal(guard(current, proposed, {binding: 'text'}).outcome, 'refused');
});
test('strip uses an explicit text binding on stdin', () => {
  const result = spawnSync(process.execPath, [reader, 'strip', '-', '--binding', 'text'],
    {input: '# will/1 keep\r\nExact.\r\n# /will', encoding: 'utf8'});
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Exact.\r\n');
  assert.deepEqual(JSON.parse(result.stderr), {removed: 2});
});
