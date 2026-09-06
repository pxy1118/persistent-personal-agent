import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Type } from 'typebox';
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  createReadTool, createWriteTool, createEditTool, createBashTool, createPowerShellTool,
  createGrepTool, createFindTool, createLsTool, ModelRuntime, SessionManager, SettingsManager,
  convertToLlm, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type AgentSessionRuntime,
} from '@earendil-works/pi-coding-agent';
import { Store, type Proposal, type Source, type Memory } from './store.js';
import { Actions, type Ask } from './actions.js';
import { projection, systemPrompt } from './context.js';
import { type Config, type Paths } from './config.js';
import { MemoryDialogue } from './memory-dialogue.js';
import { reflect } from './reflection.js';
import type { Context } from '@earendil-works/pi-ai';
import { Text } from '@earendil-works/pi-tui';
import { conversationalStream } from './speech-stream.js';

const response = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], details: data });
const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
const proposalSchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 120 }), content: Type.String({ minLength: 1, maxLength: 2000 }),
  kind: Type.Union(['fact', 'preference', 'episode', 'relationship'].map(x => Type.Literal(x))),
  evidence: Type.String({ minLength: 1, description: 'Exact substring of the CURRENT user message. Copy verbatim, with NO prefix such as 用户原话： and no surrounding quotation marks.' }), scope: Type.Optional(Type.String()),
  certainty: Type.Union(['stated', 'inferred', 'uncertain'].map(x => Type.Literal(x))),
  durability: Type.Union(['stable', 'temporary'].map(x => Type.Literal(x))),
  sensitivity: Type.Union(['ordinary', 'sensitive', 'secret'].map(x => Type.Literal(x))),
  sourceKind: Type.Union(['user', 'quotation', 'hypothesis'].map(x => Type.Literal(x))),
  targetId: Type.Optional(Type.String()), expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  reference: Type.Optional(Type.String({ description: 'For revision: existing topic key returned by search. Host resolves ID and version; do not invent IDs.' })),
});
export type AdapterOptions = { store: Store; actions: Actions; paths: Paths; config: Config; modelIds: string[]; ask?: Ask; fresh?: boolean };

