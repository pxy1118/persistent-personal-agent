import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PpaSession } from '../src/ppa-session.js';
import { PpaTerminal } from '../src/ppa-terminal.js';
import { locations, root, readConfig, cliAsync, atomicJson, configureAgent, modelIds } from '../src/ppa-runtime.js';
import { acquireLock } from '../src/lock.js';
import { createServer } from 'node:http';

// Real model + real terminal, isolated identity. Does not change the user's model profile or agent.
const p = locations(join(root, '.ppa', 'ppa-tui-validation'));
mkdirSync(p.data, { recursive: true }); const release = acquireLock(p.data);
let c = readConfig(locations());
const mock = process.argv.includes('--mock');
const reportFile = join(root, `.ppa/reports/ppa-tui-${mock ? 'mock' : 'real'}.json`);
const server = mock ? createServer(async (req,res) => {
  if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'ppa-tui-fixture'}]}));return;}
  let raw='';for await(const d of req)raw+=d;const body=JSON.parse(raw);const last=body.messages.at(-1);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const emit=(delta:object,finish_reason:string|null=null)=>res.write(`data: ${JSON.stringify({id:'tui',object:'chat.completion.chunk',created:1,model:'ppa-tui-fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
  if(last.role==='user' && JSON.stringify(last.content).includes('长回复')) {const t=setInterval(()=>emit({content:'这是持续输出的验收文本。'}),100);res.on('close',()=>clearInterval(t));return;}
  if(last.role==='user' && JSON.stringify(last.content).includes('写文件')) {emit({role:'assistant',tool_calls:[{index:0,id:'tui-write',type:'function',function:{name:'Write',arguments:JSON.stringify({file_path:join(p.workspace,'approved.txt'),content:'PPA_TUI_APPROVED'})}}]});emit({},'tool_calls');}
  else {emit({role:'assistant',reasoning_content:'PRIVATE_REASONING'});for(const content of ['你好，','我是糯糯。','这是 PPA 自己的终端。']){emit({content});await new Promise(r=>setTimeout(r,120));}emit({},'stop');}
  res.end('data: [DONE]\n\n');
}) : undefined;
if(server){await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));c={modelBaseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,modelId:'ppa-tui-fixture',contextWindow:32768,maxTokens:4096,provider:'openai-compatible'};}
let session: PpaSession | undefined;
try {
  const ids = await modelIds(c);
  const agent = JSON.parse(await cliAsync(p, ['agents','create','--name','糯糯 · 界面验收','--personality','blank','--model',`openai-compatible/${c.modelId ?? ids[0]}`]));
  atomicJson(p.manifest, { status:'complete', agentId:agent.id }); configureAgent(p,agent.id,c,c.modelId ?? ids[0]);
  session = new PpaSession(p); await session.start(c);
  const persona = (await session.memories()).find(d=>d.path==='system/persona.md')!;
  await session.writeMemory(persona,'---\ndescription: 终端验收人格\n---\n你叫糯糯，自然、简短地用中文交流。此身份只用于界面验收。\n');
  const report = { status:'RUNNING',kind:mock?'MOCK_MODEL_REAL_NATIVE_RUNTIME':'REAL_MODEL',agentId:agent.id,data:p.data,model:c.modelId,events:[] as {type:string;detail:unknown}[] };
  for(const type of ['text','approval','done']) session.on(type,detail=>{report.events.push({type,detail});atomicJson(reportFile,report);});
  await new PpaTerminal(session).run();
  report.status='TERMINAL_EXITED';atomicJson(reportFile,report);
} finally { await session?.close(); release();server?.closeAllConnections();server?.close(); }
