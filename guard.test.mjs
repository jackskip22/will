// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {guard} from './guard.mjs';

const source = '// will/1 keep\nApproved.\n// /will\nlet x = 1;\n';
test('keep refusal names the protected region and its line', () => {
  const v=guard(source,source.replace('Approved.','Changed.'),{file:'rules.js'});
  assert.equal(v.outcome,'refused'); assert.equal(v.law,'keep'); assert.equal(v.region,0); assert.equal(v.line,1);
  assert.equal(v.rule,'law_violated'); assert.ok(v.message.length>20);
});
test('append allows additions at the end but rejects rewrites and sorting', () => {
  const before='# will/1 append\nZ\nA\n# /will\n';
  assert.equal(guard(before,before.replace('A\n#','A\nB\n#'),{file:'history.txt'}).outcome,'applied');
  assert.equal(guard(before,before.replace('Z\nA','A\nZ'),{file:'history.txt'}).law,'append');
  assert.equal(guard(before,before.replace('Z','B'),{file:'history.txt'}).outcome,'refused');
});
test('a mixed act refuses as a whole without modifying its inputs', () => {
  const before=Buffer.from(source), copy=Buffer.from(before);
  const verdict=guard(before,[{start:15,end:24,insert:'Other.'},{start:40,end:41,insert:'2'}],{file:'x.js'});
  assert.equal(verdict.outcome,'refused'); assert.deepEqual(before,copy);
});
test('the exact edit cannot replace a marker even with identical bytes', () => {
  assert.equal(guard(source,[{start:0,end:15,insert:'// will/1 keep\n'}],{file:'x.js'}).rule,'marker_span_touched');
  assert.equal(guard(source,source,{file:'x.js'}).outcome,'applied');
});
test('Uint8Array exact edits work outside kept content', () => {
  assert.equal(guard(source,[{start:source.length,end:source.length,insert:new Uint8Array([120,10])}],{file:'x.js'}).outcome,'applied');
});
test('unreadable input and unknown binding never pass', () => {
  for(const value of [null,{},'\ud800']) assert.equal(guard(value,'after',{file:'x.js'}).outcome,'invalid');
  assert.equal(guard(source,{},{}).outcome,'invalid');
  assert.equal(guard(source,source,{binding:'guess'}).outcome,'invalid');
  assert.equal(guard(source,[{start:0,end:0}],{file:'x.js'}).outcome,'invalid');
});
test('an explicit invalid guard binding cannot fall back to a file or Markdown', () => {
  const after=source.replace('Approved.','Changed.');
  for(const binding of [undefined,null,'unknown']) for(const file of [undefined,'rules.txt']) {
    const result=guard(source,after,{binding,...(file===undefined?{}:{file})});
    assert.equal(result.outcome,'invalid');assert.equal(result.rule,'unknown_binding');
  }
  assert.equal(guard(source,after).outcome,'applied');
  assert.equal(guard(source,after,{file:'rules.txt'}).outcome,'refused');
});
test('a faulty before file is kept and an invalid UTF-8 result is refused', () => {
  const v=guard('// will/1 keep\nx','y',{file:'x.js'});
  assert.equal(v.rule,'before_faulted');assert.equal(v.law,'keep');assert.equal(v.line,1);assert.equal(v.region,null);
  assert.equal(guard(source,Buffer.concat([Buffer.from(source),Buffer.from([255])]),{file:'x.js'}).rule,'result_faulted');
});
test('Markdown quoting still permits edits and mixed-case file names select it', () => {
  const doc=' <!-- will/1 keep -->\nx\n <!-- /will -->\n';
  assert.equal(guard(doc,doc.replace('\nx\n','\ny\n'),{file:'guide.MD'}).outcome,'applied');
  assert.equal(guard(doc,doc.replace('\nx\n','\ny\n'),{file:'guide.txt'}).outcome,'refused');
});
test('separated edits around markers are allowed without replacing the markers', () => {
  const before='top = 1\n'+source+'bottom = 1\n';
  assert.equal(guard(before,before.replaceAll('= 1','= 2'),{file:'x.js'}).outcome,'applied');
});
test('large snapshots with unchanged protected spans stay enforceable', () => {
  const lead=Array.from({length:4000},(_,i)=>`const row${i} = 1;\n`).join('');
  const before=lead+source+lead.replaceAll('row','tail');
  assert.equal(guard(before,before.replaceAll(' = 1;',' = 2;'),{file:'x.js'}).outcome,'applied');
  assert.equal(guard(before,before.replace('Approved.','Rejected.'),{file:'x.js'}).outcome,'refused');
});
test('CRLF counts as one line and Unicode byte positions stay exact', () => {
  const before='intro\r\n; will/1 keep\r\n🐈\r\n; /will\r\n';
  const v=guard(before,before.replace('🐈','cat'),{file:'notes.txt'});
  assert.equal(v.line,2);assert.equal(v.region,0);assert.equal(v.law,'keep');
});
test('CLI checks snapshots and explicit edits without writing either file', () => {
  const dir=mkdtempSync(join(tmpdir(),'will-guard-'));
  try {
    const before=join(dir,'before'),after=join(dir,'after'),edits=join(dir,'edits.json');
    writeFileSync(before,source);writeFileSync(after,source.replace('Approved.','Other.'));
    writeFileSync(edits,JSON.stringify([{start:source.length,end:source.length,insert:'tail\n'}]));
    const cli=new URL('./guard.mjs',import.meta.url).pathname;
    const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
    let r=run(before,after,'--file','x.js');assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).law,'keep');
    r=run(before,'--splices',edits,'--file','x.js');assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).outcome,'applied');
    r=run(before,after,'--binding','guess');assert.equal(r.status,2);
    r=run(before);assert.equal(r.status,2);
    assert.equal(readFileSync(before,'utf8'),source);assert.equal(readFileSync(after,'utf8'),source.replace('Approved.','Other.'));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
for (const [name,document] of [
  ['fractional offset','[{"start":1.00000000000000000001,"end":1.00000000000000000001,"insert":"x"}]'],
  ['underflowed offset','[{"start":1e-999,"end":1e-999,"insert":"x"}]'],
  ['invalid UTF-8',Buffer.concat([Buffer.from('[{"start":0,"end":0,"insert":"'),Buffer.from([255]),Buffer.from('"}]')])]
]) test('splice JSON rejects '+name+' without changing its meaning', () => {
  const dir=mkdtempSync(join(tmpdir(),'will-json-'));
  try {
    writeFileSync(join(dir,'before.txt'),'open\n');writeFileSync(join(dir,'edits.json'),document);
    const r=spawnSync(process.execPath,[new URL('./guard.mjs',import.meta.url).pathname,join(dir,'before.txt'),'--splices',join(dir,'edits.json')],{encoding:'utf8'});
    assert.equal(r.status,2);assert.equal(JSON.parse(r.stdout).outcome,'invalid');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