export async function createPpaRuntime(options: AdapterOptions) {
  const { store, paths, config, modelIds } = options;
  const modelRuntime = await ModelRuntime.create({ authPath: resolve(paths.agent, 'auth.json'), modelsPath: null, modelsStorePath: resolve(paths.agent, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('ppa-local', {
    streamSimple: conversationalStream,
    baseUrl: config.modelBaseUrl, api: 'openai-completions', apiKey: process.env.PPA_MODEL_API_KEY ?? 'local-no-key',
    models: modelIds.map(modelId => ({ id: modelId, name: modelId, reasoning: /qwen/i.test(modelId), input: ['text'], contextWindow: config.contextWindow, maxTokens: config.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, ...(/qwen/i.test(modelId) ? { supportsReasoningEffort: false, thinkingFormat: 'qwen-chat-template' as const } : {}) } })),
  });
  await modelRuntime.setRuntimeApiKey('ppa-local', process.env.PPA_MODEL_API_KEY ?? 'local-no-key');
  let runtime: AgentSessionRuntime;
  let resetPending = false;
  const tasks = new Set<Promise<unknown>>();
  const reset = () => {
    if (resetPending) return;
    resetPending = true;
    // Session replacement must occur after Pi has settled its current event stack.
    const task = new Promise<void>(r => setTimeout(r, 0)).then(async () => { await runtime.newSession(); }).finally(() => { resetPending = false; tasks.delete(task); });
    tasks.add(task); task.catch(e => { process.stderr.write(`新会话创建失败：${String(e)}；请退出并重启。\n`); });
  };
  const factory: Parameters<typeof createAgentSessionRuntime>[0] = async ({ sessionManager, sessionStartEvent }) => {
    const sessionId = sessionManager.getSessionId(); const sessionPath = sessionManager.getSessionFile();
    if (sessionPath && existsSync(sessionPath) && !store.canResume(sessionPath)) throw new Error('未知或已归档会话不能恢复。');
    const epoch = store.epoch;
    store.session(sessionId, sessionPath);
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      // Pi's default 20K retained history can exceed the useful budget of a small local context.
      compaction: { enabled: true, reserveTokens: Math.min(Math.floor(config.contextWindow * 0.4), config.maxTokens + Math.ceil(config.memoryBudgetChars / 2) + 2048), keepRecentTokens: Math.min(12000, Math.floor(config.contextWindow * 0.3)) },
      defaultTools: ['read', 'write', 'edit', process.platform === 'win32' ? 'powershell' : 'bash', 'grep', 'find', 'ls'],
    });
    const extension = (pi: ExtensionAPI) => installPpa(pi, { ...options, modelRuntime, epoch, sessionId, reset, isResetting: () => resetPending });
    const services = await createAgentSessionServices({ cwd: paths.workspace, agentDir: paths.agent, modelRuntime, settingsManager, resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: config.extensions, additionalSkillPaths: config.skills, extensionFactories: [{ name: 'PPA', factory: extension }],
      systemPromptOverride: () => systemPrompt(store), agentsFilesOverride: () => ({ agentsFiles: [] }), appendSystemPromptOverride: () => [],
    } });
    if (services.diagnostics.some(d => d.type === 'error')) throw new Error(services.diagnostics.map(d => d.message).join('\n'));
    const savedModel = store.get('model_id');
    const selected = savedModel && modelIds.includes(savedModel) ? savedModel : config.modelId ?? modelIds[0];
    const model = modelRuntime.getModel('ppa-local', selected);
    if (!model) throw new Error(`已选择模型不可用：${selected}；请恢复模型服务或在 config/local.json 设置 modelId，并运行 doctor。`);
    // This is the speaking/selection phase. Deliberation remains available via reflect with reasoning enabled.
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: 'off' });
    // Resource errors (including a broken explicitly enabled extension) are fatal, not silently ignored.
    if (result.extensionsResult.errors.length) { result.session.dispose(); throw new Error(JSON.stringify(result.extensionsResult.errors)); }
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const last = store.one<{ path: string; epoch: number }>('SELECT path,epoch FROM sessions WHERE id=?', store.get('last_session') ?? '');
  const manager = !options.fresh && last?.epoch === store.epoch && last.path && existsSync(last.path) ? SessionManager.open(last.path, paths.sessions, paths.workspace) : SessionManager.create(paths.workspace, paths.sessions);
  runtime = await createAgentSessionRuntime(factory, { cwd: paths.workspace, agentDir: paths.agent, sessionManager: manager });
  return { runtime, modelRuntime, waitForReset: async () => { await Promise.all([...tasks]); } };
}

