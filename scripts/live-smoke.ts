import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, modelIds, paths } from '../src/config.js';
import { Store, now } from '../src/store.js';
import { Actions } from '../src/actions.js';
import { createPpaRuntime } from '../src/pi-adapter.js';
import { loadProjectIdentity } from '../src/identity.js';

// Opt-in, isolated real-model test. Never starts a model server or reads the user's agent database.
const dialogueMode = process.argv.includes('--dialogue');
const c = config(); const base = paths(); const reportPath = resolve(base.data, dialogueMode ? 'reports/live-dialogue.json' : 'reports/live-smoke.json');
const transcript: { prompt: string; reply: string }[] = [];
mkdirSync(resolve(base.data, 'reports'), { recursive: true });
const report: { status: string; createdAt: string; model?: string; error?: string; data?: string; checks: { name: string; passed: boolean; durationMs: number }[]; timings?: unknown } = { status: 'RUNNING', createdAt: now(), checks: [] };
let store: Store | undefined; let app: Awaited<ReturnType<typeof createPpaRuntime>> | undefined;
try {
  let ids: string[];
  try { ids = await modelIds(c); }
  catch (e) { report.status = 'UNAVAILABLE_NOT_VALIDATED'; report.error = String(e); process.exitCode = 2; ids = []; }
  if (ids.length) {
    const p = paths(resolve(base.data, 'live', now().replace(/[:.]/g, '-'))); report.data = p.data;
    store = new Store(p.db, loadProjectIdentity()); const actions = new Actions(store); actions.grant('write', p.workspace); actions.grant('read', p.workspace);
    app = await createPpaRuntime({ store, actions, paths: p, config: c, modelIds: ids, ask: async title => dialogueMode && title === '忘记这条记忆并开始干净会话？' });
    report.model = app.runtime.session.model!.id;
    const run = async (prompt: string) => {
      const timeout = setTimeout(() => { void app!.runtime.session.abort(); }, 90000);
      try { await app!.runtime.session.prompt(prompt); }
      finally { clearTimeout(timeout); }
      const last = [...app!.runtime.session.messages].reverse().find(m => m.role === 'assistant');
      if (!last || last.role !== 'assistant' || last.stopReason === 'error' || last.stopReason === 'aborted') throw new Error('真实模型请求失败或超过 90 秒。');
      const reply = last.content.filter(x => x.type === 'text').map(x => x.text).join('');
      transcript.push({ prompt, reply }); return reply;
    };
    const check = async (name: string, fn: () => Promise<boolean>) => { const start = performance.now(); const passed = await fn(); const result = { name, passed, durationMs: performance.now() - start }; report.checks.push(result); console.log(JSON.stringify(result)); };
    if (dialogueMode) {
      await check('自然偏好形成记忆', async () => { await run('我平时最喜欢喝白桃乌龙茶。'); return store!.search('白桃乌龙茶').length === 1; });
      const original = store.search('白桃乌龙茶')[0];
      if (!original) throw new Error('未形成初始记忆，不能验证修订。');
      await check('自然纠正等待确认', async () => { await run('不是白桃乌龙了，我现在更喜欢桂花红茶。'); return store!.memory(original.id)?.version === 1 && store!.all("SELECT id FROM candidates WHERE status='pending'").length === 1; });
      await check('下一句确认提交新版本', async () => { await run('对，就这样记。'); const m = store!.memory(original.id); return m?.version === 2 && m.content.includes('桂花红茶') && !m.content.includes('白桃乌龙'); });
      await app.runtime.newSession();
      await check('新会话只召回纠正版本', async () => { const reply = await run('我最喜欢喝什么茶？'); return reply.includes('桂花红茶') && !reply.includes('白桃乌龙'); });
      await check('临时要求不永久化', async () => { const before = store!.all('SELECT * FROM memories'); await run('今天先别叫我昵称，回答也短一点。'); return JSON.stringify(store!.all('SELECT * FROM memories')) === JSON.stringify(before) && store!.all("SELECT id FROM candidates WHERE status='pending'").length === 0; });
      await check('自然忘记建立边界', async () => { const epoch = store!.epoch; await run('请忘记我的饮茶偏好。'); await app!.waitForReset(); return store!.epoch === epoch + 1 && store!.memory(original.id)?.status === 'withdrawn'; });
      await check('忘记后不能召回茶名', async () => { const reply = await run('我最喜欢喝什么茶？不知道就直接说不知道。'); return !reply.includes('桂花红茶') && !reply.includes('白桃乌龙'); });
    } else {
    await check('中文自然回复', async () => (await run('你好，请用一句简短中文回应。')).length > 0);
    await check('真实模型自然记忆提交', async () => { await run('请记住，我最喜欢的虚构茶饮叫青岚七叶茶。'); return store!.search('青岚七叶茶').length > 0; });
    await app.runtime.newSession();
    await check('新会话召回', async () => (await run('我最喜欢的虚构茶饮叫什么？')).includes('青岚七叶茶'));
    await check('原生文件写入', async () => { await run('请在当前工作区创建 ppa-live-note.txt，内容为 PPA_LIVE_OK。'); return actions.list().some(a => a.tool === 'write' && a.status === 'succeeded') && readFileSync(resolve(p.workspace, 'ppa-live-note.txt'), 'utf8').trim() === 'PPA_LIVE_OK'; });
    const memory = store.search('青岚七叶茶')[0];
    if (memory) { store.forget(memory.id); await app.runtime.newSession(); }
    await check('忘记后不召回', async () => !(await run('我最喜欢的虚构茶饮叫什么？不知道就说不知道。')).includes('青岚七叶茶'));
    }
    report.timings = store.all('SELECT kind,duration_ms,created_at FROM timings');
    report.status = report.checks.every(c => c.passed) ? 'LIVE_SMOKE_PASSED_NOT_FULL_ACCEPTANCE' : 'LIVE_SMOKE_FAILED';
    if (report.status === 'LIVE_SMOKE_FAILED') process.exitCode = 1;
  }
} catch (e) { report.status = 'LIVE_SMOKE_FAILED'; report.error = String(e); process.exitCode = 1; }
finally {
  if (app) { await app.waitForReset(); await app.runtime.dispose(); }
  store?.close(); writeFileSync(reportPath, JSON.stringify({ ...report, transcript }, null, 2)); console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}
