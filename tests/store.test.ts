import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Proposal } from '../src/store.js';
import { projection } from '../src/context.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ppa-store-')); const store = new Store(join(dir, 'ppa.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); }); return store;
}
const proposal = (content = '我喜欢喝乌龙茶'): Proposal => ({ key: '饮茶偏好', content, kind: 'preference', evidence: content, certainty: 'stated', durability: 'stable', sensitivity: 'ordinary', sourceKind: 'user' });
test('identity persists independently of sessions and model metadata', t => {
  const s = fixture(t); const agent = s.get('agent_id'); const before = s.identity();
  s.saveIdentity({ ...before, name: '小禾' }); s.session('a', 'session-a'); s.session('b', 'session-b'); s.set('model_id', 'other-model');
  const reopened = new Store(s.path);
  try { assert.equal(reopened.get('agent_id'), agent); assert.equal(reopened.identity().name, '小禾'); assert.equal(reopened.identity().version, 2); } finally { reopened.close(); }
});
test('ordinary Chinese memory commits, deduplicates and retrieves by bigrams', t => {
  const s = fixture(t); const source = s.addSource('a', 'user', 'interactive', '我喜欢喝乌龙茶');
  const first = s.propose(proposal(), source.id); const second = s.propose(proposal(), source.id);
  assert.equal(first.status, 'active'); assert.equal(first.id, second.id); assert.equal(s.search('乌龙茶')[0].id, first.id); assert.equal(s.search('量子力学').length, 0);
});
test('assistant, extension, missing evidence and archived sources cannot commit', t => {
  const s = fixture(t);
  for (const [role, origin] of [['assistant', 'model'], ['user', 'extension']]) {
    const src = s.addSource('a', role, origin, '我喜欢喝乌龙茶'); assert.throws(() => s.propose(proposal(), src.id));
  }
  const src = s.addSource('a', 'user', 'interactive', '你好'); assert.throws(() => s.propose(proposal(), src.id));
});
test('hypotheses, temporary statements and credentials are not memories', t => {
  const s = fixture(t); const src = s.addSource('a', 'user', 'interactive', '我喜欢喝乌龙茶');
  assert.equal(s.propose({ ...proposal(), sourceKind: 'hypothesis' }, src.id).status, 'ignored');
  assert.equal(s.propose({ ...proposal(), durability: 'temporary' }, src.id).status, 'ignored');
  assert.equal(s.propose({ ...proposal(), sensitivity: 'secret' }, src.id).status, 'ignored');
  assert.equal(s.search('').length, 0);
});
test('sensitive and inferred memory require user review; rejected candidates stay rejected', t => {
  const s = fixture(t); const src = s.addSource('a', 'user', 'interactive', '我喜欢喝乌龙茶');
  const p = { ...proposal(), certainty: 'inferred' as const }; const result = s.propose(p, src.id);
  assert.equal(result.status, 'pending'); assert.equal(s.search('').length, 0);
  s.review(result.id!, false); assert.equal(s.propose(p, src.id).status, 'rejected'); assert.throws(() => s.review(result.id!, true));
});
test('revision requires confirmation and optimistic version, supersedes prior content', t => {
  const s = fixture(t); const src = s.addSource('a', 'user', 'interactive', '我喜欢喝乌龙茶'); const m = s.propose(proposal(), src.id);
  const next = s.addSource('a', 'user', 'interactive', '现在我喜欢红茶');
  const p = { ...proposal('现在我喜欢红茶'), targetId: m.id, expectedVersion: 1 };
  const c = s.propose(p, next.id); assert.equal(c.status, 'pending'); assert.equal(s.memory(m.id!)!.version, 1);
  s.review(c.id!, true); assert.equal(s.memory(m.id!)!.version, 2); assert.equal(s.search('乌龙').length, 0); assert.equal(s.search('红茶').length, 1);
  assert.throws(() => s.propose(p, next.id)); assert.equal(s.all('SELECT * FROM memory_history').length, 1);
});
test('forget archives every session and source, blocks renamed content; explicit restore starts new version', t => {
  const s = fixture(t); s.session('a', 'old.jsonl'); const src = s.addSource('a', 'user', 'interactive', '我喜欢喝乌龙茶'); const m = s.propose(proposal(), src.id);
  s.forget(m.id!); assert.equal(s.search('').length, 0); assert.equal(s.canResume('old.jsonl'), false);
  assert.throws(() => s.session('a')); assert.throws(() => s.propose(proposal(), src.id));
  const newSource = s.addSource('b', 'user', 'interactive', '我喜欢喝乌龙茶');
  assert.equal(s.propose({ ...proposal(), key: '换一个名字' }, newSource.id).status, 'blocked');
  s.restore(m.id!, newSource.id); assert.equal(s.memory(m.id!)!.version, 2); assert.equal(s.search('乌龙').length, 1); assert.equal(s.canResume('old.jsonl'), false);
});
test('old pending candidates are invalidated by forget', t => {
  const s = fixture(t); const src = s.addSource('a', 'user', 'interactive', '我喜欢喝乌龙茶'); const m = s.propose(proposal(), src.id);
  const c = s.propose({ ...proposal(), key: '其他偏好', certainty: 'uncertain' }, src.id);
  s.forget(m.id!); assert.throws(() => s.review(c.id!, true));
});
test('scope isolation and bounded relevant projection', t => {
  const s = fixture(t); const src = s.addSource('a', 'user', 'interactive', '我喜欢喝乌龙茶'); s.propose({ ...proposal(), scope: 'workspace:A' }, src.id);
  assert.equal(s.search('乌龙', 'workspace:B').length, 0);
  assert.equal(s.search('乌龙', 'workspace:A').length, 1);
  assert.ok(!projection(s, '乌龙', 'workspace:A', 2).includes('饮茶偏好'));
  assert.ok(!projection(s, '数学', 'workspace:A', 6000).includes('饮茶偏好'));
});
test('transaction failure leaves no partial long-term state', t => {
  const s = fixture(t); assert.throws(() => s.transaction(() => { s.set('partial', 'yes'); throw new Error('simulated disk failure'); })); assert.equal(s.get('partial'), undefined);
});