type ExtensionOptions = AdapterOptions & { modelRuntime: ModelRuntime; epoch: number; sessionId: string; reset: () => void; isResetting: () => boolean };
function installPpa(pi: ExtensionAPI, options: ExtensionOptions) {
  const { store, actions, config, paths, epoch, sessionId } = options;
  const scope = `workspace:${paths.workspace}`;
  const dialogue = new MemoryDialogue(store, scope);
  let reflectionContext: Context | undefined;
  let reflections = 0;
  let spokenThisTurn = '';
  let reviewResult: { status: string; id?: string } | undefined;
  let current: Source | undefined; let rawInput: { text: string; origin: string } | undefined;
  let started = 0; let firstToken = false; let broken = false;
  const extensionActions = new Map<string, string>();
  const ask = (ctx: ExtensionContext): Ask => options.ask ?? (async (title, detail) => ctx.hasUI && await ctx.ui.confirm(title, detail));
  const guard = () => { if (broken) throw new Error('持久状态读取或写入失败，请停止并检查本地存储。'); if (store.epoch !== epoch || options.isResetting()) throw new Error('会话正在清理，请在新会话继续。'); };
  const source = () => { guard(); if (!current || current.origin !== 'interactive' || current.epoch !== store.epoch) throw new Error('没有当前用户原话来源。'); return current; };
  const notify = (ctx: ExtensionContext, value: unknown) => ctx.ui.notify(typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'info');
  const command = (name: string, description: string, handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>) => pi.registerCommand(name, { description, handler: async (args, ctx) => {
    try { if (!ctx.isIdle()) { notify(ctx, '请先停止或等待当前回复。'); return; } await handler(args.trim(), ctx); } catch (e) { ctx.ui.notify(String(e), 'error'); }
  } });

  pi.on('input', (event, ctx) => {
    if (store.epoch !== epoch || options.isResetting()) { options.reset(); notify(ctx, '已建立新的记忆边界，正在切换会话，请稍后重新输入。'); return { action: 'handled' }; }
    if (!ctx.isIdle()) { notify(ctx, '请先停止当前回复后再发消息，避免记忆来源串轮。'); return { action: 'handled' }; }
    rawInput = { text: event.text, origin: event.source === 'interactive' || event.source === 'rpc' ? 'interactive' : 'extension' };
    return { action: 'continue' };
  });
  pi.on('before_agent_start', (event, ctx) => {
    current = undefined;
    try {
      guard(); store.session(sessionId, ctx.sessionManager.getSessionFile());
      reflections = 0; reflectionContext = undefined; spokenThisTurn = '';
      current = store.addSource(sessionId, 'user', rawInput?.origin ?? 'extension', rawInput?.text ?? event.prompt);
      reviewResult = dialogue.acceptReply(current);
      if (!reviewResult && /^(?:对[，,]?\s*就这样记|确认记住|确认保存)[。.!！\s]*$/.test(current.content.trim())) reviewResult = { status: 'not_confirmed_no_visible_unique_candidate' };
      if (reviewResult && ctx.hasUI) ctx.ui.notify(reviewResult.status === 'active' ? 'PPA：记忆已提交。' : reviewResult.status === 'rejected' ? 'PPA：候选已拒绝。' : 'PPA：未提交记忆；没有可直接确认的唯一候选，请明确内容或通过 /memory 查看。', 'info');
      rawInput = undefined; started = performance.now(); firstToken = false;
      return { systemPrompt: systemPrompt(store) };
    } catch (e) { broken = true; ctx.ui.notify(String(e), 'error'); return { systemPrompt: 'PPA 持久状态发生错误。只告知用户检查存储，不调用工具，不声称操作成功。' }; }
  });
  pi.on('context', (event, ctx) => {
    try {
      if (broken) throw new Error('持久状态不可用。');
      if (store.epoch !== epoch) return { messages: [{ role: 'user', content: 'PPA 已完成用户确认的忘记操作。不要回顾先前内容或调用工具，只简短确认。', timestamp: Date.now() }] };
      const memories = projection(store, current?.content ?? '', scope, config.memoryBudgetChars) + (reviewResult ? `\n宿主候选处理结果：${JSON.stringify(reviewResult)}。active 才是提交成功，rejected 是拒绝；not_confirmed 表示没有提交，请坦诚说明并让用户明确要保存的内容。成功后简短确认，不重复提议或询问。` : '');
      const messages = [{ role: 'user' as const, content: memories, timestamp: Date.now() }, ...event.messages.filter(m => !(m.role === 'custom' && m.customType === 'ppa-memory'))];
      reflectionContext = { systemPrompt: systemPrompt(store), messages: convertToLlm(messages) };
      return { messages };
    } catch (e) {
      broken = true; ctx.abort(); ctx.ui.notify(String(e), 'error');
      // Pi logs extension exceptions and continues, so return a clean context on failure.
      return { messages: [{ role: 'user', content: 'PPA 持久状态读取失败。请停止并检查本地存储。', timestamp: Date.now() }] };
    }
  });
  pi.on('message_update', event => {
    if (event.assistantMessageEvent.type === 'text_delta') spokenThisTurn = (spokenThisTurn + event.assistantMessageEvent.delta).slice(-4000);
    if (!firstToken && event.assistantMessageEvent.type === 'text_delta') { firstToken = true; store.timing('chat.first_token', performance.now() - started); }
  });
  pi.on('message_end', event => {
    if (event.message.role === 'assistant') dialogue.finishReply(textOf(event.message.content), ['error', 'aborted'].includes(event.message.stopReason));
    if (event.message.role === 'assistant' && store.epoch === epoch) store.addSource(sessionId, 'assistant', 'model', textOf(event.message.content));
  });
  pi.on('agent_settled', (_event, ctx) => {
    if (started) { store.timing('chat.turn', performance.now() - started); started = 0; }
    current = undefined;
    for (const actionId of extensionActions.values()) actions.finish(actionId, 'unknown', '扩展执行未收到最终结果');
    extensionActions.clear();
    if (store.epoch !== epoch) options.reset();
    else store.session(sessionId, ctx.sessionManager.getSessionFile());
  });
  pi.on('session_start', (_event, ctx) => { store.session(sessionId, ctx.sessionManager.getSessionFile()); ctx.ui.setStatus('ppa', `${store.identity().name} · 记忆边界 ${epoch} · 本机可信模式`); });
  pi.on('session_before_switch', (event, ctx) => {
    if (event.reason === 'resume' && (!event.targetSessionFile || !store.canResume(event.targetSessionFile))) { notify(ctx, '该会话已归档或不属于 PPA，仅可在本地历史中查看。'); return { cancel: true }; }
  });
  pi.on('session_before_fork', (_event, ctx) => { notify(ctx, '首版暂不允许分叉或导入对话；请使用 /new。'); return { cancel: true }; });
  pi.on('session_before_tree', (_event, ctx) => { notify(ctx, '首版暂不重放历史分支；请使用 /new 或恢复有效会话。'); return { cancel: true }; });
  pi.on('session_before_compact', () => store.epoch !== epoch ? { cancel: true } : undefined);
  pi.on('model_select', event => { store.set('model_id', event.model.id); });
  pi.on('user_bash', () => ({ result: { output: 'PPA 禁用 ! / !! 快捷 Shell。请让助手调用受控 Shell 工具。', exitCode: 1, cancelled: false, truncated: false } }));

  const native = [createReadTool(paths.workspace), createWriteTool(paths.workspace), createEditTool(paths.workspace), createGrepTool(paths.workspace), createFindTool(paths.workspace), createLsTool(paths.workspace), process.platform === 'win32' ? createPowerShellTool(paths.workspace) : createBashTool(paths.workspace)];
  const nativeNames = new Set(native.map(t => t.name));
  for (const tool of native) pi.registerTool({
    name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, executionMode: 'sequential',
    execute: async (callId, args, signal, onUpdate, ctx) => { guard(); return actions.execute(callId, sessionId, tool.name, args as Record<string, unknown>, paths.workspace, ask(ctx), async () => { guard(); return tool.execute(callId, args as never, signal, onUpdate); }, signal); },
  });
  const memoryNames = new Set(['search', 'propose', 'revise', 'forget', 'review', 'reflect']);
  pi.on('tool_call', async (event, ctx) => {
    if (broken) return { block: true, reason: '持久状态不可用，禁止执行。', terminate: true };
    if (store.epoch !== epoch) return { block: true, reason: '已建立忘记边界，禁止继续旧轮次。', terminate: true };
    if (nativeNames.has(event.toolName) || memoryNames.has(event.toolName)) return;
    try {
      const actionId = await actions.begin(event.toolCallId, sessionId, event.toolName, event.input, paths.workspace, ask(ctx));
      actions.dispatch(actionId); extensionActions.set(event.toolCallId, actionId);
    } catch (e) { return { block: true, reason: String(e) }; }
  });
  pi.on('tool_result', event => {
    const actionId = extensionActions.get(event.toolCallId); if (!actionId) return;
    actions.finish(actionId, event.isError ? 'failed' : 'succeeded', '扩展返回最终结果'); extensionActions.delete(event.toolCallId);
  });
  pi.registerTool({ name: 'search', label: '检索长期记忆', description: 'Search effective long-term memories. Empty query lists recent memories. Current workspace and global only.', parameters: Type.Object({ query: Type.String() }), execute: async (_id, args) => { guard(); const rows = store.search(args.query, scope); dialogue.focus(rows); return response(rows.map(({ id, key, content, kind, scope, version }) => ({ id, key, content, kind, scope, version }))); } });
  pi.registerTool({ name: 'reflect', label: '思考', description: 'Consider a difficult question using the same model with reasoning enabled. For speak-then-think, put your meaningful first sentence in opening; the terminal displays it BEFORE reasoning starts. Use an empty opening to think silently before answering. After the result continue naturally. Simple conversation needs no call. Not a source of facts or permissions.', parameters: Type.Object({ opening: Type.String({ maxLength: 400, description: 'Required choice: empty string to think silently; a genuine first sentence to speak BEFORE thinking. When user asks for a first reaction before thinking this MUST be nonempty. No filler or process narration.' }), question: Type.String({ minLength: 1, maxLength: 1600, description: 'Brief issue to consider, not a chain of thought.' }) }), executionMode: 'sequential', execute: async (_id, args, signal, _update, ctx) => {
    guard(); if (!ctx.model || !reflectionContext) throw new Error('没有可用的当前模型或对话。');
    if (++reflections > 2) throw new Error('本轮思考次数已用完，请基于已有信息回应，不要再次调用。');
    if (args.opening?.trim()) {
      spokenThisTurn = (spokenThisTurn + '\n' + args.opening).slice(-4000);
      store.addSource(sessionId, 'assistant', 'model', args.opening);
    }
    const start = performance.now();
    ctx.ui.setStatus('ppa-reflection', '正在思考…');
    try {
      const result = await reflect({ runtime: options.modelRuntime, model: ctx.model, context: reflectionContext, question: `${args.question}\n本轮已经对用户说出的内容（助手发言，不是用户事实）：${JSON.stringify(spokenThisTurn)}`, signal, maxTokens: config.reflectionMaxTokens ?? 4096, timeoutMs: config.reflectionTimeoutMs ?? 60000 });
      guard(); signal?.throwIfAborted(); return response({ ...result, openingAlreadyShown: args.opening, continuation: '用户已经看到 openingAlreadyShown，请直接接着说新增的判断或必要的一问，不再问候、不重说开场，不说“现在我认真想完了”。不确定的对象先澄清，不根据推测执行动作或记忆写入。' });
    } catch (e) {
      if (ctx.hasUI) ctx.ui.notify(signal?.aborted ? '思考已取消。' : `思考未完成：${String(e)}`, 'warning');
      throw e;
    } finally { ctx.ui.setStatus('ppa-reflection', undefined); store.timing('chat.reflection', performance.now() - start); }
  },
    // Keep internal tool arguments and conclusion out of conversational TUI; status and errors use the host UI.
    renderCall: args => new Text(args.opening ?? '', 0, 0),
    renderResult: () => ({ render: () => [], invalidate() {} }),
  });
  const save = async (args: unknown, ctx: ExtensionContext, revision = false) => {
    const s = source(); let p = args as Proposal & { reference?: string };
    if (revision || p.reference) {
      const target = dialogue.resolve(p.reference ?? p.targetId ?? p.key);
      p = { ...p, key: target.key, kind: target.kind, scope: target.scope, targetId: target.id, expectedVersion: target.version };
    }
    if (p.scope && p.scope !== 'global' && p.scope !== scope) throw new Error('只能保存全局或当前工作区记忆。');
    const result = store.propose(p, s.id);
    if (result.status === 'pending' && result.id) {
      const content = dialogue.offer(result.id, ctx.hasUI);
      if (ctx.hasUI) ctx.ui.notify(`待确认记忆：${content}\n可回复“对，就这样记”或“不要记”。`, 'info');
      return response({ ...result, proposedContent: content, instruction: '向用户逐字展示 proposedContent 并询问。用户下一句可说“对，就这样记”或“不要记”；不要要求复制 ID，不要立即调用 review 打开另一层确认。' });
    }
    return response(result);
  };
  pi.registerTool({ name: 'propose', label: '记忆提议', description: 'Propose durable memory grounded in current user words. Ordinary stated facts may commit; uncertain/sensitive/changes become pending. Never use assistant/quoted statements as user facts.', parameters: proposalSchema, execute: async (_id, args, _signal, _update, ctx) => save(args, ctx) });
  pi.registerTool({ name: 'revise', label: '修订记忆', description: 'Revise an existing memory using reference=topic key from search, content and exact current-user evidence. Host resolves ID/version. Present the candidate for a natural next-turn confirmation.', parameters: proposalSchema, execute: async (_id, args, _signal, _update, ctx) => save(args, ctx, true) });
  pi.registerTool({ name: 'review', label: '确认候选记忆', description: 'Resolve an older pending candidate by topic key (reference) and request host UI approval. For the immediately preceding candidate, let the user answer naturally instead.', parameters: Type.Object({ id: Type.Optional(Type.String()), reference: Type.Optional(Type.String()) }), execute: async (_id, args, _signal, _update, ctx) => {
    source(); const c = dialogue.pendingReference(args.reference ?? args.id);
    if (!await ask(ctx)('记住这条内容？', c.data)) return response({ status: 'pending', reason: '尚未确认。' });
    return response(store.review(c.id, true));
  } });
  pi.registerTool({ name: 'forget', label: '忘记记忆', description: 'Withdraw one memory using reference=topic key from search (or id). Ambiguous references require clarification. On success all old sessions become view-only and a clean session starts.', parameters: Type.Object({ id: Type.Optional(Type.String()), reference: Type.Optional(Type.String()) }), execute: async (_id, args, _signal, _update, ctx) => {
    source(); const m = dialogue.resolve(args.reference ?? args.id ?? 'latest');
    if (!await ask(ctx)('忘记这条记忆并开始干净会话？', m.content)) return response({ status: 'not_confirmed' });
    const result = store.forget(m.id); current = undefined; return response(result);
  } });

  command('identity', '查看人格；/identity edit 修改', async (args, ctx) => {
    if (args !== 'edit') { notify(ctx, store.identity()); return; }
    const old = store.identity();
    const name = await ctx.ui.input('名字', old.name); if (!name) return;
    const personality = await ctx.ui.input('人格基调', old.personality); if (!personality) return;
    const relationship = await ctx.ui.input('相处方式', old.relationship); if (!relationship) return;
    if (await ask(ctx)('保存人格新版本？', JSON.stringify({ name, personality, relationship }))) notify(ctx, store.saveIdentity({ name, personality, relationship }));
  });
  command('memory', '查看记忆；pending / approve ID / reject ID / restore ID / search 词', async (args, ctx) => {
    const [op, ...rest] = args.split(/\s+/); const key = rest.join(' ');
    if (op === 'pending') notify(ctx, store.all("SELECT id,data FROM candidates WHERE status='pending'"));
    else if (op === 'approve' || op === 'reject') notify(ctx, store.review(key, op === 'approve'));
    else if (op === 'restore') {
      const m = store.memory(key); if (!m) throw new Error('记忆不存在。');
      if (await ask(ctx)('明确重新记住？', m.content)) { const s = store.addSource(sessionId, 'user', 'interactive', `明确重新记住：${m.content}`); notify(ctx, store.restore(key, s.id)); }
    } else if (op === 'withdrawn') notify(ctx, store.all<Memory>("SELECT * FROM memories WHERE status='withdrawn'"));
    else notify(ctx, store.search(op === 'search' ? key : args, scope, 50));
  });
  command('forget', '忘记指定 ID，并切换干净会话', async (args, ctx) => {
    const m = store.memory(args); if (!m || m.status !== 'active') throw new Error('请用 /memory 查找有效记忆 ID。');
    if (!await ask(ctx)('忘记并归档所有旧会话？', m.content)) return;
    store.forget(args); current = undefined; notify(ctx, '已忘记。旧历史保留在本机，但不再送入模型。'); await ctx.newSession();
  });
  command('permissions', '查看授权；grant read|write 目录 / shell / revoke ID', async (args, ctx) => {
    const match = /^grant (read|write) (.+)$/.exec(args);
    if (match) {
      const resource = resolve(paths.workspace, match[2]);
      if (await ask(ctx)('授予目录权限？', `${match[1]} ${resource}`)) notify(ctx, actions.grant(match[1] as 'read' | 'write', resource));
    } else if (args === 'shell') {
      if (await ask(ctx)('允许当前会话 Shell 使用宿主权限？', '可访问工作区以外的文件和网络；重启后失效。')) notify(ctx, actions.grant('shell', '*', sessionId));
    } else if (args.startsWith('revoke ')) { actions.revoke(args.slice(7)); notify(ctx, '已撤销。'); }
    else notify(ctx, actions.grants());
  });
  command('actions', '查看执行；resolve ID succeeded|failed 核实依据', async (args, ctx) => {
    const m = /^resolve (\S+) (succeeded|failed) (.+)$/.exec(args);
    if (m) { if (await ask(ctx)('提交人工核实结果？', args)) { actions.resolveUnknown(m[1], m[2] as 'succeeded' | 'failed', m[3]); notify(ctx, '已记录核实结果。'); } }
    else notify(ctx, actions.list(args === 'unknown' ? 'unknown' : undefined));
  });
  command('backup', '备份数据库与 Pi 会话', async (_args, ctx) => { const { createBackup } = await import('./backup.js'); notify(ctx, await createBackup(store, paths)); });
}
