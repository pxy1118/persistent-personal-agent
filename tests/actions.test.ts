import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actions } from '../src/actions.js';
import { acquireLock } from '../src/lock.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ppa-actions-')); const s = new Store(join(dir, 'ppa.sqlite')); const workspace = join(dir, 'workspace'); mkdirSync(workspace);
  const a = new Actions(s, [join(dir, 'ppa.sqlite')]);
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); }); return { dir, s, a, workspace };
}
const yes = async () => true, no = async () => false;
test('ungranted path cannot execute; granted native call has complete ledger', async t => {
  const { a, workspace } = fixture(t); let count = 0;
  await assert.rejects(a.execute('a', 's', 'write', { path: 'note.txt' }, workspace, yes, async () => ++count));
  a.grant('write', workspace);
  assert.equal(await a.execute('b', 's', 'write', { path: 'note.txt' }, workspace, no, async () => ++count), 1);
  assert.equal(a.list().find(x => x.call_id === 's:b')!.status, 'succeeded');
  await assert.rejects(a.execute('b', 's', 'write', { path: 'note.txt' }, workspace, yes, async () => ++count)); assert.equal(count, 1);
});
test('parent traversal, sibling prefix and junction escape cannot use workspace grant', async t => {
  const { a, dir, workspace } = fixture(t); a.grant('write', workspace);
  for (const path of ['../escape.txt', '../workspace-other/x']) await assert.rejects(a.begin(path, 's', 'write', { path }, workspace, yes));
  const outside = join(dir, 'outside'); mkdirSync(outside); symlinkSync(outside, join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(a.begin('junction', 's', 'write', { path: 'link/escape.txt' }, workspace, yes));
});
test('protected internal state stays blocked even with parent grant', async t => {
  const { a, dir, workspace } = fixture(t); a.grant('read', dir);
  await assert.rejects(a.begin('read-db', 's', 'read', { path: '../ppa.sqlite' }, workspace, yes));
});
test('shell requires consent, scoped consent expires at restart and revoke takes effect', async t => {
  const { a, workspace } = fixture(t);
  await assert.rejects(a.begin('denied', 's', 'powershell', { command: 'test' }, workspace, no));
  const g = a.grant('shell', '*', 's'); const pending = await a.begin('approved', 's', 'powershell', { command: 'test' }, workspace, no);
  a.revoke(g); assert.throws(() => a.dispatch(pending));
  a.grant('shell', '*', 's'); a.recover(); assert.equal(a.grants().filter(g => g.kind === 'shell').length, 0);
});
test('crash before dispatch cancels; crash after dispatch becomes unknown and blocks same arguments', async t => {
  const { a, s, workspace } = fixture(t);
  const before = await a.begin('before', 's', 'powershell', { command: 'one' }, workspace, yes);
  const after = await a.begin('after', 's', 'powershell', { command: 'two' }, workspace, yes); a.dispatch(after);
  const restarted = new Actions(s); restarted.recover();
  assert.equal(a.list().find(x => x.id === before)!.status, 'cancelled'); assert.equal(a.list().find(x => x.id === after)!.status, 'unknown');
  await assert.rejects(restarted.begin('retry', 'new-session', 'powershell', { command: 'two' }, workspace, yes));
  restarted.resolveUnknown(after, 'failed', '人工核实没有产生目标文件');
  assert.ok(await restarted.begin('manual-retry', 'new-session', 'powershell', { command: 'two' }, workspace, yes));
});
test('result persistence failure leaves dispatched rather than falsely marking failed', async t => {
  const { a, workspace } = fixture(t); let effects = 0;
  const finish = a.finish.bind(a); a.finish = () => { throw new Error('disk unavailable'); };
  await assert.rejects(a.execute('x', 's', 'custom', {}, workspace, yes, async () => ++effects));
  assert.equal(effects, 1); a.finish = finish; a.recover(); assert.equal(a.list()[0].status, 'unknown');
});
test('execution errors are recorded; pre-start cancellation does not execute', async t => {
  const { a, workspace } = fixture(t); let count = 0;
  await assert.rejects(a.execute('fail', 's', 'custom', {}, workspace, yes, async () => { throw new Error('tool failed'); }));
  assert.equal(a.list()[0].status, 'failed');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(a.execute('cancel', 's', 'custom', { x: 1 }, workspace, yes, async () => ++count, controller.signal)); assert.equal(count, 0);
});
test('single-instance lock excludes concurrent open and releases cleanly', t => {
  const { dir } = fixture(t); const release = acquireLock(dir); assert.throws(() => acquireLock(dir)); release(); const again = acquireLock(dir); again();
});
