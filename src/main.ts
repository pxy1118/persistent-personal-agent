import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { InteractiveMode, createFindTool, createGrepTool } from '@earendil-works/pi-coding-agent';
import { config, modelIds, paths, type Paths } from './config.js';
import { Store } from './store.js';
import { Actions } from './actions.js';
import { acquireLock } from './lock.js';
import { createPpaRuntime } from './pi-adapter.js';
import { createBackup, restoreBackup } from './backup.js';
import { loadProjectIdentity, applyProjectIdentity } from './identity.js';

export function protectedPaths(p: Paths) { return [p.db, `${p.db}-wal`, `${p.db}-shm`, p.agent, p.sessions, p.backups, resolve(p.data, 'instance.lock')]; }
async function main() {
  // Only affects this PPA process. Prevent Pi startup catalog/package network checks.
  const c = config(); const p = paths(); const mode = process.argv[2] ?? 'chat';
  if (mode === 'setup-tools') {
    process.env.PI_OFFLINE = '';
    console.log('使用 Pi 原生工具安装所需的 fd / rg，文件保存在 PPA 私有目录；不启动模型。');
    const signal = AbortSignal.timeout(180000);
    await createFindTool(p.workspace).execute('setup-find', { pattern: '*.txt' }, signal);
    await createGrepTool(p.workspace).execute('setup-grep', { pattern: 'PPA' }, signal);
    console.log('Pi 搜索工具已就绪。'); return;
  }
  if (mode === 'doctor') {
    let models: string[] = []; let error: string | undefined;
    try { models = await modelIds(c); } catch (e) { error = String(e); }
    console.log(JSON.stringify({ node: process.version, pi: '0.85.0', data: p.data, modelBaseUrl: c.modelBaseUrl, models, modelStatus: error ? 'UNAVAILABLE_NOT_VALIDATED' : 'ENDPOINT_AVAILABLE_NOT_CHAT_VALIDATED', error, existingDatabase: existsSync(p.db) }, null, 2));
    if (error) process.exitCode = 2; return;
  }
  if (mode === 'restore') {
    if (!process.argv[3] || !process.argv[4]) throw new Error('用法：npm run restore -- <备份目录> <新的数据目录>');
    console.log(await restoreBackup(resolve(process.argv[3]), resolve(process.argv[4]))); return;
  }
  if (!['chat', 'backup', 'identity-apply'].includes(mode)) throw new Error('用法：npm start；npm run doctor；npm run backup；npm run identity:apply；npm run restore -- <备份> <新目录>');
  const release = acquireLock(p.data);
  let store: Store;
  try { store = new Store(p.db, mode === 'backup' ? undefined : loadProjectIdentity()); } catch (e) { release(); throw e; }
  let closed = false;
  const cleanup = () => { if (!closed) { closed = true; try { store.close(); } finally { release(); } } };
  // Pi's native TUI exits the process; its orderly shutdown disposes the runtime first.
  process.once('exit', cleanup);
  let dispose: (() => Promise<void>) | undefined;
  try {
    if (mode === 'identity-apply') {
      const profile = loadProjectIdentity(); const current = store.identity();
      const differs = (['name', 'personality', 'relationship'] as const).some(k => current[k] !== profile[k]);
      const backup = differs ? await createBackup(store, p) : null;
      console.log(JSON.stringify({ ...applyProjectIdentity(store, profile), backup }, null, 2)); return;
    }
    if (mode === 'backup') { console.log(await createBackup(store, p)); return; }
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('聊天需要交互终端。离线检查请用 npm run doctor。');
    const actions = new Actions(store, protectedPaths(p));
    const unknown = actions.recover(); if (unknown.length) console.log(`发现 ${unknown.length} 条结果未知的动作。不会自动重试；进入后用 /actions unknown 查看。`);
    if (!store.get('initialized')) {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        console.log('欢迎使用 PPA。直接回车保留当前人格；首次创建采用 config/identity.json 中的项目设定。'); const old = store.identity();
        const name = await rl.question(`助手名字 [${old.name}]：`);
        const personality = await rl.question('人格基调 [保留当前完整设定]：');
        const relationship = await rl.question('相处方式 [保留当前完整设定]：');
        if (name || personality || relationship) store.saveIdentity({ name: name || old.name, personality: personality || old.personality, relationship: relationship || old.relationship });
        actions.grant('read', p.workspace); actions.grant('write', p.workspace);
        store.set('initialized', '1');
      } finally { rl.close(); }
    }
    const ids = await modelIds(c).catch(e => { throw new Error(`无法连接模型服务：${String(e)}。身份已保存；请启动你自己的模型服务后重试。PPA 不自动启动或修改服务。`); });
    const app = await createPpaRuntime({ store, actions, paths: p, config: c, modelIds: ids });
    dispose = async () => { await app.waitForReset(); await app.runtime.dispose(); };
    console.log(`PPA 工作区：${p.workspace}\n/identity /memory /forget /permissions /actions /backup；Pi 原生 /new /resume /model 可用。`);
    const ui = new InteractiveMode(app.runtime, { migratedProviders: [] });
    await ui.run();
  } finally { try { if (dispose) await dispose(); } finally { cleanup(); process.removeListener('exit', cleanup); } }
}
main().catch(e => { console.error(`PPA: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
