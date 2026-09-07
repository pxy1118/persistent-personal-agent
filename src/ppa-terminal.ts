import { createElement } from 'react';
import { render } from 'ppa-ink';
import { TuiView, type TuiState, type Entry, type Menu } from './tui-view.js';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { PpaSession, type MemoryDocument, type ToolApproval, type ChatMessage } from './ppa-session.js';
import { acquireLock } from './lock.js';
import { locations, readConfig, redact } from './letta-runtime.js';
import { readProfiles, selectProfile, writeActiveConfig } from './model-profiles.js';

export function safeTerminal(text: string) { return redact(text).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); }
const help = `
  日常聊天       直接输入内容，Enter 发送
  /new           新对话，保留人格与记忆
  /sessions      列出会话；/resume 序号 恢复
  /history       显示最近的对话内容
  /persona       查看人格；/persona edit 编辑
  /memory        列出记忆文件；/memory 序号 查看
  /memory edit 序号  编辑记忆，保存到原生存储
  /model         列出已有模型配置；/model 配置名 切换
  /status        当前助手、模型和连接状态
  /reconnect     模型服务启动后重新连接
  /stop          中断本轮（也可按 Escape）
  /quit          退出 PPA（也可在空闲时按 Ctrl+C）

  工具审批       输入 y 仅允许本次，n 拒绝
  记忆编辑       Ctrl+S 保存，Esc 放弃，Enter 换行
`;
const toolLabel = (name: string) => ({ Read: '读取文件', Write: '写入文件', Edit: '编辑文件', Bash: '执行命令', memory: '更新记忆', Agent: '调用助手', Skill: '使用技能' }[name] ?? name);

