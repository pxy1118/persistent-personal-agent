import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, version, json, atomicJson, digest, cli, memoryDir, agentFile, configureAgent, connect, modelIds, type Locations, type LettaConfig } from './letta-runtime.js';

export type ImportSource = { agentId: string; identity: { name: string; personality: string; relationship: string; version?: number }; memories: { id: string; key: string; content: string; kind: string; scope: string; version: number }[] };
export type Migration = { version: 1; status: 'preparing' | 'complete'; sourceFingerprint: string; oldAgentId: string; agentId?: string; sourceMemoryIds: string[]; createdAt: string; completedAt?: string; legacyBackup?: string; lettaVersion: string };
export function readLegacy(p: Locations): ImportSource {
  const file = join(p.data, 'ppa.sqlite');
  if (!existsSync(file)) return { agentId: 'new', identity: json(join(root, 'config/identity.json')).identity, memories: [] };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1 || db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('旧数据库版本或完整性校验失败。');
    const identity = JSON.parse(String(db.prepare('SELECT data FROM identities ORDER BY version DESC LIMIT 1').get()?.data));
    const memories = db.prepare("SELECT id,key,content,kind,scope,version FROM memories WHERE status='active' AND (scope='global' OR scope=?) ORDER BY id").all(`workspace:${p.workspace}`) as ImportSource['memories'];
    return { agentId: String(db.prepare("SELECT value FROM meta WHERE key='agent_id'").get()?.value), identity, memories };
  } finally { db.close(); }
}
export function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(n => { const p = join(dir, n), s = lstatSync(p); if (s.isSymbolicLink()) throw new Error(`备份不接受链接：${p}`); return s.isDirectory() ? filesUnder(p) : s.isFile() ? [p] : []; });
}
function seal(target: string, extra: object) {
  const files = Object.fromEntries(filesUnder(target).map(f => [relative(target, f), digest(readFileSync(f))]));
  atomicJson(join(target, 'manifest.json'), { version: 2, ...extra, createdAt: new Date().toISOString(), files });
  return target;
}
export async function legacySnapshot(p: Locations) {
  const target = join(p.backups, `pre-letta-${Date.now()}-${randomUUID().slice(0, 8)}`); mkdirSync(target, { recursive: true });
  if (existsSync(join(p.data, 'ppa.sqlite'))) { const db = new DatabaseSync(join(p.data, 'ppa.sqlite'), { readOnly: true }); try { await sqliteBackup(db, join(target, 'ppa.sqlite')); } finally { db.close(); } }
  if (existsSync(join(p.data, 'sessions'))) cpSync(join(p.data, 'sessions'), join(target, 'sessions'), { recursive: true });
  cpSync(join(root, 'config'), join(target, 'config'), { recursive: true });
  const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (rev.status !== 0) throw new Error('无法记录迁移前代码版本。');
  const archive = spawnSync('git', ['archive', '--format=zip', `--output=${join(target, 'code.zip')}`, 'HEAD'], { cwd: root, windowsHide: true });
  if (archive.status !== 0) throw new Error('无法备份迁移前代码。');
  return seal(target, { kind: 'legacy', commit: rev.stdout.trim() });
}
export function renderImport(source: ImportSource) {
  const i = source.identity;
  if (![i.name, i.personality, i.relationship].every(v => typeof v === 'string' && v.trim())) throw new Error('人格数据缺失。');
  return {
    'persona.md': `---\ndescription: 助手的人格与相处方式，可随长期交流自然发展。\n---\n名字：${i.name}\n\n${i.personality}\n\n相处方式：${i.relationship}\n`,
    'human.md': `---\ndescription: 从 PPA 导入的当前有效用户资料；可按后续交流纠正和整理。\n---\n${source.memories.map(m => `- ${m.scope === 'global' ? '' : `（仅适用于工作区 ${m.scope.slice('workspace:'.length)}）`}${m.content}`).join('\n')}\n`,
  };
}
export async function migrate(p: Locations, c: LettaConfig) {
  let record: Migration | undefined = existsSync(p.manifest) ? json(p.manifest) : undefined;
  if (record?.status === 'complete' && record.agentId) { agentFile(p, record.agentId); return record; }
  const source = readLegacy(p), fingerprint = digest(JSON.stringify(source));
  if (record && record.sourceFingerprint !== fingerprint) throw new Error('未完成迁移的来源已改变，请保留现场后使用新的数据目录重新迁移。');
  const ids = await modelIds(c); // Fail before creating an agent when the endpoint is unavailable.
  const model = c.modelId ?? ids[0];
  if (!record) {
    const legacyBackup = await legacySnapshot(p);
    record = { version: 1, status: 'preparing', sourceFingerprint: fingerprint, oldAgentId: source.agentId, sourceMemoryIds: source.memories.map(m => m.id), createdAt: new Date().toISOString(), legacyBackup, lettaVersion: version };
    atomicJson(p.manifest, record);
  }
  connect(p, c);
  const tag = `ppa-import:${fingerprint}`;
  if (!record.agentId) {
    const agents = JSON.parse(cli(p, ['agents', 'list', '--tags', tag]));
    const rows = Array.isArray(agents) ? agents : agents.items;
    if (!Array.isArray(rows) || rows.length > 1) throw new Error('导入目标存在歧义。');
    const agent = rows[0] ?? JSON.parse(cli(p, ['agents', 'create', '--name', source.identity.name, '--personality', 'blank', '--model', `openai-compatible/${model}`, '--tags', tag]));
    record.agentId = agent.id;
    atomicJson(p.manifest, record); // A interrupted create is recovered by its deterministic tag.
  }
  const id = record.agentId!;
  configureAgent(p, id, c, model);
  const mem = memoryDir(p, id), expected = renderImport(source);
  mkdirSync(join(mem, 'system'), { recursive: true });
  for (const [name, content] of Object.entries(expected)) writeFileSync(join(mem, 'system', name), content);
  for (const [name, content] of Object.entries(expected)) if (readFileSync(join(mem, 'system', name), 'utf8') !== content) throw new Error('记忆导入核验失败。');
  for (const args of [['add', '--', 'system/persona.md', 'system/human.md'], ['-c', 'user.name=PPA Migration', '-c', 'user.email=ppa@localhost', 'commit', '--allow-empty', '-m', 'Import current PPA identity and effective memories']]) {
    const r = spawnSync('git', args, { cwd: mem, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`记忆提交失败：${r.stderr}`);
  }
  // Match through the official CLI as well as reading persisted state.
  const checked = JSON.parse(cli(p, ['agents', 'config', '--agent', id]));
  if (!JSON.stringify(checked).includes(id)) throw new Error('Letta 无法加载迁移后的 Agent。');
  record.status = 'complete'; record.completedAt = new Date().toISOString(); atomicJson(p.manifest, record);
  return record;
}
export function backupLetta(p: Locations) {
  const m = json<Migration>(p.manifest); if (m.status !== 'complete' || !m.agentId) throw new Error('迁移尚未完成。'); agentFile(p, m.agentId);
  const target = join(p.backups, `letta-${Date.now()}-${randomUUID().slice(0, 8)}`); mkdirSync(target, { recursive: true });
  for (const name of ['letta', 'letta-home', 'workspace', 'letta-migration.json', 'letta-config.json', 'ppa-terminal.json']) {
    const from = join(p.data, name); if (!existsSync(from)) continue;
    if (lstatSync(from).isDirectory()) filesUnder(from);
    cpSync(from, join(target, name), { recursive: true });
  }
  // Environment API keys must be supplied again after restore. Never export provider credentials.
  const auth = join(target, 'letta/providers/auth.json');
  if (existsSync(auth)) { const a = json(auth); a.providers = {}; atomicJson(auth, a); }
  return seal(target, { kind: 'letta', agentId: m.agentId, lettaVersion: version, sourceData: p.data });
}
export function restoreLetta(source: string, target: string) {
  source = resolve(source); target = resolve(target);
  if (existsSync(target)) throw new Error('恢复目标必须是不存在的新目录。');
  const m = json(join(source, 'manifest.json'));
  if (m.version !== 2 || m.kind !== 'letta' || !m.files || !m.files['letta-migration.json']) throw new Error('无效 Letta 备份。');
  const safe = (base: string, name: string) => { const full = resolve(base, name), r = relative(base, full); if (!r || r.startsWith('..') || isAbsolute(r)) throw new Error('备份路径越界。'); return full; };
  const actual = new Set(filesUnder(source));
  for (const [name, hash] of Object.entries(m.files)) { const file = safe(source, name); safe(target, name); if (!actual.has(file) || digest(readFileSync(file)) !== hash) throw new Error(`备份校验失败：${name}`); }
  mkdirSync(target);
  for (const name of Object.keys(m.files)) { const out = safe(target, name); mkdirSync(dirname(out), { recursive: true }); cpSync(safe(source, name), out); }
  // Native project settings use the absolute local storage path as their session namespace.
  const settings = join(target, 'workspace/.letta/settings.local.json');
  if (existsSync(settings)) { const text = readFileSync(settings, 'utf8'); writeFileSync(settings, text.split(JSON.stringify(m.sourceData).slice(1, -1)).join(JSON.stringify(target).slice(1, -1))); }
  const p = { data: target, store: join(target, 'letta') } as Locations;
  agentFile(p, m.agentId);
  return target;
}
