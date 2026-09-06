import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actions } from '../src/actions.js';
import { paths, type Config } from '../src/config.js';
import { createPpaRuntime } from '../src/pi-adapter.js';
import { speechText, continuationText } from '../src/speech-stream.js';

test('continuation drops only the exact delivered opening without losing a changed or shorter reply',()=>{
  const opening='听起来你很累。'; const text=opening+'先休息吧。'; let previous='';
  for(let i=1;i<=text.length;i++) {const current=continuationText(text.slice(0,i),opening,false);assert.ok(current.startsWith(previous));previous=current;}
  assert.equal(previous,'先休息吧。');
  assert.equal(continuationText('听起来你并不累。',opening),'听起来你并不累。');
  assert.equal(continuationText('听起来你',opening),'听起来你');
  assert.equal(continuationText('你好',''),'你好');
});

test('streaming thought delimiters never become user-facing text, across every split',()=>{
  const raw='先回应。<think>秘密推理</think>再回答。[thinking]内部笔记[/thinking]结束。';
  let previous='';
  for(let i=1;i<=raw.length;i++){
    const current=speechText(raw.slice(0,i),false);
    assert.ok(current.startsWith(previous));assert.ok(!/秘密|推理|内部|笔记|think|[<>\[\]]/.test(current));previous=current;
  }
  assert.equal(speechText(raw),'先回应。再回答。结束。');
  assert.equal(speechText('开头<think>未结束的推理'),'开头');
});

function sse(res:ServerResponse, delta:object, stop='stop') {
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  for(const [d,reason] of [[{role:'assistant',...delta},null],[{},stop]]) res.write(`data: ${JSON.stringify({id:'r',object:'chat.completion.chunk',created:1,model:'Qwen-fixture',choices:[{index:0,delta:d,finish_reason:reason}]})}\n\n`);
  res.end('data: [DONE]\n\n');
}
test('Pi speech/thought order, reasoning transport, private output, timeout and cancellation', {timeout:30000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ppa-reflect-')); const p=paths(dir); const store=new Store(p.db);
  let mode='direct'; let nested=0; let invalid=false;
  let app:Awaited<ReturnType<typeof createPpaRuntime>>|undefined;
  const payloads:Record<string,any>[]=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part; const body=JSON.parse(raw);payloads.push(body);
    if(!body.tools?.length){
      nested++;
      if(mode==='abort'||mode==='timeout'){
        res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(':waiting\n\n');
        if(mode==='abort')setTimeout(()=>void app!.runtime.session.abort(),20);
        return;
      }
      sse(res,{reasoning_content:'PRIVATE_REASONING_SENTINEL',content:'核算后结论：甲七岁，乙五岁。'}, invalid?'length':'stop');return;
    }
    if(mode==='direct') {sse(res,{content:'[thinking]PRIVATE_REASONING_SENTINEL</think>晚上好。'});return;}
    if(body.messages.at(-1).role==='tool') {sse(res,{content:invalid?'思考没有完成。':(mode==='opening'?'先听你说，我会认真考虑。':'')+'甲七岁，乙五岁。'});return;}
    sse(res,{...(mode==='between'?{content:'这道题可以核算。'}:{}),tool_calls:[{index:0,id:`c${payloads.length}`,type:'function',function:{name:'reflect',arguments:JSON.stringify({...mode==='opening'?{opening:'先听你说，我会认真考虑。'}:{opening:''},question:'核算年龄'})}}]},'tool_calls');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const c:Config={modelBaseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,modelId:null,contextWindow:32768,maxTokens:1024,memoryBudgetChars:2000,extensions:[],skills:[],reflectionTimeoutMs:150,reflectionMaxTokens:1024};
  try{
    app=await createPpaRuntime({store,actions:new Actions(store),paths:p,config:c,modelIds:['Qwen-fixture'],ask:async()=>false});
    for(const m of ['direct','before','between','opening','truncated','timeout','abort']){
      mode=m;invalid=m==='truncated';await app.runtime.newSession();const before=nested;
      const events:string[]=[];const off=app.runtime.session.subscribe(e=>{
        if(e.type==='message_update'&&e.assistantMessageEvent.type==='text_delta')events.push('speech');
        if(e.type==='tool_execution_start'&&e.toolName==='reflect')events.push('think');
        if(e.type==='tool_execution_end'&&e.toolName==='reflect')events.push(e.isError?'failed':'done');
      });
      await app.runtime.session.prompt('请回答当前问题');off();
      if(m==='direct'){assert.equal(nested,before);assert.deepEqual(events,['speech']);}
      if(m==='before')assert.deepEqual(events,['think','done','speech']);
      if(m==='between')assert.deepEqual(events,['speech','think','done','speech']);
      if(m==='opening') {
        assert.deepEqual(events,['think','done','speech']);
        assert.ok(JSON.stringify(payloads.filter(x=>!x.tools?.length).at(-1)).includes('先听你说，我会认真考虑。'));
        assert.ok(store.all<{role:string;content:string}>('SELECT role,content FROM sources').some(s=>s.role==='assistant'&&s.content==='先听你说，我会认真考虑。'));
        const last=app.runtime.session.messages.at(-1);
        assert.ok(last?.role==='assistant');
        assert.equal(last.content.filter(c=>c.type==='text').map(c=>c.text).join(''),'甲七岁，乙五岁。');
      }
      if(['truncated','timeout','abort'].includes(m)){assert.ok(events.includes('failed'),m);assert.ok(!events.includes('done'),m);}
      if(m==='abort')assert.equal(events.at(-1),'failed');
      assert.ok(!JSON.stringify(app.runtime.session.messages).includes('PRIVATE_REASONING_SENTINEL'));
      assert.ok(!readFileSync(app.runtime.session.sessionManager.getSessionFile()!,'utf8').includes('PRIVATE_REASONING_SENTINEL'));
    }
    const thinking=payloads.filter(x=>!x.tools?.length);
    assert.ok(thinking.every(x=>x.chat_template_kwargs?.enable_thinking===true));
    assert.ok(payloads.filter(x=>x.tools?.length).every(x=>x.chat_template_kwargs?.enable_thinking===false));
    assert.equal(store.all('SELECT * FROM memories').length,0);
    assert.equal(store.all('SELECT * FROM actions').length,0);
    mode='direct';await app.runtime.session.prompt('取消后继续');
  }finally{if(app)await app.runtime.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
});
