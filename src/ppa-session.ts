import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createAppServerClient, type AppServerClient } from '@ppa/runtime/app-server-client';
import { agentFile, atomicJson, childEnv, cliPath, cliAsync, configureAgent, digest, json, modelApiKey, modelHandle, modelIds, readConfig, readResponseMode, redact, responseModes, writeResponseMode, version, upstreamVersion, type Locations, type LettaConfig, type ResponseMode } from './ppa-runtime.js';
import { permissionModes, type PermissionMode } from './permission-modes.js';
import { type Migration } from './ppa-data.js';
import { captureScreen, screenToolDefinition, screenToolResult } from './screen-tool.js';
import { deliberateToolDefinition, parseDeliberationInput, probeAdaptiveThinking, removeExactRepeatedOpening, runDeliberation } from './adaptive-thinking.js';
import { activateCapabilityToolDefinition, parseCapabilityActivation, toolsForCapabilities, type CapabilityName } from './capability-routing.js';

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
  responseModeRequested: ResponseMode = 'native';
  responseMode: ResponseMode = 'native';
  adaptiveUnavailableReason = '';
  mode: PermissionMode = 'standard';
  pending = new Map<string, ToolApproval>();
  private trustedScreenApprovals = new Set<string>();
  private closing = false;
  private finished = Promise.resolve();
  private finish?: () => void;
  private nativeUrl = '';
  private token = '';
  private activeModelId = '';
  private activeTurnId?: string;
  private acceptTurnEvents = false;
  private currentUserText = '';
  private currentAssistantText = '';
  private continuationPrefix = '';
  private continuationBuffer = '';
  private deliberationUsedTurnId?: string;
  private deliberationAbort?: AbortController;
  private deliberateToolStreaming = false;
  private capabilityToolStreaming = false;
  private capabilityActivationUsedTurnId?: string;
  private pendingCapabilities?: CapabilityName[];
  private capabilityContinuationActive = false;
  readonly stateFile: string;
  constructor(readonly paths: Locations) {
    super();
    const migration = json<Migration>(paths.manifest);
    if (migration.status !== 'complete' || !migration.agentId) throw new Error('请先运行 npm run migrate:ppa。');
    this.agentId = migration.agentId; agentFile(paths, this.agentId);
    this.stateFile = join(paths.data, 'ppa-terminal.json');
  }
  async start(config?: LettaConfig) {
    const p = this.paths, c = config ?? readConfig(p);
    this.config = c;
    this.responseModeRequested = readResponseMode(p);
    this.responseMode = this.responseModeRequested;
    this.adaptiveUnavailableReason = '';
    try {
      const ids = await modelIds(c); this.activeModelId = c.modelId ?? ids[0]!; this.modelReady = true;
      if (this.responseModeRequested === 'adaptive') {
        const probe = await probeAdaptiveThinking(c, this.activeModelId);
        if (!probe.available) { this.responseMode = 'native'; this.adaptiveUnavailableReason = probe.reason ?? '自适应思考能力验证未通过。'; }
      }
    } catch {
      // Offline inspection must not silently switch providers or recreate an agent.
      this.modelReady = false;
    }
    if (this.modelReady) { await cliAsync(p, ['connect', c.provider, '--base-url', c.modelBaseUrl, '--api-key', modelApiKey(c)]); configureAgent(p, this.agentId, c, undefined, this.responseMode); }
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
      if (info.backend !== 'local' || info.implementation !== 'ppa-runtime' || info.ppa_runtime_version !== version || info.upstream_letta_code_version !== upstreamVersion || info.protocol_version !== 1) throw new Error('后台版本或本地模式不匹配。');
      this.client.onMessage(m => this.receive(m));
      this.client.onExternalToolCall(async request => {
        if (!request.runtime || request.runtime.agent_id !== this.agentId || request.runtime.conversation_id !== this.runtime?.conversation_id) throw new Error('内部工具请求不属于当前会话。');
        if (request.tool_name === screenToolDefinition.name) {
          try { return screenToolResult(await captureScreen(request.input)); }
          catch (e) { return { content: [{ type: 'text' as const, text: `屏幕读取失败：${e instanceof Error ? e.message : String(e)}` }], is_error: true }; }
        }
        if (request.tool_name === deliberateToolDefinition.name) return this.deliberate(request.input);
        if (request.tool_name === activateCapabilityToolDefinition.name) return this.activateCapabilities(request.input);
        throw new Error(`未知的外部工具：${request.tool_name}`);
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
      if ([screenToolDefinition.name, deliberateToolDefinition.name, activateCapabilityToolDefinition.name].includes(m.request.tool_name)) { this.allowTrustedTool(m.request_id); return; }
      const a = { id: m.request_id, tool: m.request.tool_name, args: m.request.input };
      this.pending.set(a.id, a); this.emitPhase('approval'); this.emit('approval', a);
    } else if (m.type === 'update_device_status') {
      const reported = m.device_status?.current_permission_mode;
      if (permissionModes.includes(reported) && reported !== this.mode) {
        this.mode = reported;
        if (this.runtime) atomicJson(this.stateFile, { agentId: this.agentId, conversationId: this.runtime.conversation_id, mode: reported });
        this.emit('mode', reported);
      }
      for (const item of m.device_status.pending_control_requests ?? []) {
        if (item.request.subtype !== 'can_use_tool' || this.pending.has(item.request_id)) continue;
        if ([screenToolDefinition.name, deliberateToolDefinition.name, activateCapabilityToolDefinition.name].includes(item.request.tool_name)) { this.allowTrustedTool(item.request_id); continue; }
        const a = { id: item.request_id, tool: item.request.tool_name, args: item.request.input }; this.pending.set(a.id, a); this.emitPhase('approval'); this.emit('approval', a);
      }
    } else if (m.type === 'stream_delta' && !m.subagent_id) {
      const d = m.delta;
      if (d.message_type === 'assistant_message') {
        // Stream chunks must preserve whitespace; historical displayText trims complete messages only.
        const text = typeof d.content === 'string' ? d.content : Array.isArray(d.content) ? d.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('') : '';
        if (text && this.acceptTurnEvents && (!this.pendingCapabilities || this.capabilityContinuationActive)) this.emitVisibleText(text);
      } else if (d.message_type === 'reasoning_message' && this.acceptTurnEvents) { this.emitPhase('thinking'); this.emit('thinking', { turnId: this.activeTurnId }); }
      else if (d.message_type === 'usage_statistics' && this.acceptTurnEvents) this.emit('usage', { ...d, turnId: this.activeTurnId });
      else if (d.message_type === 'client_tool_start' && this.acceptTurnEvents) {
        if (d.tool_name === deliberateToolDefinition.name) { this.deliberateToolStreaming = true; this.emitPhase('thinking'); }
        else if (d.tool_name === activateCapabilityToolDefinition.name) { this.capabilityToolStreaming = true; this.emitPhase('tool'); }
        else { this.emitPhase('tool'); this.emit('tool', { name: d.tool_name, status: 'running', turnId: this.activeTurnId }); }
      }
      else if (d.message_type === 'client_tool_end' && this.acceptTurnEvents) {
        if (this.deliberateToolStreaming) { this.deliberateToolStreaming = false; this.emitPhase('response'); }
        else if (this.capabilityToolStreaming) { this.capabilityToolStreaming = false; this.emitPhase('response'); }
        else { this.emitPhase('response'); this.emit('tool', { name: '', status: d.status, turnId: this.activeTurnId }); }
      }
      else if (d.message_type === 'loop_error' || d.message_type === 'retry') this.emit('notice', d.message);
    } else if (m.type === 'turn_finished') {
      if (this.pendingCapabilities && !this.capabilityContinuationActive && this.acceptTurnEvents) {
        void this.continueWithCapabilities();
        return;
      }
      this.flushContinuation();
      this.trustedScreenApprovals.clear();
      const turnId = this.activeTurnId;
      this.busy = false; this.pending.clear(); this.pendingCapabilities = undefined; this.capabilityContinuationActive = false; this.finish?.(); this.emit('phase', { turnId, phase: 'end' }); this.emit('done', { reason: m.stop_reason, error: m.error, turnId });
      this.acceptTurnEvents = false;
    }
  }
  private allowTrustedTool(id: string) {
    if (this.trustedScreenApprovals.has(id) || !this.client || !this.runtime) return;
    this.trustedScreenApprovals.add(id);
    void this.client.submitInput({ runtime: this.runtime, payload: { kind: 'approval_response', request_id: id, decision: { behavior: 'allow' } } }).then(result => {
      if (!result.accepted) this.emit('notice', result.error ?? '后台未接受内部工具授权。');
    }).catch(e => this.emit('notice', `内部工具授权失败：${e instanceof Error ? e.message : String(e)}`));
  }
  private emitPhase(phase: 'response' | 'thinking' | 'tool' | 'approval') { this.emit('phase', { turnId: this.activeTurnId, phase }); }
  private emitVisibleText(text: string) {
    if (this.continuationPrefix) {
      this.continuationBuffer += text;
      if (this.continuationPrefix.startsWith(this.continuationBuffer) && this.continuationBuffer.length < this.continuationPrefix.length) return;
      text = removeExactRepeatedOpening(this.continuationPrefix, this.continuationBuffer);
      this.continuationPrefix = ''; this.continuationBuffer = '';
    }
    if (!text) return;
    this.currentAssistantText += text; this.emitPhase('response'); this.emit('text', text);
  }
  private flushContinuation() {
    if (!this.continuationBuffer || !this.acceptTurnEvents) { this.continuationBuffer = ''; this.continuationPrefix = ''; return; }
    const text = removeExactRepeatedOpening(this.continuationPrefix, this.continuationBuffer);
    this.continuationBuffer = ''; this.continuationPrefix = '';
    if (text) { this.currentAssistantText += text; this.emit('text', text); }
  }
  private async deliberate(raw: Record<string, unknown>) {
    if (this.responseMode !== 'adaptive' || !this.activeTurnId || !this.acceptTurnEvents) return { content: [{ type: 'text' as const, text: '自适应思考当前不可用，请基于已有信息直接回应。' }], is_error: true };
    if (this.deliberationUsedTurnId === this.activeTurnId) return { content: [{ type: 'text' as const, text: '本轮已经认真思考过一次，请直接完成回答。' }], is_error: true };
    this.deliberationUsedTurnId = this.activeTurnId;
    const args = parseDeliberationInput(raw);
    this.emitPhase('thinking'); this.emit('thinking', { turnId: this.activeTurnId, depth: args.depth });
    this.deliberationAbort = new AbortController();
    const startedAt = Date.now();
    try {
      const result = await runDeliberation({ config: this.config, modelId: this.activeModelId, args, history: await this.history(), userText: this.currentUserText, visibleOpening: this.currentAssistantText, signal: AbortSignal.any([this.deliberationAbort.signal, AbortSignal.timeout(60000)]) });
      this.emit('deliberation', { turnId: this.activeTurnId, depth: args.depth, elapsedMs: Date.now() - startedAt, budget: result.budget, usage: result.usage });
      this.continuationPrefix = this.currentAssistantText.trim();
      return { content: [{ type: 'text' as const, text: `Private deliberation completed. Continue the same answer from the next useful point. Do not repeat text already spoken.\n\n${result.text}` }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Private deliberation failed once: ${error instanceof Error ? error.message : String(error)}. Continue once using what is known, state uncertainty plainly, and do not retry deliberate.` }], is_error: true };
    } finally { this.deliberationAbort = undefined; }
  }
  private activateCapabilities(raw: Record<string, unknown>) {
    if (!this.activeTurnId || !this.acceptTurnEvents) return { content: [{ type: 'text' as const, text: '能力激活已失效。' }], is_error: true };
    if (this.capabilityActivationUsedTurnId === this.activeTurnId) return { content: [{ type: 'text' as const, text: '本轮能力已经激活，请使用现有工具完成请求。' }], is_error: true };
    const activation = parseCapabilityActivation(raw);
    this.capabilityActivationUsedTurnId = this.activeTurnId;
    this.pendingCapabilities = activation.capabilities;
    this.emit('capability', { turnId: this.activeTurnId, capabilities: activation.capabilities, status: 'activating' });
    return { content: [{ type: 'text' as const, text: 'The requested capabilities are available and will be attached by PPA. End this phase now without answering or claiming success; the same user turn will continue automatically.' }] };
  }
  private async continueWithCapabilities() {
    if (!this.client || !this.runtime || !this.pendingCapabilities || !this.acceptTurnEvents) return;
    const capabilities = this.pendingCapabilities;
    this.capabilityContinuationActive = true;
    const allowlist = [...toolsForCapabilities(capabilities), ...(this.responseMode === 'adaptive' ? [deliberateToolDefinition.name] : [])];
    this.emit('capability', { turnId: this.activeTurnId, capabilities, status: 'active' });
    try {
      const result = await this.client.submitInput({ runtime: this.runtime, payload: {
        kind: 'create_message',
        messages: [{ role: 'user', content: `<system-reminder>PPA has now attached these requested real capabilities: ${capabilities.join(', ')}. Continue the same user request using the available tools. Do not say the capability is unavailable, do not repeat any visible opening, and do not claim success until the tool result confirms it.</system-reminder>`, client_message_id: randomUUID() }],
        client_toolset: { base: 'none' }, client_tool_allowlist: allowlist, image_failure_mode: 'drop', exclude_interactive_tools: true,
      } });
      if (!result.accepted) throw new Error(result.error ?? '后台未接受能力续答。');
    } catch (error) {
      if (!this.acceptTurnEvents) return;
      this.pendingCapabilities = undefined; this.capabilityContinuationActive = false; this.busy = false; this.finish?.();
      this.emit('notice', `能力激活失败：${error instanceof Error ? error.message : String(error)}`);
      this.emit('phase', { turnId: this.activeTurnId, phase: 'end' });
      this.emit('done', { reason: 'error', error: '能力激活失败，未声称该能力不存在。', turnId: this.activeTurnId });
      this.acceptTurnEvents = false;
    }
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
    const tools = [activateCapabilityToolDefinition, screenToolDefinition, ...(this.responseMode === 'adaptive' ? [deliberateToolDefinition] : [])];
    const r = await this.client!.runtimeStart({ agent_id: this.agentId, ...(id ? { conversation_id: id } : { create_conversation: { body: {} } }), cwd: this.paths.workspace, mode: this.mode, skill_sources: ['bundled', 'agent'], client_info: { name: 'ppa-terminal', title: 'PPA', version: '0.1.0' }, recover_approvals: true, wait_for_replay: true, external_tools: [{ tools }] });
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
    this.busy = true; this.activeTurnId = randomUUID(); this.acceptTurnEvents = true; this.currentUserText = text; this.currentAssistantText = ''; this.continuationPrefix = ''; this.continuationBuffer = ''; this.deliberationUsedTurnId = undefined; this.deliberateToolStreaming = false; this.capabilityToolStreaming = false; this.capabilityActivationUsedTurnId = undefined; this.pendingCapabilities = undefined; this.capabilityContinuationActive = false; this.emitPhase('response'); this.finished = new Promise(resolve => { this.finish = resolve; });
    try {
      // Multimodal user messages use letta-client content parts; image_failure_mode:'drop'
      // keeps the turn text-only if the backend cannot prepare the image for the model.
      const content: any = images.length ? [{ type: 'text', text }, ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } }))] : text;
      const coreTools = [activateCapabilityToolDefinition.name, ...(this.responseMode === 'adaptive' ? [deliberateToolDefinition.name] : [])];
      const r = await this.client!.submitInput({ runtime: this.runtime, payload: { kind: 'create_message', messages: [{ role: 'user', content, client_message_id: randomUUID() }], client_toolset: { base: 'none' }, client_tool_allowlist: coreTools, image_failure_mode: images.length ? 'drop' : undefined, exclude_interactive_tools: true } });
      if (!r.accepted) throw new Error(r.error ?? '后台未接受输入。');
    } catch (e) { this.busy = false; this.finish?.(); throw e; }
  }
  async stop() { if (this.runtime && this.client && this.online) { this.acceptTurnEvents = false; this.pendingCapabilities = undefined; this.deliberationAbort?.abort(); await this.client.abort({ runtime: this.runtime }, { timeoutMs: 5000 }); await waitAtMost(this.finished, 5000); } }
  async interruptAndSend(text: string, images: ImageInput[] = []) { if (this.busy) await this.stop(); if (this.busy) throw new Error('旧回复尚未停止，输入已保留，没有并行发送。'); await this.send(text, images); }
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
    this.requireIdle(); const ids = await modelIds(c), nextModelId = c.modelId ?? ids[0]!, handle = modelHandle(c, nextModelId);
    const previousResponseMode = this.responseMode, previousUnavailableReason = this.adaptiveUnavailableReason;
    if (this.responseModeRequested === 'adaptive') {
      const probe = await probeAdaptiveThinking(c, nextModelId);
      this.responseMode = probe.available ? 'adaptive' : 'native';
      this.adaptiveUnavailableReason = probe.available ? '' : probe.reason ?? '目标模型不支持自适应思考。';
    }
    try {
      await this.request('connect_provider', { target: 'local', provider_id: c.provider, fields: { baseUrl: c.modelBaseUrl, apiKey: modelApiKey(c) } });
      await this.request('agent_update', { agent_id: this.agentId, body: { model: handle, context_window_limit: c.contextWindow, max_tokens: c.maxTokens, model_settings: this.responseModelSettings() } });
      await this.request('update_model', { runtime: this.runtime, payload: { model_handle: handle } });
      if (this.runtime!.conversation_id !== 'default') await this.request('conversation_update', { conversation_id: this.runtime!.conversation_id, body: { context_window_limit: c.contextWindow, model_settings: { max_tokens: c.maxTokens, ...this.responseModelSettings() } } });
      atomicJson(this.paths.settings, c); persist(c); this.model = handle; this.activeModelId = nextModelId; this.config = c; this.modelReady = true;
    } catch (error) { this.responseMode = previousResponseMode; this.adaptiveUnavailableReason = previousUnavailableReason; throw error; }
    if (this.responseMode !== previousResponseMode) await this.restart();
    this.emit('responseMode', this.responseMode);
  }
  private responseModelSettings() { return { ppa_response_mode: this.responseMode, thinking: { type: this.responseMode === 'adaptive' ? 'disabled' : 'enabled' }, reasoning_effort: this.responseMode === 'adaptive' ? null : 'high' }; }
  async setResponseMode(mode: ResponseMode) {
    this.requireIdle();
    if (!responseModes.includes(mode)) throw new Error('回复节奏必须是 native 或 adaptive。');
    if (mode === 'adaptive') {
      const probe = await probeAdaptiveThinking(this.config, this.activeModelId);
      if (!probe.available) throw new Error(probe.reason ?? '自适应思考不可用。');
    }
    writeResponseMode(this.paths, mode); this.responseModeRequested = mode; this.responseMode = mode; this.adaptiveUnavailableReason = '';
    await this.restart(); this.emit('responseMode', mode);
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
  }
}
