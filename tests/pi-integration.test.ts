import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Actions } from '../src/actions.js';
import { paths, type Config } from '../src/config.js';
import { createPpaRuntime } from '../src/pi-adapter.js';

type RequestBody = { messages: { role: string; content: unknown; tool_calls?: unknown[] }[]; tools?: { function: { name: string } }[]; model: string };
function sse(res: ServerResponse, delta: object, finish = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (d: object, reason: string | null) => `data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: d, finish_reason: reason }] })}\n\n`;
  res.write(chunk({ role: 'assistant', ...delta }, null)); res.write(chunk({}, finish)); res.end('data: [DONE]\n\n');
}
test('actual Pi SDK loop: streaming, native write, memory, fresh context, forgetting and restore guard', { timeout: 45000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ppa-pi-')); const p = paths(dir); const store = new Store(p.db); const actions = new Actions(store);
  actions.grant('write', p.workspace); actions.grant('read', p.workspace);
  const requests: RequestBody[] = []; let tool: { name: string; args: object } | undefined; let consent = true; let stall = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const parsed = JSON.parse(body) as RequestBody; requests.push(parsed);
    if (stall) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n'); return; }
    if (tool) { const next = tool; tool = undefined; sse(res, { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, 'tool_calls'); }
    else sse(res, { content: '你好，收到。' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  const extensionFile = join(dir, 'explicit-extension.mjs'); const extensionMarker = join(dir, 'extension-marker.txt');
  writeFileSync(extensionFile, `import { writeFileSync } from 'node:fs'; export default pi => { pi.registerTool({ name: 'external_echo', label: 'External echo', description: 'Fixture tool', parameters: { type: 'object', properties: {} }, async execute() { writeFileSync(${JSON.stringify(extensionMarker)}, 'explicit'); return {content:[{type:'text',text:'EXTENSION_OK'}]}; } }); };`);
  const autoDir = join(p.workspace, '.pi/extensions'); mkdirSync(autoDir, { recursive: true });
  writeFileSync(join(autoDir, 'unwanted.mjs'), 'throw new Error("UNWANTED_AUTODISCOVERY")');
  writeFileSync(join(p.workspace, 'AGENTS.md'), 'UNWANTED_CONTEXT_FILE');
  const c: Config = { modelBaseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'test-model', contextWindow: 32768, maxTokens: 1024, memoryBudgetChars: 2000, extensions: [extensionFile], skills: [] };
  let app: Awaited<ReturnType<typeof createPpaRuntime>> | undefined;
  try {
    app = await createPpaRuntime({ store, actions, paths: p, config: c, modelIds: ['test-model', 'other-model'], ask: async () => consent });
    const stream: string[] = [];
    app.runtime.session.subscribe(e => { if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') stream.push(e.assistantMessageEvent.delta); });
    await app.runtime.session.prompt('你好'); assert.ok(stream.join('').includes('你好'));
    assert.ok(!JSON.stringify(requests[0]).includes('UNWANTED_CONTEXT_FILE'));
    const tools = requests[0].tools!.map(t => t.function.name); assert.ok(tools.includes('propose')); assert.ok(tools.includes('write'));
    tool = { name: 'write', args: { path: 'note.txt', content: 'Pi 原生写入成功' } };
    await app.runtime.session.prompt('创建 note.txt'); assert.equal(readFileSync(join(p.workspace, 'note.txt'), 'utf8'), 'Pi 原生写入成功');
    assert.equal(actions.list().find(a => a.tool === 'write')?.status, 'succeeded');
    tool = { name: process.platform === 'win32' ? 'powershell' : 'bash', args: { command: process.platform === 'win32' ? "Write-Output 'PPA_SHELL_OK'" : "printf PPA_SHELL_OK" } };
    await app.runtime.session.prompt('运行一条输出命令'); assert.ok(JSON.stringify(requests.at(-1)).includes('PPA_SHELL_OK'));
    assert.ok(actions.list().some(a => ['powershell', 'bash'].includes(a.tool) && a.status === 'succeeded'));
    consent = false; tool = { name: 'external_echo', args: {} }; await app.runtime.session.prompt('执行扩展示例');
    assert.equal(existsSync(extensionMarker), false); assert.equal(actions.list().find(a => a.tool === 'external_echo')!.status, 'denied');
    consent = true; tool = { name: 'external_echo', args: {} }; await app.runtime.session.prompt('执行已授权扩展示例');
    assert.equal(readFileSync(extensionMarker, 'utf8'), 'explicit'); assert.equal(actions.list().find(a => a.tool === 'external_echo')!.status, 'succeeded');
    tool = { name: 'propose', args: { key: '饮茶偏好', content: '用户喜欢紫鹃红茶', kind: 'preference', evidence: '我喜欢紫鹃红茶', certainty: 'stated', durability: 'stable', sensitivity: 'ordinary', sourceKind: 'user' } };
    await app.runtime.session.prompt('我喜欢紫鹃红茶'); const memory = store.search('紫鹃')[0]; assert.ok(memory);
    const memoriesBeforeCompaction = store.search('').map(m => m.id);
    app.runtime.services.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 128 } });
    await app.runtime.session.compact('Summarize this fixture conversation briefly.');
    assert.deepEqual(store.search('').map(m => m.id), memoriesBeforeCompaction, 'compaction must not create authoritative memory');
    await app.runtime.session.prompt('我的饮茶偏好是什么'); assert.ok(JSON.stringify(requests.at(-1)).includes('紫鹃'));
    await app.runtime.newSession(); await app.runtime.session.prompt('我的饮茶偏好是什么'); assert.ok(JSON.stringify(requests.at(-1)).includes('紫鹃'));
    const other = app.modelRuntime.getModel('ppa-local', 'other-model')!; await app.runtime.session.setModel(other);
    await app.runtime.session.prompt('你好'); assert.equal(requests.at(-1)!.model, 'other-model');
    const oldPath = app.runtime.session.sessionManager.getSessionFile()!;
    tool = { name: 'forget', args: { id: memory.id } }; await app.runtime.session.prompt('请忘记我的饮茶偏好'); await app.waitForReset();
    assert.equal(store.search('紫鹃').length, 0); assert.equal(store.canResume(oldPath), false);
    assert.equal((await app.runtime.switchSession(oldPath)).cancelled, true);
    await app.runtime.session.prompt('你记得我喜欢什么茶吗'); assert.ok(!JSON.stringify(requests.at(-1)).includes('紫鹃'));
    assert.ok(!JSON.stringify(requests.at(-1)).includes('Pi 原生写入成功'));
    assert.ok(existsSync(oldPath));
    const activePath = app.runtime.session.sessionManager.getSessionFile();
    await app.runtime.dispose();
    app = await createPpaRuntime({ store, actions, paths: p, config: c, modelIds: ['test-model', 'other-model'], ask: async () => true });
    assert.equal(app.runtime.session.sessionManager.getSessionFile(), activePath);
    await app.runtime.session.prompt('重启后的你好'); assert.equal(requests.at(-1)!.model, 'other-model');
    assert.ok(!JSON.stringify(requests.at(-1)).includes('紫鹃'));
    stall = true; const aborted = app.runtime.session.prompt('请等待');
    const abortTimer = setTimeout(() => { void app!.runtime.session.abort(); }, 100);
    await aborted; clearTimeout(abortTimer); stall = false;
    const lastAssistant = [...app.runtime.session.messages].reverse().find(m => m.role === 'assistant');
    assert.ok(lastAssistant?.role === 'assistant' && lastAssistant.stopReason === 'aborted');
    await app.runtime.session.prompt('取消后继续'); assert.ok(JSON.stringify(requests.at(-1)).includes('取消后继续'));
  } finally {
    if (app) { await app.waitForReset(); await app.runtime.dispose(); }
    await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
