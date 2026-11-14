import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, linkSync, copyFileSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const hook = join(here, 'hook.mjs');
const gitCheck = join(here, 'git-check.mjs');
const node = process.execPath;
function temp(t) { const path = mkdtempSync(join(tmpdir(), 'will-wrappers-')); t.after(() => rmSync(path, {recursive: true, force: true})); return path; }
function callHook(file, tool, fields, overrides = {}) {
  const input = {hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {file_path: file, ...fields}, ...overrides};
  const got = spawnSync(node, [hook], {input: JSON.stringify(input), encoding: 'utf8'});
  assert.equal(got.status, 0, got.stderr);
  return JSON.parse(got.stdout);
}
function denied(result, pattern) {
  assert.equal(result.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, pattern);
}
const keep = '// will/1 keep: approved\nconst answer = 42;\n// /will\nlet next = 1;\n';
const md = '<!-- will/1 keep -->\nAuthor words.\n<!-- /will -->\nDraft.\n';
function git(cwd, ...args) { return execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}); }
function repository(t, files) {
  const cwd = temp(t);
  git(cwd, 'init', '-q'); git(cwd, 'config', 'user.email', 'will-test@example.invalid'); git(cwd, 'config', 'user.name', 'Will test');
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(cwd, file), bytes);
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  return cwd;
}
function check(cwd, ...args) { return spawnSync(node, [gitCheck, ...args], {cwd, encoding: 'utf8'}); }
function gitRefused(result) { assert.equal(result.status, 1, result.stdout + result.stderr); assert.match(result.stdout, /"outcome":"refused"/); }

test('hook denies a source-file keep rewrite and preserves original bytes', t => {
  const file = join(temp(t), 'source.ts'); writeFileSync(file, keep);
  denied(callHook(file, 'Write', {content: keep.replace('42', '43')}), /keep.*region|region.*keep/);
  assert.equal(readFileSync(file, 'utf8'), keep);
  assert.deepEqual(callHook(file, 'Write', {content: keep.replace('next = 1', 'next = 2')}), {});
});

