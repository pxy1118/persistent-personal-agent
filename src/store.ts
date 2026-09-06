import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export type Identity = { name: string; personality: string; relationship: string; version: number };
export type MemoryKind = 'fact' | 'preference' | 'episode' | 'relationship';
export type Memory = { id: string; key: string; content: string; kind: MemoryKind; scope: string; source_id: string; evidence: string; version: number; status: string; created_at: string; updated_at: string };
export type Source = { id: string; session_id: string; role: string; origin: string; content: string; epoch: number; created_at: string };
export type Proposal = { key: string; content: string; kind: MemoryKind; scope?: string; evidence: string; certainty: 'stated' | 'inferred' | 'uncertain'; durability: 'stable' | 'temporary'; sensitivity: 'ordinary' | 'sensitive' | 'secret'; sourceKind: 'user' | 'quotation' | 'hypothesis'; targetId?: string; expectedVersion?: number };

const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
export function terms(s: string): Set<string> {
  const parts = s.normalize('NFKC').toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? [];
  return new Set(parts.flatMap(p => /\p{Script=Han}/u.test(p) ? (p.length < 2 ? [p] : Array.from({ length: p.length - 1 }, (_, i) => p.slice(i, i + 2))) : [p]));
}
const secret = /(?:api[ _-]?key|password|密码|口令|私钥|助记词|access[ _-]?token|sk-[a-z0-9]{12})/i;

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly path: string, initialIdentity?: Omit<Identity, 'version'>) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const v = Number(this.one<{ user_version: number }>('PRAGMA user_version')!.user_version);
    if (v > 1) { this.db.close(); throw new Error('数据库版本高于此程序支持的版本。'); }
    if (!v) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE identities (version INTEGER PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, path TEXT UNIQUE, epoch INTEGER NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE sources (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, origin TEXT NOT NULL, content TEXT NOT NULL, epoch INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE memories (id TEXT PRIMARY KEY, key TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id), evidence TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX active_memory_key ON memories(key, scope) WHERE status='active';
        CREATE TABLE memory_history (id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,version));
        CREATE TABLE candidates (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), data TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE withdrawals (key TEXT NOT NULL, scope TEXT NOT NULL, content_hash TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY(key,scope,content_hash));
        CREATE TABLE grants (id TEXT PRIMARY KEY, kind TEXT NOT NULL, resource TEXT NOT NULL, session_id TEXT, active INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE actions (id TEXT PRIMARY KEY, call_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, tool TEXT NOT NULL, args_hash TEXT NOT NULL, summary TEXT NOT NULL, grant_id TEXT, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE timings (id TEXT PRIMARY KEY, kind TEXT NOT NULL, duration_ms REAL NOT NULL, created_at TEXT NOT NULL);
        PRAGMA user_version=1;
      `);
      this.set('agent_id', id()); this.set('epoch', '0');
      this.saveIdentity(initialIdentity ?? { name: 'PPA', personality: '温和自然地用中文交流，诚实，有自己的判断，不刻意讨好。', relationship: '长期相处的个人助手；尊重用户的现实生活和自主选择。' });
    });
  }
  one<T>(sql: string, ...args: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T>(sql: string, ...args: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  run(sql: string, ...args: (string | number | null)[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  get(key: string) { return this.one<{ value: string }>('SELECT value FROM meta WHERE key=?', key)?.value; }
  set(key: string, value: string) { this.run('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value); }
  get epoch() { return Number(this.get('epoch')); }
  identity(): Identity { return JSON.parse(this.one<{ data: string }>('SELECT data FROM identities ORDER BY version DESC LIMIT 1')!.data); }
  saveIdentity(value: Omit<Identity, 'version'>): Identity {
    for (const field of ['name', 'personality', 'relationship'] as const) if (!value[field]?.trim() || value[field].length > 2000) throw new Error('人格字段不能为空或超过 2000 字符。');
    const version = (this.one<{ v: number }>('SELECT MAX(version) AS v FROM identities')?.v ?? 0) + 1;
    const result = { ...value, version };
    this.run('INSERT INTO identities VALUES (?,?,?)', version, JSON.stringify(result), now()); return result;
  }
  session(sessionId: string, path?: string) {
    const old = this.one<{ epoch: number }>('SELECT epoch FROM sessions WHERE id=?', sessionId);
    if (old && old.epoch !== this.epoch) throw new Error('此会话已归档，不能送入模型。');
    this.run('INSERT INTO sessions VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=COALESCE(excluded.path,sessions.path),updated_at=excluded.updated_at', sessionId, path ?? null, this.epoch, now());
    this.set('last_session', sessionId);
  }
  canResume(path: string) { return this.one<{ epoch: number }>('SELECT epoch FROM sessions WHERE path=?', path)?.epoch === this.epoch; }
  addSource(sessionId: string, role: string, origin: string, content: string): Source {
    const value = { id: id(), session_id: sessionId, role, origin, content, epoch: this.epoch, created_at: now() };
    this.run('INSERT INTO sources VALUES (?,?,?,?,?,?,?)', value.id, sessionId, role, origin, content, value.epoch, value.created_at); return value;
  }
  source(sourceId: string) { return this.one<Source>('SELECT * FROM sources WHERE id=?', sourceId); }
  memory(memoryId: string) { return this.one<Memory>('SELECT * FROM memories WHERE id=?', memoryId); }
  search(query: string, scope = 'global', limit = 8): Memory[] {
    const q = terms(query);
    const rows = this.all<Memory>("SELECT * FROM memories WHERE status='active' AND (scope='global' OR scope=?) ORDER BY updated_at DESC", scope);
    return rows.map(m => {
      const t = terms(`${m.key} ${m.content}`);
      const overlap = [...q].filter(w => t.has(w)).length;
      const score = overlap / Math.sqrt(Math.max(1, q.size * t.size)) + (m.scope === scope ? 0.01 : 0);
      return { m, overlap, score };
    }).filter(x => !q.size || x.overlap > 0).sort((a, b) => b.score - a.score || b.m.updated_at.localeCompare(a.m.updated_at)).slice(0, Math.min(limit, 50)).map(x => x.m);
  }
  propose(p: Proposal, sourceId: string): { status: string; id?: string; reason?: string } {
    const started = performance.now();
    const result = this.transaction(() => {
      const source = this.source(sourceId);
      if (!source || source.epoch !== this.epoch || source.role !== 'user' || source.origin !== 'interactive') throw new Error('没有当前有效的用户来源。');
      if (!p.evidence?.trim() || !source.content.includes(p.evidence)) throw new Error('证据必须来自当前用户原文。');
      if (!p.key?.trim() || !p.content?.trim() || p.key.length > 120 || p.content.length > 2000) throw new Error('记忆文本无效。');
      const scope = p.scope ?? 'global';
      if (scope !== 'global' && !scope.startsWith('workspace:')) throw new Error('无效作用范围。');
      p = { ...p, key: normalize(p.key), scope };
      if (p.sourceKind !== 'user' || p.durability === 'temporary') return { status: 'ignored', reason: '引文、假设及临时要求不进入长期记忆。' };
      if (p.sensitivity === 'secret' || secret.test(p.evidence + p.content)) return { status: 'ignored', reason: '凭据不进入长期记忆。' };
      if (this.one('SELECT 1 FROM withdrawals WHERE (key=? AND scope=?) OR content_hash=?', p.key, scope, hash(normalize(p.content)))) return { status: 'blocked', reason: '内容已撤回。用户可在 /memory restore 中明确重新记住。' };
      const target = p.targetId ? this.memory(p.targetId) : this.one<Memory>("SELECT * FROM memories WHERE key=? AND scope=? AND status='active'", p.key, scope);
      if (p.targetId && (!target || target.status !== 'active' || target.scope !== scope || p.expectedVersion !== target.version)) throw new Error('目标不存在、范围不匹配或版本已变化，请重新检索。');
      if (target?.content === p.content) return { status: 'active', id: target.id };
      // Semantic classification is a model proposal, not a proof. Ambiguity and changes receive human review.
      const quotedEnvelope = /```|^\s*>|[“「"]|(?:以下|这段).{0,6}(?:文章|材料|引用|示例)/m.test(source.content);
      const pending = !!target || p.certainty !== 'stated' || p.sensitivity !== 'ordinary' || quotedEnvelope;
      const data = { ...p, targetId: target?.id, expectedVersion: target?.version };
      if (pending) {
        const fingerprint = hash(JSON.stringify({ sourceId, data }));
        const old = this.one<{ id: string; status: string }>('SELECT id,status FROM candidates WHERE fingerprint=?', fingerprint);
        if (old) return old;
        const candidateId = id();
        this.run('INSERT INTO candidates VALUES (?,?,?,?,?,?)', candidateId, sourceId, JSON.stringify(data), fingerprint, 'pending', now());
        return { status: 'pending', id: candidateId, reason: '需要用户确认内容或修订。' };
      }
      return { status: 'active', id: this.commit(data, sourceId) };
    });
    this.timing('memory.propose', performance.now() - started); return result;
  }
  private commit(p: Proposal, sourceId: string) {
    const old = p.targetId ? this.memory(p.targetId) : undefined;
    if (p.targetId && (!old || old.status !== 'active' || old.version !== p.expectedVersion)) throw new Error('候选目标已经变化。');
    if (old) this.run('INSERT INTO memory_history VALUES (?,?,?)', old.id, old.version, JSON.stringify({ ...old, status: 'superseded' }));
    const memoryId = old?.id ?? id(); const timestamp = now();
    this.run(`INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET key=excluded.key,content=excluded.content,kind=excluded.kind,scope=excluded.scope,source_id=excluded.source_id,evidence=excluded.evidence,version=excluded.version,status=excluded.status,updated_at=excluded.updated_at`, memoryId, p.key, p.content, p.kind, p.scope ?? 'global', sourceId, p.evidence, (old?.version ?? 0) + 1, 'active', old?.created_at ?? timestamp, timestamp);
    return memoryId;
  }
  review(candidateId: string, approve: boolean, confirmationSourceId?: string) {
    return this.transaction(() => {
      const c = this.one<{ status: string; data: string; source_id: string }>('SELECT * FROM candidates WHERE id=?', candidateId);
      if (!c || c.status !== 'pending') throw new Error('候选已处理或不存在。');
      if (confirmationSourceId) {
        const confirmation = this.source(confirmationSourceId);
        if (!confirmation || confirmation.epoch !== this.epoch || confirmation.role !== 'user' || confirmation.origin !== 'interactive') throw new Error('确认需要有效用户来源。');
      }
      const p: Proposal = JSON.parse(c.data);
      if (this.source(c.source_id)?.epoch !== this.epoch) throw new Error('旧来源已归档。');
      if (this.one('SELECT 1 FROM withdrawals WHERE (key=? AND scope=?) OR content_hash=?', p.key, p.scope ?? 'global', hash(normalize(p.content)))) throw new Error('候选对应内容已撤回。');
      const memoryId = approve ? this.commit(p, c.source_id) : undefined;
      this.run('UPDATE candidates SET status=? WHERE id=?', approve ? 'approved' : 'rejected', candidateId);
      if (confirmationSourceId) this.run('UPDATE candidates SET data=? WHERE id=?', JSON.stringify({ ...p, confirmationSourceId }), candidateId);
      return { status: approve ? 'active' : 'rejected', id: memoryId };
    });
  }
  forget(memoryId: string) {
    return this.transaction(() => {
      const m = this.memory(memoryId); if (!m || m.status !== 'active') throw new Error('没有这条有效记忆。');
      const epoch = this.epoch + 1;
      const versions = this.all<{ data: string }>('SELECT data FROM memory_history WHERE id=?', memoryId).map(v => JSON.parse(v.data) as Memory);
      for (const v of [...versions, m]) this.run('INSERT OR IGNORE INTO withdrawals VALUES (?,?,?,?)', v.key, v.scope, hash(normalize(v.content)), epoch);
      this.run("UPDATE memories SET status='withdrawn',updated_at=? WHERE id=?", now(), memoryId);
      this.run("UPDATE candidates SET status='archived' WHERE status='pending'");
      this.set('epoch', String(epoch)); this.set('last_session', '');
      return { status: 'withdrawn', epoch };
    });
  }
  restore(memoryId: string, sourceId: string) {
    return this.transaction(() => {
      const m = this.memory(memoryId); const source = this.source(sourceId);
      if (!m || m.status !== 'withdrawn' || !source || source.epoch !== this.epoch || source.origin !== 'interactive') throw new Error('无法重新记住。');
      if (this.one("SELECT 1 FROM memories WHERE key=? AND scope=? AND status='active'", m.key, m.scope)) throw new Error('已有同主题记忆，请先处理冲突。');
      this.run('DELETE FROM withdrawals WHERE key=? AND scope=?', m.key, m.scope);
      this.run('INSERT OR IGNORE INTO memory_history VALUES (?,?,?)', m.id, m.version, JSON.stringify(m));
      this.run("UPDATE memories SET status='active',version=version+1,source_id=?,evidence=?,updated_at=? WHERE id=?", sourceId, source.content, now(), memoryId);
      return this.memory(memoryId);
    });
  }
  timing(kind: string, duration: number) {
    // Metrics are not authoritative state. A metrics write failure must not turn a committed memory into a reported failure.
    try { this.run('INSERT INTO timings VALUES (?,?,?,?)', id(), kind, duration, now()); } catch { /* Measurement unavailable. */ }
  }
  async backup(target: string) { mkdirSync(dirname(target), { recursive: true }); await backup(this.db, target); }
  close() { this.db.close(); }
}
