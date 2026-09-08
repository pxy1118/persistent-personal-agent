import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, json, normalizeConfig, root, type LettaConfig } from './letta-runtime.js';

export type ModelProfile = LettaConfig;

const exampleFile = join(root, 'config/models.example.json');
const localFile = join(root, 'config/models.json');

function profile(value: unknown, name: string): ModelProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`模型配置 ${name} 无效。`);
  const v = value as Record<string, any>;
  return normalizeConfig({
    modelBaseUrl: v.modelBaseUrl,
    modelId: v.modelId ?? null,
    contextWindow: v.contextWindow,
    maxTokens: v.maxTokens,
    provider: v.provider,
    apiKeyEnv: v.apiKeyEnv,
  });
}

export function readProfiles(file = existsSync(localFile) ? localFile : exampleFile): Record<string, ModelProfile> {
  const raw = json<Record<string, unknown>>(file);
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error('模型配置列表无效。');
  const entries = Object.entries(raw);
  if (!entries.length) throw new Error('模型配置列表为空。');
  return Object.fromEntries(entries.map(([name, value]) => [name, profile(value, name)]));
}

export function selectProfile(name: string, all = readProfiles()): ModelProfile {
  const selected = all[name];
  if (!selected) throw new Error(`未知模型配置：${name}。可用配置：${Object.keys(all).join(', ')}`);
  return selected;
}

export function activeConfigFile() { return join(root, 'config/local.json'); }

export function writeActiveConfig(c: ModelProfile, file = activeConfigFile()) { atomicJson(file, c); }

export function addProfile(name: string, value: unknown, file = localFile) {
  if (!/^[\p{L}\p{N}._-]+$/u.test(name)) throw new Error('配置名只能包含文字、数字、点、下划线或连字符。');
  const profiles = readProfiles(existsSync(file) ? file : exampleFile);
  if (profiles[name]) throw new Error(`模型配置 ${name} 已存在；请编辑 config/models.json 或换一个名称。`);
  const selected = profile(value, name);
  const url = new URL(selected.modelBaseUrl);
  const local = ['localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase()) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!local && url.protocol !== 'https:') throw new Error('远程模型地址必须使用 HTTPS。');
  atomicJson(file, { ...profiles, [name]: selected });
  return selected;
}