test('Edit witnesses bytes, refuses marker rewrite unchanged and all-or-nothing replace_all', t => {
  const file = join(temp(t), 'code.js'); const before = keep + 'const copy = 42;\n'; writeFileSync(file, before);
  denied(callHook(file, 'Edit', {old_string: '// will/1 keep: approved', new_string: '// will/1 keep: approved'}), /marker|protected/);
  denied(callHook(file, 'Edit', {old_string: '42', new_string: '43', replace_all: true}), /keep|protected/);
  denied(callHook(file, 'Edit', {old_string: '42', new_string: '43'}), /ambiguous|more than once/);
  denied(callHook(file, 'Edit', {old_string: 'absent', new_string: 'new'}), /match|read/);
  assert.deepEqual(callHook(file, 'Edit', {old_string: 'next = 1', new_string: 'next = 2'}), {});
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('Edit uses UTF-8 byte offsets and only appends to the append prefix', t => {
  const file = join(temp(t), 'journal.txt'); const before = '🙂\r\n# will/1 append\r\nα\r\n# /will\r\n'; writeFileSync(file, before);
  assert.deepEqual(callHook(file, 'Edit', {old_string: 'α', new_string: 'αβ'}), {});
  denied(callHook(file, 'Edit', {old_string: 'α', new_string: 'β'}), /append/);
});

test('hook refuses invalid input and read failures; new Write uses host permissions', t => {
  const cwd = temp(t); const absent = join(cwd, 'new.md');
  assert.deepEqual(callHook(absent, 'Write', {content: md}), {});
  denied(callHook(absent, 'Edit', {old_string: 'a', new_string: 'b'}), /read|exist/);
  denied(callHook(absent, 'Write', {content: '\ud800'}), /scalar|Unicode|input/);
  denied(callHook('relative.txt', 'Write', {content: 'ok'}), /absolute|path/);
  denied(callHook(cwd, 'Write', {content: 'ok'}), /regular|read/);
  const bad = spawnSync(node, [hook], {input: '{', encoding: 'utf8'}); assert.equal(bad.status, 0); denied(JSON.parse(bad.stdout), /read|JSON|request/);
  const invalid = spawnSync(node, [hook], {input: Buffer.from([0xff])}); assert.equal(invalid.status, 0); denied(JSON.parse(invalid.stdout), /read|UTF-8|request/);
});

test('a symlink alias cannot change the binding of its real target', t => {
  const cwd = temp(t); const target = join(cwd, 'rules.txt'); const alias = join(cwd, 'rules.md'); writeFileSync(target, '# will/1 keep\nowner\n# /will\n'); symlinkSync(target, alias);
  denied(callHook(alias, 'Write', {content: '# will/1 keep\nchanged\n# /will\n'}), /keep|protected/);
  const dangling = join(cwd, 'dangling.txt'); symlinkSync(join(cwd, 'missing'), dangling);
  denied(callHook(dangling, 'Write', {content: 'new'}), /read|resolve|symbolic|symlink/);
});

test('hard links cannot select a weaker binding for the same file', t => {
  const cwd = temp(t), source = join(cwd, 'rules.ts'), alias = join(cwd, 'rules.md');
  const before = '# will/1 keep\nowner\n# /will\nlet draft = 1;\n'; writeFileSync(source, before); linkSync(source, alias);
  denied(callHook(alias, 'Write', {content: before.replace('owner', 'changed')}), /hard link/);
  denied(callHook(alias, 'Edit', {old_string: 'owner', new_string: 'changed'}), /hard link/);
  assert.equal(readFileSync(source, 'utf8'), before); assert.equal(readFileSync(alias, 'utf8'), before);
  rmSync(alias);
  assert.deepEqual(callHook(source, 'Edit', {old_string: 'draft = 1', new_string: 'draft = 2'}), {});
  denied(callHook(source, 'Edit', {old_string: 'owner', new_string: 'changed'}), /keep/);
});

test('precommit reads staged bytes, not an unstaged repair', t => {
  const cwd = repository(t, {'source.ts': keep}); writeFileSync(join(cwd, 'source.ts'), keep.replace('42', '43')); git(cwd, 'add', '.'); writeFileSync(join(cwd, 'source.ts'), keep);
  const got = check(cwd, 'staged'); assert.equal(got.status, 1, got.stdout + got.stderr); assert.match(got.stdout, /source\.ts/); assert.match(got.stdout, /keep/);
  git(cwd, 'config', 'diff.relative', 'true'); mkdirSync(join(cwd, 'subdir')); gitRefused(check(join(cwd, 'subdir'), 'staged'));
  git(cwd, 'add', '.'); assert.equal(check(cwd, 'staged').status, 0);
});

test('the installed pre-commit form blocks an actual Git commit without changing the index', t => {
  const cwd = repository(t, {'source.ts': keep}); const head = git(cwd, 'rev-parse', 'HEAD');
  const hookDir = join(cwd, '.git', 'hooks'); mkdirSync(join(hookDir, 'will'));
  for (const file of ['will.mjs', 'guard.mjs', 'git-check.mjs']) copyFileSync(join(here, file), join(hookDir, 'will', file));
  copyFileSync(join(here, 'pre-commit'), join(hookDir, 'pre-commit')); chmodSync(join(hookDir, 'pre-commit'), 0o755);
  writeFileSync(join(cwd, 'source.ts'), keep.replace('42', '43')); git(cwd, 'add', '.'); const index = git(cwd, 'write-tree');
  const result = spawnSync('git', ['commit', '-qm', 'must refuse'], {cwd, encoding: 'utf8'});
  assert.equal(result.status, 1); assert.match(result.stdout + result.stderr, /keep/);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), head); assert.equal(git(cwd, 'write-tree'), index);
  writeFileSync(join(cwd, 'source.ts'), keep.replace('next = 1', 'next = 2')); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'allowed change');
  assert.notEqual(git(cwd, 'rev-parse', 'HEAD'), head);
});

test('PR checks every text extension and cannot bypass through rename or binary conversion', t => {
  const cwd = repository(t, {'source.weird': keep, 'notes.md': md}); const base = git(cwd, 'rev-parse', 'HEAD').trim();
  git(cwd, 'mv', 'source.weird', 'source.md'); git(cwd, 'commit', '-qm', 'rename');
  gitRefused(check(cwd, 'pr', base, 'HEAD'));
  const cwd2 = repository(t, {'source.ts': keep}); writeFileSync(join(cwd2, 'source.ts'), Buffer.from([0, 255, 1])); git(cwd2, 'add', '.');
  gitRefused(check(cwd2, 'staged'));
});

