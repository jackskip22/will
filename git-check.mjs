#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import {execFileSync} from 'node:child_process';
import {isUtf8} from 'node:buffer';
import {pathToFileURL} from 'node:url';
import {guard} from './guard.mjs';
import {bindingForFile} from './will.mjs';

const ZERO = '0000000000000000000000000000000000000000';
const text = (bytes, file) => bindingForFile(file) === 'markdown' ||
  (!bytes.includes(0) && isUtf8(bytes)) || bytes.includes('will/') || bytes.includes('/will');

export function checkGit({cwd = process.cwd(), staged = false, base, head = 'HEAD'} = {}) {
  // ceiling: one Git object up to 256 MiB; raise only with a measured memory bound.
  const git = (...args) => execFileSync('git', args, {cwd, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']});
  const commit = ref => git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}').toString().trim();
  let before, after;
  if (staged) {
    // One immutable index tree supplies both the changed paths and their exact blobs.
    after = git('write-tree').toString().trim();
    try { before = commit('HEAD'); }
    catch {
      const branch = git('symbolic-ref', '-q', 'HEAD').toString().trim();
      try { git('show-ref', '--verify', '--quiet', branch); throw new Error('HEAD exists but cannot be read.'); }
      catch (error) { if (error.status !== 1) throw error; }
      return {checked: 0, skippedBinary: 0, refused: []};
    }
  } else {
    if (typeof base !== 'string' || !base) throw new Error('Supply a base commit.');
    before = commit(base); after = commit(head);
  }
  // Moving a marked file removes its original carrier. Treat renames as deletion plus creation.
  const raw = git('diff', '--no-ext-diff', '--no-textconv', '--no-relative', '--no-renames', '--raw', '-z', '--no-abbrev', before, after, '--');
  const fields = new TextDecoder('utf-8', {fatal: true}).decode(raw).split('\0');
  const result = {checked: 0, skippedBinary: 0, refused: []};
  for (let i = 0; i < fields.length - 1; i += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/.exec(fields[i]);
    const file = fields[i + 1];
    if (!match || !file) throw new Error('Unreadable Git change list.');
    const [, oldMode, newMode, oldOid, newOid, status] = match;
    if (status === 'A' || oldOid === ZERO || !/^100/.test(oldMode)) continue;
    const original = git('cat-file', 'blob', oldOid);
    if (!text(original, file)) { result.skippedBinary++; continue; }
    const proposed = newOid === ZERO || !/^100/.test(newMode) ? Buffer.alloc(0) : git('cat-file', 'blob', newOid);
    result.checked++;
    const decision = guard(original, proposed, {file});
    if (decision.outcome !== 'applied') result.refused.push({file, ...decision});
  }
  return result;
}

function escapeData(value) { return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'); }
function escapeProperty(value) { return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C'); }

export function gitCheckCLI(argv = process.argv.slice(2)) {
  const github = argv.includes('--github');
  const args = argv.filter(value => value !== '--github');
  try {
    if (!(args[0] === 'staged' && args.length === 1 || args[0] === 'pr' && (args.length === 2 || args.length === 3)))
      throw new Error('Usage: git-check.mjs staged [--github] | pr <base> [head] [--github]');
    const result = checkGit({staged: args[0] === 'staged', base: args[1], head: args[2] || 'HEAD'});
    for (const decision of result.refused) {
      if (github) process.stdout.write('::error file=' + escapeProperty(decision.file) + ',line=' + (decision.line || 1) + '::' + escapeData(decision.message) + '\n');
      else process.stdout.write(JSON.stringify(decision) + '\n');
    }
    process.stdout.write(`Will: ${result.checked} text changes checked, ${result.refused.length} refused, ${result.skippedBinary} binary changes skipped.\n`);
    return result.refused.length ? 1 : 0;
  } catch (error) {
    const message = 'Will could not check this change: ' + error.message;
    if (github) process.stdout.write('::error::' + escapeData(message) + '\n');
    else process.stderr.write(message + '\n');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = gitCheckCLI();
