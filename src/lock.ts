import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function acquireLock(data: string) {
  const path = resolve(data, 'instance.lock'); const token = randomUUID();
  try { mkdirSync(path); }
  catch (error) {
    if (!existsSync(path)) throw error;
    let owner: { pid: number; token: string };
    try { owner = JSON.parse(readFileSync(resolve(path, 'owner.json'), 'utf8')); }
    catch { throw new Error(`实例锁尚未就绪或损坏，请核实没有 PPA 进程后移走：${path}`); }
    try { process.kill(owner.pid, 0); throw new Error(`PPA 已在运行（PID ${owner.pid}）。`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    // Atomic rename prevents two starters from both claiming a stale lock.
    const stale = resolve(data, `stale-lock-${token}`); renameSync(path, stale);
    rmSync(stale, { recursive: true }); mkdirSync(path);
  }
  writeFileSync(resolve(path, 'owner.json'), JSON.stringify({ pid: process.pid, token }));
  return () => {
    try { if (JSON.parse(readFileSync(resolve(path, 'owner.json'), 'utf8')).token === token) rmSync(path, { recursive: true }); } catch { /* Already removed. */ }
  };
}
