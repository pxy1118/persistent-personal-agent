import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { PpaSession } from '../src/ppa-session.js';
import { locations, root, readConfig, cliAsync, atomicJson, configureAgent, modelIds, modelHandle } from '../src/letta-runtime.js';
import { acquireLock } from '../src/lock.js';

// Real model + real native runtime, isolated identity. Validates multimodal `/image` delivery
// to the configured local model service (llama-cpp provider reads /props vision capabilities).
const p = locations(join(root, '.ppa', 'ppa-image-validation'));
mkdirSync(p.data, { recursive: true }); const release = acquireLock(p.data);
const reportFile = join(root, '.ppa/reports/ppa-image.json');
const report: any = { status: 'RUNNING', data: p.data, steps: [] };
const save = () => atomicJson(reportFile, report);
const step = (name: string, detail?: unknown) => { report.steps.push(name); save(); console.log('STEP ' + name + (detail !== undefined ? ' ' + String(detail) : '')); };
// 96x96 PNG: red ellipse, blue center, black "PPA" label. Deterministic fixture image.
const png = Buffer.from('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', 'base64');
let session: PpaSession | undefined;
try {
  step('config'); let c = readConfig(locations());
  if (process.env.PPA_IMAGE_SMOKE_BASE) c = { ...c, modelBaseUrl: process.env.PPA_IMAGE_SMOKE_BASE };
  step('models', c.provider); const ids = await modelIds(c); step('modelIds', ids[0]);
  step('create-agent');
  const agent = JSON.parse(await cliAsync(p, ['agents', 'create', '--name', '糯糯 · 多模态验收', '--personality', 'blank', '--model', modelHandle(c, c.modelId ?? ids[0])]));
  atomicJson(p.manifest, { status: 'complete', agentId: agent.id }); configureAgent(p, agent.id, c, c.modelId ?? ids[0]);
  step('start'); session = new PpaSession(p); await session.start(c); step('started');
  const persona = (await session.memories()).find(d => d.path === 'system/persona.md')!;
  await session.writeMemory(persona, '---\ndescription: 多模态验收人格\n---\n你叫糯糯，自然、简短地用中文交流。此身份只用于多模态验收。\n');
  const fixture = join(p.workspace, 'fixture.png'); writeFileSync(fixture, png);
  session.on('notice', (t: string) => step('notice', t));
  session.on('approval', (a: any) => step('approval', a.tool + ' ' + JSON.stringify(a.args).slice(0, 120)));
  const raw: any[] = []; session.client!.onMessage((m: any) => {
    raw.push({ type: m.type, reason: m.stop_reason, error: m.error ? String(m.error).slice(0, 200) : undefined, delta: m.delta?.message_type, stream: m.stream_delta ? String((m as any).delta?.content ?? '').slice(0, 80) : undefined }); save();
  });
  step('send');
  let reply = ''; session.on('text', t => reply += t);
  const turn = async (input: string, images?: { mimeType: string; data: string }[]) => {
    const started = Date.now(); reply = '';
    let timer: NodeJS.Timeout;
    const timeout = new Promise<{ reason: string }>(r => { timer = setTimeout(() => r({ reason: 'watchdog' }), 150000); });
    await session!.send(input, images);
    const outcome: any = await Promise.race([once(session!, 'done'), timeout]);
    clearTimeout(timer!);
    if (outcome?.reason === 'watchdog') { step('watchdog-stop'); await session!.stop(); }
    return { reason: outcome?.reason ?? outcome, seconds: ((Date.now() - started) / 1000).toFixed(1), reply };
  };
  const textTurn = await turn('请只回复两个字：好的');
  step('text-done', `${textTurn.reason} ${textTurn.seconds}s`);
  step('text-reply', textTurn.reply.slice(0, 80));
  report.textReply = textTurn.reply; save();
  if (!/好的/.test(textTurn.reply)) throw new Error(`文字回合未收到预期回复：${textTurn.reply.slice(0, 120)}`);
  step('send-image');
  const imgTurn = await turn('这张图里有什么颜色和图案？请用中文简短回答。', [{ mimeType: 'image/png', data: png.toString('base64') }]);
  step('done', `${imgTurn.reason} ${imgTurn.seconds}s`);
  reply = imgTurn.reply;
  report.reply = reply; report.provider = c.provider; report.model = ids[0]; report.raw = raw; save();
  console.log('REPLY: ' + reply.slice(0, 300));
  if (!/红|蓝|PPA|圈|圆/.test(reply)) throw new Error(`模型的回答未体现图片内容：${reply.slice(0, 120)}`);
  report.status = 'PASSED'; save(); console.log('PASS multimodal real model');
} catch (e) { report.status = 'FAILED'; report.error = String(e); save(); console.error(e); process.exitCode = 1; }
finally { await session?.close(); release(); }
