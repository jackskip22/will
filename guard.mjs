#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {bindingForFile,compare,evaluate,parse,exactJSON} from './will.mjs';

const bytes = input => {
  if (typeof input === 'string' ? !input.isWellFormed() : !(input instanceof Uint8Array))
    throw new TypeError('document must be a Unicode scalar string or Uint8Array');
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
};
const invalid = (rule,message) => ({outcome:'invalid',reason:'precondition',rule,message});

/** Judge the exact proposed bytes or witnessed splices. The host commits them only after its own authorization. */
export function guard(beforeInput,change,options={}) {
  let before, binding, verdict;
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options))
      return invalid('unknown_binding','Supply a file name or an explicit markdown or text binding.');
    binding = 'binding' in options ? options.binding : options.file === undefined ? 'markdown' : bindingForFile(options.file);
    if (binding !== 'markdown' && binding !== 'text')
      return invalid('unknown_binding','Use the markdown or text binding.');
    before=bytes(beforeInput);
    verdict=Array.isArray(change) ? evaluate(before,change,'working',{binding}) : compare(before,bytes(change),{binding});
  } catch(error) {
    return invalid('malformed_document',error.message);
  }
  if (verdict.outcome === 'applied') return verdict;
  if (verdict.outcome === 'invalid') return {...verdict,message:'Supply nonoverlapping UTF-8 byte splices against the unchanged source, each with an explicit insertion.'};
  const parsed=parse(before,{binding});
  const region=Number.isInteger(verdict.region) ? parsed.regions[verdict.region] : null;
  const fault=verdict.faults?.[0];
  const line=region ? region.opener.line+1 : fault?.line === null || fault?.line === undefined ? 1 : fault.line+1;
  const law=region?.law ?? (verdict.rule.includes('faulted') ? 'keep' : 'edit');
  const place=region ? `Region ${region.index}, ${law}, begins at line ${line}. ` : `Line ${line}. `;
  const recovery=verdict.rule === 'before_faulted'
    ? 'The original marks cannot be read exactly; the whole file is kept. Restore or have the author repair the marks before editing.'
    : verdict.rule === 'result_faulted'
      ? 'The proposed bytes damage a mark or UTF-8 text. Preserve the original marks and submit valid UTF-8.'
      : verdict.rule === 'law_violated'
        ? law === 'append'
          ? 'The existing content must stay in order. Add only at the region’s end; do not rewrite, remove, or sort the prefix.'
          : 'The protected content must stay byte-for-byte unchanged. Edit an unmarked or edit region instead.'
        : 'A worker cannot add, replace, remove, or move a mark. Keep the original marker bytes in place and edit only permitted content.';
  return {...verdict,law,region:region?.index??null,line,message:place+recovery};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    const args=process.argv.slice(2), positional=[], options={};
    let edits;
    for(let i=0;i<args.length;i++) {
      if (['--file','--binding','--splices'].includes(args[i])) {
        const key=args[i].slice(2),value=args[++i];
        if (!value || value.startsWith('--') || (key==='splices' ? edits !== undefined : Object.hasOwn(options,key)))
          throw new Error('Each option needs one value.');
        if(key==='splices') edits=value; else options[key]=value;
      } else if (args[i].startsWith('--')) throw new Error('Unknown option: '+args[i]);
      else positional.push(args[i]);
    }
    if (positional.length !== (edits===undefined ? 2 : 1) || positional.filter(p=>p==='-').length>1)
      throw new Error('Usage: guard.mjs BEFORE AFTER [--file NAME] [--binding text|markdown], or BEFORE --splices EDITS.json.');
    options.file ??= positional[0];
    const read = file => readFileSync(file==='-' ? 0 : file);
    const change=edits===undefined ? read(positional[1]) : exactJSON(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(readFileSync(edits)));
    if (edits!==undefined && !Array.isArray(change)) throw new Error('The splice file must contain an array.');
    result=guard(read(positional[0]),change,options);
  } catch(error) {result=invalid('unreadable_request',error.message);}
  process.stdout.write(JSON.stringify(result)+'\n');
  process.exitCode=result.outcome==='applied' ? 0 : result.outcome==='refused' ? 1 : 2;
}
