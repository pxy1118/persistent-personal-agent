import { createElement } from 'react';
import { render } from 'ppa-ink';
import { TuiView, type TuiState, type Entry, type Menu } from './tui-view.js';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { PpaSession, type MemoryDocument, type ToolApproval, type ChatMessage } from './ppa-session.js';
import { permissionModes, permissionModeLabel, permissionModeDetail, cyclePermissionMode, type PermissionMode } from './permission-modes.js';
import { acquireLock } from './lock.js';
import { isLocalModelEndpoint, locations, readConfig, redact } from './ppa-runtime.js';
import { readProfiles, selectProfile, writeActiveConfig } from './model-profiles.js';

export function safeTerminal(text: string) { return redact(text).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); }
export const imageExtensions = new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp','.heic','.heif']);
const imageMediaTypes: Record<string, string> = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.heic':'image/heic','.heif':'image/heif' };
export function imageMediaType(path: string) { return imageMediaTypes[path.slice(path.lastIndexOf('.')).toLowerCase()] ?? undefined; }
/**
 * Split `/image` args into a file path and an optional question.
 * Quoted paths win; otherwise the longest existing prefix is the path, so
 * paths containing spaces still work when followed by a question.
 */
export function splitImageArgs(rest: string, exists: (p: string) => boolean): { path?: string; question: string } {
  const quoted = rest.match(/^"([^"]*)"(?:\s+(.*))?$/);
  if (quoted) return { path: quoted[1] || undefined, question: quoted[2]?.trim() ?? '' };
  const parts = rest.split(/\s+/).filter(Boolean);
  for (let k = parts.length; k >= 1; k--) {
    const candidate = parts.slice(0, k).join(' ');
    if (exists(candidate)) return { path: candidate, question: parts.slice(k).join(' ').trim() };
  }
  return { question: '' };
}
const help = `
  日常聊天       直接输入内容，Enter 发送
  /new           新对话，保留人格与记忆
  /sessions      列出会话；/resume 序号 恢复
  /history       显示最近的对话内容
  /persona       查看人格；/persona edit 编辑
  /memory        列出记忆文件；/memory 序号 查看
  /memory edit 序号  编辑记忆，保存到原生存储
  /model         列出已有模型配置；/model 配置名 切换
  /rhythm        查看回复节奏；/rhythm native|adaptive 切换
  /mode          查看并切换权限模式（标准 / 自动批准编辑 / 严格等）
  /image         发送图片：/image "图片路径" [问题]
  /status        当前助手、模型和连接状态
  /reconnect     模型服务启动后重新连接
  /stop          中断本轮（也可按 Escape）
  /quit          退出 PPA（也可在空闲时按 Ctrl+C）

  工具审批       输入 y 仅允许本次，n 拒绝
  记忆编辑       Ctrl+S 保存，Esc 放弃，Enter 换行
`;
const toolLabel = (name: string) => ({ Read: '读取文件', Write: '写入文件', Edit: '编辑文件', Bash: '执行命令', memory: '更新记忆', Agent: '调用助手', Skill: '使用技能', capture_screen: '读取屏幕', deliberate: '认真想想' }[name] ?? name);

