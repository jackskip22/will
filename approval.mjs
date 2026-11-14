#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import {lstatSync, readdirSync, readFileSync} from 'node:fs';
import {isUtf8} from 'node:buffer';
import {join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {bindingForFile, parse, verifySeals} from './will.mjs';

/** Stdout holds sealed regions only. Errors use stderr and cannot return success. */
export function approvalReport(target, emit = row => process.stdout.write(JSON.stringify(row) + '\n'),
  error = row => process.stderr.write(JSON.stringify(row) + '\n')) {
  let status = 0;
  const absolute = resolve(target);
  const diagnostic = (file, detail) => { status = 2; error({file, ...detail}); };
  let tree = false;
  const visit = (file, top = false) => {
    const name = tree ? relative(absolute, file).split(sep).join('/') : target;
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        if (top) diagnostic(name, {error: 'symbolic_link'});
        return;
      }
      if (stat.isDirectory()) {
        if (top) tree = true;
        for (const entry of readdirSync(file).sort()) if (entry !== '.git') visit(join(file, entry));
        return;
      }
      if (!stat.isFile()) {
        diagnostic(name, {error: 'not_regular_file'});
        return;
      }
      const bytes = readFileSync(file);
      const options = {binding: bindingForFile(file)};
      if (bytes.includes(0) || !isUtf8(bytes)) {
        if (top || options.binding === 'markdown' || bytes.includes(Buffer.from('will/')) ||
            bytes.includes(Buffer.from('/will'))) diagnostic(name, {error: 'not_utf8_text'});
        return;
      }
      const parsed = parse(bytes, options), checked = verifySeals(bytes, options);
      if (checked.faulted) {
        for (const fault of checked.faults)
          diagnostic(name, {error: fault.mode, line: fault.line === null ? null : fault.line + 1});
        return;
      }
      for (const region of checked.regions) {
        const line = parsed.regions[region.region].opener.line + 1;
        if (region.status === 'unsealed') {
          if (region.reason !== 'absent') diagnostic(name, {error: region.reason, region: region.region, line});
        } else {
          emit({file: name, region: region.region, line, law: region.law, status: region.status});
          if (region.status === 'changed' && status === 0) status = 1;
        }
      }
    } catch (exception) {
      diagnostic(name, {error: exception.code ?? 'unreadable_file'});
    }
  };
  visit(absolute, true);
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    process.stderr.write('Usage: node approval.mjs <file-or-tree>\n');
    process.exitCode = 2;
  } else process.exitCode = approvalReport(process.argv[2]);
}