export class PpaTerminal {
  private commandBusy = false;
  private exiting = false;
  private editor?: { doc: MemoryDocument; header: string; lines: string[] };
  private documents: MemoryDocument[] = [];
  private sessions: any[] = [];
  private approval?: ToolApproval;
  private entries: Entry[] = [];
  private stream = '';
  private task = '';
  private menu?: Menu;
  private sequence = 0;
  private listeners = new Set<(s:TuiState)=>void>();
  private done?: () => void;
  private ui?: ReturnType<typeof render>;
  constructor(readonly session: PpaSession, readonly input = process.stdin, readonly output = process.stdout) {}
  private snapshot():TuiState { return {entries:[...this.entries],name:safeTerminal(this.session.name),model:safeTerminal(this.session.model),busy:this.session.busy||this.commandBusy,task:this.task,stream:this.stream,online:this.session.online,modelReady:this.session.modelReady,approval:this.approval?{tool:toolLabel(this.approval.tool),args:safeTerminal(JSON.stringify(this.approval.args,null,2)),id:this.approval.id}:undefined,menu:this.menu,editor:this.editor?{path:this.editor.doc.path,text:this.editor.lines.join('\n')}:undefined,closing:this.exiting}; }
  private subscribe=(fn:(s:TuiState)=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private refresh(){const state=this.snapshot();for(const fn of this.listeners)fn(state);}
  private endStream(){if(this.stream){this.entries.push({id:++this.sequence,role:'assistant',text:this.stream});this.stream='';}}
  private line(text=''){this.endStream();const clean=safeTerminal(text).trim();if(clean)this.entries.push({id:++this.sequence,role:clean.startsWith('!')?'error':'info',text:clean});this.refresh();}
  private prompt(){this.refresh();}
  private printHistory(messages:ChatMessage[],limit=6){
    for(const m of messages.slice(-limit)){const text=limit===6&&m.text.length>500?m.text.slice(0,140)+'\n…\n'+m.text.slice(-260):m.text;this.entries.push({id:++this.sequence,role:m.role,text:safeTerminal(text)});}this.refresh();
  }
  async run(){
    this.printHistory(await this.session.history());
    const completed=new Promise<void>(resolve=>{this.done=resolve;});
    const handlers:Record<string,(...args:any[])=>void>={
      text:(text:string)=>{this.stream+=safeTerminal(text);this.refresh();},
      thinking:()=>{this.task='正在思考';this.refresh();},
      tool:({name,status})=>{this.endStream();this.task=status==='running'?'正在'+toolLabel(name||'执行工具'):'正在继续';this.line((status==='error'?'× 工具失败':status==='running'?'↳ '+toolLabel(name||'执行工具'):'✓ 工具完成'));},
      notice:(text:string)=>this.line('! '+text),
      approval:(a:ToolApproval)=>{if(!this.approval)this.showApproval(a);},
      done:({reason,error})=>{this.endStream();this.approval=undefined;this.task='';if(error)this.line('! '+error);else if(/interrupt|cancel|abort/.test(reason))this.line('已中断，不会自动重发。');this.refresh();},
    };
    for(const [event,handler] of Object.entries(handlers))this.session.on(event,handler);
    for(const a of this.session.pending.values()){this.approval=a;break;}
    this.ui=render(createElement(TuiView,{initial:this.snapshot(),subscribe:this.subscribe,actions:{submit:(text:string)=>{this.menu=undefined;void this.accept(text);},stop:()=>{void this.stop();},quit:()=>{void this.quit();},dismiss:()=>{this.menu=undefined;this.editor=undefined;this.refresh();},save:(text:string)=>{void this.saveEditor(text);}}}),{stdin:this.input,stdout:this.output,stderr:this.output,exitOnCtrlC:false,patchConsole:false});
    await completed;
    for(const [event,handler] of Object.entries(handlers))this.session.off(event,handler);
    this.ui.unmount();
    this.output.write('\nPPA 已退出。\n');
  }
  private showApproval(a:ToolApproval){this.endStream();this.approval=a;this.task='等待确认';this.refresh();}
  private async saveEditor(text:string){
    if(!this.editor||this.commandBusy)return;this.commandBusy=true;this.task='正在保存记忆';this.refresh();
    try{if(!text.trim())throw new Error('正文不能为空。');await this.session.writeMemory(this.editor.doc,this.editor.header+text.replace(/\n*$/,'')+'\n');this.editor=undefined;this.line('✓ 已保存到原生记忆。');}
    catch(e){this.line('! '+String(e));}finally{this.commandBusy=false;this.task='';this.refresh();}
  }
  private async stop(){if(!this.session.busy)return;this.task='正在中断';this.refresh();try{await this.session.stop();}catch(e){this.line('! '+String(e));}this.refresh();}
  private async quit(){if(this.exiting)return;this.exiting=true;this.refresh();try{await this.session.close();}catch(e){this.line('! '+String(e));process.exitCode=1;}this.done?.();}
  private async accept(raw: string) {
    if (this.exiting) return;
    const line = raw.trim();
    try {
      if (['/quit', '/exit', 'exit'].includes(line)) { await this.quit(); return; }
      if (line === '/stop') { await this.stop(); return; }
      if (this.commandBusy) { this.line('  当前操作尚未结束，请稍候。'); this.prompt(); return; }
      if (this.approval) {
        if (!['y','n','是','否','允许','拒绝'].includes(line.toLowerCase())) throw new Error('请输入 y 允许本次，或 n 拒绝。');
        const allow = ['y','是','允许'].includes(line.toLowerCase());
        await this.session.approve(this.approval.id, allow); this.line(allow ? '  已允许本次操作。' : '  已拒绝本次操作。'); this.approval = undefined;
        const next = this.session.pending.values().next().value; if (next) this.showApproval(next); this.prompt(); return;
      }
      if (this.editor) {
        if (line === '.cancel') { this.editor = undefined; this.line('  已放弃编辑。'); }
        else if (line === '.save') {
          const edit = this.editor; this.commandBusy = true;
          if (!edit.lines.join('\n').trim()) throw new Error('内容为空；如需放弃请使用 .cancel。');
          await this.session.writeMemory(edit.doc, edit.header + edit.lines.join('\n') + '\n'); this.editor = undefined; this.line('  已保存到人格/记忆，并生成原生版本记录。');
        } else this.editor.lines.push(raw);
        this.prompt(); return;
      }
      if (this.session.busy) throw new Error('正在回复。可按 Escape 中断后再发送，输入不会排队或重放。');
      if (!line) { this.prompt(); return; }
      this.commandBusy = true;
      const [command, ...parts] = line.split(/\s+/), args = parts.join(' ');
      if (command === '/help') this.line(help);
      else if (command === '/status') {
        const c = this.session.config;
        this.line(`  助手：${this.session.name}\n  模型：${this.session.model}\n  会话：${this.session.runtime?.conversation_id}\n  后台：${this.session.online ? '已连接' : '离线'} · 模型：${this.session.modelReady ? '已连接' : '离线'}\n  上下文：${c.contextWindow} · 最大输出：${c.maxTokens}\n  工作目录：${this.session.paths.workspace}`);
      } else if (command === '/reconnect') {
        this.line('  正在连接模型…'); await this.session.changeModel(readConfig(this.session.paths), () => {}); this.line('  模型已连接，可以继续聊天。');
      } else if (command === '/history') this.printHistory(await this.session.history(), 20);
      else if (command === '/new') { await this.session.open(); this.line('  新对话已就绪，人格与记忆继续保留。'); }
      else if (command === '/sessions') {
        this.sessions = await this.session.conversations();
        this.menu={title:'选择会话',items:this.sessions.map((s,i)=>({label:(s.summary||s.description||'未命名对话').slice(0,35),detail:s.id===this.session.runtime?.conversation_id?'当前会话':s.id,command:`/resume ${i+1}`}))};
      } else if (command === '/resume') {
        if (!this.sessions.length) this.sessions = await this.session.conversations();
        const s = this.sessions[Number(args) - 1]; if (!s) throw new Error('请先用 /sessions 查看，再输入 /resume 序号。');
        this.printHistory(await this.session.open(s.id));
      } else if (command === '/model') {
        const profiles = readProfiles();
        if (!args || args === 'list') { this.menu={title:'选择模型配置',items:Object.entries(profiles).map(([name,c])=>({label:name,detail:`${c.modelBaseUrl} · ${c.contextWindow} 上下文`,command:`/model ${name}`}))}; }
        else { this.line('  正在验证并切换模型…'); await this.session.changeModel(selectProfile(args, profiles), writeActiveConfig); this.line(`  已切换：${args}`); }
      } else if (command === '/persona' || command === '/memory') {
        const current = await this.session.memories();
        if (!args || command === '/persona' || !this.documents.length) this.documents = current;
        const edit = parts[0] === 'edit';
        const selected = command === '/persona' ? 'system/persona.md' : this.documents[Number(edit ? parts[1] : parts[0]) - 1]?.path;
        const doc = current.find(d => d.path === selected);
        if (doc) {
          const header = doc.content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0] ?? '';
          this.line(`\n  ${command === '/persona' ? '人格' : doc.path}\n${doc.content.slice(header.length)}`);
          if (edit) { this.editor = { doc, header, lines: doc.content.slice(header.length).trimEnd().split('\n') }; }
          else this.menu={title:command==='/persona'?'人格':'记忆',items:[{label:'编辑正文',detail:'Ctrl+S 保存，Esc 放弃',command:command==='/persona'?'/persona edit':`/memory edit ${this.documents.findIndex(d=>d.path===doc.path)+1}`}]};
        } else if (edit || command === '/persona' || args) throw new Error('未找到该记忆，请先用 /memory 查看序号。');
        else { this.menu={title:'人格与记忆',items:this.documents.map((d,i)=>({label:d.path,detail:d.description,command:`/memory ${i+1}`}))}; }
      } else if (command.startsWith('/')) throw new Error('未知 PPA 命令。输入 /help 查看。');
      else { this.entries.push({id:++this.sequence,role:'user',text:safeTerminal(raw)}); this.task='正在回应'; this.refresh(); await this.session.send(raw); }
      this.prompt();
    } catch (e) { this.line(`  ! ${e instanceof Error ? e.message : String(e)}`); this.prompt(); }
    finally { this.commandBusy = false; this.refresh(); }
  }
}

export async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('PPA 终端需要交互式终端，请运行 npm start 或 start.cmd。');
  const p = locations(); mkdirSync(p.data, { recursive: true });
  if (!existsSync(p.manifest)) throw new Error('请先运行 npm run migrate:letta。');
  const release = acquireLock(p.data); let session: PpaSession | undefined;
  try {
    process.stdout.write('\n  PPA · 正在连接你的助手…\n');
    session = new PpaSession(p); await session.start(); await new PpaTerminal(session).run();
  } finally {
    if (session) await session.close();
    release();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(`PPA：${safeTerminal(e instanceof Error ? e.message : String(e))}`); process.exitCode = 1; });
