import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { PpaSession, type ImageInput, type ToolApproval } from '../src/ppa-session.js';
import { probeAdaptiveThinking } from '../src/adaptive-thinking.js';
import { atomicJson, cliAsync, configureAgent, locations, modelHandle, modelIds, readConfig, root, writeResponseMode, type ResponseMode } from '../src/ppa-runtime.js';

const targetedOpening = process.argv.includes('--targeted-opening');
const repeats = process.argv.includes('--quick') ? 1 : 3;
const p = locations(join(root,'.ppa',`adaptive-live-${Date.now()}`));
const reportFile = join(root,'.ppa/reports',targetedOpening?'adaptive-thinking-opening.json':'adaptive-thinking-live.json');
mkdirSync(p.workspace,{recursive:true});
if(existsSync(reportFile))renameSync(reportFile,join(root,'.ppa/reports',`adaptive-thinking-live-${new Date().toISOString().replace(/[:.]/g,'-')}.json`));
const report:any={status:'RUNNING',startedAt:new Date().toISOString(),data:p.data,repeats,runs:[]};
const save=()=>atomicJson(reportFile,report);
const config=readConfig(p);
let session:PpaSession|undefined;
const redPng:ImageInput={mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgQIAzQd9WQAAAABJRU5ErkJggg=='};
const cases=[
  {category:'greeting',prompt:'你好，简短自然地回应。'},
  {category:'confirmation',prompt:'好，就这样。请自然接话，不要为了显得认真而展开。'},
  {category:'emotional_complex',prompt:'这件事让我很难受，也不知道该不该继续。先回应我的具体感受，再认真分析我应该从哪些事实判断。'},
  {category:'correction',prompt:'纠正一下：不是北京，是上海。请直接承接新意思，不要重述上一段。'},
  {category:'complex',prompt:'请比较“立刻重构”和“先做兼容层”两种方案，说明约束、不确定性和推荐条件。'},
  {category:'tool',prompt:`请读取 ${join(p.workspace,'rhythm-fixture.txt')} 并告诉我其中的验收词。只读，不要修改。`},
  {category:'image',prompt:'看看这张图片，简短说明主要颜色。',images:[redPng]}
];

function median(values:number[]){const rows=[...values].sort((a,b)=>a-b);return rows.length?rows[Math.floor(rows.length/2)]:null;}
function percentile(values:number[],fraction:number){const rows=[...values].sort((a,b)=>a-b);return rows.length?rows[Math.min(rows.length-1,Math.max(0,Math.ceil(rows.length*fraction)-1))]:null;}
async function runTurn(mode:ResponseMode,category:string,prompt:string,images:ImageInput[]=[]){
  await session!.open();
  const row:any={mode,category,startedAt:new Date().toISOString(),events:[],answer:'',usage:[],deliberation:[]};
  report.runs.push(row);save();
  const start=performance.now();let firstText:number|undefined;
  const phase=(data:any)=>row.events.push({type:'phase',phase:data.phase,atMs:Math.round(performance.now()-start),turnId:data.turnId});
  const thinking=(data:any)=>row.events.push({type:'thinking',atMs:Math.round(performance.now()-start),depth:data?.depth,turnId:data?.turnId});
  const text=(chunk:string)=>{if(firstText===undefined)firstText=performance.now()-start;row.answer+=chunk;};
  const usage=(data:any)=>row.usage.push(data);
  const deliberation=(data:any)=>row.deliberation.push(data);
  session!.on('phase',phase);session!.on('thinking',thinking);session!.on('text',text);session!.on('usage',usage);session!.on('deliberation',deliberation);
  try{
    const ended=once(session!,'done');await session!.send(prompt,images);
    const timer=setTimeout(()=>void session!.stop(),120000);const [done]=await ended;clearTimeout(timer);
    row.elapsedMs=Math.round(performance.now()-start);row.firstVisibleTextMs=firstText===undefined?null:Math.round(firstText);row.done=done;row.status=done?.error?'ERROR':'COMPLETE';save();
  }finally{
    session!.off('phase',phase);session!.off('thinking',thinking);session!.off('text',text);session!.off('usage',usage);session!.off('deliberation',deliberation);
  }
}

try{
  const ids=await modelIds(config),modelId=config.modelId??ids[0]!;report.modelId=modelId;
  const probe=await probeAdaptiveThinking(config,modelId);report.capabilityProbe=probe;save();
  if(!probe.available)throw new Error(probe.reason??'自适应思考能力验证未通过。');
  writeFileSync(join(p.workspace,'rhythm-fixture.txt'),'PPA_RHYTHM_OK\n');
  const created=JSON.parse(await cliAsync(p,['agents','create','--name','节奏验收助手','--personality','blank','--model',modelHandle(config,modelId)]));
  atomicJson(p.manifest,{version:1,status:'complete',agentId:created.id});writeResponseMode(p,'native');configureAgent(p,created.id,{...config,modelId},modelId,'native');
  session=new PpaSession(p);await session.start({...config,modelId});
  session.on('approval',(approval:ToolApproval)=>{const path=String(approval.args.file_path??approval.args.path??'');void session!.approve(approval.id,approval.tool==='Read'&&path===join(p.workspace,'rhythm-fixture.txt'));});
  for(const mode of (targetedOpening?['adaptive']:['native','adaptive']) as ResponseMode[]){
    if(mode==='adaptive')await session.setResponseMode('adaptive');
    for(let repeat=1;repeat<=repeats;repeat++)for(const item of cases.filter(item=>!targetedOpening||item.category==='emotional_complex'))await runTurn(mode,item.category,item.prompt,item.images);
  }
  report.summary={};
  for(const mode of ['native','adaptive']){
    const rows=report.runs.filter((r:any)=>r.mode===mode),simple=rows.filter((r:any)=>['greeting','confirmation'].includes(r.category)).map((r:any)=>r.firstVisibleTextMs).filter(Number.isFinite);
    const deliberated=rows.filter((r:any)=>r.deliberation.length),openingFirst=deliberated.filter((r:any)=>{const thinking=r.events.find((event:any)=>event.type==='thinking');return thinking&&Number.isFinite(r.firstVisibleTextMs)&&r.firstVisibleTextMs<thinking.atMs;});
    report.summary[mode]={completed:rows.filter((r:any)=>r.status==='COMPLETE').length,noVisibleText:rows.filter((r:any)=>!Number.isFinite(r.firstVisibleTextMs)).length,simpleFirstVisibleMedianMs:median(simple),simpleFirstVisibleP95Ms:percentile(simple,.95),deliberatedTurns:deliberated.length,openingBeforeDeliberation:openingFirst.length,possibleReasoningLeaks:rows.filter((r:any)=>/<\/?think>|reasoning_content|\bWe need\b/.test(r.answer)).map((r:any)=>({category:r.category,answer:r.answer.slice(0,160)}))};
  }
  report.acceptance={simpleLatencyTargetMet:targetedOpening?null:report.summary.adaptive.simpleFirstVisibleMedianMs<=2000&&report.summary.adaptive.simpleFirstVisibleP95Ms<=5000,allTurnsCompleted:report.runs.every((r:any)=>r.status==='COMPLETE'),automaticSafetyChecksPassed:Object.values(report.summary).every((value:any)=>value.possibleReasoningLeaks.length===0),requiresHumanReview:true};
  report.status='LIVE_REVIEW_REQUIRED';report.finishedAt=new Date().toISOString();save();
  console.log(`完成 ${report.runs.length} 个隔离回合；请人工检查 ${reportFile}`);
}catch(error){report.status='FAILED';report.error=error instanceof Error?error.message:String(error);report.finishedAt=new Date().toISOString();save();console.error(report.error);process.exitCode=1;}
finally{await session?.close();}
