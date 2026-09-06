import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export type Config = { modelBaseUrl: string; modelId: string | null; contextWindow: number; maxTokens: number; memoryBudgetChars: number; extensions: string[]; skills: string[]; reflectionMaxTokens?: number; reflectionTimeoutMs?: number };
export function config(): Config {
  const example = JSON.parse(readFileSync(resolve(root, 'config/local.example.json'), 'utf8'));
  const localPath = resolve(root, 'config/local.json');
  const c = { ...example, ...(existsSync(localPath) ? JSON.parse(readFileSync(localPath, 'utf8')) : {}) } as Config;
  const url = new URL(c.modelBaseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('模型地址必须是无内嵌凭据的 HTTP(S) 地址。');
  for (const k of ['contextWindow', 'maxTokens', 'memoryBudgetChars'] as const) if (!Number.isInteger(c[k]) || c[k] < 256) throw new Error(`配置 ${k} 无效。`);
  if (c.maxTokens >= c.contextWindow) throw new Error('maxTokens 必须小于 contextWindow。');
  if (!Number.isInteger(c.reflectionMaxTokens) || c.reflectionMaxTokens! < 256 || c.reflectionMaxTokens! >= c.contextWindow) throw new Error('reflectionMaxTokens 必须在 256 与 contextWindow 之间。');
  if (!Number.isInteger(c.reflectionTimeoutMs) || c.reflectionTimeoutMs! < 1000 || c.reflectionTimeoutMs! > 180000) throw new Error('reflectionTimeoutMs 必须在 1000–180000 之间。');
  for (const k of ['extensions', 'skills'] as const) {
    if (!Array.isArray(c[k]) || !c[k].every(p => typeof p === 'string')) throw new Error(`配置 ${k} 无效。`);
    c[k] = c[k].map(p => resolve(root, p));
  }
  return c;
}
export function paths(dataDir = process.env.PPA_DATA_DIR ?? resolve(root, '.ppa')) {
  const data = resolve(dataDir);
  const result = { data, db: resolve(data, 'ppa.sqlite'), agent: resolve(data, 'pi'), sessions: resolve(data, 'sessions'), workspace: resolve(data, 'workspace'), backups: resolve(data, 'backups') };
  for (const path of [data, result.agent, result.sessions, result.workspace, result.backups]) mkdirSync(path, { recursive: true });
  return result;
}
export type Paths = ReturnType<typeof paths>;
export async function modelIds(c: Config) {
  const response = await fetch(`${c.modelBaseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(5000), headers: process.env.PPA_MODEL_API_KEY ? { Authorization: `Bearer ${process.env.PPA_MODEL_API_KEY}` } : {} });
  if (!response.ok) throw new Error(`模型列表 HTTP ${response.status}`);
  const data = await response.json() as { data?: { id: string }[] };
  const ids = data.data?.map(m => m.id).filter(x => typeof x === 'string' && x.length);
  if (!ids?.length) throw new Error('模型列表为空。');
  if (c.modelId && !ids.includes(c.modelId)) throw new Error(`配置模型不在服务列表中：${c.modelId}`);
  return ids;
}
