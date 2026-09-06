import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InteractiveMode } from '@earendil-works/pi-coding-agent';
import { Store, now } from '../src/store.js';
import { Actions } from '../src/actions.js';
import { paths, root, type Config } from '../src/config.js';
import { createPpaRuntime } from '../src/pi-adapter.js';
import { acquireLock } from '../src/lock.js';
import { loadProjectIdentity } from '../src/identity.js';

// Manual PTY smoke fixture: no user data and no real-model claims. Exit with /quit.
process.env.PI_OFFLINE = '1';
const reflection = process.argv.includes('--reflection');
const p = paths(mkdtempSync(join(tmpdir(), 'ppa-tui-'))); const release = acquireLock(p.data); const store = new Store(p.db, loadProjectIdentity());
const report = { status: 'TUI_RUNNING', kind: 'MOCK_MODEL_ONLY', createdAt: now(), data: p.data, requests: 0 };
const server = createServer(async (req, res) => {
  let raw=''; for await (const part of req) raw+=part; const body=JSON.parse(raw); report.requests++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const item = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'tui-test', object: 'chat.completion.chunk', created: 1, model: 'tui-test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  if(reflection && body.tools?.length && body.messages.at(-1).role!=='tool') {
    res.write(item({role:'assistant',tool_calls:[{index:0,id:'think1',type:'function',function:{name:'reflect',arguments:JSON.stringify({opening:'听起来你有些累了，先缓一缓。',question:'怎么自然回应疲惫'})}}]},null));res.write(item({},'tool_calls'));
  } else {
    if(reflection && !body.tools?.length) {await new Promise(r=>setTimeout(r,3000));res.write(item({reasoning_content:'PRIVATE_TUI_REASONING'},null));}
    res.write(item({ role: 'assistant', content: reflection ? '可以先休息一下，明天再决定下一步。' : '你好，PPA 终端正在正常工作。' }, null)); res.write(item({}, 'stop'));
  }
  res.end('data: [DONE]\n\n');
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const c: Config = { modelBaseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'tui-test', contextWindow: 32768, maxTokens: 1024, memoryBudgetChars: 2000, extensions: [], skills: [] };
const app = await createPpaRuntime({ store, actions: new Actions(store), paths: p, config: c, modelIds: ['tui-test'] });
process.once('exit', code => {
  report.status = code === 0 && report.requests > 0 ? 'TUI_SMOKE_PASSED_MOCK_MODEL' : 'TUI_SMOKE_INCOMPLETE';
  const reports = resolve(root, '.ppa/reports'); mkdirSync(reports, { recursive: true }); writeFileSync(resolve(reports, 'tui-smoke.json'), JSON.stringify(report, null, 2)); store.close(); release();
});
const ui = new InteractiveMode(app.runtime, { migratedProviders: [], initialMessage: '你好' });
await ui.run();
