import { mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PpaSession, type MemoryDocument } from './ppa-session.js';
import { acquireLock } from './lock.js';
import { locations, readConfig, redact, type LettaConfig } from './ppa-runtime.js';
import { readProfiles, selectProfile, writeActiveConfig } from './model-profiles.js';
import { permissionModes, type PermissionMode } from './permission-modes.js';

export type PetRequest = { id: string; method: string; params?: Record<string, any> };
const media: Record<string, string> = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.bmp':'image/bmp', '.heic':'image/heic', '.heif':'image/heif' };
export async function petImage(path: string) {
  const mimeType = media[extname(path).toLowerCase()];
  if (!mimeType) throw new Error('不支持的图片格式。');
  const s = await stat(path);
  if (!s.isFile() || s.size > 20 * 1024 * 1024) throw new Error('请选择不超过 20MB 的图片文件。');
  const data = await readFile(path);
  if (data.length > 20 * 1024 * 1024) throw new Error('图片超过 20MB。');
  return { mimeType, data: data.toString('base64') };
}

/** Narrow, testable interface. No raw native request or shell method is exposed. */
export class PetBridge {
  private commandBusy = false;
  private cancellation = 0;
  private settled = Promise.resolve();
  private settle?: () => void;
  private stopping?: Promise<unknown>;
  private documents = new Map<string, MemoryDocument>();
  constructor(readonly session: PpaSession, readonly emit: (event: string, data: unknown) => void) {
    for (const event of ['text', 'thinking', 'tool', 'approval', 'done', 'notice', 'mode']) {
      session.on(event, data => { emit(event, data ?? null); if (event !== 'text' && event !== 'thinking') emit('status', this.status()); });
    }
  }
  status() {
    const s = this.session;
    return { name:s.name, agentId:s.agentId, conversationId:s.runtime?.conversation_id, model:s.model, online:s.online, modelReady:s.modelReady, busy:s.busy, mode:s.mode, pending:[...s.pending.values()] };
  }
  async cancelAndWait() { this.cancellation++; await Promise.allSettled([this.settled, this.stopping]); }
  async dispatch(request: PetRequest): Promise<unknown> {
    if (!request || typeof request.id !== 'string' || request.id.length > 100 || typeof request.method !== 'string') throw new Error('无效请求。');
    const p = request.params ?? {};
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('无效参数。');
    const s = this.session;
    if (request.method === 'status') return this.status();
    if (request.method === 'stop') {
      this.cancellation++;
      if (this.stopping) return this.stopping;
      this.stopping = (async () => {
        try { await s.stop(); } catch(e) { if (!s.busy) throw e; }
        if (s.busy) {
          // A hung upstream stream may acknowledge abort without ending the turn.
          // Terminate only our owned child, then restore the same persisted session.
          await s.restart(true);
          this.emit('done', { reason:'cancelled', forced:true });
          this.emit('notice', '后台未及时响应停止，已重连当前会话。输入不会自动重发。');
        }
        this.emit('status', this.status()); return this.status();
      })();
      try { return await this.stopping; } finally { this.stopping = undefined; }
    }
    if (this.stopping) throw new Error('正在停止，请稍候。');
    if (request.method === 'approve') {
      if (typeof p.id !== 'string' || typeof p.allow !== 'boolean') throw new Error('无效审批。');
      await s.approve(p.id, p.allow); this.emit('status', this.status()); return this.status();
    }
    if (request.method === 'mode') {
      if (!permissionModes.includes(p.mode as PermissionMode)) throw new Error('未知权限模式。');
      await s.setMode(p.mode); this.emit('status', this.status()); return this.status();
    }
    if (this.commandBusy) throw new Error('上一操作尚未完成。');
    this.commandBusy = true;
    this.settled = new Promise(resolve => { this.settle = resolve; });
    const epoch = this.cancellation;
    try {
      if (s.busy) throw new Error('正在回复，请等待或停止。输入不会排队。');
      switch (request.method) {
        case 'send': {
          if (typeof p.text !== 'string' || p.text.length > 100000 || (!p.text.trim() && !p.image)) throw new Error('请输入内容。');
          if (p.image !== undefined && typeof p.image !== 'string') throw new Error('无效图片路径。');
          const images = p.image ? [await petImage(p.image)] : [];
          if (epoch !== this.cancellation) throw new Error('已停止，输入未发送，也不会自动重发。');
          await s.send(p.text || '请看看这张图片。', images); return this.status();
        }
        case 'history': return s.history();
        case 'sessions': return s.conversations();
        case 'open':
          if (p.id !== undefined && typeof p.id !== 'string') throw new Error('无效会话。');
          await s.open(p.id);
          return await s.history();
        case 'memories': {
          const docs = await s.memories(); this.documents = new Map(docs.map(d => [d.path, d])); return docs;
        }
        case 'writeMemory': {
          const doc = this.documents.get(p.path);
          if (!doc || p.hash !== doc.hash || typeof p.content !== 'string' || !p.content.trim() || p.content.length > 1000000) throw new Error('请重新打开记忆后编辑。');
          // The UI edits only the body; preserve existing YAML metadata verbatim.
          const header = doc.content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0] ?? '';
          await s.writeMemory(doc, header + p.content.trimEnd() + '\n'); this.documents.delete(doc.path); return { saved:true };
        }
        case 'models': return readProfiles();
        case 'model': await s.changeModel(selectProfile(p.name), writeActiveConfig); return this.status();
        case 'reconnect':
          if (!s.online) await s.restart(true);
          else await s.changeModel(readConfig(s.paths), () => {});
          return this.status();
        default: throw new Error('未知桌宠操作。');
      }
    } finally { this.commandBusy = false; this.settle?.(); this.emit('status', this.status()); }
  }
}

export async function main(config?: LettaConfig) {
  const p = locations(); mkdirSync(p.data, { recursive:true });
  const release = acquireLock(p.data);
  let s: PpaSession;
  try { s = new PpaSession(p); } catch(e) { release(); throw e; }
  let closing = false;
  let startup: Promise<unknown> = Promise.resolve();
  const output = (value: unknown) => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(value) + '\n'); };
  const bridge = new PetBridge(s, (event, data) => output({ event, data }));
  const close = async () => {
    if (closing) return; closing = true;
    try { await bridge.cancelAndWait(); await startup.catch(() => {}); await s.close(); release(); } catch (e) { console.error(redact(String(e))); process.exitCode = 1; }
    process.stdin.destroy();
  };
  process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
  process.stdout.on('error', () => void close());
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { output({event:'error',data:'请求过大。'}); void close(); return; }
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      void (async () => {
        let request: PetRequest | undefined;
        try {
          request = JSON.parse(line);
          if (request?.method === 'shutdown') { await close(); output({id:request.id,result:{closed:true}}); return; }
          if (closing) throw new Error('后台正在退出。');
          const result = await bridge.dispatch(request!); output({id:request!.id,result});
        } catch(e) { output({id:request?.id ?? null,error:redact(e instanceof Error ? e.message : String(e))}); }
      })();
    }
  });
  process.stdin.on('end', () => void close());
  try { startup = s.start(config); await startup; if (closing) return; output({event:'ready',data:bridge.status()}); }
  catch(e) { output({event:'error',data:redact(String(e))}); await close(); process.exitCode = 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { process.stdout.write(JSON.stringify({event:'error',data:redact(String(e))})+'\n'); process.exitCode = 1; });
