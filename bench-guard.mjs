#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import {performance} from 'node:perf_hooks';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {cpus,tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {guard} from './guard.mjs';

const limit=1_000_000, marker='// will/1 keep\nApproved.\n// /will\n';
const dense='\n'.repeat(limit-marker.length-2)+marker+'x\n';
const ordinary=('const value = 1;\n'.repeat(Math.ceil(limit/17))).slice(0,limit-marker.length-3)+'\n'+marker+'x\n';
const distributed=Array.from({length:6000},(_,i)=>`let row${i} = 1;${' '.repeat(80)}\n`).join('');
const middle=distributed.slice(0,Math.floor((limit-marker.length)/2)-1)+'\n';
const split=middle+marker+middle.slice(0,limit-marker.length-middle.length);
const prose=('The program will read this line.\n'.repeat(Math.ceil(limit/33))).slice(0,limit-marker.length-3)+'\n'+marker+'x\n';
const cases=[
  ['ordinary-will-prose',prose,prose.slice(0,-2)+'y\n','applied'],
  ['local-edit',ordinary,ordinary.slice(0,-2)+'y\n','applied'],
  ['keep-refusal',ordinary,ordinary.replace('Approved.','Rejected.'),'refused'],
  ['dense-lines',dense,dense.slice(0,-2)+'y\n','applied'],
  ['distributed-edits',split,split.replaceAll(' = 1;',' = 2;'),'applied']
];
const percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))];
const stats=xs=>({medianMs:+percentile(xs,.5).toFixed(3),p95Ms:+percentile(xs,.95).toFixed(3),maxMs:+Math.max(...xs).toFixed(3)});
const records=[],dir=mkdtempSync(join(tmpdir(),'will-speed-'));
try {
  for (const [name,beforeText,afterText,outcome] of cases) {
    const before=Buffer.from(beforeText),after=Buffer.from(afterText),samples=[],cpuSamples=[];
    if(before.length!==limit) throw new Error('benchmark must use exactly one million bytes');
    for(let i=0;i<8;i++) guard(before,after,{file:'sample.js'});
    for(let i=0;i<30;i++) {
      const cpu=process.cpuUsage(),t=performance.now(),v=guard(before,after,{file:'sample.js'});samples.push(performance.now()-t);
      const used=process.cpuUsage(cpu);cpuSamples.push((used.user+used.system)/1000);
      if(v.outcome!==outcome) throw new Error(name+': '+JSON.stringify(v));
    }
    writeFileSync(join(dir,'before.js'),before);writeFileSync(join(dir,'after.js'),after);
    const cold=[];
    for(let i=0;i<10;i++) {
      const t=performance.now();
      const r=spawnSync(process.execPath,[new URL('./guard.mjs',import.meta.url).pathname,join(dir,'before.js'),join(dir,'after.js')],{encoding:'utf8'});
      cold.push(performance.now()-t);
      if(JSON.parse(r.stdout).outcome!==outcome) throw new Error(name+' CLI: '+r.stdout+r.stderr);
    }
    records.push({name,beforeBytes:before.length,outcome,api:stats(samples),apiCpu:stats(cpuSamples),command:stats(cold)});
  }
  const startup=[];
  for(let i=0;i<10;i++){const t=performance.now();spawnSync(process.execPath,['-e',''],{encoding:'utf8'});startup.push(performance.now()-t);}
  console.log(JSON.stringify({node:process.version,cpu:cpus()[0]?.model,logicalCpus:cpus().length,arch:process.arch,platform:process.platform,
    clock:'wall time plus separately labeled in-process CPU; command includes Node startup, two reads, check, JSON output, and process exit',
    sourceSha256:Object.fromEntries(['will.mjs','guard.mjs'].map(name=>[name,createHash('sha256').update(readFileSync(new URL(name,import.meta.url))).digest('hex')])),
    samples:{api:30,command:10,warmup:8},emptyNode:stats(startup),records},null,2));
} finally {rmSync(dir,{recursive:true,force:true});}
