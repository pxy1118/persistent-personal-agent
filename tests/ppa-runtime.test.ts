import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { locations, atomicJson, json, childEnv, agentFile, cliPath, configureAgent, normalizeConfig, modelApiKey, modelHandle, modelIds, root, upstreamVersion, version } from '../src/ppa-runtime.js';
import { readLegacy, renderImport, backupLetta, restoreLetta } from '../src/ppa-data.js';
import { addProfile, readProfiles, selectProfile, writeActiveConfig } from '../src/model-profiles.js';
import { acquireLock } from '../src/lock.js';
import { PpaSession } from '../src/ppa-session.js';

function fixture() {
  const p = locations(mkdtempSync(join(tmpdir(), 'ppa-runtime-test-')));
  mkdirSync(join(p.store, 'agents'), { recursive: true });
  const id = 'agent-local-test';
  atomicJson(join(p.store, 'agents', 'fixture.json'), { id, model: 'openai-compatible/original', model_settings: {}, system: 'native' });
  atomicJson(p.manifest, { version: 1, status: 'complete', agentId: id });
  atomicJson(p.settings, { modelBaseUrl: 'http://localhost:8080/v1', modelId: null, contextWindow: 32768, maxTokens: 4096 });
  return { p, id };
}

test('runtime entry resolves from the project-owned PPA package', () => {
  const entry = cliPath();
  const pkg = json(join(dirname(entry), 'package.json'));
  assert.equal(basename(entry), 'ppa-runtime.js');
  assert.equal(pkg.name, '@ppa/runtime');
  assert.equal(pkg.version, version);
  assert.equal(upstreamVersion, '0.31.12');
  assert.equal(existsSync(join(root, 'node_modules/@letta-ai/letta-code')), false);
});
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
  configureAgent(p, id, { ...json(p.settings), modelId: 'replacement', provider: 'llama-cpp' }); assert.equal(json(agentFile(p,id)).model, 'llama.cpp/replacement');
});
test('model config provider defaults to openai-compatible and validates llama-cpp handles', () => {
  const base = { modelBaseUrl: 'http://127.0.0.1:8080/v1', modelId: 'x', contextWindow: 4096, maxTokens: 1024 };
  assert.equal(normalizeConfig(base).provider, 'openai-compatible');
  const llm = normalizeConfig({ ...base, provider: 'llama-cpp' });
  assert.equal(llm.provider, 'llama-cpp');
  assert.equal(modelHandle(llm, 'qwen.gguf'), 'llama.cpp/qwen.gguf');
  assert.equal(modelHandle(normalizeConfig(base), 'qwen.gguf'), 'openai-compatible/qwen.gguf');
  assert.throws(() => normalizeConfig({ ...base, provider: 'ollama' }), /provider 无效/);
  assert.throws(() => normalizeConfig({ ...base, apiKeyEnv: 'BAD-NAME' }), /apiKeyEnv/);
});
test('remote profiles reference environment credentials without persisting secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ppa-profile-test-')), file = join(dir, 'models.json');
  atomicJson(file, { local: { modelBaseUrl: 'http://127.0.0.1:8080/v1', modelId: 'local', contextWindow: 4096, maxTokens: 1024 } });
  const cloud = addProfile('cloud', { modelBaseUrl: 'https://api.example.com/v1', modelId: 'online-model', contextWindow: 32768, maxTokens: 4096, apiKeyEnv: 'TEST_CLOUD_API_KEY' }, file);
  assert.equal(cloud.provider, 'openai-compatible');
  assert.equal(json<any>(file).cloud.apiKeyEnv, 'TEST_CLOUD_API_KEY');
  assert.ok(!readFileSync(file, 'utf8').includes('super-secret'));
  process.env.TEST_CLOUD_API_KEY = 'super-secret';
  try { assert.equal(modelApiKey(cloud), 'super-secret'); } finally { delete process.env.TEST_CLOUD_API_KEY; }
  assert.throws(() => modelApiKey(cloud), /未设置/);
  assert.throws(() => addProfile('insecure', { ...cloud, modelBaseUrl: 'http://api.example.com/v1' }, file), /HTTPS/);
});
test('model discovery uses the credential selected by the profile', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer profile-secret');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'online-model' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  process.env.TEST_PROFILE_API_KEY = 'profile-secret';
  try {
    const config = normalizeConfig({ modelBaseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'online-model', contextWindow: 4096, maxTokens: 1024, apiKeyEnv: 'TEST_PROFILE_API_KEY' });
    assert.deepEqual(await modelIds(config), ['online-model']);
  } finally {
    delete process.env.TEST_PROFILE_API_KEY;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
test('live model switch sends the original endpoint directly to PPA Runtime', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'online-model' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const { p } = fixture(), session = new PpaSession(p), calls: any[] = [];
  session.online = true;
  (session as any).client = {};
  (session as any).runtime = { agent_id: session.agentId, conversation_id: 'default' };
  (session as any).request = async (type: string, payload: unknown) => { calls.push({ type, payload }); return {}; };
  try {
    const config = normalizeConfig({ modelBaseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'online-model', contextWindow: 4096, maxTokens: 1024 });
    await session.changeModel(config, () => {});
    const connected = calls.find(call => call.type === 'connect_provider');
    assert.equal(connected.payload.fields.baseUrl, config.modelBaseUrl);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
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
  mkdirSync(join(p.data,'pet')); atomicJson(join(p.data,'pet/preferences.json'),{initiative_off:true});
  const b = backupLetta(p), target = p.data + '-restored'; restoreLetta(b,target);
  assert.equal(json(join(target,'pet/preferences.json')).initiative_off,true);
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
  const result=spawnSync(process.execPath,['--import','tsx','--import',offline,join(root,'src/ppa-cli.ts')],{cwd:root,env:{...process.env,PPA_DATA_DIR:p.data},encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(result.status,1);assert.deepEqual(readFileSync(agentFile(p,id)),before);assert.equal(existsSync(join(p.data,'instance.lock')),false);assert.equal(json(p.manifest).agentId,id);
});
