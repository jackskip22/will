// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const reader = fileURLToPath(new URL('./will.mjs', import.meta.url));
const {sealVectors} = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
for (const [id, status] of [['INTACT', 0], ['ABSENT', 0], ['BODY-CHANGE', 1], ['MALFORMED', 1],
  ['UNSUPPORTED-VERSION', 1], ['EDIT-CARRIER', 1], ['INVALID-UTF8', 1], ['APPEND-SAME-LINE', 0],
  ['APPEND-CONTENT-TERMINATOR-LF', 1]]) test(id + ' verify CLI', () => {
  const v = sealVectors.find(v => v.id === 'SEAL-' + id);
  const result = spawnSync(process.execPath, [reader, 'verify', '-'],
    {input: Buffer.from(v.docBase64, 'base64'), encoding: 'utf8'});
  assert.equal(result.status, status);
  assert.deepEqual(JSON.parse(result.stdout), v.expect);
});
for (const id of ['WRITE-KEEP', 'REFUSE-CHANGE', 'ATOMIC-REFUSAL']) test(id + ' seal CLI', () => {
  const v = sealVectors.find(v => v.id === 'SEAL-' + id);
  const result = spawnSync(process.execPath, [reader, 'seal', '-'], {input: Buffer.from(v.docBase64, 'base64')});
  assert.equal(result.status, v.expect.error ? 1 : 0);
  if (v.expect.error) assert.equal(result.stdout.length, 0);
  else assert.equal(result.stdout.toString('base64'), v.expect.docBase64);
});
