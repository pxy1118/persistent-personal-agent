import { memo, useEffect, useState, useRef } from 'react';
import { Box, Text, Static, useInput, useStdout, type Key } from 'ppa-ink';
import { permissionModeLabel } from './permission-modes.js';

export type Entry = { id: number; role: 'user' | 'assistant' | 'info' | 'error'; text: string };
export type Menu = { title: string; items: { label: string; detail?: string; command: string }[] };
export type TuiState = {
  entries: Entry[]; name: string; model: string; busy: boolean; task: string; stream: string;
  online: boolean; modelReady: boolean; mode: string; approval?: { tool: string; args: string; id: string };
  menu?: Menu; editor?: { path: string; text: string }; closing: boolean;
};
export type TuiActions = { submit: (text: string) => boolean | void | Promise<boolean | void>; stop: () => void; quit: () => void; dismiss: () => void; save: (text: string) => void; cycleMode: (dir: number) => void };
export const commands = [
  ['/help','命令与快捷键'],['/new','开始新对话'],['/sessions','切换会话'],['/model','切换模型配置'],['/rhythm','回复节奏'],['/mode','权限模式'],['/image','发送图片'],['/persona','查看人格'],['/persona edit','编辑人格'],['/memory','查看与编辑记忆'],['/history','查看对话历史'],['/status','连接与工作区'],['/reconnect','重新连接模型'],['/quit','退出 PPA'],
];
const accent = '#88cbd4', muted = '#868b97';
function Spinner(){const [frame,setFrame]=useState(0);useEffect(()=>{const timer=setInterval(()=>setFrame(n=>(n+1)%10),100);return()=>clearInterval(timer);},[]);return <Text>{['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'][frame]}</Text>;}
export function shortModel(model: string) { return model.split(/[\\/]/).at(-1)?.replace(/\.gguf$/i,'') || '未选择模型'; }
/** True when an open memory editor holds text different from its saved content. */
export function hasUnsavedEditor(text: string, draft: string) { return draft !== text; }