export class PpaTerminal {
  private commandBusy = false;
  private exiting = false;
  private editor?: { doc: MemoryDocument; header: string; text: string };
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
  private snapshot():TuiState { return {entries:[...this.entries],name:safeTerminal(this.session.name),model:safeTerminal(this.session.model),busy:this.session.busy||this.commandBusy,task:this.task,stream:this.stream,online:this.session.online,modelReady:this.session.modelReady,mode:this.session.mode,approval:this.approval?{tool:toolLabel(this.approval.tool),args:safeTerminal(JSON.stringify(this.approval.args,null,2)),id:this.approval.id}:undefined,menu:this.menu,editor:this.editor?{path:this.editor.doc.path,text:this.editor.text}:undefined,closing:this.exiting}; }
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
      phase:({phase}:{phase:string})=>{this.task=phase==='thinking'?'正在认真想':phase==='tool'?'正在执行工具':phase==='approval'?'等待确认':phase==='response'?'正在回应':'';this.refresh();},
      tool:({name,status})=>{this.endStream();this.task=status==='running'?'正在'+toolLabel(name||'执行工具'):'正在继续';this.line((status==='error'?'× 工具失败':status==='running'?'↳ '+toolLabel(name||'执行工具'):'✓ 工具完成'));},
      notice:(text:string)=>this.line('! '+text),
      mode:()=>{ this.line('  权限模式已切换：'+permissionModeLabel(this.session.mode)); this.refresh(); },
      responseMode:(mode:string)=>{this.line(`  回复节奏已切换：${mode==='adaptive'?'自适应':'原生'}`);this.refresh();},
      approval:(a:ToolApproval)=>{if(!this.approval)this.showApproval(a);},
      done:({reason,error})=>{this.endStream();this.approval=undefined;this.task='';if(error)this.line('! '+error);else if(/interrupt|cancel|abort/.test(reason))this.line('已中断，不会自动重发。');this.refresh();},
    };
    for(const [event,handler] of Object.entries(handlers))this.session.on(event,handler);
    for(const a of this.session.pending.values()){this.approval=a;break;}
    if(this.session.adaptiveUnavailableReason)this.line('! 已回退到原生回复：'+this.session.adaptiveUnavailableReason);
    this.ui=render(createElement(TuiView,{initial:this.snapshot(),subscribe:this.subscribe,actions:{submit:(text:string)=>{this.menu=undefined;return this.accept(text);},stop:()=>{void this.stop();},quit:()=>{void this.quit();},dismiss:()=>{this.menu=undefined;this.editor=undefined;this.refresh();},save:(text:string)=>{void this.saveEditor(text);},cycleMode:(dir:number)=>{const next=cyclePermissionMode(this.session.mode,dir as 1|-1);void this.session.setMode(next).catch(e=>this.line('! '+String(e)));}}}),{stdin:this.input,stdout:this.output,stderr:this.output,exitOnCtrlC:false,patchConsole:false});
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
  private async accept(raw: string):Promise<boolean> {
    if (this.exiting) return false;
    const line = raw.trim();
    try {
      if (['/quit', '/exit', 'exit'].includes(line)) { await this.quit(); return true; }
      if (line === '/stop') { await this.stop(); return true; }
      if (this.commandBusy) { this.line('  当前操作尚未结束，请稍候。'); this.prompt(); return false; }
      if (this.approval) {
        if (['y','n','是','否','允许','拒绝'].includes(line.toLowerCase())) {
          const allow = ['y','是','允许'].includes(line.toLowerCase());
          await this.session.approve(this.approval.id, allow); this.line(allow ? '  已允许本次操作。' : '  已拒绝本次操作。'); this.approval = undefined;
          const next = this.session.pending.values().next().value; if (next) this.showApproval(next); this.prompt(); return true;
        }
        if (!line) return false;
        this.commandBusy=true;this.task='正在中断并接话';this.refresh();
        await this.session.interruptAndSend(line);this.approval=undefined;
        this.endStream();this.entries.push({id:++this.sequence,role:'user',text:safeTerminal(line)});this.task='正在回应';this.refresh();return true;
      }
      if (this.editor) return false; // 编辑器由界面自己处理（Ctrl+S 保存 / Esc 放弃），不接受命令行提交。
      if (!line) { this.prompt(); return false; }
      if (this.session.busy) {
        if (line.startsWith('/')) throw new Error('回复中只能发送新的聊天内容；Esc 只中断当前回复。');
        this.commandBusy=true;this.task='正在中断并接话';this.refresh();
        await this.session.interruptAndSend(line);
        this.endStream();this.entries.push({id:++this.sequence,role:'user',text:safeTerminal(line)});this.task='正在回应';this.refresh();
        return true;
      }
      this.commandBusy = true;
      const [command, ...parts] = line.split(/\s+/), args = parts.join(' ');
      if (command === '/help') this.line(help);
      else if (command === '/status') {
        const c = this.session.config;
        this.line(`  助手：${this.session.name}\n  模型：${this.session.model}\n  模型服务：${isLocalModelEndpoint(c.modelBaseUrl) ? '本机' : '远程'} · ${c.modelBaseUrl}\n  会话：${this.session.runtime?.conversation_id}\n  权限：${permissionModeLabel(this.session.mode)}\n  回复节奏：${this.session.responseMode==='adaptive'?'自适应':'原生'}${this.session.adaptiveUnavailableReason?'（请求的自适应不可用）':''}\n  后台：${this.session.online ? '已连接' : '离线'} · 模型：${this.session.modelReady ? '已连接' : '离线'}\n  上下文：${c.contextWindow} · 最大输出：${c.maxTokens}\n  工作目录：${this.session.paths.workspace}`);
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
        if (!args || args === 'list') { this.menu={title:'选择模型配置',items:Object.entries(profiles).map(([name,c])=>({label:name,detail:`${isLocalModelEndpoint(c.modelBaseUrl) ? '本机' : '远程'} · ${c.modelId ?? '自动选择首个模型'} · ${c.contextWindow} 上下文`,command:`/model ${name}`}))}; }
        else { this.line('  正在验证并切换模型…'); await this.session.changeModel(selectProfile(args, profiles), writeActiveConfig); this.line(`  已切换：${args}`); }
      } else if (command === '/rhythm') {
        if(!args)this.menu={title:'回复节奏',items:[{label:'原生',detail:this.session.responseMode==='native'?'当前模式':'使用模型服务默认思考方式',command:'/rhythm native'},{label:'自适应',detail:this.session.responseMode==='adaptive'?'当前模式':'先快速回应，需要时再认真想',command:'/rhythm adaptive'}]};
        else if(args==='native'||args==='adaptive'){this.line('  正在验证并切换回复节奏…');await this.session.setResponseMode(args);}
        else throw new Error('请输入 /rhythm native 或 /rhythm adaptive。');
      } else if (command === '/mode') {
        if (!args) this.menu={title:'权限模式',items:permissionModes.map(m=>({label:permissionModeLabel(m),detail:m===this.session.mode?'当前模式':permissionModeDetail(m),command:`/mode ${m}`}))};
        else { const m = args as PermissionMode; if (!permissionModes.includes(m)) throw new Error(`未知权限模式：${args}。请输入 /mode 查看。`); await this.session.setMode(m); this.line(`  正在切换权限模式：${permissionModeLabel(m)}`); }
      } else if (command === '/persona' || command === '/memory') {
        const current = await this.session.memories();
        if (!args || command === '/persona' || !this.documents.length) this.documents = current;
        const edit = parts[0] === 'edit';
        const selected = command === '/persona' ? 'system/persona.md' : this.documents[Number(edit ? parts[1] : parts[0]) - 1]?.path;
        const doc = current.find(d => d.path === selected);
        if (doc) {
          const header = doc.content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0] ?? '';
          this.line(`\n  ${command === '/persona' ? '人格' : doc.path}\n${doc.content.slice(header.length)}`);
          if (edit) { this.editor = { doc, header, text: doc.content.slice(header.length).trimEnd() }; }
          else this.menu={title:command==='/persona'?'人格':'记忆',items:[{label:'编辑正文',detail:'Ctrl+S 保存，Esc 放弃',command:command==='/persona'?'/persona edit':`/memory edit ${this.documents.findIndex(d=>d.path===doc.path)+1}`}]};
        } else if (edit || command === '/persona' || args) throw new Error('未找到该记忆，请先用 /memory 查看序号。');
        else { this.menu={title:'人格与记忆',items:this.documents.map((d,i)=>({label:d.path,detail:d.description,command:`/memory ${i+1}`}))}; }
      } else if (command === '/image') {
        if (!this.session.modelReady) throw new Error('模型服务尚未连接。启动服务后输入 /reconnect，或用 /model 切换配置。');
        const { path, question } = splitImageArgs(args, existsSync);
        if (!path) throw new Error('请提供图片路径：/image "图片路径" [问题]。含空格的路径请用引号。');
        const stat = statSync(path);
        if (stat.isDirectory()) throw new Error(`该路径是目录，不是图片文件：${path}`);
        const mime = imageMediaType(path);
        if (!mime) throw new Error(`不支持的图片格式。支持：${[...imageExtensions].join(' ')}`);
        if (stat.size > 20 * 1024 * 1024) throw new Error('图片超过 20MB 上限，无法发送。');
        const data = readFileSync(path).toString('base64');
        const text = question || '请看看这张图片。';
        this.entries.push({ id: ++this.sequence, role: 'user', text: safeTerminal(`📷 ${path}${question ? '\n' + question : ''}`) });
        this.task = '正在回应'; this.refresh();
        await this.session.send(text, [{ mimeType: mime, data }]);
      } else if (command.startsWith('/')) throw new Error('未知 PPA 命令。输入 /help 查看。');
      else { this.entries.push({id:++this.sequence,role:'user',text:safeTerminal(raw)}); this.task='正在回应'; this.refresh(); await this.session.send(raw); }
      this.prompt();
      return true;
    } catch (e) { this.line(`  ! ${e instanceof Error ? e.message : String(e)}`); this.prompt(); return false; }
    finally { this.commandBusy = false; this.refresh(); }
  }
}

export async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('PPA 终端需要交互式终端，请运行 npm start 或 start.cmd。');
  const p = locations(); mkdirSync(p.data, { recursive: true });
  if (!existsSync(p.manifest)) throw new Error('请先运行 npm run migrate:ppa。');
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
