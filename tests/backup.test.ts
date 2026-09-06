import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { paths } from '../src/config.js';
import { createBackup, restoreBackup } from '../src/backup.js';
import { Actions } from '../src/actions.js';

test('consistent backup verifies and restores into isolated directory; original is untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ppa-backup-')); const p = paths(join(dir, 'original')); const s = new Store(p.db);
  try {
    const agent = s.get('agent_id'); s.session('session', join(p.sessions, 'session.jsonl'));
    writeFileSync(join(p.sessions, 'session.jsonl'), '{"type":"session"}\n');
    const a = new Actions(s); a.grant('write', p.workspace);
    const source = s.addSource('session', 'user', 'interactive', '我喜欢红茶');
    s.propose({ key: '饮茶', content: '我喜欢红茶', kind: 'preference', evidence: '我喜欢红茶', certainty: 'stated', durability: 'stable', sensitivity: 'ordinary', sourceKind: 'user' }, source.id);
    s.propose({ key: '项目饮茶', content: '我喜欢红茶', kind: 'preference', scope: `workspace:${p.workspace}`, evidence: '我喜欢红茶', certainty: 'stated', durability: 'stable', sensitivity: 'ordinary', sourceKind: 'user' }, source.id);
    const backup = await createBackup(s, p); const restored = join(dir, 'restored'); await restoreBackup(backup, restored);
    const copy = new Store(join(restored, 'ppa.sqlite'));
    try { assert.equal(copy.get('agent_id'), agent); assert.equal(copy.search('红茶').length, 1); assert.equal(copy.search('红茶', `workspace:${join(restored, 'workspace')}`).length, 2); assert.equal(new Actions(copy).grants().length, 0); assert.equal(copy.canResume(join(restored, 'sessions/session.jsonl')), true); }
    finally { copy.close(); }
    assert.equal(a.grants().length, 1); await assert.rejects(restoreBackup(backup, restored));
    writeFileSync(join(backup, 'sessions/session.jsonl'), 'corruption');
    await assert.rejects(restoreBackup(backup, join(dir, 'corrupt')), /校验失败/);
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});
