import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { locations, atomicJson, json, childEnv, agentFile, configureAgent, root } from '../src/letta-runtime.js';
import { readLegacy, renderImport, backupLetta, restoreLetta } from '../src/letta-data.js';
import { readProfiles, selectProfile, writeActiveConfig } from '../src/model-profiles.js';
import { acquireLock } from '../src/lock.js';

function fixture() {
  const p = locations(mkdtempSync(join(tmpdir(), 'ppa-letta-test-')));
  mkdirSync(join(p.store, 'agents'), { recursive: true });
  const id = 'agent-local-test';
  atomicJson(join(p.store, 'agents', 'fixture.json'), { id, model: 'openai-compatible/original', model_settings: {}, system: 'native' });
  atomicJson(p.manifest, { version: 1, status: 'complete', agentId: id });
  atomicJson(p.settings, { modelBaseUrl: 'http://localhost:8080/v1', modelId: null, contextWindow: 32768, maxTokens: 4096 });
  return { p, id };
}
test('only effective global/current-workspace memories and latest identity are selected', () => {
  const { p } = fixture(), db = new DatabaseSync(join(p.data, 'ppa.sqlite'));
  db.exec(`PRAGMA user_version=1; CREATE TABLE meta(key,value); INSERT INTO meta VALUES('agent_id','old-id'); CREATE TABLE identities(version,data); CREATE TABLE memories(id,key,content,kind,scope,version,status);`);
  const put = db.prepare('INSERT INTO identities VALUES(?,?)'); put.run(1, JSON.stringify({ name: 'old' })); put.run(2, JSON.stringify({ name: 'new', personality: 'kind', relationship: 'friend' }));
  const row = db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?)');
  row.run('a','a','current','fact','global',1,'active'); row.run('b','b','withdrawn','fact','global',1,'withdrawn'); row.run('c','c','other','fact','workspace:other',1,'active'); row.run('d','d','scoped','fact',`workspace:${p.workspace}`,1,'active'); db.close();
  const before = readFileSync(join(p.data, 'ppa.sqlite')); const result = readLegacy(p);
  assert.equal(result.identity.name, 'new'); assert.deepEqual(result.memories.map(m => m.id), ['a', 'd']); assert.deepEqual(readFileSync(join(p.data, 'ppa.sqlite')), before);
  const rendered = renderImport(result); assert.ok(rendered['human.md'].includes('current')); assert.ok(!rendered['human.md'].includes('withdrawn'));
});
test('native model selection survives launch config while bounds update', () => {
  const { p, id } = fixture(); configureAgent(p, id, { ...json(p.settings), maxTokens: 2048 });
  assert.equal(json(agentFile(p,id)).model, 'openai-compatible/original'); assert.equal(json(agentFile(p,id)).model_settings.max_tokens, 2048);
  configureAgent(p, id, { ...json(p.settings), modelId: 'replacement' }); assert.equal(json(agentFile(p,id)).model, 'openai-compatible/replacement');
});
test('model profiles include the vLLM Ornith endpoint and write an active config', () => {
  const profiles = readProfiles(join(root, 'config/models.example.json'));
  const ornith = selectProfile('ornith', profiles);
  assert.equal(ornith.modelBaseUrl, 'http://127.0.0.1:8000/v1');
  assert.equal(ornith.modelId, 'Ornith-1.5');
  const target = join(mkdtempSync(join(tmpdir(), 'ppa-model-test-')), 'local.json');
  writeActiveConfig(ornith, target);
  assert.deepEqual(json(target), ornith);
});
test('missing agent never silently creates a new identity', () => {
  const { p } = fixture(); assert.throws(() => agentFile(p, 'agent-local-missing'), /缺失/); assert.throws(() => agentFile(p, '../cloud'), /非本地/);
});
test('local runtime routing is explicit and cloud identity is not inherited', () => {
  const { p } = fixture(); const env = childEnv(p); assert.equal(env.LETTA_LOCAL_BACKEND_DIR, p.store); assert.equal(env.LETTA_LOCAL_BACKEND_EXPERIMENTAL, '1'); assert.equal(env.LETTA_DISABLE_MODS, '1'); assert.equal(env.LETTA_TELEMETRY_DISABLED,'1'); assert.equal(env.LETTA_BASE_URL, undefined);
});
test('backup restores native data into a new directory without exporting provider credentials', () => {
  const { p, id } = fixture(); mkdirSync(join(p.store,'providers')); atomicJson(join(p.store,'providers/auth.json'), { version:1, providers:{ secret:{auth:{key:'TEST_SECRET'}} } });
  atomicJson(join(p.data,'ppa-terminal.json'),{agentId:id,conversationId:'local-conv-1'});
  mkdirSync(join(p.workspace,'.letta'),{recursive:true}); atomicJson(join(p.workspace,'.letta/settings.local.json'),{ sessionsByServer:{[`local:${p.store}`]:{agentId:id,conversationId:'local-conv-1'}} });
  const b = backupLetta(p), target = p.data + '-restored'; restoreLetta(b,target);
  assert.equal(json(join(target,'letta-migration.json')).agentId,id); assert.ok(!readFileSync(join(b,'letta/providers/auth.json'),'utf8').includes('TEST_SECRET'));
  assert.equal(json(join(target,'ppa-terminal.json')).conversationId,'local-conv-1');
  assert.ok(readFileSync(join(target,'workspace/.letta/settings.local.json'),'utf8').includes(JSON.stringify(join(target,'letta')).slice(1,-1)));
  assert.throws(()=>restoreLetta(b,target),/不存在/);
});
test('restore rejects corruption and traversal before making target', () => {
  const { p }=fixture(), b=backupLetta(p), target=p.data+'-bad'; writeFileSync(join(b,'letta-migration.json'),'corrupt'); assert.throws(()=>restoreLetta(b,target),/校验/); assert.equal(existsSync(target),false);
  const m=json(join(b,'manifest.json')); m.files={'../escape':'bad','letta-migration.json':'bad'}; atomicJson(join(b,'manifest.json'),m); assert.throws(()=>restoreLetta(b,target),/越界/); assert.equal(existsSync(target),false);
});
test('instance lock prevents concurrent migration or backup and respects live orphan child', () => {
  const { p }=fixture(); const release=acquireLock(p.data); assert.throws(()=>acquireLock(p.data),/运行/); release();
  mkdirSync(join(p.data,'instance.lock')); atomicJson(join(p.data,'instance.lock/owner.json'),{pid:2147483647,childPid:process.pid,token:'orphan'}); assert.throws(()=>acquireLock(p.data),/子进程仍在运行/);
});
test('offline startup preserves identity and releases its lock', () => {
  const {p,id}=fixture(); atomicJson(p.settings,{...json<Record<string,unknown>>(p.settings),modelBaseUrl:'http://127.0.0.1:1/v1'});
  const before=readFileSync(agentFile(p,id));
  // Force transport failure without depending on the developer's active config or live services.
  const offline = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = async () => { throw new Error("offline fixture"); };');
  const result=spawnSync(process.execPath,['--import','tsx','--import',offline,join(root,'src/letta-cli.ts')],{cwd:root,env:{...process.env,PPA_DATA_DIR:p.data},encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(result.status,1);assert.deepEqual(readFileSync(agentFile(p,id)),before);assert.equal(existsSync(join(p.data,'instance.lock')),false);assert.equal(json(p.manifest).agentId,id);
});
