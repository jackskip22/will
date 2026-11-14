// SPDX-License-Identifier: MIT
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as will from './will.mjs';

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url)));
for (const v of vectors.textVectors) test(v.id, () => {
  const input = key => v[key+'Base64'] === undefined ? v[key] : Buffer.from(v[key+'Base64'],'base64');
  const options = {binding:v.binding};
  const got = v.kind === 'parse' ? will.parse(input('doc'),options) : will.evaluate(input('before'),v.splices,v.path,options);
  assert.deepEqual(got,v.expect);
});

test('file binding keeps Markdown exact, including uppercase extensions', () => {
  assert.equal(will.bindingForFile('README.MARKDOWN'),'markdown');
  assert.equal(will.bindingForFile('guide.md'),'markdown');
  for (const name of ['worker.mjs','Dockerfile','ledger.tsv','notes.txt']) assert.equal(will.bindingForFile(name),'text');
});
test('a seal preserves each text carrier and checks the same governed bytes', () => {
  for(const [open,close] of [['# ', ''],['// ',''],['-- ',''],['; ',''],['% ',''],['',''],['/* ',' */'],['<!-- ',' -->']]) {
    const before = '  '+open+'will/1 keep'+close+'  \r\nExact.\r\n  '+open+'/will'+close+'  \r\n';
    const sealed = will.seal(before,{binding:'text'});
    assert.match(sealed.toString(),/\[seal\/1 sha256-128:/);
    assert.ok(sealed.toString().startsWith('  '+open+'will/1 keep: '));
    assert.ok(sealed.toString().endsWith(close+'  \r\nExact.\r\n  '+open+'/will'+close+'  \r\n'));
    assert.equal(will.verifySeals(sealed,{binding:'text'}).regions[0].status,'intact');
    assert.equal(will.verifySeals(sealed.toString().replace('Exact.','Other.'),{binding:'text'}).regions[0].status,'changed');
  }
});
test('changing a comment delimiter refuses even when the payload stays the same', () => {
  const before = '# will/1 keep\nx\n# /will\n';
  assert.equal(will.compare(before,before.replaceAll('# ','// '),{binding:'text'}).outcome,'refused');
});
test('byte-splice law holds for Unicode and does not touch the marker', () => {
  const before = Buffer.from('// will/1 keep\n🐈\n// /will\n');
  assert.equal(will.evaluate(before,[{start:14,end:18,insert:'cat'}],'working',{binding:'text'}).outcome,'refused');
});
test('an explicit invalid binding never falls back to Markdown', () => {
  const before='# will/1 keep\nExact.\n# /will\n',after=before.replace('Exact.','Other.');
  for(const binding of [undefined,null,'','unknown',false,0]) {
    const options={binding};
    for(const read of [will.parse,will.seal,will.verifySeals]) assert.throws(()=>read(before,options),/binding/);
    assert.throws(()=>will.diffSplices(before,before,options),/binding/);
    assert.deepEqual(will.evaluate(before,[],'working',options),{outcome:'invalid',reason:'precondition',rule:'unknown_binding'});
    assert.equal(will.compare(before,after,options).outcome,'invalid');
  }
});
test('omitted binding keeps Markdown default and text remains explicit', () => {
  const text='# will/1 keep\nExact.\n# /will\n';
  for(const options of [undefined,{}]) {
    assert.equal(will.parse(text,options).regions.length,0);
    assert.equal(will.compare(text,text.replace('Exact.','Other.'),options).outcome,'applied');
    const markdown='<!-- will/1 keep -->\nExact.\n<!-- /will -->\n';
    assert.equal(will.compare(markdown,markdown.replace('Exact.','Other.'),options).outcome,'refused');
  }
  assert.equal(will.compare(text,text.replace('Exact.','Other.'),{binding:'text'}).outcome,'refused');
});
test('file commands reject malformed binding overrides without losing text protection', () => {
  const dir=mkdtempSync(join(tmpdir(),'will-binding-'));
  try {
    const before=join(dir,'before.txt'),after=join(dir,'after.txt');
    writeFileSync(before,'# will/1 keep\nExact.\n# /will\n');
    writeFileSync(after,'# will/1 keep\nOther.\n# /will\n');
    const cli=new URL('./will.mjs',import.meta.url).pathname;
    const run=(...options)=>spawnSync(process.execPath,[cli,'compare',before,after,...options],{encoding:'utf8'});
    for(const options of [['--binding'],['--binding','null'],['--binding','unknown'],['--binding','--authoring'],['--binding','text','--binding','markdown']]) {
      const result=run(...options);
      assert.notEqual(result.status,0,JSON.stringify(options)+' must fail');
      assert.doesNotMatch(result.stdout,/"outcome"\s*:\s*"applied"/);
    }
    assert.equal(JSON.parse(run().stdout).outcome,'refused');
    assert.equal(JSON.parse(run('--binding','text').stdout).outcome,'refused');
    assert.equal(JSON.parse(run('--binding','markdown').stdout).outcome,'applied');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('ordinary will prose does not change marker lines or UTF-8 byte spans', () => {
  for (const a of ['\n', '\r\n', '\r']) for (const b of ['\n', '\r\n', '\r']) {
    const prefix = `We will keep reading.é${a}Another will word.🌿${b}`;
    const open = `# will/1 keep${a}`, body = `Café\u2028🌿${b}`, close = '# /will';
    const start = Buffer.byteLength(prefix), governed = start + Buffer.byteLength(open);
    const end = governed + Buffer.byteLength(body), length = end + Buffer.byteLength(close);
    assert.deepEqual(will.parse(prefix + open + body + close, {binding: 'text'}), {
      regions: [{index: 0, law: 'keep', intent: null,
        opener: {line: 2, byteSpan: [start, governed]},
        closer: {line: 4, byteSpan: [end, length]}, governedSpan: [governed, end]}],
      faults: [], faulted: false,
    });
  }
});
