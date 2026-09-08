import { createServer } from 'node:http';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PpaSession, type ToolApproval, type ImageInput } from '../src/ppa-session.js';
import { locations, root, cliAsync, atomicJson, configureAgent } from '../src/ppa-runtime.js';

const p = locations(join(root, '.ppa', `ppa-interface-test-${Date.now()}`)); mkdirSync(p.workspace, { recursive: true });
const report: any = { status: 'RUNNING', data: p.data, checks: [] };
const reportFile = join(root, '.ppa/reports/ppa-interface.json');
const pass = (name: string) => { report.checks.push(name); atomicJson(reportFile, report); console.log('PASS ' + name); };
let mode = 'chat', count = 0, model = '', timeout: NodeJS.Timeout | undefined, sawImage = false, sawScreenTool = false, sawScreenImage = false, screenApproval = false;
const server = createServer(async (req, res) => {
  if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture' }, { id: 'fixture2' }] })); return; }
  // llama-cpp provider discovery probes /props for vision capabilities; the local model is vision-capable.
  if (req.url?.startsWith('/props')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ modalities: { vision: true }, default_generation_settings: { n_ctx: 32768 } })); return; }
  // llama-cpp discovery also probes the native endpoint before falling back to OpenAI compatibility.
  if (req.method === 'GET' || req.method === 'HEAD') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}'); return; }
  let raw = ''; for await (const d of req) raw += d;
  const body = JSON.parse(raw); count++; model = body.model;
  sawScreenTool ||= body.tools?.some((tool: any) => tool.function?.name === 'capture_screen');
  const last = body.messages.at(-1);
  if (Array.isArray(last.content)) sawImage ||= last.content.some((part: any) => part.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('data:image/png;base64,'));
  if (mode === 'screen' && count > 1 && Array.isArray(last.content)) sawScreenImage ||= last.content.some((part: any) => part.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('data:image/png;base64,'));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'ppa-test', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (mode === 'cancel') { const t = setInterval(() => emit({ content: '持续输出 ' }), 40); res.on('close', () => clearInterval(t)); return; }
  if (mode === 'screen' && count === 1) {
    emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'test-screen', type: 'function', function: { name: 'capture_screen', arguments: JSON.stringify({ display: 'primary', max_width: 800 }) } }] }); emit({}, 'tool_calls');
  } else if (['allow','deny'].includes(mode) && count === 1) {
    emit({ role: 'assistant', tool_calls: [{ index: 0, id: `test-${mode}`, type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: join(p.workspace, `${mode}.txt`), content: 'PPA_NATIVE_WRITE' }) } }] }); emit({}, 'tool_calls');
  } else { emit({ role: 'assistant', reasoning_content: 'PRIVATE_REASONING' }); emit({ content: '你好，' }); emit({ content: '这是 PPA。' }); emit({}, 'stop'); }
  res.end('data: [DONE]\n\n');
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const c = { modelBaseUrl: `http://127.0.0.1:${(server.address() as {port:number}).port}/v1`, modelId: 'fixture', contextWindow: 32768, maxTokens: 4096, provider: 'llama-cpp' as const };
let session: PpaSession | undefined;
try {
  const a = JSON.parse(await cliAsync(p, ['agents','create','--name','PPA测试','--personality','blank','--model','llama.cpp/fixture']));
  atomicJson(p.manifest, { version: 1, status: 'complete', agentId: a.id }); configureAgent(p, a.id, c, 'fixture');
  session = new PpaSession(p); await session.start(c); pass('native_runtime_local_start');
  const runtimePid = session.child!.pid;
  let streamed = ''; session.on('text', t => { streamed += t; });
  const turn = async (input: string, images?: ImageInput[]) => {
    const finished = once(session!, 'done'); timeout = setTimeout(() => { void session!.stop(); }, 20000);
    await session!.send(input, images); await finished; clearTimeout(timeout);
  };
  await turn('你好'); assert.equal(streamed,'你好，这是 PPA。'); assert.ok(!streamed.includes('PRIVATE_REASONING')); pass('chinese_stream_without_private_reasoning');
  const first = session.runtime!.conversation_id; const history = await session.history(); assert.ok(history.some(m => m.text === '你好')); assert.ok(history.some(m => m.text === streamed)); pass('native_history');
  await session.open(); assert.notEqual(session.runtime!.conversation_id, first); await session.open(first); pass('new_and_resume_same_agent');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  count = 0; await turn('看看这张图', [{ mimeType: 'image/png', data: png }]); assert.equal(sawImage, true); pass('image_message_reaches_vision_model');
  const docs = await session.memories(), persona = docs.find(d => d.path === 'system/persona.md')!; assert.ok(persona);
  await session.writeMemory(persona, '---\ndescription: PPA测试人格\n---\n我是糯糯。\n');
  assert.ok((await session.memories()).find(d => d.path === persona.path)?.content.includes('我是糯糯')); await assert.rejects(session.writeMemory(persona,'stale'),/记忆已变化/); pass('memory_native_commit_and_conflict_guard');
  session.on('approval', (approval: ToolApproval) => {
    if (approval.tool === 'capture_screen') { screenApproval = true; return; }
    void session!.approve(approval.id, mode === 'allow');
  });
  mode='screen';count=0;await turn('看看我的屏幕'); assert.equal(sawScreenTool,true); assert.equal(sawScreenImage,true); assert.equal(screenApproval,false); pass('screen_tool_runs_without_separate_approval');
  mode='allow';count=0;await turn('写入测试文件'); assert.equal(readFileSync(join(p.workspace,'allow.txt'),'utf8'),'PPA_NATIVE_WRITE'); pass('approve_real_file_tool');
  mode='deny';count=0;await turn('拒绝测试文件'); assert.equal(existsSync(join(p.workspace,'deny.txt')),false); pass('deny_real_file_tool');
  assert.equal(session.child!.pid, runtimePid); pass('consecutive_turns_reuse_runtime_after_cleanup');
  const untilMode = async (want: 'standard' | 'acceptEdits' | 'unrestricted' | 'strict', label: string) => {
    for (let i = 0; i < 50 && session!.mode !== want; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(session!.mode, want, label);
  };
  await session.setMode('acceptEdits'); await untilMode('acceptEdits', 'mode acceptEdits');
  await session.setMode('standard'); await untilMode('standard', 'mode standard');
  pass('permission_mode_switch');
  mode='cancel';count=0; const textReady=once(session,'text'), ended=once(session,'done'); await session.send('中断测试'); await textReady;
  await session.setMode('unrestricted'); await untilMode('unrestricted','mode changes while thinking');
  await session.stop(); await ended; assert.equal(session.busy,false); pass('permission_mode_switch_while_thinking_and_cancel_stream');
  const beforeRestart = count; await session.close(); session = new PpaSession(p); await session.start(c); assert.equal(count,beforeRestart); assert.equal(session.runtime!.conversation_id,first); assert.equal(session.mode,'unrestricted'); pass('restart_without_input_replay_and_mode_persists');
  mode='chat'; let persisted=false; await session.changeModel({...c,modelId:'fixture2'},()=>{persisted=true;}); assert.ok(persisted); await turn('切换模型后'); assert.equal(model,'fixture2'); pass('model_switch_keeps_identity_and_conversation');
  await session.close(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
  session=new PpaSession(p);await session.start(c);assert.equal(session.modelReady,false);assert.ok((await session.memories()).length);await assert.rejects(session.send('offline'),/模型服务尚未连接/);pass('offline_memory_access_without_sending_or_recreating_agent');
  report.status='PASSED'; atomicJson(reportFile,report);
} catch(e) { report.status='FAILED';report.error=String(e);atomicJson(reportFile,report);console.error(e);process.exitCode=1; }
finally { if(timeout)clearTimeout(timeout); await session?.close(); if(server.listening){server.closeAllConnections(); server.close();} }
