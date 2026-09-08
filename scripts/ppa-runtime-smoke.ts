import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { locations, root, readConfig, normalizeConfig, atomicJson, cli, sessionArgs, memoryDir, json, connect, type Locations } from '../src/ppa-runtime.js';
import { migrate, backupLetta, restoreLetta, filesUnder } from '../src/ppa-data.js';
import { acquireLock } from '../src/lock.js';

const reportFile = join(root, '.ppa/reports/letta-live.json');
const previous = process.argv.includes('--resume') ? json(reportFile) : undefined;
const p = locations(previous?.data ?? join(root, '.ppa', `letta-live-${Date.now()}`)); mkdirSync(p.data, { recursive: true });
if(previous) atomicJson(join(p.data,`previous-failure-${Date.now()}.json`),previous);
const report: any = previous ?? { status: 'RUNNING', data: p.data, startedAt: new Date().toISOString(), checks: [] };
report.status='RUNNING'; delete report.error;
const save = () => atomicJson(reportFile, report);
const release = acquireLock(p.data);
function check(name: string, ok: boolean, detail?: unknown) { if(previous && report.checks.some((c:any)=>c.name===name && c.ok))return; report.checks.push({ name, ok, detail }); save(); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) throw new Error(name); }
function memoryText(target: Locations, agent: string) { return filesUnder(join(memoryDir(target, agent), 'system')).map(f => readFileSync(f, 'utf8')).join('\n'); }
function turn(agent: string, name: string, prompt: string, extra: string[] = [], target = p) {
  console.log(`RUN ${name}`);
  if(previous && report.checks.some((c:any)=>c.name===name+'.completed' && c.ok)) {const out=json(join(p.data,name+'.json')).output;const result=out.split('\n').flatMap((line:string)=>{try{return [JSON.parse(line)];}catch{return [];}}).findLast((e:any)=>e.type==='result');return {out,result};}
  const start = Date.now();
  const out = cli(target, [...sessionArgs(agent), '--no-skills', '--output-format', 'stream-json', ...extra, '-p', prompt], 120000);
  atomicJson(join(p.data, name + '.json'), { output: out, elapsedMs: Date.now() - start });
  const events = out.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = events.findLast(e => e.type === 'result');
  check(name + '.completed', !!result && !result.is_error, { elapsedMs: Date.now() - start, result });
  return { out, result };
}
try {
  if(!previous) {
  const db = new DatabaseSync(join(p.data, 'ppa.sqlite'));
  db.exec(`PRAGMA user_version=1; CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('agent_id','fixture-identity'); CREATE TABLE identities(version INTEGER,data TEXT); CREATE TABLE memories(id TEXT,key TEXT,content TEXT,kind TEXT,scope TEXT,version INTEGER,status TEXT);`);
  db.prepare('INSERT INTO identities VALUES(1,?)').run(JSON.stringify({ name: '小舟', personality: '温和简洁地用中文交流，诚实，不编造记忆。', relationship: '测试用个人助手。' }));
  for (let i = 0; i < 6; i++) db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?)').run(`m${i}`, `fact${i}`, `验收代号${i}是蓝舟${i}。`, 'fact', 'global', 1, 'active');
  db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?)').run('withdrawn', 'old', 'WITHDRAWN_MUST_NOT_IMPORT', 'fact', 'global', 1, 'withdrawn'); db.close();
  }
  const configured = readConfig(p);
  const c = normalizeConfig({
    ...configured,
    ...(process.env.PPA_LIVE_SMOKE_BASE ? { modelBaseUrl: process.env.PPA_LIVE_SMOKE_BASE } : {}),
    ...(process.env.PPA_LIVE_SMOKE_PROVIDER ? { provider: process.env.PPA_LIVE_SMOKE_PROVIDER } : {}),
    ...(process.env.PPA_LIVE_SMOKE_MODEL ? { modelId: process.env.PPA_LIVE_SMOKE_MODEL === 'auto' ? null : process.env.PPA_LIVE_SMOKE_MODEL } : {}),
  });
  const m = await migrate(p, c); const id = m.agentId!; report.agentId = id; save();
  const text = memoryText(p, id);
  check('migration', m.sourceMemoryIds.length === 6 && text.includes('蓝舟5') && !text.includes('WITHDRAWN_MUST_NOT_IMPORT'));
  const again = await migrate(p, c); check('idempotency', again.agentId === id && memoryText(p, id) === text);
  const chat = turn(id, 'chat', '你好，你叫什么？验收代号3是什么？简短回答，不调用工具。');
  check('chinese_identity_recall', /小舟/.test(chat.result.result) && /蓝舟3/.test(chat.result.result));
  const mem = memoryDir(p, id);
  turn(id, 'remember', `请记住一个测试偏好：我的测试饮料是柚子茶。请实际编辑你的原生记忆文件保存，不要只口头答应。你的记忆目录是 ${mem}。仅在该目录操作。`, ['--allowedTools', 'Read,Write,Edit,Bash']);
  check('memory_persisted', memoryText(p, id).includes('柚子茶'));
  const recall = turn(id, 'recall', '我的测试饮料是什么？只根据你的记忆简短回答。', ['--new']);
  check('new_conversation_recall', /柚子茶/.test(recall.result.result));
  turn(id, 'revise', '纠正一下：我的测试饮料现在是桂花茶，请把当前记忆中的柚子茶替换为桂花茶。实际编辑记忆，不保留旧饮料作为当前偏好。', ['--allowedTools', 'Read,Write,Edit,Bash']);
  check('memory_revised', memoryText(p, id).includes('桂花茶') && !memoryText(p, id).includes('柚子茶'));
  turn(id, 'forget', '删除当前记忆里关于测试饮料的整条偏好。只编辑原生记忆，不删除聊天历史。', ['--allowedTools', 'Read,Write,Edit,Bash']);
  check('memory_deleted', !/柚子茶|桂花茶/.test(memoryText(p, id)));
  const target = join(p.workspace, 'tool-receipt.txt');
  turn(id, 'tools', `只在当前测试目录操作：用 Write 写入 ${target}，内容 PPA_TOOL_OK；用 Read 读取它；用 Bash 执行 Write-Output 'PPA_SHELL_OK'。完成后简短报告。`, ['--new','--permission-mode','acceptEdits','--allowedTools', 'Bash']);
  check('file_side_effect', existsSync(target) && readFileSync(target, 'utf8').trim() === 'PPA_TOOL_OK');
  const toolRecord = json(join(p.data, 'tools.json')).output;
  check('shell_receipt', toolRecord.includes('PPA_SHELL_OK') && toolRecord.includes('tool_return_message'));
  const deniedTarget = join(p.workspace, 'must-not-exist.txt');
  turn(id, 'denied', `请用 Write 工具创建 ${deniedTarget} 内容 denied。若工具被禁止就停止，不用其他方式代替。`, ['--permission-mode','strict']);
  check('permission_denied', !existsSync(deniedTarget));
  const backup = backupLetta(p), restored = locations(p.data + '-restored'); restoreLetta(backup, restored.data); connect(restored, c);
  check('backup_restore_state', json(restored.manifest).agentId === id && memoryText(restored, id) === memoryText(p, id));
  const after = turn(id, 'restored-chat', '验收代号3是什么？简短回答。', [], restored);
  check('backup_restore_chat', after.result.agent_id === id && /蓝舟3/.test(after.result.result));
  report.status = 'LIVE_CORE_PASSED'; save();
} catch (e) { report.status = 'FAILED'; report.error = String(e); save(); console.error(String(e)); process.exitCode = 1; }
finally { release(); }
