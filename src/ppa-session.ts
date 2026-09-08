import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createAppServerClient, type AppServerClient } from '@letta-ai/letta-code/app-server-client';
import { agentFile, atomicJson, childEnv, cliPath, cliAsync, configureAgent, digest, json, modelApiKey, modelHandle, modelIds, readConfig, redact, version, type Locations, type LettaConfig } from './letta-runtime.js';
import { startModelBridge, type ModelBridge } from './model-bridge.js';
import { permissionModes, type PermissionMode } from './permission-modes.js';
import { type Migration } from './letta-data.js';
import { captureScreen, screenToolDefinition, screenToolResult } from './screen-tool.js';

export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string };
export type MemoryDocument = { path: string; content: string; description: string; hash: string };
export type ToolApproval = { id: string; tool: string; args: Record<string, unknown> };
/** Base64 image attachment carried with a user message (multimodal turns). */
export type ImageInput = { mimeType: string; data: string };
// Keep the tiny wire identity explicit; the upstream .d.ts barrel uses extensionless exports.
type ConversationRuntimeScope = { agent_id: string | null; conversation_id: string };
async function waitAtMost(work: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); } finally { if (timer) clearTimeout(timer); }
}
export function displayText(content: unknown): string {
  if (typeof content === 'string') return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!Array.isArray(content)) return '';
  return content.filter(p => p?.type === 'text').map(p => displayText(p.text)).filter(Boolean).join('\n');
}

