#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import {readFileSync, lstatSync, statSync, realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {guard} from './guard.mjs';

const scalar = value => typeof value === 'string' && value.isWellFormed();
const deny = message => ({hookSpecificOutput: {
  hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message,
}});

export function checkHook(request) {
  try {
    if (!request || request.hook_event_name !== 'PreToolUse' || !['Write', 'Edit'].includes(request.tool_name))
      throw new Error('Unreadable request: this hook accepts PreToolUse Write and Edit only.');
    const input = request.tool_input;
    if (!input || !scalar(input.file_path) || !isAbsolute(input.file_path) || input.file_path.includes('\0'))
      throw new Error('Supply an absolute file_path.');
    if (request.tool_name === 'Write' ? !scalar(input.content) :
      !scalar(input.old_string) || !input.old_string || !scalar(input.new_string) ||
      (input.replace_all !== undefined && typeof input.replace_all !== 'boolean'))
      throw new Error('Unreadable input: use Unicode scalar strings and a nonempty old_string for Edit.');

    let exists = true;
    try { lstatSync(input.file_path); }
    catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
    // Creating a document has no previous Will. This does not grant the host permission to create it.
    if (!exists && request.tool_name === 'Write') return {};
    const file = realpathSync(input.file_path);
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error('The path is not a regular file.');
    if (stat.nlink > 1) throw new Error('The file has multiple hard links. Have the author resolve its aliases before editing.');
    const before = readFileSync(file);
    let change = input.content;
    if (request.tool_name === 'Edit') {
      const needle = Buffer.from(input.old_string), replacement = Buffer.from(input.new_string);
      change = [];
      for (let at = 0; (at = before.indexOf(needle, at)) !== -1; at += needle.length)
        change.push({start: at, end: at + needle.length, insert: replacement});
      if (!change.length) throw new Error('The old_string does not match. Read the file again and use its exact text.');
      if (!input.replace_all && change.length > 1)
        throw new Error('The old_string is ambiguous. Include enough unchanged context to match once.');
    }
    const result = guard(before, change, {file});
    // Never return "allow": Will supplies a veto, while the host still decides permission.
    return result.outcome === 'applied' ? {} : deny(file + ': ' + result.message);
  } catch (error) {
    return deny('Will could not read or check this write: ' + error.message + ' Read the original file and correct the request before retrying.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try { result = checkHook(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(readFileSync(0)))); }
  catch { result = deny('Will could not read the request as UTF-8 JSON. Send a valid PreToolUse Write or Edit request.'); }
  process.stdout.write(JSON.stringify(result) + '\n');
}
