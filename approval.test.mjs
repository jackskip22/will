// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {seal} from './will.mjs';

const command = fileURLToPath(new URL('./approval.mjs', import.meta.url));
const keep = '<!-- will/1 keep: Approved by Ada on 2026-11-13. [seal/1 sha256-128:2:2b054f4b13229641acc4cdb9fa46a4ea] -->\nA\n<!-- /will -->\n';
const temp = () => mkdtempSync(join(tmpdir(), 'will-approval-'));
const run = path => {
  const result = spawnSync(process.execPath, [command, path], {encoding: 'utf8'});
  assert.ifError(result.error);
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return {...result, rows: lines.map(line => JSON.parse(line))};
};
const save = (dir, path, bytes) => { const file = join(dir, path); writeFileSync(file, bytes); return file; };

test('reports only sealed parts, preserving region and one-based opener line', () => {
  const dir = temp();
  try {
    const source = 'notes\n<!-- will/1 edit -->\nUnsealed.\n<!-- /will -->\n\n' + keep;
    const file = save(dir, 'notes.md', source), result = run(file);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.rows, [{file, region: 1, line: 6, law: 'keep', status: 'intact'}]);
    assert.equal(readFileSync(file, 'utf8'), source);
    assert(!result.stdout.includes('Ada'));
    assert(!result.stdout.includes('Unsealed'));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a changed sealed region exits 1, including same-length changes and lost bytes', () => {
  const dir = temp();
  try {
    for (const body of ['B\n', '', 'A\r\n']) {
      const file = save(dir, 'changed.md', keep.replace('\nA\n', '\n' + body)), result = run(file);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(result.rows, [{file, region: 0, line: 1, law: 'keep', status: 'changed'}]);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('an append seal reports its approved prefix, with later additions outside the fingerprint', () => {
  const dir = temp();
  try {
    const marked = seal('<!-- will/1 append -->\nEntry one.\n<!-- /will -->\n').toString();
    const file = save(dir, 'record.md', marked.replace('Entry one.\n', 'Entry one.\nEntry two.\n'));
    let result = run(file);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.rows[0].status, 'intact');
    save(dir, 'record.md', marked.replace('Entry one.', 'Entry ONE.'));
    result = run(file);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.rows[0].status, 'changed');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a tree includes unknown text extensions and excludes unsealed files and quoted Markdown', () => {
  const dir = temp();
  try {
    mkdirSync(join(dir, 'nested'));
    save(dir, 'a.md', keep);
    save(dir, 'nested/source.unknown', keep.replaceAll('<!-- ', '// ').replaceAll(' -->', ''));
    save(dir, 'plain', 'Plain, unsealed text.\n');
    save(dir, 'quote.MARKDOWN', keep.split('\n').map(line => ' ' + line).join('\n'));
    save(dir, 'heading.md', keep.replaceAll('<!-- ', '# ').replaceAll(' -->', ''));
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.rows, [
      {file: 'a.md', region: 0, line: 1, law: 'keep', status: 'intact'},
      {file: 'nested/source.unknown', region: 0, line: 1, law: 'keep', status: 'intact'},
    ]);
    assert.equal(result.stderr, '');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('corrupt and unsupported seal tags cannot silently pass as absent', () => {
  const dir = temp();
  try {
    for (const damaged of [keep.replace('sha256-128:2:', 'sha256-128:02:'), keep.replace('[seal/1', '[seal/2'), keep.replace('2b054f4b', '2B054F4B'), keep.replace(' -->', ' broken -->')]) {
      const result = run(save(dir, 'broken.md', damaged));
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      const diagnostic = JSON.parse(result.stderr);
      assert.match(diagnostic.error, /seal/);
      assert.equal(diagnostic.region, 0);
      assert.equal(diagnostic.line, 1);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('faulted markers and seals on edit regions are errors, never approvals', () => {
  const dir = temp();
  try {
    for (const damaged of [keep.replace('<!-- /will -->', '<!-- /will BAD -->'), keep + '<!-- /will -->\n', keep.replace('will/1 keep', 'will/1 edit')]) {
      const result = run(save(dir, 'broken.md', damaged));
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      assert(result.stderr.trim());
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('tree errors do not hide valid or changed seals in other files', () => {
  const dir = temp();
  try {
    save(dir, 'a.md', keep);
    save(dir, 'b.md', keep.replace('\nA\n', '\nB\n'));
    save(dir, 'c.md', keep.replace('[seal/1', '[seal/2'));
    const result = run(dir);
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(result.rows.map(row => [row.file, row.status]), [['a.md', 'intact'], ['b.md', 'changed']]);
    assert.equal(JSON.parse(result.stderr).file, 'c.md');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('skips binary files in trees but rejects a corrupt file that could contain a seal', () => {
  const dir = temp();
  try {
    save(dir, 'a.md', keep);
    const binary = save(dir, 'picture.bin', Buffer.from([0, 255, 254, 0]));
    let result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.rows.length, 1);
    result = run(binary);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    save(dir, 'corrupt.md', Buffer.concat([Buffer.from(keep), Buffer.from([255])]));
    result = run(dir);
    assert.equal(result.status, 2);
    assert.equal(result.rows.length, 1);
    assert.equal(JSON.parse(result.stderr).file, 'corrupt.md');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('tree traversal does not follow symlinks or inspect .git', () => {
  const dir = temp(), outside = temp();
  try {
    save(dir, 'a.md', keep);
    save(outside, 'outside.md', keep.replace('\nA\n', '\nB\n'));
    symlinkSync(outside, join(dir, 'linked'), 'dir');
    symlinkSync(join(outside, 'outside.md'), join(dir, 'linked.md'));
    mkdirSync(join(dir, '.git'));
    save(dir, '.git/unreadable.md', keep.replace('[seal/1', '[seal/2'));
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.rows.map(row => row.file), ['a.md']);
    assert.equal(run(join(dir, 'linked.md')).status, 2);
  } finally { rmSync(dir, {recursive: true, force: true}); rmSync(outside, {recursive: true, force: true}); }
});

test('missing targets and special files fail without an approval row', () => {
  const dir = temp();
  try {
    const result = run(join(dir, 'missing.md'));
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'ENOENT');
    const special = run('/dev/null');
    assert.equal(special.status, 2);
    assert.equal(special.stdout, '');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
