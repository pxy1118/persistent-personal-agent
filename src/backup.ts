import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Store, hash, id, now } from './store.js';
import { type Paths, paths as createPaths } from './config.js';
import { inside, canonicalPath } from './actions.js';

export async function createBackup(store: Store, paths: Paths) {
  // Caller holds the application instance lock and only invokes this while Pi is idle.
  const target = resolve(paths.backups, `${now().replace(/[:.]/g, '-')}-${id().slice(0, 8)}`);
  mkdirSync(target, { recursive: true });
  await store.backup(resolve(target, 'ppa.sqlite'));
  cpSync(paths.sessions, resolve(target, 'sessions'), { recursive: true });
  const files: Record<string, string> = {};
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const p = resolve(dir, entry.name); if (entry.isDirectory()) walk(p); else if (entry.isFile()) files[relative(target, p)] = hash(readFileSync(p).toString('base64')); } };
  walk(target);
  writeFileSync(resolve(target, 'manifest.json'), JSON.stringify({ version: 1, createdAt: now(), agentId: store.get('agent_id'), epoch: store.epoch, workspace: paths.workspace, files, note: '不包含凭据、工作区产物和外部副作用；恢复会重映射会话和工作区记忆范围，撤销原授权。' }, null, 2));
  return target;
}

export async function restoreBackup(backupDir: string, target: string) {
  if (existsSync(target)) throw new Error('恢复目标必须是不存在的新目录，禁止覆盖现有数据。');
  const manifest = JSON.parse(readFileSync(resolve(backupDir, 'manifest.json'), 'utf8')) as { version: number; files: Record<string, string>; agentId: string; workspace?: string };
  if (manifest.version !== 1 || !manifest.files?.['ppa.sqlite']) throw new Error('无效备份清单。');
  const sourceRoot = canonicalPath(backupDir);
  for (const [file, digest] of Object.entries(manifest.files)) {
    const source = resolve(backupDir, file); const output = resolve(target, file);
    if (!inside(canonicalPath(source), sourceRoot) || !inside(output, resolve(target)) || lstatSync(source).isSymbolicLink()) throw new Error('备份包含越界路径。');
    if (hash(readFileSync(source).toString('base64')) !== digest) throw new Error(`备份校验失败：${file}`);
  }
  const p = createPaths(target);
  for (const file of Object.keys(manifest.files)) { const output = resolve(target, file); mkdirSync(resolve(output, '..'), { recursive: true }); cpSync(resolve(backupDir, file), output); }
  const store = new Store(p.db);
  try {
    if (store.get('agent_id') !== manifest.agentId || store.one<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check !== 'ok') throw new Error('恢复后的数据库校验失败。');
    store.transaction(() => {
      for (const row of store.all<{ id: string; path: string | null }>('SELECT id,path FROM sessions')) {
        if (row.path) {
          const name = row.path.split(/[/\\]/).at(-1)!; const next = resolve(p.sessions, name);
          store.run('UPDATE sessions SET path=? WHERE id=?', existsSync(next) ? next : null, row.id);
        }
      }
      store.run('UPDATE grants SET active=0');
      if (manifest.workspace) {
        const oldScope = `workspace:${manifest.workspace}`; const newScope = `workspace:${p.workspace}`;
        store.run('UPDATE memories SET scope=? WHERE scope=?', newScope, oldScope);
        store.run('UPDATE withdrawals SET scope=? WHERE scope=?', newScope, oldScope);
        for (const row of store.all<{ id: string; version: number; data: string }>('SELECT * FROM memory_history')) {
          const value = JSON.parse(row.data); if (value.scope === oldScope) { value.scope = newScope; store.run('UPDATE memory_history SET data=? WHERE id=? AND version=?', JSON.stringify(value), row.id, row.version); }
        }
        for (const row of store.all<{ id: string; data: string }>('SELECT id,data FROM candidates')) {
          const value = JSON.parse(row.data); if (value.scope === oldScope) { value.scope = newScope; store.run('UPDATE candidates SET data=? WHERE id=?', JSON.stringify(value), row.id); }
        }
      }
      store.run("UPDATE actions SET status='unknown' WHERE status='dispatched'");
      store.run("UPDATE actions SET status='cancelled' WHERE status IN ('proposed','authorized')");
    });
    // Restoring data never restores authority over the old machine's resources.
    store.set('initialized', '1');
  } finally { store.close(); }
  return `已恢复到 ${p.data}。原授权已撤销；设置 PPA_DATA_DIR 指向该目录后启动，并重新授权工作目录。`;
}
