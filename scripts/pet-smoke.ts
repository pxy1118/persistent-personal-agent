import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { root, locations, readConfig, cliAsync, configureAgent, atomicJson, modelIds, modelHandle, type LettaConfig } from '../src/ppa-runtime.js';

const live=process.argv.includes('--live');
const p=locations(join(root,'.ppa',`pet-${live?'live':'integration'}-${Date.now()}`));
mkdirSync(p.workspace,{recursive:true});
const file=join(root,'.ppa/reports',live?'pet-live.json':'pet-integration.json');
const report:any={status:'RUNNING',data:p.data,checks:[],replies:[]};
const pass=(name:string)=>{report.checks.push(name);atomicJson(file,report);console.log('PASS '+name);};
let mode='chat',count=0,sawImage=false;
const modelEvents=new EventEmitter();
const server=createServer(async(req,res)=>{
  if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
  if(req.url?.startsWith('/props')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({modalities:{vision:true},default_generation_settings:{n_ctx:32768}}));return;}
  if(req.method==='GET'||req.method==='HEAD'){res.writeHead(404);res.end();return;}
  let raw='';for await(const d of req)raw+=d;
  const body=JSON.parse(raw);count++;modelEvents.emit('request',mode);
  sawImage ||= body.messages.some((m:any)=>Array.isArray(m.content)&&m.content.some((c:any)=>c.type==='image_url'));
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const emit=(delta:object,finish_reason:string|null=null)=>res.write(`data: ${JSON.stringify({id:'pet-test',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
  if(mode==='cancel'){emit({role:'assistant'});const timer=setInterval(()=>emit({content:'持续输出 '}),50);res.on('close',()=>clearInterval(timer));return;}
  if(['allow','deny'].includes(mode)&&count===1){
    emit({role:'assistant',tool_calls:[{index:0,id:'pet-file-'+mode,type:'function',function:{name:'Write',arguments:JSON.stringify({file_path:join(p.workspace,mode+'.txt'),content:'PPA_PET_VERIFIED'})}}]});emit({},'tool_calls');
  }else{emit({role:'assistant',reasoning_content:'HIDDEN_REASONING'});emit({content:'你好，'});emit({content:'桌宠已连接。'});emit({},'stop');}
  res.end('data: [DONE]\n\n');
});

class Client extends EventEmitter {
  child!:ChildProcessWithoutNullStreams; next=0; waiting=new Map<string,{resolve:(value:any)=>void,reject:(e:Error)=>void,timer:NodeJS.Timeout}>();
  wait(event:string,ms=120000):Promise<any[]> {
    return new Promise((resolve,reject)=>{
      const receive=(...args:any[])=>{clearTimeout(timer);resolve(args);};
      const timer=setTimeout(()=>{this.off(event,receive);reject(new Error('Event timeout '+event));},ms);
      this.once(event,receive);
    });
  }
  async start(c:LettaConfig){
    const ready=this.wait('ready');
    this.child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',"import {main} from './src/pet-bridge.ts'; await main(JSON.parse(process.env.PPA_TEST_CONFIG));"],{cwd:root,env:{...process.env,PPA_DATA_DIR:p.data,PPA_TEST_CONFIG:JSON.stringify(c)},windowsHide:true,stdio:'pipe'});
    this.child.stderr.on('data',d=>{report.stderr=(report.stderr??'')+d.toString();atomicJson(file,report);});
    createInterface({input:this.child.stdout}).on('line',line=>{
      const value=JSON.parse(line);
      if(value.event){if(value.event==='error')this.emit('bridge-error',value.data);else this.emit(value.event,value.data);}
      else{const work=this.waiting.get(value.id);if(work){clearTimeout(work.timer);this.waiting.delete(value.id);if(value.error)work.reject(new Error(value.error));else work.resolve(value.result);}}
    });
    return (await ready)[0];
  }
  request(method:string,params:object={}):Promise<any>{
    const id=String(++this.next);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.waiting.delete(id);reject(new Error('Request timeout '+method));},120000);
      this.waiting.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');
    });
  }
  async close(){
    if(!this.child||this.child.exitCode!==null)return;
    const exited=once(this.child,'exit');await this.request('shutdown');await exited;
    assert.equal(existsSync(join(p.data,'instance.lock')),false);
  }
}
let client:Client|undefined;
const watchdog=setTimeout(()=>{console.error('Smoke watchdog expired');client?.child.stdin.end();process.exitCode=1;},600000);
try {
  let c:LettaConfig;
  if(live){c=readConfig(locations());await modelIds(c);}
  else{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));c={modelBaseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`,provider:'llama-cpp',modelId:'fixture',contextWindow:32768,maxTokens:4096};}
  const agent=JSON.parse(await cliAsync(p,['agents','create','--name','桌宠隔离验收','--personality','blank','--model',modelHandle(c,c.modelId??(await modelIds(c))[0])]));
  atomicJson(p.manifest,{version:1,status:'complete',agentId:agent.id});configureAgent(p,agent.id,c);
  client=new Client();const status=await client.start(c);assert.equal(status.agentId,agent.id);pass('json_lines_ready_and_existing_identity');
  await assert.rejects(client.request('shell',{command:'anything'}),/未知/);pass('narrow_protocol_rejects_raw_execution');
  const turn=async(text:string,image?:string)=>{
    let reply='';const append=(value:string)=>{reply+=value;};client!.on('text',append);
    const done=client!.wait('done');await client!.request('send',{text,...(image?{image}:{})});
    const [result]=await done;client!.off('text',append);assert.ok(!result.error,JSON.stringify(result));
    report.replies.push({text,reply,reason:result.reason});atomicJson(file,report);return reply;
  };
  let docs=await client.request('memories');const persona=docs.find((d:any)=>d.path==='system/persona.md');assert.ok(persona);
  await client.request('writeMemory',{path:persona.path,hash:persona.hash,content:'你叫糯糯，用中文简短回复。验收暗号是松果灯塔。用户明确要求写文件时，调用 Write 工具实际写入指定路径。此身份只用于隔离验收。'});
  await assert.rejects(client.request('writeMemory',{path:persona.path,hash:persona.hash,content:'stale'}),/重新打开/);pass('memory_save_and_stale_editor_rejection');
  const reply=await turn(live?'请只回复：好的':'你好');assert.ok(live?/好的/.test(reply):reply==='你好，桌宠已连接。');assert.ok(!reply.includes('HIDDEN_REASONING'));pass('chinese_stream');
  const history=await client.request('history');assert.ok(history.some((m:any)=>m.role==='assistant'));pass('persistent_history');
  const first=status.conversationId;await client.request('open');assert.notEqual((await client.request('status')).conversationId,first);await client.request('open',{id:first});pass('new_and_resume_conversation');
  const image=join(root,'nuonuo_dev_assets/assets/sprites/runtime/idle/frame_00.png');
  const imageReply=await turn('图片中的人物头发是什么颜色？请用一句中文回答。',image);
  assert.ok(live?/灰|银|白|蓝|绿/.test(imageReply):sawImage);pass('image_reaches_model_and_answer_verified');
  let approvals=0;
  client.on('approval',a=>{approvals++;void client!.request('approve',{id:a.id,allow:mode==='allow'}).catch(e=>{console.error('APPROVAL',e);report.approvalError=String(e);atomicJson(file,report);void client!.request('stop');});});
  mode='allow';count=0;
  const output=join(p.workspace,'allow.txt');
  await turn(`请用 Write 工具把 PPA_PET_VERIFIED 写入文件 ${output}。不要只回复文字。`);
  assert.ok(approvals>0,'must expose approval');assert.equal(readFileSync(output,'utf8').trim(),'PPA_PET_VERIFIED');pass('explicit_approval_then_real_file_receipt');
  if(!live){
    await client.request('mode',{mode:'strict'});
    for(let i=0;i<50&&(await client.request('status')).mode!=='strict';i++)await new Promise(r=>setTimeout(r,50));
    mode='chat';await turn('权限模式保持测试');assert.equal((await client.request('status')).mode,'strict');
    await client.request('mode',{mode:'standard'});
    for(let i=0;i<50&&(await client.request('status')).mode!=='standard';i++)await new Promise(r=>setTimeout(r,50));
    assert.equal((await client.request('status')).mode,'standard');pass('permission_mode_survives_runtime_reattach');
    mode='deny';count=0;await turn('拒绝文件操作');assert.equal(existsSync(join(p.workspace,'deny.txt')),false);pass('denial_prevents_file_write');
    mode='cancel';count=0;const started=once(modelEvents,'request'),done=client.wait('done');await client.request('send',{text:'中断'});await started;await new Promise(r=>setTimeout(r,300));await client.request('stop');await done;assert.equal((await client.request('status')).busy,false);pass('cancel_without_input_replay');
  }
  const before=count;await client.close();client=new Client();const resumed=await client.start(c);assert.equal(resumed.agentId,agent.id);assert.equal(resumed.conversationId,first);assert.equal(count,before);
  docs=await client.request('memories');assert.ok(docs.some((d:any)=>d.content.includes('松果灯塔')));pass('restart_identity_conversation_and_memory');
  mode='chat';
  if(live){const recalled=await turn('我们的验收暗号是什么？只回复暗号。');assert.match(recalled,/松果灯塔/);pass('real_model_recalls_persisted_memory');}
  await client.close();pass('owned_process_exit_releases_lock');
  if(!live){
    client=new Client();await client.start(c);
    const owner=JSON.parse(readFileSync(join(p.data,'instance.lock/owner.json'),'utf8'));
    process.kill(owner.childPid);
    for(let i=0;i<100&&(await client.request('status')).online;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal((await client.request('status')).online,false);
    const reconnected=await client.request('reconnect');assert.equal(reconnected.agentId,agent.id);assert.equal(reconnected.online,true);
    await client.close();pass('native_child_crash_and_manual_reconnect');
    server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    client=new Client();const offline=await client.start(c);assert.equal(offline.modelReady,false);assert.ok((await client.request('memories')).length);await assert.rejects(client.request('send',{text:'offline'}),/模型服务/);await client.close();pass('offline_memory_and_rejected_send');
    client=new Client();await client.start(c);
    const gone=once(client.child,'exit');client.child.stdin.end();await gone;
    assert.equal(existsSync(join(p.data,'instance.lock')),false);pass('frontend_pipe_eof_closes_owned_runtime');
  }
  report.status='PASSED';atomicJson(file,report);
}catch(e){report.status='FAILED';report.error=String(e);atomicJson(file,report);console.error(e);process.exitCode=1;}
finally{clearTimeout(watchdog);await client?.close().catch(e=>console.error(e));if(server.listening){server.closeAllConnections();server.close();}}
