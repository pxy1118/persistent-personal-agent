import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Store, hash, id, now } from './store.js';

export type Action = { id: string; call_id: string; session_id: string; tool: string; args_hash: string; summary: string; grant_id: string | null; status: string; result: string | null };
export type Grant = { id: string; kind: string; resource: string; session_id: string | null; active: number };
export type Ask = (title: string, detail: string) => Promise<boolean>;
export function canonicalPath(path: string) {
  let existing = resolve(path); const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('无法解析路径。');
    tail.unshift(existing.slice(parent.length).replace(/^[/\\]/, '')); existing = parent;
  }
  return resolve(realpathSync.native(existing), ...tail);
}
export function inside(path: string, root: string) {
  const r = relative(root, path);
  return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export class Actions {
  constructor(readonly store: Store, readonly protectedRoots: string[] = []) {}
  recover() {
    this.store.run("UPDATE actions SET status='unknown',updated_at=? WHERE status='dispatched'", now());
    this.store.run("UPDATE actions SET status='cancelled',updated_at=? WHERE status IN ('proposed','authorized')", now());
    // A shell session grant never survives a process restart, even when a conversation is resumed.
    this.store.run("UPDATE grants SET active=0 WHERE kind='shell'");
    return this.list('unknown');
  }
  list(status?: string) { return this.store.all<Action>(`SELECT * FROM actions ${status ? 'WHERE status=?' : ''} ORDER BY created_at DESC LIMIT 50`, ...(status ? [status] : [])); }
  grants() { return this.store.all<Grant>('SELECT * FROM grants WHERE active=1'); }
  grant(kind: 'read' | 'write' | 'shell', resource: string, sessionId?: string) {
    if (kind !== 'shell') {
      resource = canonicalPath(resource);
      if (!statSync(resource).isDirectory()) throw new Error('目录授权需要现有目录。');
    } else if (!sessionId) throw new Error('Shell 授权必须绑定会话。');
    const grantId = id();
    this.store.run('INSERT INTO grants VALUES (?,?,?,?,1,?)', grantId, kind, resource, sessionId ?? null, now()); return grantId;
  }
  revoke(grantId: string) { this.store.run('UPDATE grants SET active=0 WHERE id=?', grantId); }
  resolveUnknown(actionId: string, result: 'succeeded' | 'failed', evidence: string) {
    if (!evidence.trim()) throw new Error('请提供人工核实依据。');
    const changed = this.store.run("UPDATE actions SET status=?,result=?,updated_at=? WHERE id=? AND status='unknown'", result, evidence, now(), actionId);
    if (!changed.changes) throw new Error('不是待核实动作。');
  }
  async begin(callId: string, sessionId: string, tool: string, args: Record<string, unknown>, cwd: string, ask: Ask, signal?: AbortSignal) {
    const mode = ['read', 'grep', 'find', 'ls'].includes(tool) ? 'read' : ['write', 'edit'].includes(tool) ? 'write' : undefined;
    let target: string | undefined;
    if (mode) {
      const raw = args.path ?? (['ls', 'grep', 'find'].includes(tool) ? '.' : undefined);
      if (typeof raw !== 'string' || raw.includes('\0') || (process.platform === 'win32' && raw.replace(/^[a-z]:/i, '').includes(':'))) throw new Error('无效文件路径。');
      const expanded = raw === '~' ? homedir() : /^~[/\\]/.test(raw) ? resolve(homedir(), raw.slice(2)) : resolve(cwd, raw);
      target = canonicalPath(expanded);
      // Pass exactly the validated path to Pi; do not let its own ~ or symlink resolution reinterpret it.
      args.path = target;
    }
    const digest = hash(stable({ tool, args, cwd }));
    if (this.store.one('SELECT 1 FROM actions WHERE call_id=?', `${sessionId}:${callId}`)) throw new Error('重复工具调用 ID，已阻止重放。');
    if (this.store.one("SELECT 1 FROM actions WHERE args_hash=? AND status='unknown'", digest)) throw new Error('同一动作结果未知，先在 /actions resolve 核实，禁止重试。');
    const actionId = id();
    const summary = stable({ cwd, args }).slice(0, 4000);
    this.store.run('INSERT INTO actions VALUES (?,?,?,?,?,?,NULL,?,NULL,?,?)', actionId, `${sessionId}:${callId}`, sessionId, tool, digest, summary, 'proposed', now(), now());
    try {
      let grantId: string | undefined;
      if (mode) {
        if (this.protectedRoots.some(p => inside(target!, canonicalPath(p)) || (['grep', 'find'].includes(tool) && inside(canonicalPath(p), target!)))) throw new Error('PPA 内部状态和历史只能通过专用管理入口访问；请缩小搜索目录。');
        grantId = this.grants().find(g => g.kind === mode && inside(target!, g.resource))?.id;
        if (!grantId) throw new Error(`目录未获 ${mode} 授权：${target}。请使用 /permissions grant ${mode} <目录>。`);
      } else {
        if (['bash', 'powershell'].includes(tool)) grantId = this.grants().find(g => g.kind === 'shell' && g.session_id === sessionId)?.id;
        if (!grantId) {
          if (!await ask('允许执行？', `${tool}\n${summary}\n使用宿主权限；错误不代表副作用回滚。`)) throw new Error('用户未授权。');
          grantId = `once:${actionId}`;
        }
      }
      if (signal?.aborted) { this.finish(actionId, 'cancelled', '执行前取消'); throw new Error('执行前取消。'); }
      if (!grantId.startsWith('once:') && !this.grants().some(g => g.id === grantId)) throw new Error('授权已撤销。');
      this.store.run("UPDATE actions SET status='authorized',grant_id=?,updated_at=? WHERE id=?", grantId, now(), actionId);
      return actionId;
    } catch (error) {
      this.store.run("UPDATE actions SET status='denied',result=?,updated_at=? WHERE id=? AND status='proposed'", String(error), now(), actionId); throw error;
    }
  }
  dispatch(actionId: string) {
    const a = this.store.one<Action>('SELECT * FROM actions WHERE id=?', actionId);
    if (!a || a.status !== 'authorized') throw new Error('动作不处于授权状态。');
    if (a.grant_id && !a.grant_id.startsWith('once:') && !this.grants().some(g => g.id === a.grant_id)) {
      this.finish(actionId, 'denied', '授权已撤销'); throw new Error('授权已撤销。');
    }
    this.store.run("UPDATE actions SET status='dispatched',updated_at=? WHERE id=?", now(), actionId);
  }
  finish(actionId: string, status: string, result: string) { this.store.run('UPDATE actions SET status=?,result=?,updated_at=? WHERE id=?', status, result.slice(0, 4000), now(), actionId); }
  async execute<T>(callId: string, sessionId: string, tool: string, args: Record<string, unknown>, cwd: string, ask: Ask, execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const actionId = await this.begin(callId, sessionId, tool, args, cwd, ask, signal);
    this.dispatch(actionId);
    let result: T;
    try { result = await execute(); }
    catch (error) { this.finish(actionId, signal?.aborted ? 'unknown' : 'failed', String(error)); throw error; }
    // A result-persistence failure intentionally leaves dispatched, recovered as unknown.
    this.finish(actionId, 'succeeded', '工具正常返回；完整内容见会话记录。'); return result;
  }
}
