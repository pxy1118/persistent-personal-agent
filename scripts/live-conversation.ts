import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, modelIds, paths } from '../src/config.js';
import { Store } from '../src/store.js';
import { Actions } from '../src/actions.js';
import { loadProjectIdentity } from '../src/identity.js';
import { createPpaRuntime } from '../src/pi-adapter.js';

type Step = { prompt:string; includes?:RegExp; excludes?:RegExp; maxChars?:number; question?:boolean; reflection?:boolean };
const cases: {name:string;steps:Step[]}[] = [
  {name:'普通接话',steps:[{prompt:'你好，晚上好呀。',maxChars:120},{prompt:'嗯，今天还不错。',maxChars:120}]},
  {name:'倾诉与理解纠正',steps:[{prompt:'今天有点累，我只想说说，先不用给我想办法。',maxChars:180},{prompt:'我不是说工作累，是一直等朋友回复，等得心烦。',includes:/朋友|回复|等/,excludes:/工作太|工作压力|工作量/,maxChars:220}]},
  {name:'指代与局部修正',steps:[
    {prompt:'讨论两个虚构方案：甲是周六测试，乙是周日整理文档。只是讨论，先别执行或保存。',maxChars:180},
    {prompt:'我说的是后一个，你理解成什么？',includes:/周日.*文档|文档.*周日/,maxChars:180},
    {prompt:'对，不过不是周日，是周一。复述现在的乙方案，一句话就好。',includes:/周一.*文档|文档.*周一/,excludes:/周日|周六/,maxChars:120},
  ]},
  {name:'歧义不执行',steps:[{prompt:'我在比较两个虚构助手名字小禾和小岚，还没选。先别保存。',maxChars:180},{prompt:'把那个改一下。',question:true,maxChars:180}]},
  {name:'撤回话题',steps:[{prompt:'我在构思一个虚构故事的结尾，暂时没有具体内容，也不用你帮我设计。',maxChars:150},{prompt:'算了，先不聊这个。说句晚安吧。',includes:/晚安/,excludes:/故事|结尾|[？?]/,maxChars:100}]},
  {name:'思考后接住新意图',steps:[
    {prompt:'我做了很久的项目又失败了。先回应我一句，再认真考虑怎么判断该坚持还是换方向，接着只说最重要的一点。',reflection:true,maxChars:420},
    {prompt:'先等等，我不是要建议清单，我只想先把失败的经过讲完。',maxChars:180,excludes:/^\s*\d[.、]/m},
  ]},
];
const repeats = Number(process.argv.find(x=>x.startsWith('--repeat='))?.slice(9) ?? 2);
if(!Number.isInteger(repeats)||repeats<1||repeats>3) throw new Error('repeat 只能是 1–3。');
const started=Date.now(); const c=config();const base=paths();const p=paths(resolve(base.data,'live',`conversation-${started}`));
const store=new Store(p.db,loadProjectIdentity());const rows:Record<string,unknown>[]=[];
let app:Awaited<ReturnType<typeof createPpaRuntime>>|undefined;let error:string|undefined;
try {
  app=await createPpaRuntime({store,actions:new Actions(store),paths:p,config:c,modelIds:await modelIds(c),ask:async()=>false});
  for(let repeat=1;repeat<=repeats;repeat++) for(const scenario of cases){
    if(Date.now()-started>480000) throw new Error('达到本次 8 分钟验收预算，保留已完成记录。');
    await app.runtime.newSession();
    for(const [index,step] of scenario.steps.entries()){
      const start=performance.now();let text='';let reflections=0;let reflectionErrors=0;let observed=0;const openings:string[]=[];let firstMs:number|undefined;
      const off=app.runtime.session.subscribe(e=>{
        if(e.type==='message_update'&&e.assistantMessageEvent.type==='text_delta'){text+=e.assistantMessageEvent.delta;firstMs??=performance.now()-start;}
        if(e.type==='tool_execution_start'&&e.toolName==='reflect'){reflections++;if(e.args.opening?.trim()){openings.push(e.args.opening);text+=e.args.opening+'\n';firstMs??=performance.now()-start;}}
        if(e.type==='tool_execution_end'&&e.toolName==='reflect'){if(e.isError)reflectionErrors++;if(e.result?.details?.reasoningObserved)observed++;}
      });
      const timer=setTimeout(()=>void app!.runtime.session.abort(),75000);
      try{await app.runtime.session.prompt(step.prompt);}finally{clearTimeout(timer);off();}
      const last=[...app.runtime.session.messages].reverse().find(m=>m.role==='assistant');
      const checks={
        completed:!!last&&last.role==='assistant'&&last.stopReason==='stop'&&text.trim().length>0,
        rhythm:step.reflection?reflections>0&&reflectionErrors===0&&observed>0:reflections===0,
        meaning:(!step.includes||step.includes.test(text))&&(!step.excludes||!step.excludes.test(text)),
        concise:text.length<=(step.maxChars??250),
        noProcessNarration:!/(先说我的第一反应|现在[，,]?我.*想完|\[thinking\]|<\/?think>|调用\s*reflect)/i.test(text),
        clarification:!step.question||(/[？?]/.test(text)&&(text.match(/[？?]/g)?.length??0)<=2),
        noRepeatedOpening:openings.every(s=>text.split(s).length<=2),
        noDurableWrite:store.all('SELECT id FROM memories').length===0&&store.all('SELECT id FROM candidates').length===0,
        noAction:store.all('SELECT id FROM actions').length===0,
      };
      const passed=Object.values(checks).every(Boolean);
      rows.push({repeat,scenario:scenario.name,turn:index+1,prompt:step.prompt,text,checks,passed,reflections,firstMs,durationMs:performance.now()-start});
      console.log(JSON.stringify({repeat,scenario:scenario.name,turn:index+1,passed,failed:Object.entries(checks).filter(([,ok])=>!ok).map(([key])=>key)}));
    }
  }
}catch(e){error=String(e);process.exitCode=1;}
finally{
  if(app){await app.waitForReset();await app.runtime.dispose();}store.close();
  const passed=rows.filter(r=>r.passed).length;const expected=repeats*cases.reduce((n,c)=>n+c.steps.length,0);
  const status=error?'PARTIAL_NOT_FINAL':passed===expected?'CHECKS_PASSED_REQUIRES_HUMAN_REVIEW':'CHECKS_FAILED_REQUIRES_HUMAN_REVIEW';
  if(passed!==expected)process.exitCode=1;
  const report={status,createdAt:new Date().toISOString(),data:p.data,model:c.modelId,error,passed,total:rows.length,expected,passRate:rows.length?passed/rows.length:null,note:'固定语义锚点、长度和行为检查，不是对自然程度的自动评分；需阅读原始对话。所有重复与失败保留。',rows};
  const dir=resolve(base.data,'reports');mkdirSync(dir,{recursive:true});const file=resolve(dir,`live-conversation-${started}.json`);
  writeFileSync(file,JSON.stringify(report,null,2));writeFileSync(resolve(dir,'live-conversation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status,passed,total:rows.length,file}));
}