/** PPA owns interaction; the version-pinned native runtime owns all agent state. */
export class PpaSession extends EventEmitter {
  client?: AppServerClient;
  child?: ChildProcess;
  runtime?: ConversationRuntimeScope;
  agentId: string;
  name = 'PPA';
  model = '';
  config!: LettaConfig;
  busy = false;
  online = false;
  modelReady = false;
  mode: PermissionMode = 'standard';
  pending = new Map<string, ToolApproval>();
  private trustedScreenApprovals = new Set<string>();
  private closing = false;
  private finished = Promise.resolve();
  private finish?: () => void;
  private nativeUrl = '';
  private token = '';
  private bridge?: ModelBridge;
  readonly stateFile: string;
  constructor(readonly paths: Locations) {
    super();
    const migration = json<Migration>(paths.manifest);
    if (migration.status !== 'complete' || !migration.agentId) throw new Error('请先运行 npm run migrate:letta。');
    this.agentId = migration.agentId; agentFile(paths, this.agentId);
    this.stateFile = join(paths.data, 'ppa-terminal.json');
  }
  async start(config?: LettaConfig) {
    const p = this.paths, c = config ?? readConfig(p);
    this.config = c;
    if (c.provider === 'llama-cpp' && c.modelBaseUrl) {
      // llama.cpp discovery only learns vision through /props; the native /models
      // probe short-circuits it. The bridge forces the /props path for the runtime.
      this.bridge = await startModelBridge(c.modelBaseUrl);
    }
    try { await modelIds(c); this.modelReady = true; } catch {
      // Offline inspection must not silently switch providers or recreate an agent.
      this.modelReady = false;
    }
    if (this.modelReady) { await cliAsync(p, ['connect', c.provider, '--base-url', this.bridge?.baseUrl ?? c.modelBaseUrl, '--api-key', modelApiKey(c)]); configureAgent(p, this.agentId, c); }
    mkdirSync(p.workspace, { recursive: true });
    mkdirSync(join(p.data, 'letta-home'), { recursive: true });
    this.token = randomBytes(32).toString('hex');
    const tokenFile = join(p.data, 'ppa-runtime.token'); writeFileSync(tokenFile, this.token, { mode: 0o600 });
    const log = join(p.data, 'ppa-runtime.log');
    const child = spawn(process.execPath, [cliPath(), 'server', '--backend', 'local', '--listen', '--ws-auth', 'capability-token', '--ws-token-file', tokenFile], { cwd: p.workspace, env: childEnv(p), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const owner = join(p.data, 'instance.lock/owner.json');
    if (existsSync(owner)) atomicJson(owner, { ...json<Record<string, unknown>>(owner), childPid: child.pid });
    try {
      this.nativeUrl = await new Promise<string>((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('后台运行时启动超时，请查看 .ppa/ppa-runtime.log。')), 30000);
        const output = (data: Buffer) => {
          const text = redact(data.toString()).split(this.token).join('[redacted]');
          appendFileSync(log, text); buffer = (buffer + text).slice(-12000);
          const url = buffer.match(/Listening on (ws:\/\/127\.0\.0\.1:\d+)/)?.[1];
          if (url) { clearTimeout(timer); resolve(url); }
        };
        child.stdout!.on('data', output); child.stderr!.on('data', output);
        child.once('error', e => { clearTimeout(timer); reject(e); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`后台运行时退出（${code}），请查看日志。`)); });
      });
      this.client = await createAppServerClient({ url: this.nativeUrl, authToken: this.token, WebSocket, requestTimeoutMs: 45000 }).connect();
      const info = await this.client.info();
      if (info.backend !== 'local' || info.letta_code_version !== version || info.protocol_version !== 1) throw new Error('后台版本或本地模式不匹配。');
      this.client.onMessage(m => this.receive(m));
      this.client.onExternalToolCall(async request => {
        if (request.tool_name !== screenToolDefinition.name) throw new Error(`未知的外部工具：${request.tool_name}`);
        if (!request.runtime || request.runtime.agent_id !== this.agentId || request.runtime.conversation_id !== this.runtime?.conversation_id) throw new Error('屏幕读取请求不属于当前会话。');
        try { return screenToolResult(await captureScreen(request.input)); }
        catch (e) { return { content: [{ type: 'text' as const, text: `屏幕读取失败：${e instanceof Error ? e.message : String(e)}` }], is_error: true }; }
      });
      this.client.onDisconnect(() => { this.online = false; this.busy = false; this.pending.clear(); this.trustedScreenApprovals.clear(); this.finish?.(); if (!this.closing) this.emit('notice', '后台连接已断开。未自动重试输入，请退出后重新启动 PPA。'); });
      this.online = true;
      const saved = existsSync(this.stateFile) ? json(this.stateFile) : null;
      if (permissionModes.includes(saved?.mode)) this.mode = saved.mode;
      const legacy = join(p.workspace, '.letta/settings.local.json');
      const previous = existsSync(legacy) ? json(legacy) : null;
      const last = previous?.sessionsByServer?.[`local:${p.store}`] ?? previous?.lastSession;
      const conversation = saved?.agentId === this.agentId ? saved.conversationId : last?.agentId === this.agentId ? last.conversationId : 'default';
      await this.open(conversation);
    } catch (e) { try { await this.close(); } catch { /* Preserve the startup error; lock owner still tracks child PID. */ } throw e; }
  }
  private receive(m: any) {
    const scope = m.runtime ?? (m.agent_id ? { agent_id: m.agent_id, conversation_id: m.conversation_id } : null);
    if (scope && (scope.agent_id !== this.agentId || (this.runtime && scope.conversation_id !== this.runtime.conversation_id))) return;
    if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
      if (m.request.tool_name === screenToolDefinition.name) { this.allowTrustedScreen(m.request_id); return; }
      const a = { id: m.request_id, tool: m.request.tool_name, args: m.request.input };
      this.pending.set(a.id, a); this.emit('approval', a);
    } else if (m.type === 'update_device_status') {
      const reported = m.device_status?.current_permission_mode;
      if (permissionModes.includes(reported) && reported !== this.mode) {
        this.mode = reported;
        if (this.runtime) atomicJson(this.stateFile, { agentId: this.agentId, conversationId: this.runtime.conversation_id, mode: reported });
        this.emit('mode', reported);
      }
      for (const item of m.device_status.pending_control_requests ?? []) {
        if (item.request.subtype !== 'can_use_tool' || this.pending.has(item.request_id)) continue;
        if (item.request.tool_name === screenToolDefinition.name) { this.allowTrustedScreen(item.request_id); continue; }
        const a = { id: item.request_id, tool: item.request.tool_name, args: item.request.input }; this.pending.set(a.id, a); this.emit('approval', a);
      }
    } else if (m.type === 'stream_delta' && !m.subagent_id) {
      const d = m.delta;
      if (d.message_type === 'assistant_message') {
        // Stream chunks must preserve whitespace; historical displayText trims complete messages only.
        const text = typeof d.content === 'string' ? d.content : Array.isArray(d.content) ? d.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('') : '';
        if (text) this.emit('text', text);
      } else if (d.message_type === 'reasoning_message') this.emit('thinking');
      else if (d.message_type === 'client_tool_start') this.emit('tool', { name: d.tool_name, status: 'running' });
      else if (d.message_type === 'client_tool_end') this.emit('tool', { name: '', status: d.status });
      else if (d.message_type === 'loop_error' || d.message_type === 'retry') this.emit('notice', d.message);
    } else if (m.type === 'turn_finished') {
      this.trustedScreenApprovals.clear();
      this.busy = false; this.pending.clear(); this.finish?.(); this.emit('done', { reason: m.stop_reason, error: m.error });
    }
  }
  private allowTrustedScreen(id: string) {
    if (this.trustedScreenApprovals.has(id) || !this.client || !this.runtime) return;
    this.trustedScreenApprovals.add(id);
    void this.client.submitInput({ runtime: this.runtime, payload: { kind: 'approval_response', request_id: id, decision: { behavior: 'allow' } } }).then(result => {
      if (!result.accepted) this.emit('notice', result.error ?? '后台未接受屏幕读取。');
    }).catch(e => this.emit('notice', `屏幕读取授权失败：${e instanceof Error ? e.message : String(e)}`));
  }
  private requireIdle() { if (!this.online || !this.client) throw new Error('后台未连接，请重新启动 PPA。'); if (this.busy) throw new Error('请先按 Escape 中止，或等待当前回复结束。'); }
  async request(type: string, body: Record<string, unknown> = {}): Promise<any> {
    if (!this.client || !this.online) throw new Error('后台未连接。');
    const result = await this.client.requestRaw({ type, request_id: this.client.nextRequestId('ppa'), ...body }, { predicate: (m: unknown): m is any => !!m && (m as any).type === `${type}_response` });
    if (result.success === false) throw new Error(String(result.error ?? `${type} 失败`));
    return result;
  }
  async conversations(): Promise<any[]> {
    const r = await this.request('conversation_list', { query: { agent_id: this.agentId, limit: 100, order: 'desc', order_by: 'last_message_at' } });
    const rows = r.conversations.filter((c: any) => c.agent_id === this.agentId && !c.hidden);
    if (!rows.some((c: any) => c.id === 'default')) rows.push({ id: 'default', agent_id: this.agentId, summary: '初始对话（含原终端历史）' });
    return rows;
  }
  async open(id?: string) {
    this.requireIdle();
    this.trustedScreenApprovals.clear();
    if (id && id !== 'default') { const r = await this.request('conversation_retrieve', { conversation_id: id }); if (r.conversation?.agent_id !== this.agentId) throw new Error('不能打开其他助手的会话。'); }
    this.runtime = undefined;
    const r = await this.client!.runtimeStart({ agent_id: this.agentId, ...(id ? { conversation_id: id } : { create_conversation: { body: {} } }), cwd: this.paths.workspace, mode: this.mode, skill_sources: ['bundled', 'agent'], client_info: { name: 'ppa-terminal', title: 'PPA', version: '0.1.0' }, recover_approvals: true, wait_for_replay: true, external_tools: [{ tools: [screenToolDefinition] }] });
    if (!r.success || !r.runtime || !r.agent) throw new Error(r.error ?? '打开会话失败。');
    this.runtime = r.runtime; this.name = r.agent.name; this.model = r.agent.model ?? '';
    atomicJson(this.stateFile, { agentId: this.agentId, conversationId: this.runtime!.conversation_id, mode: this.mode });
    await this.request('set_reflection_settings', { runtime: this.runtime, settings: { trigger: 'off', step_count: 25 }, scope: 'local_project' });
    return this.history();
  }
  async history(): Promise<ChatMessage[]> {
    if (!this.runtime) return [];
    const id = this.runtime.conversation_id;
    const r = await this.request('conversation_messages_list', { conversation_id: id, query: { limit: 100, ...(id === 'default' ? { agent_id: this.agentId } : {}) } });
    return r.messages.filter((m: any) => ['user_message', 'assistant_message'].includes(m.message_type)).sort((a: any, b: any) => Date.parse(a.date) - Date.parse(b.date)).map((m: any) => ({ id: m.id, role: m.message_type === 'user_message' ? 'user' : 'assistant', text: displayText(m.content) })).filter((m: ChatMessage) => m.text);
  }
  async send(text: string, images: ImageInput[] = []) {
    this.requireIdle(); if (!this.runtime) throw new Error('会话未打开。');
    if (!this.modelReady) throw new Error('模型服务尚未连接。启动服务后输入 /reconnect，或用 /model 切换配置。');
    this.busy = true; this.finished = new Promise(resolve => { this.finish = resolve; });
    try {
      // Multimodal user messages use letta-client content parts; image_failure_mode:'drop'
      // keeps the turn text-only if the backend cannot prepare the image for the model.
      const content: any = images.length ? [{ type: 'text', text }, ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } }))] : text;
      const r = await this.client!.submitInput({ runtime: this.runtime, payload: { kind: 'create_message', messages: [{ role: 'user', content, client_message_id: randomUUID() }], image_failure_mode: images.length ? 'drop' : undefined, exclude_interactive_tools: true } });
      if (!r.accepted) throw new Error(r.error ?? '后台未接受输入。');
    } catch (e) { this.busy = false; this.finish?.(); throw e; }
  }
  async stop() { if (this.runtime && this.client && this.online) { await this.client.abort({ runtime: this.runtime }, { timeoutMs: 5000 }); await waitAtMost(this.finished, 5000); } }
  async setMode(mode: PermissionMode) {
    if (!permissionModes.includes(mode)) throw new Error('未知权限模式。');
    if (!this.online || !this.client || !this.runtime) throw new Error('后台未连接，请重新启动 PPA。');
    this.client!.send({ type: 'change_device_state', runtime: this.runtime!, payload: { mode } });
    this.mode = mode;
    atomicJson(this.stateFile, { agentId: this.agentId, conversationId: this.runtime.conversation_id, mode });
    this.emit('mode', mode);
  }
  async approve(id: string, allow: boolean) {
    if (!this.pending.has(id) || !this.runtime) throw new Error('该审批已失效。');
    const result = await this.client!.submitInput({ runtime: this.runtime, payload: { kind: 'approval_response', request_id: id, decision: allow ? { behavior: 'allow' } : { behavior: 'deny', message: '用户在 PPA 拒绝本次操作。' } } });
    if (!result.accepted) throw new Error(result.error ?? '后台未接受审批，该操作仍需确认。');
    this.pending.delete(id);
  }
  async memories(): Promise<MemoryDocument[]> {
    this.requireIdle();
    const requestId = this.client!.nextRequestId('memory'); const entries: MemoryDocument[] = [];
    const unsubscribe = this.client!.onMessage((m: any) => { if (m.type === 'list_memory_response' && m.request_id === requestId) for (const e of m.entries ?? []) if (e.kind !== 'image') entries.push({ path: e.relative_path, content: e.content, description: e.description ?? '', hash: digest(e.content) }); });
    try {
      const r = await this.client!.requestRaw({ type: 'list_memory', request_id: requestId, agent_id: this.agentId }, { predicate: (m: unknown): m is any => (m as any)?.type === 'list_memory_response' && ((m as any).done || !(m as any).success) });
      if (!r.success) throw new Error(r.error);
      // list_memory returns parsed Markdown bodies; editing must compare the complete file including frontmatter.
      return await Promise.all(entries.map(async e => { const raw = await this.request('read_memory_file', { agent_id: this.agentId, path: e.path }); return { ...e, content: raw.content, hash: digest(raw.content) }; }));
    } finally { unsubscribe(); }
  }
  async writeMemory(doc: MemoryDocument, content: string) {
    this.requireIdle();
    const now = await this.request('read_memory_file', { agent_id: this.agentId, path: doc.path });
    if (digest(now.content) !== doc.hash) throw new Error('记忆已变化，请重新打开后编辑，避免覆盖新内容。');
    await this.request('write_memory_file', { agent_id: this.agentId, path: doc.path, content, commit_message: 'Edit memory from PPA terminal' });
  }
  async changeModel(c: LettaConfig, persist: (c: LettaConfig) => void) {
    this.requireIdle(); const ids = await modelIds(c), handle = modelHandle(c, c.modelId ?? ids[0]);
    const previousBridge = this.bridge;
    const nextBridge = c.provider === 'llama-cpp' ? await startModelBridge(c.modelBaseUrl) : undefined;
    try {
      await this.request('connect_provider', { target: 'local', provider_id: c.provider, fields: { baseUrl: nextBridge?.baseUrl ?? c.modelBaseUrl, apiKey: modelApiKey(c) } });
      await this.request('agent_update', { agent_id: this.agentId, body: { model: handle, context_window_limit: c.contextWindow, max_tokens: c.maxTokens } });
      await this.request('update_model', { runtime: this.runtime, payload: { model_handle: handle } });
      if (this.runtime!.conversation_id !== 'default') await this.request('conversation_update', { conversation_id: this.runtime!.conversation_id, body: { context_window_limit: c.contextWindow, model_settings: { max_tokens: c.maxTokens } } });
      atomicJson(this.paths.settings, c); persist(c); this.model = handle; this.config = c; this.modelReady = true; this.bridge = nextBridge;
      if (previousBridge) previousBridge.close();
    } catch (error) {
      if (nextBridge) nextBridge.close();
      throw error;
    }
  }
  /** Reattach persisted identity/conversation through a fresh owned runtime. */
  async restart(force = false) {
    if (!force) this.requireIdle();
    const config = this.config, mode = this.mode;
    await this.close(force);
    this.client = undefined; this.child = undefined; this.runtime = undefined;
    this.pending.clear(); this.busy = false; this.closing = false;
    await this.start(config);
    if (mode !== 'standard') {
      await this.setMode(mode);
      const until = Date.now() + 5000;
      while (this.mode !== mode && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
      if (this.mode !== mode) throw new Error('权限模式尚未恢复，未发送输入。');
    }
  }
  async close(skipAbort = false) {
    this.closing = true;
    try { if (this.busy && !skipAbort) await this.stop(); } catch { /* Closing still terminates our owned runtime. */ }
    this.client?.close(); this.online = false;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await waitAtMost(closed, 5000); if (child.exitCode === null && child.signalCode === null) throw new Error('后台仍在退出，保留实例锁以防并发启动。'); }
    if (this.bridge) { try { this.bridge.close(); } catch { /* Already closed by a failed startup. */ } this.bridge = undefined; }
  }
}