test('unmarked binary changes are skipped but binary namespace bytes fail closed', t => {
  const cwd = repository(t, {'image.bin': Buffer.from([0, 255, 1]), 'damaged.txt': Buffer.concat([Buffer.from(keep), Buffer.from([255])])});
  writeFileSync(join(cwd, 'image.bin'), Buffer.from([0, 255, 2])); git(cwd, 'add', 'image.bin'); assert.equal(check(cwd, 'staged').status, 0);
  writeFileSync(join(cwd, 'damaged.txt'), 'removed\n'); git(cwd, 'add', 'damaged.txt'); gitRefused(check(cwd, 'staged'));
});

test('deletion and file-to-symlink changes cannot discard existing markers', t => {
  const cwd = repository(t, {'editable.md': '<!-- will/1 edit -->\nbody\n<!-- /will -->\n'}); git(cwd, 'rm', '-q', 'editable.md'); gitRefused(check(cwd, 'staged'));
  const cwd2 = repository(t, {'source.ts': keep}); rmSync(join(cwd2, 'source.ts')); symlinkSync('elsewhere', join(cwd2, 'source.ts')); git(cwd2, 'add', '.'); gitRefused(check(cwd2, 'staged'));
});

test('git paths are NUL-delimited and annotations cannot inject workflow commands', t => {
  const name = 'bad,one%\n::warning::fake.ts'; const cwd = repository(t, {[name]: keep}); writeFileSync(join(cwd, name), keep.replace('42', '43')); git(cwd, 'add', '.');
  const got = check(cwd, 'staged', '--github'); assert.equal(got.status, 1, got.stderr); assert.equal(got.stdout.split('\n').filter(line => line.startsWith('::error ')).length, 1);
  assert.doesNotMatch(got.stdout, /\n::warning::/); assert.match(got.stdout, /%0A/); assert.match(got.stdout, /%2C/); assert.match(got.stdout, /%25/);
});

test('the action command runs its installed checker, never candidate code or shell text from refs', t => {
  const cwd = repository(t, {'source.ts': keep, 'git-check.mjs': 'process.exit(0);\n', 'will.mjs': 'process.exit(0);\n'});
  const base = git(cwd, 'rev-parse', 'HEAD').trim(); writeFileSync(join(cwd, 'source.ts'), keep.replace('42', '43')); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'candidate');
  const command = /^\s+run: (.+)$/m.exec(readFileSync(join(here, 'action.yml'), 'utf8'))[1];
  const env = {...process.env, GITHUB_ACTION_PATH: here, WILL_BASE: base, WILL_HEAD: 'HEAD'};
  const result = spawnSync('bash', ['-c', command], {cwd, env, encoding: 'utf8'});
  assert.equal(result.status, 1); assert.match(result.stdout, /::error.*keep/);
  const invalid = spawnSync('bash', ['-c', command], {cwd, env: {...env, WILL_BASE: '$(touch injected)'}, encoding: 'utf8'});
  assert.equal(invalid.status, 2); assert.throws(() => readFileSync(join(cwd, 'injected')), {code: 'ENOENT'});
});

test('new-file initial commit and non-Will edits work; bad refs and unmerged index fail closed', t => {
  const cwd = temp(t); git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'new.md'), md); git(cwd, 'add', '.'); assert.equal(check(cwd, 'staged').status, 0);
  const repo = repository(t, {'normal.js': 'let n = 1;\n'}); writeFileSync(join(repo, 'normal.js'), 'let n = 2;\n'); git(repo, 'add', '.'); assert.equal(check(repo, 'staged').status, 0);
  assert.equal(check(repo, 'pr', 'missing-ref', 'HEAD').status, 2);
  git(repo, 'reset', '--hard', '-q', 'HEAD'); const main = git(repo, 'branch', '--show-current').trim(); git(repo, 'checkout', '-qb', 'conflict');
  writeFileSync(join(repo, 'normal.js'), 'branch\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'branch'); git(repo, 'checkout', '-q', main);
  writeFileSync(join(repo, 'normal.js'), 'main\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'main'); assert.throws(() => git(repo, 'merge', 'conflict'));
  assert.equal(check(repo, 'staged').status, 2);
});
