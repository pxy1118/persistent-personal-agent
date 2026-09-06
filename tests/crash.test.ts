import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { Actions } from '../src/actions.js';

for (const stage of ['before', 'dispatched', 'after-effect']) test(`real process exit at ${stage} preserves recovery boundary without replay`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ppa-crash-')); const db = join(dir, 'ppa.sqlite'); const marker = join(dir, 'effect.txt');
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('tests/fixtures/crash-child.ts'), db, marker, stage], { timeout: 10000, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 77, result.stderr);
    const store = new Store(db);
    try {
      const actions = new Actions(store); actions.recover(); assert.equal(actions.list()[0].status, stage === 'before' ? 'cancelled' : 'unknown');
      assert.equal(existsSync(marker), stage === 'after-effect');
      if (stage !== 'before') await assert.rejects(actions.begin('new-call', 'new-session', 'fixture', { marker }, process.cwd(), async () => true));
      if (stage === 'after-effect') assert.equal(readFileSync(marker, 'utf8'), 'one effect');
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
