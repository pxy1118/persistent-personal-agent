import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { locations, root, cliPath, childEnv, sessionArgs, configureAgent, atomicJson, agentFile, json } from '../src/ppa-runtime.js';

// Real release CLI, local deterministic HTTP/SSE fixture. No real-model quality claims.
const p = locations(join(root, '.ppa', `letta-integration-${Date.now()}`)); mkdirSync(p.workspace, { recursive: true });
const report: any = { status: 'RUNNING', data: p.data, checks: [] };
const save = () => atomicJson(join(root, '.ppa/reports/letta-integration.json'), report);
let mode: 'chat'|'write'|'denied'|'cancel' = 'chat', calls = 0, interrupt: (() => void) | undefined;
const target = join(p.workspace, 'written.txt'), denied = join(p.workspace, 'denied.txt');
const server = createServer(async (req,res) => {
  if (req.url === '/v1/models') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({data:[{id:'fixture'}]})); return; }
  let raw=''; for await (const chunk of req) raw+=chunk; const body=JSON.parse(raw);
  assert.equal(body.max_tokens ?? body.max_completion_tokens, 4096);
  calls++;
  if (mode === 'cancel') {
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const timer=setInterval(()=>res.write(`data: ${JSON.stringify({id:'cancel',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{content:'继续'},finish_reason:null}]})}\n\n`),50);
    res.on('close',()=>clearInterval(timer)); setTimeout(()=>interrupt?.(),250); return;
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const emit=(delta:object,finish_reason:string|null)=>res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
  if ((mode==='write'||mode==='denied') && calls===1) {
    const tool=body.tools.find((t:any)=>t.function.name==='Write'); assert.ok(tool, 'Write tool advertised');
    emit({role:'assistant',tool_calls:[{index:0,id:'native-write',type:'function',function:{name:'Write',arguments:JSON.stringify({file_path:mode==='write'?target:denied,content:'NATIVE_WRITE_OK'})}}]},null); emit({},'tool_calls');
  } else { emit({role:'assistant',content:'中文集成正常'},null); emit({},'stop'); }
  res.end('data: [DONE]\n\n');
});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
const port=(server.address() as {port:number}).port;
const c={modelBaseUrl:`http://127.0.0.1:${port}/v1`,modelId:'fixture',contextWindow:32768,maxTokens:4096,provider:'openai-compatible' as const};
function invoke(args:string[], input?: (child:ReturnType<typeof spawn>)=>void) {
  return new Promise<string>((done,fail)=> {
    const child=spawn(process.execPath,[cliPath(),...args],{cwd:p.workspace,env:childEnv(p),windowsHide:true,stdio:['pipe','pipe','pipe']}); let out='';
    const timer=setTimeout(()=>{child.kill();fail(new Error('Fixture CLI timeout'));},45000);
    child.stdout!.on('data',d=>{out+=d;}); child.stderr!.on('data',d=>{out+=d;}); child.on('error',fail);
    child.on('close',code=>{clearTimeout(timer);atomicJson(join(p.data,`invocation-${Date.now()}.json`),{args,code,out,calls});code===0?done(out):fail(new Error(out.slice(-2000)));});
    if(input) input(child); else child.stdin!.end();
  });
}
function pass(name:string) { report.checks.push(name); console.log(`PASS ${name}`);save(); }
try {
  await invoke(['connect','openai-compatible','--base-url',c.modelBaseUrl,'--api-key','fixture-key']);
  const a=JSON.parse(await invoke(['agents','create','--name','Fixture','--personality','blank','--model','openai-compatible/fixture']));
  const id=a.id; configureAgent(p,id,c,'fixture');
  const base=[...sessionArgs(id),'--no-skills','--toolset','default','--output-format','stream-json'];
  mode='write';calls=0;
  const write=await invoke([...base,'--permission-mode','acceptEdits','-p','Write fixture']);
  assert.equal(readFileSync(target,'utf8'),'NATIVE_WRITE_OK');assert.ok(write.includes('tool_return_message') || write.includes('tool_result')); pass('native_file_write_and_receipt');
  mode='denied';calls=0;
  const denial=await invoke([...base,'--new','--permission-mode','strict','-p','Attempt fixture write']);
  assert.equal(existsSync(denied),false); assert.match(denial,/denied|rejected|not allowed|permission/i); pass('native_permission_denial');
  mode='cancel';calls=0;
  const cancelled=await invoke([...base,'--new','--input-format','stream-json','-p'], child=>{
    interrupt=()=>{ child.stdin!.write(JSON.stringify({type:'control_request',request_id:'cancel-fixture',request:{subtype:'interrupt'}})+'\n'); setTimeout(()=>child.stdin!.end(),1500); };
    child.stdin!.write(JSON.stringify({type:'user',message:{role:'user',content:'CANCEL_FIXTURE'}})+'\n');
  });
  assert.match(cancelled,/interrupted/); pass('native_stream_interrupt');
  mode='chat';calls=0; const resumed=await invoke([...base,'-p','New input after restart']);
  assert.equal(calls,1);assert.match(resumed,/中文集成正常/);assert.equal(json(agentFile(p,id)).id,id);pass('restart_same_agent_no_replayed_request');
  assert.equal(json(agentFile(p,id)).model_settings.context_window_limit,32768);pass('model_limits_on_wire_and_state');
  report.status='PASSED';save();
} catch(e) { report.status='FAILED';report.error=String(e);save();console.error(String(e));process.exitCode=1; }
finally {server.closeAllConnections();server.close();}
