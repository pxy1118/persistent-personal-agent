import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

// Read-only export: never import the old application's modules (their constructors migrate data).
if (!process.argv[2]) throw new Error('用法：tsx scripts/export-legacy-identity.ts <旧项目目录> [输出文件]');
const oldRoot = resolve(process.argv[2]);
const output = resolve(process.argv[3] ?? 'exports/legacy-personality.json');
const configPath = resolve(oldRoot, 'config/identity.json');
const statePath = resolve(oldRoot, '.local/agent.json');
const databasePath = resolve(oldRoot, '.local/memory/memory.sqlite');
const configText = readFileSync(configPath, 'utf8');
const base = JSON.parse(configText) as { schemaVersion: number; version: number; name: string; role: string; style: string; principles: string[] };
const state = JSON.parse(readFileSync(statePath, 'utf8')) as { agentId: string };
if (!state.agentId || !base.name || !base.role || !base.style || !Array.isArray(base.principles)) throw new Error('旧项目身份配置不完整。');
const db = new DatabaseSync(databasePath, { readOnly: true });
type Row = { id: string; key: string; content: string; version: number; updated_at: string; source_json: string };
let name: Row | undefined; let address: Row | undefined;
try {
  db.exec('BEGIN');
  const query = db.prepare("SELECT id,key,content,version,updated_at,source_json FROM memories WHERE agent_id=? AND scope='global' AND domain=? AND key=? AND status='active' AND (expires_at IS NULL OR expires_at>?)");
  const time = new Date().toISOString();
  name = query.get(state.agentId, 'relationship', '助手名字', time) as Row | undefined;
  address = query.get(state.agentId, 'human', '称呼', time) as Row | undefined;
  db.exec('COMMIT');
} finally { db.close(); }
const evidence = (row: Row | undefined) => row ? { memoryId: row.id, memoryVersion: row.version, updatedAt: row.updated_at, userWords: (JSON.parse(row.source_json) as { text: string }).text } : null;
// Retain the user's actual form of address, not unrelated user profile fields in the same record.
const addressEvidence = evidence(address);
const preferredName = addressEvidence?.userWords.match(/(?:叫我|称呼我)([^，。！!哦\s]+)/u)?.[1] ?? null;
const result = {
  schemaVersion: 1,
  exportedAt: new Date().toISOString(),
  status: 'EXPORTED_NOT_IMPORTED',
  source: { project: oldRoot, configPath, databasePath, agentId: state.agentId, configSha256: createHash('sha256').update(configText).digest('hex') },
  effectiveIdentity: { ...base, name: name?.content ?? base.name },
  relationship: { userPreferredName: preferredName },
  provenance: { displayName: evidence(name), userPreferredName: addressEvidence },
  suggestedNewIdentity: {
    name: name?.content ?? base.name,
    personality: `${base.style}。${base.principles[0]}`,
    relationship: `${base.role}。${preferredName ? `用户明确喜欢被称为“${preferredName}”。` : ''}`,
  },
  notes: [
    'effectiveIdentity 根据旧版 effectiveIdentity() 的规则合并配置与有效全局助手名字。',
    'suggestedNewIdentity 是面向新版字段的适配，不是旧版原样保存的人格。',
    '旧版未发现持久化的更详细性格设定；不从聊天语气或桌宠素材推断。',
    '未导出旧运行时长提示词、权限、任务、其他用户事实、测试暗号和已撤回内容。',
    '文件未导入新助手，不复制旧 agent_id 到新版身份。',
  ],
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
const verified = JSON.parse(readFileSync(output, 'utf8'));
if (verified.effectiveIdentity.name !== result.effectiveIdentity.name || verified.status !== 'EXPORTED_NOT_IMPORTED') throw new Error('导出校验失败。');
console.log(JSON.stringify({ output, name: result.effectiveIdentity.name, userPreferredName: preferredName, status: result.status }, null, 2));
