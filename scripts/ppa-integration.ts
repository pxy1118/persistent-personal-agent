import { createServer } from 'node:http';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PpaSession, type ToolApproval } from '../src/ppa-session.js';
import { locations, root, cliAsync, atomicJson, configureAgent } from '../src/letta-runtime.js';

const p = locations(join(root, '.ppa', `ppa-interface-test-${Date.now()}`)); mkdirSync(p.workspace, { recursive: true });
const report: any = { status: 'RUNNING', data: p.data, checks: [] };
const reportFile = join(root, '.ppa/reports/ppa-interface.json');
const pass = (name: string) => { report.checks.push(name); atomicJson(reportFile, report); console.log('PASS ' + name); };
let mode = 'chat', count = 0, model = '', timeout: NodeJS.Timeout | undefined;
const server = createServer(async (req, res) => {
  if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture' }, { id: 'fixture2' }] })); return; }
  let raw = ''; for await (const d of req) raw += d;
  const body = JSON.parse(raw); count++; model = body.model;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'ppa-test', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (mode === 'cancel') { const t = setInterval(() => emit({ content: '持续输出 ' }), 40); res.on('close', () => clearInterval(t)); return; }
  if (['allow','deny'].includes(mode) && count === 1) {
    emit({ role: 'assistant', tool_calls: [{ index: 0, id: `test-${mode}`, type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: join(p.workspace, `${mode}.txt`), content: 'PPA_NATIVE_WRITE' }) } }] }); emit({}, 'tool_calls');
  } else { emit({ role: 'assistant', reasoning_content: 'PRIVATE_REASONING' }); emit({ content: '你好，' }); emit({ content: '这是 PPA。' }); emit({}, 'stop'); }
  res.end('data: [DONE]\n\n');
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const c = { modelBaseUrl: `http://127.0.0.1:${(server.address() as {port:number}).port}/v1`, modelId: 'fixture', contextWindow: 32768, maxTokens: 4096 };
let session: PpaSession | undefined;
try {
  const a = JSON.parse(await cliAsync(p, ['agents','create','--name','PPA测试','--personality','blank','--model','openai-compatible/fixture']));
  atomicJson(p.manifest, { version: 1, status: 'complete', agentId: a.id }); configureAgent(p, a.id, c, 'fixture');
  session = new PpaSession(p); await session.start(c); pass('native_runtime_local_start');
  let streamed = ''; session.on('text', t => { streamed += t; });
  const turn = async (input: string) => {
    const finished = once(session!, 'done'); timeout = setTimeout(() => { void session!.stop(); }, 20000);
    await session!.send(input); await finished; clearTimeout(timeout);
  };
  await turn('你好'); assert.equal(streamed,'你好，这是 PPA。'); assert.ok(!streamed.includes('PRIVATE_REASONING')); pass('chinese_stream_without_private_reasoning');
  const first = session.runtime!.conversation_id; const history = await session.history(); assert.ok(history.some(m => m.text === '你好')); assert.ok(history.some(m => m.text === streamed)); pass('native_history');
  await session.open(); assert.notEqual(session.runtime!.conversation_id, first); await session.open(first); pass('new_and_resume_same_agent');
  const docs = await session.memories(), persona = docs.find(d => d.path === 'system/persona.md')!; assert.ok(persona);
  await session.writeMemory(persona, '---\ndescription: PPA测试人格\n---\n我是糯糯。\n');
  assert.ok((await session.memories()).find(d => d.path === persona.path)?.content.includes('我是糯糯')); await assert.rejects(session.writeMemory(persona,'stale'),/记忆已变化/); pass('memory_native_commit_and_conflict_guard');
  session.on('approval', (approval: ToolApproval) => { void session!.approve(approval.id, mode === 'allow'); });
  mode='allow';count=0;await turn('写入测试文件'); assert.equal(readFileSync(join(p.workspace,'allow.txt'),'utf8'),'PPA_NATIVE_WRITE'); pass('approve_real_file_tool');
  mode='deny';count=0;await turn('拒绝测试文件'); assert.equal(existsSync(join(p.workspace,'deny.txt')),false); pass('deny_real_file_tool');
  mode='cancel';count=0; const textReady=once(session,'text'), ended=once(session,'done'); await session.send('中断测试'); await textReady; await session.stop(); await ended; assert.equal(session.busy,false); pass('cancel_stream');
  const beforeRestart = count; await session.close(); session = new PpaSession(p); await session.start(c); assert.equal(count,beforeRestart); assert.equal(session.runtime!.conversation_id,first); pass('restart_without_input_replay');
  mode='chat'; let persisted=false; await session.changeModel({...c,modelId:'fixture2'},()=>{persisted=true;}); assert.ok(persisted); await turn('切换模型后'); assert.equal(model,'fixture2'); pass('model_switch_keeps_identity_and_conversation');
  await session.close(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
  session=new PpaSession(p);await session.start(c);assert.equal(session.modelReady,false);assert.ok((await session.memories()).length);await assert.rejects(session.send('offline'),/模型服务尚未连接/);pass('offline_memory_access_without_sending_or_recreating_agent');
  report.status='PASSED'; atomicJson(reportFile,report);
} catch(e) { report.status='FAILED';report.error=String(e);atomicJson(reportFile,report);console.error(e);process.exitCode=1; }
finally { if(timeout)clearTimeout(timeout); await session?.close(); if(server.listening){server.closeAllConnections(); server.close();} }
