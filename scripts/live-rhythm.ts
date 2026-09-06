import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, modelIds, paths } from '../src/config.js';
import { Store } from '../src/store.js';
import { Actions } from '../src/actions.js';
import { createPpaRuntime } from '../src/pi-adapter.js';
import { loadProjectIdentity } from '../src/identity.js';

const c = config(); const base = paths(); const p = paths(resolve(base.data, 'live', `rhythm-${Date.now()}`));
const store = new Store(p.db, loadProjectIdentity());
const results: unknown[] = []; let app: Awaited<ReturnType<typeof createPpaRuntime>> | undefined;
const selectedCase = process.argv.find(arg=>arg.startsWith('--case='))?.slice(7);
if(selectedCase && !['direct','before','between'].includes(selectedCase)) throw new Error('case 必须是 direct、before 或 between。');
let status = 'FAILED';
try {
  app = await createPpaRuntime({ store, actions: new Actions(store), paths: p, config: c, modelIds: await modelIds(c), ask: async () => false });
  for (const [name, prompt, expected] of [
    ['直接回应', '你好，晚上好呀。直接跟我打个招呼就好，不用专门思考。', 'direct'],
    ['先思考后说', '请先认真想清楚再回答，不需要先回应：甲比乙大两岁，三年前甲的年龄是乙的两倍，现在两人各几岁？', 'before'],
    ['先说再想再说', '我做了很久的项目又失败了，有点泄气。先跟我说一句你的真实反应，再认真想想，接着和我聊聊怎么判断该坚持还是换方向。', 'between'],
  ]) {
    if(selectedCase && selectedCase !== expected) continue;
    await app.runtime.newSession();
    const events: { kind: string; ms: number; text?: string; error?: boolean; reasoningObserved?: boolean }[] = [];
    const start = performance.now();
    const unsubscribe = app.runtime.session.subscribe(e => {
      if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') events.push({kind:'speech', ms:performance.now()-start, text:e.assistantMessageEvent.delta});
      if (e.type === 'tool_execution_start' && e.toolName === 'reflect') {
        if(e.args.opening?.trim()) events.push({kind:'speech_opening',ms:performance.now()-start,text:e.args.opening});
        events.push({kind:'thinking_start',ms:performance.now()-start});
      }
      if (e.type === 'tool_execution_end' && e.toolName === 'reflect') events.push({kind:'thinking_end',ms:performance.now()-start,error:e.isError,reasoningObserved:e.result?.details?.reasoningObserved});
    });
    const timer = setTimeout(() => { void app!.runtime.session.abort(); }, 100000);
    try { await app.runtime.session.prompt(prompt); } finally { clearTimeout(timer); unsubscribe(); }
    const speak = events.findIndex(e=>e.kind==='speech'||e.kind==='speech_opening'); const think = events.findIndex(e=>e.kind==='thinking_start'); const end = events.findIndex(e=>e.kind==='thinking_end');
    const successful = end >= 0 && !events[end].error && events[end].reasoningObserved === true;
    const clean = !events.some(e=>e.text && /\[thinking\]|<\/?think>/i.test(e.text));
    const passed = clean && (expected === 'direct' ? speak >= 0 && think < 0 : successful && events.slice(end+1).some(e=>e.kind==='speech') && (expected === 'before' ? think < speak : speak >= 0 && speak < think));
    results.push({name,prompt,passed,durationMs:performance.now()-start,events}); console.log(JSON.stringify({name,passed,durationMs:performance.now()-start}));
  }
  status = results.every(r=>(r as {passed:boolean}).passed) ? 'LIVE_RHYTHM_PASSED_NOT_ROUTING_RELIABILITY_PROOF' : 'FAILED';
  if (status === 'FAILED') process.exitCode = 1;
} catch(e) { results.push({error:String(e)}); process.exitCode=1; }
finally {
  if(app) {await app.waitForReset(); await app.runtime.dispose();} store.close();
  const report = resolve(base.data,`reports/live-rhythm${selectedCase?'-'+selectedCase:''}.json`); mkdirSync(resolve(base.data,'reports'),{recursive:true});
  writeFileSync(report,JSON.stringify({status,createdAt:new Date().toISOString(),data:p.data,results},null,2)); console.log(report);
}
