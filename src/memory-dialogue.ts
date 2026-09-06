import { Store, type Memory, type Source } from './store.js';

const compact = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');

/** Per-session conversational references. Never resolves a vague confirmation after restart or an intervening topic. */
export class MemoryDialogue {
  private offers = new Map<string, string>();
  private focused: string[] = [];
  private visible = new Set<string>();
  constructor(readonly store: Store, readonly scope: string) {}
  focus(rows: Memory[]) { this.focused = rows.map(m => m.id); }
  resolve(reference: string): Memory {
    let rows: Memory[];
    if (['latest', '刚才那条', '上一条', '刚才'].includes(reference)) rows = this.focused.map(id => this.store.memory(id)).filter((m): m is Memory => !!m && m.status === 'active');
    else rows = this.store.all<Memory>("SELECT * FROM memories WHERE status='active' AND (scope='global' OR scope=?)", this.scope).filter(m => m.id === reference || compact(m.key) === compact(reference));
    if (rows.length !== 1) throw new Error(rows.length ? '对应多条记忆，请先检索并明确主题，不要猜测。' : '未找到有效记忆，请先 search 检索，再用返回的主题 key。');
    return rows[0];
  }
  offer(candidateId: string, visible = false): string {
    const row = this.store.one<{ data: string; status: string }>('SELECT data,status FROM candidates WHERE id=?', candidateId);
    if (!row || row.status !== 'pending') throw new Error('候选不存在或已处理。');
    const p = JSON.parse(row.data) as { content: string };
    this.offers.set(candidateId, p.content); if (visible) this.visible.add(candidateId); return p.content;
  }
  finishReply(text: string, failed = false) {
    if (failed) { this.offers.clear(); this.visible.clear(); return; }
    for (const [id, content] of this.offers) if (text.includes(content)) this.visible.add(id);
  }
  acceptReply(source: Source): { status: string; id?: string } | undefined {
    const offered = [...this.offers.keys()]; const seen = offered.every(id => this.visible.has(id)); this.offers.clear(); this.visible.clear();
    if (!seen || source.origin !== 'interactive' || source.role !== 'user' || source.epoch !== this.store.epoch || offered.length !== 1) return;
    if (/^[\s]*[>"'“‘「『`]/u.test(source.content)) return;
    const reply = compact(source.content);
    const approve = /^(?:确认记住|确认保存|对就这样记|对就这么记|是的就这样记|就这样记吧?|就这么记吧?|按这个记|可以记住)$/.test(reply);
    const reject = /^(?:不要记|别记了|不保存|不要保存|拒绝保存|不用记了)$/.test(reply);
    if (!approve && !reject) return;
    return this.store.review(offered[0], approve, source.id);
  }
  pendingReference(reference?: string) {
    const rows = this.store.all<{ id: string; data: string }>("SELECT c.id,c.data FROM candidates c JOIN sources s ON s.id=c.source_id WHERE c.status='pending' AND s.epoch=?", this.store.epoch)
      .filter(r => { const p = JSON.parse(r.data) as { scope?: string; key: string }; return (!p.scope || p.scope === 'global' || p.scope === this.scope) && (!reference || r.id === reference || compact(p.key) === compact(reference)); });
    if (rows.length !== 1) throw new Error('请明确要确认的候选主题；当前不是唯一候选。');
    return rows[0];
  }
}
