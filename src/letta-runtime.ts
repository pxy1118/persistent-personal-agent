import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const version = '0.31.12';
export const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export const json = <T = any>(p: string): T => JSON.parse(readFileSync(p, 'utf8'));
export function atomicJson(p: string, v: unknown) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p + '.tmp', JSON.stringify(v, null, 2) + '\n'); renameSync(p + '.tmp', p); }
export type LettaConfig = { modelBaseUrl: string; modelId: string | null; contextWindow: number; maxTokens: number };
export function locations(data = process.env.PPA_DATA_DIR ?? join(root, '.ppa')) {
  data = resolve(data);
  return { data, store: join(data, 'letta'), workspace: join(data, 'workspace'), manifest: join(data, 'letta-migration.json'), settings: join(data, 'letta-config.json'), backups: join(data, 'backups') };
}
export type Locations = ReturnType<typeof locations>;
export function normalizeConfig(c: Record<string, any>): LettaConfig {
  if (typeof c.modelBaseUrl !== 'string') throw new Error('模型地址无效。');
  const url = new URL(c.modelBaseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('模型地址必须是无内嵌凭据的 HTTP(S) 地址。');
  if (c.modelId !== null && (typeof c.modelId !== 'string' || !c.modelId)) throw new Error('modelId 无效。');
  if (![c.contextWindow, c.maxTokens].every(n => Number.isInteger(n) && n >= 256) || c.maxTokens >= c.contextWindow) throw new Error('上下文与输出上限无效。');
  return { modelBaseUrl: c.modelBaseUrl.replace(/\/$/, ''), modelId: c.modelId, contextWindow: c.contextWindow, maxTokens: c.maxTokens };
}
export function readConfig(p: Locations): LettaConfig {
  const file = existsSync(p.settings) ? p.settings : join(root, 'config/local.example.json');
  const c = { ...json(file), ...(existsSync(join(root, 'config/local.json')) ? json(join(root, 'config/local.json')) : {}) };
  const retired = ['memoryBudgetChars', 'reflectionMaxTokens', 'reflectionTimeoutMs', 'extensions', 'skills'].filter(k => k in c);
  if (retired.length) console.error(`旧配置不再生效：${retired.join(', ')}。使用 Letta 原生设置。`);
  return normalizeConfig(c);
}
export function childEnv(p: Locations): NodeJS.ProcessEnv {
  const env = { ...process.env, LETTA_LOCAL_BACKEND_DIR: p.store, LETTA_LOCAL_BACKEND_EXPERIMENTAL: '1', LETTA_DISABLE_MODS: '1', LETTA_HOME: join(p.data, 'letta-home'), LETTA_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' };
  // Do not inherit routing or session identity from an enclosing Letta process.
  const routing = new Set(['LETTA_API_KEY', 'LETTA_BASE_URL', 'LETTA_MEMFS_BASE_URL', 'LETTA_SETTINGS_BASE_URL', 'AGENT_ID', 'CONVERSATION_ID', 'MEMORY_DIR']);
  for (const k of Object.keys(env)) if (routing.has(k.toUpperCase())) delete env[k as keyof typeof env];
  return env;
}
export function cliPath() {
  const dir = join(root, 'node_modules/@letta-ai/letta-code');
  if (json(join(dir, 'package.json')).version !== version) throw new Error(`必须使用 Letta Code ${version}，请运行 npm ci。`);
  return join(dir, 'letta.js');
}
export function redact(s: string) { const key = process.env.PPA_MODEL_API_KEY; return key ? s.split(key).join('[redacted]') : s; }
export function cli(p: Locations, args: string[], timeout = 60000) {
  mkdirSync(p.workspace, { recursive: true });
  const r = spawnSync(process.execPath, [cliPath(), ...args], { cwd: p.workspace, env: childEnv(p), encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(redact(`Letta ${args[0]} 失败：${r.error?.message ?? ''} ${r.stderr} ${r.stdout}`).slice(0, 2000));
  return redact(r.stdout);
}
export function cliAsync(p: Locations, args: string[], timeout = 60000): Promise<string> {
  mkdirSync(p.workspace, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath(), ...args], { cwd: p.workspace, env: childEnv(p), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeout);
    child.stdout.on('data', d => { out = (out + d).slice(-8 * 1024 * 1024); }); child.stderr.on('data', d => { err = (err + d).slice(-4000); });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => { clearTimeout(timer); if (code !== 0 || expired) reject(new Error(redact(`后台配置失败：${expired ? '超时' : err}`).slice(0, 2000))); else resolve(redact(out)); });
  });
}
export async function modelIds(c: LettaConfig) {
  const r = await fetch(c.modelBaseUrl + '/models', { signal: AbortSignal.timeout(5000), headers: process.env.PPA_MODEL_API_KEY ? { Authorization: `Bearer ${process.env.PPA_MODEL_API_KEY}` } : {} });
  if (!r.ok) throw new Error(`模型列表 HTTP ${r.status}`);
  const v = await r.json() as { data?: { id: string }[] };
  const ids = v.data?.map(m => m.id).filter(id => typeof id === 'string' && id.length);
  if (!ids?.length) throw new Error('模型列表为空。');
  if (c.modelId && !ids.includes(c.modelId)) throw new Error('配置的模型不在服务列表中。');
  return ids;
}
export function agentFile(p: Locations, id: string) {
  if (!/^agent-local-[a-zA-Z0-9-]+$/.test(id)) throw new Error('拒绝非本地 Agent ID。');
  const dir = join(p.store, 'agents');
  const matches = readdirSync(dir).filter(n => n.endsWith('.json') && json(join(dir, n)).id === id);
  if (matches.length !== 1) throw new Error('本地 Agent 缺失或重复，禁止自动创建替代助手。');
  return join(dir, matches[0]);
}
export function memoryDir(p: Locations, id: string) { agentFile(p, id); return join(p.store, 'memfs', id, 'memory'); }
export function configureAgent(p: Locations, id: string, c: LettaConfig, initialModel?: string) {
  // Version-pinned native state adapter. Run only with no Letta process alive.
  const file = agentFile(p, id), a = json(file);
  if (!a.model_settings || typeof a.system !== 'string') throw new Error('不支持的 Letta Agent 存储结构。');
  const previous = existsSync(p.settings) ? json(p.settings) : null;
  if (initialModel || (c.modelId && previous?.modelId !== c.modelId)) a.model = 'openai-compatible/' + (initialModel ?? c.modelId);
  a.model_settings = { ...a.model_settings, context_window_limit: c.contextWindow, max_tokens: c.maxTokens };
  atomicJson(file, a); atomicJson(p.settings, c);
}
export function connect(p: Locations, c: LettaConfig) {
  cli(p, ['connect', 'openai-compatible', '--base-url', c.modelBaseUrl, '--api-key', process.env.PPA_MODEL_API_KEY ?? 'local-no-key']);
}
export const sessionArgs = (id: string) => ['--backend', 'local', '--agent', id, '--no-mods', '--skill-sources', 'bundled,agent', '--reflection-trigger', 'off', '--permission-mode', 'standard'];
export async function launch(p: Locations, id: string, extra: string[] = [], inherit = true) {
  const args = [...sessionArgs(id), ...extra];
  const child = spawn(process.execPath, [cliPath(), ...args], { cwd: p.workspace, env: childEnv(p), stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], windowsHide: !inherit });
  const lockOwner = join(p.data, 'instance.lock/owner.json');
  if (existsSync(lockOwner)) atomicJson(lockOwner, { ...json<Record<string, unknown>>(lockOwner), childPid: child.pid });
  let out = ''; if (!inherit) { child.stdout!.on('data', d => { out += d; }); child.stderr!.on('data', d => { out += d; }); }
  return new Promise<{ code: number; output: string }>((done, fail) => { child.on('error', fail); child.on('exit', code => done({ code: code ?? 1, output: redact(out) })); });
}
