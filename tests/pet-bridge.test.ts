import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PetBridge, petImage } from '../src/pet-bridge.js';
import type { PpaSession } from '../src/ppa-session.js';

class Session extends EventEmitter {
  busy=false; online=true; modelReady=true; name='测试助手'; mode='standard'; responseMode='native'; adaptiveUnavailableReason=''; pending=new Map();
  sent: any[]=[]; interrupted: any[]=[]; written=''; approved:any[]=[];
  async send(...args:any[]) { this.sent=args; this.busy=true; }
  async interruptAndSend(...args:any[]) { this.interrupted=args; this.sent=args; this.busy=true; }
  async stop() { this.busy=false; }
  async restart() {}
  async approve(...args:any[]) { this.approved=args; }
  async setMode(mode:string) { this.mode=mode; this.emit('mode',mode); }
  async setResponseMode(mode:string) { this.responseMode=mode; this.emit('responseMode',mode); }
  async memories() { return [{path:'system/persona.md',content:'---\ndescription: original\n---\n正文',hash:'version1'}]; }
  async writeMemory(_doc:unknown,content:string) { this.written=content; }
}
test('pet bridge rejects raw commands and invalid approvals, and a new send interrupts the old turn', async()=>{
  const s=new Session(), b=new PetBridge(s as unknown as PpaSession,()=>{});
  const call=(method:string,params:any={})=>b.dispatch({id:'1',method,params});
  await assert.rejects(call('request',{type:'raw'}),/未知/);
  await assert.rejects(call('approve',{id:'x',allow:'yes'}),/无效/);
  await call('send',{text:'你好'}); assert.deepEqual(s.sent,['你好',[]]);
  await call('send',{text:'再次输入'}); assert.deepEqual(s.interrupted,['再次输入',[]]);
  await call('approve',{id:'x',allow:false}); assert.deepEqual(s.approved,['x',false]);
  await call('stop'); assert.equal(s.busy,false);
});
test('pet bridge exposes and switches the shared reply rhythm',async()=>{
  const s=new Session(),b=new PetBridge(s as unknown as PpaSession,()=>{});
  const status:any=await b.dispatch({id:'status',method:'status'});
  assert.equal(status.responseMode,'native');
  await b.dispatch({id:'rhythm',method:'rhythm',params:{mode:'adaptive'}});
  assert.equal(s.responseMode,'adaptive');
  await assert.rejects(b.dispatch({id:'rhythm',method:'rhythm',params:{mode:'random'}}),/未知回复节奏/);
});
test('pet bridge changes permission mode while a reply is in progress',async()=>{
  const s=new Session();s.busy=true;
  const events:any[]=[];const b=new PetBridge(s as unknown as PpaSession,(event,data)=>events.push({event,data}));
  const result:any=await b.dispatch({id:'mode',method:'mode',params:{mode:'unrestricted'}});
  assert.equal(s.mode,'unrestricted');assert.equal(result.mode,'unrestricted');
  assert.ok(events.some(e=>e.event==='mode'&&e.data==='unrestricted'));
});
test('pet memory editor preserves metadata and rejects unissued versions',async()=>{
  const s=new Session(),b=new PetBridge(s as unknown as PpaSession,()=>{});
  const call=(method:string,params:any={})=>b.dispatch({id:'1',method,params});
  await call('memories');
  await assert.rejects(call('writeMemory',{path:'elsewhere',hash:'version1',content:'x'}),/重新打开/);
  await call('writeMemory',{path:'system/persona.md',hash:'version1',content:'新正文'});
  assert.equal(s.written,'---\ndescription: original\n---\n新正文\n');
  await assert.rejects(call('writeMemory',{path:'system/persona.md',hash:'version1',content:'again'}),/重新打开/);
});
test('pet image limits and supported extension match terminal input',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pet-image-'));
  try {
    const file=join(dir,'test.PNG'); writeFileSync(file,Buffer.from('image'));
    assert.deepEqual(await petImage(file),{mimeType:'image/png',data:Buffer.from('image').toString('base64')});
    await assert.rejects(petImage(join(dir,'test.exe')),/格式/);
    writeFileSync(file,Buffer.alloc(20*1024*1024+1)); await assert.rejects(petImage(file),/20MB/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('send reuses the ready runtime without reconnecting',async()=>{
  const s=new Session();let restarted=false;
  s.restart=async()=>{restarted=true;};
  const b=new PetBridge(s as unknown as PpaSession,()=>{});
  await b.dispatch({id:'send',method:'send',params:{text:'复用当前运行时'}});
  assert.equal(restarted,false);assert.deepEqual(s.sent,['复用当前运行时',[]]);
});
test('a stuck abort replaces only the owned runtime and emits cancelled',async()=>{
  const s=new Session();s.busy=true;s.stop=async()=>{};
  let restarted=false;s.restart=async()=>{restarted=true;s.busy=false;};
  const events:any[]=[];const b=new PetBridge(s as unknown as PpaSession,(event,data)=>events.push({event,data}));
  await b.dispatch({id:'stop',method:'stop'});
  assert.ok(restarted);assert.ok(events.some(e=>e.event==='done'&&e.data.reason==='cancelled'&&e.data.forced));assert.deepEqual(s.sent,[]);
});
