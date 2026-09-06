import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type Proposal } from '../src/store.js';
import { MemoryDialogue } from '../src/memory-dialogue.js';

const proposal: Proposal = { key: '饮茶偏好', content: '喜欢红茶', evidence: '喜欢红茶', kind: 'preference', certainty: 'inferred', durability: 'stable', sensitivity: 'ordinary', sourceKind: 'user' };
test('natural confirmation requires a visible unique candidate and preserves confirmation source', () => {
  const s = new Store(':memory:');
  try {
    const d = new MemoryDialogue(s, 'global');
    const src = s.addSource('a', 'user', 'interactive', '喜欢红茶');
    const c = s.propose(proposal, src.id); d.offer(c.id!); d.finishReply('我想记住：喜欢红茶。对吗？');
    const reply = s.addSource('a', 'user', 'interactive', '对，就这样记。');
    assert.equal(d.acceptReply(reply)?.status, 'active');
    assert.equal(d.resolve('饮茶偏好').version, 1);
    assert.equal(JSON.parse(s.one<{data:string}>('SELECT data FROM candidates WHERE id=?', c.id!)!.data).confirmationSourceId, reply.id);
    assert.equal(d.acceptReply(reply), undefined);
  } finally { s.close(); }
});
test('unseen, cancelled, ambiguous and interrupted proposals cannot be approved by a vague reply', () => {
  const s = new Store(':memory:');
  try {
    const src = s.addSource('a', 'user', 'interactive', '喜欢红茶');
    const c = s.propose(proposal, src.id);
    const reply = (text: string) => s.addSource('a', 'user', 'interactive', text);
    for (const mode of ['unseen', 'cancelled', 'multiple', 'interrupted', 'generic', 'restart', 'quoted']) {
      let d = new MemoryDialogue(s, 'global'); d.offer(c.id!, mode !== 'unseen');
      if (mode === 'cancelled') d.finishReply('', true);
      if (mode === 'multiple') { const other = s.propose({...proposal, key: '另一个主题'}, src.id); d.offer(other.id!, true); }
      if (mode === 'interrupted') assert.equal(d.acceptReply(reply('聊聊今天的天气')), undefined);
      if (mode === 'restart') d = new MemoryDialogue(s, 'global');
      assert.equal(d.acceptReply(reply(mode === 'generic' ? '好' : mode === 'quoted' ? '“对，就这样记”' : '对，就这样记')), undefined, mode);
    }
    assert.equal(s.search('').length, 0);
    const d = new MemoryDialogue(s, 'global'); d.offer(c.id!, true);
    assert.equal(d.acceptReply(reply('不要记'))?.status, 'rejected');
  } finally { s.close(); }
});
test('topic references resolve current versions and reject ambiguous focus', () => {
  const s = new Store(':memory:');
  try {
    const src = s.addSource('a', 'user', 'interactive', '喜欢红茶');
    s.propose({...proposal, certainty:'stated'}, src.id);
    s.propose({...proposal, key:'第二主题', certainty:'stated', content:'我喜欢红茶'}, src.id);
    const d = new MemoryDialogue(s, 'global'); d.focus(s.search('红茶'));
    assert.throws(() => d.resolve('latest'));
    const old = d.resolve('饮茶偏好');
    const next = s.addSource('a', 'user', 'interactive', '喜欢绿茶');
    const c = s.propose({...proposal, content:next.content, evidence:next.content, targetId:old.id, expectedVersion:old.version}, next.id);
    d.offer(c.id!, true); d.acceptReply(s.addSource('a', 'user', 'interactive', '对，就这样记'));
    assert.equal(d.resolve('饮茶偏好').version, 2);
    s.forget(old.id); assert.throws(() => d.resolve('饮茶偏好'));
  } finally { s.close(); }
});