/** Unicode code-point cursor; Ink handles terminal cell widths and reflow. */
export function editInput(value: string, cursor: number, input: string, key: Partial<Key>): { value: string; cursor: number } {
  const chars=Array.from(value); let c=Math.min(cursor,chars.length);
  if(key.leftArrow)c=Math.max(0,c-1);
  else if(key.rightArrow)c=Math.min(chars.length,c+1);
  else if(key.home || key.ctrl && input==='a')c=0;
  else if(key.end || key.ctrl && input==='e')c=chars.length;
  else if(key.ctrl && input==='u'){chars.splice(0,c);c=0;}
  else if(key.backspace){if(c>0)chars.splice(--c,1);}
  else if(key.delete)chars.splice(c,1);
  else if(key.upArrow || key.downArrow){
    const start=chars.lastIndexOf('\n',c-1)+1, column=c-start;
    if(key.upArrow && start>0){const previous=chars.lastIndexOf('\n',start-2)+1;c=previous+Math.min(column,start-1-previous);}
    else if(key.downArrow){const end=chars.indexOf('\n',c);if(end>=0){let next=chars.indexOf('\n',end+1);if(next<0)next=chars.length;c=end+1+Math.min(column,next-end-1);}}
  } else if(!key.ctrl && !key.meta && !key.escape && input){const pasted=Array.from(input.replace(/\r\n?/g,'\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,''));chars.splice(c,0,...pasted);c+=pasted.length;}
  return {value:chars.join(''),cursor:c};
}

function Composer({value,setValue,focus,onSubmit,onNavigate,onTab,cycleMode,multiline=false,onSave,suggesting=false}:{
  value:string;setValue:(v:string)=>void;focus:boolean;onSubmit:()=>void;onNavigate:(n:number)=>void;onTab:()=>boolean;cycleMode:(dir:number)=>void;multiline?:boolean;onSave?:()=>void;suggesting?:boolean;
}) {
  const [cursor,setCursor]=useState(Array.from(value).length);
  const ownValue=useRef(value);
  useEffect(()=>{if(value!==ownValue.current){setCursor(Array.from(value).length);ownValue.current=value;}},[value]);
  useInput((input,key)=>{
    if(key.ctrl && input==='c' || key.escape)return;
    if(key.ctrl && input==='s' && multiline){onSave?.();return;}
    if(key.tab){if(key.shift){cycleMode(-1);return;}if(!onTab())cycleMode(1);return;}
    if((key.upArrow||key.downArrow)&&suggesting){onNavigate(key.upArrow?-1:1);return;}
    if(key.return||key.ctrl&&input==='n'){if(multiline||key.shift||key.ctrl){const chars=Array.from(value);chars.splice(cursor,0,'\n');ownValue.current=chars.join('');setValue(ownValue.current);setCursor(cursor+1);}else onSubmit();return;}
    const next=editInput(value,cursor,input,key);if(next.value!==value){ownValue.current=next.value;setValue(next.value);}setCursor(next.cursor);
  },{isActive:focus});
  const chars=Array.from(value), current=Math.min(cursor,chars.length);
  return <Text wrap="wrap">{!value&&!multiline?<><Text inverse>{' '}</Text><Text color={muted}>和助手说点什么，或输入 / 查看命令</Text></>:<>{chars.slice(0,current).join('')}<Text inverse={focus}>{chars[current]||' '}</Text>{chars.slice(current+1).join('')}</>}</Text>;
}

const EntryRow = memo(function EntryRow({entry}:{entry:Entry}) {
  return <Box flexDirection="column" paddingX={2} marginBottom={1}>
    {entry.role==='user'?<Text color={accent}>❯ {entry.text}</Text>:entry.role==='assistant'?<Box gap={1}><Text color={accent}>●</Text><Text wrap="wrap">{entry.text}</Text></Box>:<Text color={entry.role==='error'?'red':muted}>{entry.text}</Text>}
  </Box>;
});

export function TuiView({initial,subscribe,actions}:{initial:TuiState;subscribe:(f:(s:TuiState)=>void)=>()=>void;actions:TuiActions}) {
  const [state,setState]=useState(initial), [draft,setDraft]=useState(''), [selected,setSelected]=useState(0), [allow,setAllow]=useState(false), [confirmQuit,setConfirmQuit]=useState(false), [submitting,setSubmitting]=useState(false);
  const {stdout}=useStdout(); const [width,setWidth]=useState(stdout.columns||80);
  useEffect(()=>subscribe(setState),[subscribe]);
  useEffect(()=>{const resize=()=>setWidth(stdout.columns||80);stdout.on('resize',resize);return()=>{stdout.off('resize',resize);};},[stdout]);
  useEffect(()=>{setSelected(0);},[state.menu]);
  useEffect(()=>{setAllow(false);setDraft('');},[state.approval?.id]);
  useEffect(()=>{setDraft(state.editor?.text??'');},[state.editor?.path]);
  useEffect(()=>{setConfirmQuit(false);},[state.editor?.path]);
  const suggested=!state.menu&&!state.approval&&!state.editor&&draft.startsWith('/')&&!draft.includes('\n')?commands.filter(([c])=>c!.startsWith(draft)).map(([label,detail])=>({label:label!,detail,command:label!})):[];
  const items=state.menu?.items??suggested;
  const index=Math.min(selected,Math.max(0,items.length-1));
  const submit=()=>{
    if(state.closing||submitting)return;
    const value=items.length&&draft.startsWith('/')&&!commands.some(([c])=>c===draft)?items[index]!.command:draft;
    if(!value.trim())return;setSubmitting(true);
    void Promise.resolve(actions.submit(value)).then(ok=>{if(ok!==false){setDraft('');setSelected(0);}}).finally(()=>setSubmitting(false));
  };
  const submitApproval=(decision:string)=>{if(submitting)return;setSubmitting(true);void Promise.resolve(actions.submit(decision)).then(ok=>{if(ok!==false)setDraft('');}).finally(()=>setSubmitting(false));};
  useInput((input,key)=>{
    if(confirmQuit){
      if(!key.ctrl&&!key.meta&&input.toLowerCase()==='y')actions.quit();
      else if(input.toLowerCase()==='n'||key.escape||key.return||key.ctrl)setConfirmQuit(false);
      return;
    }
    if(key.ctrl && input==='c'){
      if(state.editor&&hasUnsavedEditor(state.editor.text,draft)){setConfirmQuit(true);return;}
      state.busy?actions.stop():actions.quit();return;
    }
    if(key.escape){if(state.editor||state.menu)actions.dismiss();else if(state.approval||state.busy)actions.stop();else setDraft('');return;}
    if(key.tab&&state.busy&&!state.approval&&!state.menu&&!state.editor){actions.cycleMode(key.shift?-1:1);return;}
    if(state.approval){
      if(!draft&&(key.leftArrow||key.rightArrow||key.upArrow||key.downArrow))setAllow(a=>!a);
      else if(input.toLowerCase()==='y'||input.toLowerCase()==='n')submitApproval(input.toLowerCase());
    } else if(state.menu){
      if(key.upArrow)setSelected(n=>(n-1+items.length)%items.length);
      else if(key.downArrow)setSelected(n=>(n+1)%items.length);
      else if(key.return&&items[index]){setSubmitting(true);void Promise.resolve(actions.submit(items[index]!.command)).then(ok=>{if(ok!==false)setDraft('');}).finally(()=>setSubmitting(false));}
    }
  });
  const start=Math.max(0,index-5), shown=items.slice(start,start+7);
  return <Box flexDirection="column" width={width}>
    <Static items={[{id:-1,role:'info' as const,text:''},...state.entries]}>
      {entry=>entry.id===-1?<Box key="header" marginY={1} paddingX={2} gap={2}>
        <Text color={accent}>{'╭───╮\n│ P │\n╰───╯'}</Text>
        <Box flexDirection="column"><Text bold>PPA <Text color={muted}>v0.1.0</Text></Text><Text>{state.name}</Text><Text color={muted}>持续相伴 · 本地记忆</Text></Box>
      </Box>:<EntryRow key={entry.id} entry={entry}/>}
    </Static>
    {state.stream&&<Box paddingX={2} marginBottom={1} gap={1}><Text color={accent}>●</Text><Text wrap="wrap">{state.stream}</Text></Box>}
    {state.busy&&!state.approval&&<Box paddingX={2} gap={1}><Text color={accent}><Spinner/></Text><Text color={muted}>{state.task||'正在回应'} · Esc 中断</Text></Box>}
    {state.approval?<Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={2} marginTop={1}>
      <Text bold color="yellow">需要你的确认 · {state.approval.tool}</Text>
      <Box marginY={1}><Text wrap="wrap">{state.approval.args}</Text></Box>
      <Box gap={3}><Text color={allow?accent:muted} bold={allow}>{allow?'❯ ':'  '}允许本次</Text><Text color={!allow?accent:muted} bold={!allow}>{!allow?'❯ ':'  '}拒绝</Text></Box>
      <Box borderStyle="single" borderTop borderBottom borderLeft={false} borderRight={false} borderColor={muted} marginTop={1} gap={1}>
        <Text color={accent}>›</Text><Box flexGrow={1}><Composer value={draft} setValue={setDraft} focus={!state.closing&&!submitting} onSubmit={()=>{if(draft.trim())submit();else submitApproval(allow?'y':'n');}} suggesting={false} onNavigate={()=>{}} onTab={()=>false} cycleMode={actions.cycleMode}/></Box>
      </Box>
      <Text color={muted}>空输入 Enter 确认 · y / n 快捷操作 · 输入新消息并 Enter 可打断旧回合 · Esc 只中断</Text>
    </Box>:state.editor?(confirmQuit?<Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text bold color="yellow">放弃未保存的编辑并退出？</Text>
      <Box marginY={1}><Text wrap="wrap">{state.editor.path}</Text></Box>
      <Text color={muted}>y 确认退出并放弃 · n / Esc 返回</Text>
    </Box>:<Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginTop={1}>
      <Text bold color={accent}>编辑 · {state.editor.path}</Text>
      <Box marginY={1}><Composer value={draft} setValue={setDraft} focus={!state.closing&&!state.busy} multiline onSubmit={()=>{}} onNavigate={()=>{}} onTab={()=>false} cycleMode={()=>{}} onSave={()=>actions.save(draft)}/></Box>
      <Text color={muted}>Ctrl+S 保存 · Esc 放弃 · Enter 换行</Text>
    </Box>):<>
      {items.length>0&&<Box flexDirection="column" paddingX={2} marginTop={1}>
        {state.menu&&<Text bold color={accent}>{state.menu.title}</Text>}
        {shown.map((item,i)=><Box key={item.command} gap={2}><Box minWidth={22}><Text color={start+i===index?accent:muted} bold={start+i===index}>{start+i===index?'❯ ':'  '}{item.label}</Text></Box><Text color={muted} wrap="truncate-end">{item.detail??''}</Text></Box>)}
        <Text color={muted}>↑ ↓ 选择 · {state.menu?'Enter 打开 · Esc 返回':'Tab 补全 · Shift+Tab 权限 · Enter 执行'}</Text>
      </Box>}
      {!state.menu&&<Box borderStyle="single" borderTop borderBottom borderLeft={false} borderRight={false} borderColor={state.busy?muted:accent} paddingX={2} marginTop={1} gap={1}>
        <Text color={accent}>›</Text><Box flexGrow={1}><Composer value={draft} setValue={setDraft} focus={!state.closing&&!submitting} onSubmit={submit} suggesting={items.length>0} onNavigate={n=>setSelected(i=>(i+n+items.length)%items.length)} onTab={()=>{if(items[index]){setDraft(items[index]!.command);return true;}return false;}} cycleMode={actions.cycleMode}/></Box>
      </Box>}
    </>}
    <Box justifyContent="space-between" paddingX={2} marginTop={state.menu?1:0}>
      <Text color={state.modelReady?accent:'yellow'}>● {state.closing?'正在退出':state.modelReady?permissionModeLabel(state.mode):'模型离线'}</Text>
      <Text color={muted} wrap="truncate-start">{shortModel(state.model)} · {state.name}</Text>
    </Box>
    <Box paddingX={2} marginBottom={1}><Text color={muted}>{state.editor?'人格与记忆由原生存储保存 · 未保存时 Ctrl+C 需确认':state.approval?'请核对操作参数':state.busy?'回复中可继续输入 · Enter 打断并发送 · Esc 只中断':'Enter 发送 · Shift+Enter 换行 · Tab / Shift+Tab 切换权限 · /help 帮助'}</Text></Box>
  </Box>;
}
