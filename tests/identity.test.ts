import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actions } from '../src/actions.js';
import { loadProjectIdentity, applyProjectIdentity } from '../src/identity.js';
import { systemPrompt } from '../src/context.js';

test('project persona seeds new agents; explicit apply preserves state and restart respects later customization', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ppa-identity-')); const path = join(dir, 'ppa.sqlite');
  const profile = loadProjectIdentity(); let store = new Store(path, profile);
  try {
    assert.equal(store.identity().name, profile.name);
    const agent = store.get('agent_id');
    store.saveIdentity({ name: '先前的名字', personality: '先前的性格', relationship: '先前的相处方式' });
    new Actions(store).grant('read', dir);
    const source = store.addSource('s', 'user', 'interactive', '我喜欢乌龙茶');
    store.propose({ key: '饮茶', content: '我喜欢乌龙茶', kind: 'preference', evidence: source.content, sourceKind: 'user', certainty: 'stated', durability: 'stable', sensitivity: 'ordinary' }, source.id);
    const before = { memories: store.all('SELECT * FROM memories'), grants: store.all('SELECT * FROM grants'), sources: store.all('SELECT * FROM sources'), epoch: store.epoch };
    const result = applyProjectIdentity(store, profile);
    assert.equal(result.changed, true); assert.equal(result.identity.version, 3); assert.equal(store.get('agent_id'), agent);
    assert.deepEqual({ memories: store.all('SELECT * FROM memories'), grants: store.all('SELECT * FROM grants'), sources: store.all('SELECT * FROM sources'), epoch: store.epoch }, before);
    assert.ok(systemPrompt(store).includes(profile.name)); assert.ok(systemPrompt(store).includes(profile.relationship.slice(0, 8)));
    assert.equal(applyProjectIdentity(store, profile).changed, false); assert.equal(store.identity().version, 3);
    store.saveIdentity({ ...profile, name: '后来用户修改的名字' }); store.close();
    store = new Store(path, profile);
    assert.equal(store.identity().name, '后来用户修改的名字'); assert.equal(store.identity().version, 4);
    assert.equal(store.get('agent_id'), agent); assert.equal(store.search('乌龙').length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
