import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { PpaSession, type ToolApproval } from '../src/ppa-session.js';
import { atomicJson, cliAsync, configureAgent, locations, modelHandle, modelIds, readConfig, root, writeResponseMode } from '../src/ppa-runtime.js';

const paths = locations(join(root, '.ppa', `capability-live-${Date.now()}`));
const reportFile = join(root, '.ppa/reports/capability-routing-live.json');
mkdirSync(paths.workspace, { recursive: true });
const report: any = { status: 'RUNNING', startedAt: new Date().toISOString(), data: paths.data, runs: [] };
const save = () => atomicJson(reportFile, report);
const fixture = join(paths.workspace, 'capability-fixture.txt');
const config = readConfig(paths);
let session: PpaSession | undefined;

async function run(category: string, prompt: string) {
  await session!.open();
  const row: any = { category, answer: '', usage: [], capabilities: [], tools: [] };
  report.runs.push(row); save();
  const started = performance.now(); let firstText: number | undefined;
  const text = (chunk: string) => { firstText ??= performance.now() - started; row.answer += chunk; };
  const usage = (value: any) => row.usage.push(value);
  const capability = (value: any) => row.capabilities.push(value);
  const tool = (value: any) => row.tools.push(value);
  session!.on('text', text); session!.on('usage', usage); session!.on('capability', capability); session!.on('tool', tool);
  try {
    const done = once(session!, 'done'); await session!.send(prompt);
    const timer = setTimeout(() => void session!.stop(), 120000); const [ending] = await done; clearTimeout(timer);
    row.firstVisibleTextMs = firstText === undefined ? null : Math.round(firstText); row.elapsedMs = Math.round(performance.now() - started); row.done = ending;
  } finally {
    session!.off('text', text); session!.off('usage', usage); session!.off('capability', capability); session!.off('tool', tool); save();
  }
}

try {
  const modelId = config.modelId ?? (await modelIds(config))[0]!; report.modelId = modelId;
  writeFileSync(fixture, 'PPA_CAPABILITY_ROUTING_OK\n');
  const created = JSON.parse(await cliAsync(paths, ['agents', 'create', '--name', '能力路由验收助手', '--personality', 'blank', '--model', modelHandle(config, modelId)]));
  atomicJson(paths.manifest, { version: 1, status: 'complete', agentId: created.id }); writeResponseMode(paths, 'adaptive'); configureAgent(paths, created.id, { ...config, modelId }, modelId, 'adaptive');
  session = new PpaSession(paths); await session.start({ ...config, modelId });
  if (session.responseMode !== 'adaptive') throw new Error(session.adaptiveUnavailableReason || '自适应模式未生效。');
  session.on('approval', (approval: ToolApproval) => { const path = String(approval.args.file_path ?? approval.args.path ?? ''); void session!.approve(approval.id, approval.tool === 'Read' && path === fixture); });
  await run('greeting', '你好，请只自然地回复一句。');
  await run('file_read', `请读取 ${fixture} 并告诉我其中的验收词。不要修改文件。`);
  const greeting = report.runs[0], read = report.runs[1];
  const contextTokens = greeting.usage.map((item: any) => item.context_tokens).find(Number.isFinite);
  const routed = read.capabilities.some((item: any) => item.status === 'active' && item.capabilities?.includes('files_read'));
  const usedRead = read.tools.some((item: any) => item.name === 'Read' && item.status === 'running');
  const deniedCapability = /(?:不存在|无法访问|没有.*(?:工具|能力)|cannot access|not available|do not have)/i.test(read.answer);
  report.acceptance = { lightweightContextTokens: contextTokens ?? null, reducedBelow10000: Number.isFinite(contextTokens) && contextTokens < 10000, routedFilesRead: routed, executedRead: usedRead, answerContainsFixture: read.answer.includes('PPA_CAPABILITY_ROUTING_OK'), deniedCapability };
  report.status = report.acceptance.reducedBelow10000 && routed && usedRead && report.acceptance.answerContainsFixture && !deniedCapability ? 'PASSED' : 'FAILED';
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: report.status, acceptance: report.acceptance, timings: report.runs.map((row: any) => ({ category: row.category, firstVisibleTextMs: row.firstVisibleTextMs, elapsedMs: row.elapsedMs })) }, null, 2));
  if (report.status !== 'PASSED') process.exitCode = 1;
} catch (error) {
  report.status = 'FAILED'; report.error = error instanceof Error ? error.message : String(error); report.finishedAt = new Date().toISOString(); save(); console.error(report.error); process.exitCode = 1;
} finally { await session?.close(); }
