import { existsSync, mkdirSync } from 'node:fs';
import { acquireLock } from './lock.js';
import { locations, readConfig, json, cli, modelIds, connect, configureAgent, launch, redact } from './letta-runtime.js';
import { migrate, backupLetta, restoreLetta, type Migration } from './letta-data.js';
import { readProfiles, selectProfile, writeActiveConfig } from './model-profiles.js';

const p = locations(); mkdirSync(p.data, { recursive: true });
const command = process.argv[2] ?? 'start';
const modelAction = process.argv[3] ?? 'list';
try {
  if (command === 'restore') {
    if (!process.argv[3] || !process.argv[4]) throw new Error('用法：restore <备份目录> <新的数据目录>');
    console.log(restoreLetta(process.argv[3], process.argv[4]));
  } else if (command === 'model' && (modelAction === 'list' || modelAction === 'current')) {
    const profiles = readProfiles();
    if (modelAction === 'list') {
      console.log(JSON.stringify({ profiles: Object.entries(profiles).map(([name, c]) => ({ name, ...c })) }, null, 2));
    } else {
      const c = readConfig(p);
      const matched = Object.entries(profiles).filter(([, candidate]) => candidate.modelBaseUrl === c.modelBaseUrl && candidate.contextWindow === c.contextWindow && candidate.maxTokens === c.maxTokens && (candidate.modelId === null || candidate.modelId === c.modelId)).map(([name]) => name);
      console.log(JSON.stringify({ profile: matched[0] ?? null, ...c }, null, 2));
    }
  } else {
    const release = acquireLock(p.data);
    try {
      if (command === 'backup') console.log(backupLetta(p));
      else if (command === 'migrate') { const m = await migrate(p, readConfig(p)); console.log(JSON.stringify({ status: m.status, agentId: m.agentId, importedMemories: m.sourceMemoryIds.length, backup: m.legacyBackup })); }
      else if (command === 'model') {
        const action = modelAction;
        const profiles = readProfiles();
        if (action === 'use' || action === 'switch') {
          const name = process.argv[4];
          if (!name) throw new Error('用法：npm run model -- use <配置名>');
          const m = existsSync(p.manifest) ? json<Migration>(p.manifest) : null;
          if (m?.status !== 'complete' || !m.agentId) throw new Error('请先运行 npm run migrate:letta，初始化或迁移助手。');
          const profile = selectProfile(name, profiles);
          const ids = await modelIds(profile);
          const selectedModel = profile.modelId ?? ids[0];
          const active = { ...profile, modelId: selectedModel };
          connect(p, active);
          configureAgent(p, m.agentId, active, selectedModel);
          writeActiveConfig(active);
          console.log(JSON.stringify({ status: 'MODEL_SWITCHED', profile: name, modelBaseUrl: active.modelBaseUrl, modelId: active.modelId, agentId: m.agentId }, null, 2));
        } else throw new Error('用法：npm run model -- list | current | use <配置名>');
      }
      else if (command === 'doctor') {
        const ids = await modelIds(readConfig(p));
        const m = existsSync(p.manifest) ? json<Migration>(p.manifest) : null;
        if (m?.agentId) cli(p, ['agents', 'config', '--agent', m.agentId]);
        console.log(JSON.stringify({ status: 'ENDPOINT_AVAILABLE_NOT_CHAT_VALIDATED', models: ids, agentId: m?.agentId, backend: 'local' }));
      } else if (command === 'start') {
        const c = readConfig(p);
        if (!existsSync(p.manifest)) throw new Error('请先运行 npm run migrate:letta，初始化或迁移助手。');
        const m = json<Migration>(p.manifest);
        if (m.status !== 'complete' || !m.agentId) throw new Error('迁移未完成，请运行 npm run migrate:letta。');
        await modelIds(c); connect(p, c); configureAgent(p, m.agentId, c);
        const result = await launch(p, m.agentId);
        process.exitCode = result.code;
      } else throw new Error(`未知命令：${command}。使用 Letta 原生命令管理记忆和人格。`);
    } finally { release(); }
  }
} catch (e) { console.error(redact(e instanceof Error ? e.message : String(e))); process.exitCode = 1; }
