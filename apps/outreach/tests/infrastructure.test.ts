import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PriorityScheduler } from '../server/scheduler.js';
import { assertStrictSchema, validateOutput } from '../server/schema.js';
import { FileStore, safeKey } from '../server/store.js';

test('strict-schema preflight rejects nested optional or open objects',()=>{
  assert.throws(()=>assertStrictSchema({type:'object',properties:{nested:{type:'object',properties:{x:{type:'string'}},required:['x']}},required:['nested'],additionalProperties:false}),/additionalProperties/);
  assert.throws(()=>assertStrictSchema({type:'object',properties:{x:{type:'string'}},required:[],additionalProperties:false}),/every property/);
  assert.throws(()=>assertStrictSchema({type:'object',properties:{ids:{type:'array',items:{type:'string'},uniqueItems:true}},required:['ids'],additionalProperties:false}),/uniqueItems is not supported/);
  const schema={type:'object',properties:{x:{type:['string','null']}},required:['x'],additionalProperties:false};
  assert.doesNotThrow(()=>assertStrictSchema(schema));assert.deepEqual(validateOutput(schema,{x:null}),{x:null});
  assert.throws(()=>validateOutput(schema,{x:3}),/Invalid structured/);
});

test('scheduler caps actual concurrency and prioritizes inbound jobs without preemption',async()=>{
  const scheduler=new PriorityScheduler(3);let active=0,peak=0;const starts:string[]=[];const release: (()=>void)[]=[];
  const task=(name:string)=>async()=>{active++;peak=Math.max(peak,active);starts.push(name);await new Promise<void>(r=>release.push(r));active--;};
  const running=[0,1,2].map(i=>scheduler.run(`bg${i}`,'sourcing',2,task(`bg${i}`)));
  await new Promise(r=>setImmediate(r));
  const queued=scheduler.run('bg3','sourcing',2,task('bg3'));
  const high=scheduler.run('reply','negotiation',1,task('reply'));
  assert.deepEqual(starts,['bg0','bg1','bg2']);release.shift()!();await new Promise(r=>setImmediate(r));
  assert.equal(starts[3],'reply');assert.equal(peak,3);
  while(release.length){release.shift()!();await new Promise(r=>setImmediate(r));}
  await Promise.all([...running,queued,high]);assert.equal(peak,3);
});

test('file store immutable writes serialize and reject conflicting payloads',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sourcing-test-'));const store=new FileStore(dir);
  try{
    await Promise.all([store.immutable('inbox/a.json',{id:'a',v:1}),store.immutable('inbox/a.json',{v:1,id:'a'})]);
    await assert.rejects(store.immutable('inbox/a.json',{id:'a',v:2}),/conflict/);
    assert.deepEqual(await store.get('inbox/a.json'),{id:'a',v:1});
    assert.deepEqual(await store.list('inbox/'),['inbox/a.json']);
    for(const path of ['../.env','/etc/passwd','a/../b','a\\b'])assert.throws(()=>safeKey(path));
  }finally{await rm(dir,{recursive:true,force:true});}
});
