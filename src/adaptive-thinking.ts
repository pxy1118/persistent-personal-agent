import type { ChatMessage } from './ppa-session.js';
import { modelApiKey, type LettaConfig } from './ppa-runtime.js';

export const deliberationDepths = ['standard', 'deep'] as const;
export type DeliberationDepth = (typeof deliberationDepths)[number];
export type DeliberationInput = { question: string; depth: DeliberationDepth };
export type AdaptiveProbe = { available: boolean; reason?: string };

export const deliberateToolDefinition = {
  name: 'deliberate',
  label: '认真想想',
  description: `Use this private internal tool only when the user's request needs comparison, multi-step reasoning, careful uncertainty handling, or a consequential judgment. Simple conversation, greetings, acknowledgements, factual recall, and ordinary emotional listening should be answered directly without this tool. For an emotional request that also needs substantial analysis, FIRST emit one short, specific, honest acknowledgement as ordinary assistant content, and only AFTER that visible content emit the deliberate tool call in the same assistant turn; after the tool returns, continue from the next point. The opening must never be placed in tool arguments. Example ordering: assistant content that specifically acknowledges the user's tension -> deliberate tool call -> continuation that does not repeat the acknowledgement. If you cannot emit content before a tool call, answer directly without deliberate instead of leaving the user waiting. For analysis where an early statement could mislead, call deliberate before saying anything. Never use a fixed filler such as “让我想想”, never narrate that analysis is required, never claim an action or verification before it happened, and never call this tool more than once in a user turn. The tool performs no actions and writes no memory.`,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['question', 'depth'],
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 4000, description: 'The exact issue that needs private careful reasoning, including the decision or uncertainty to resolve.' },
      depth: { type: 'string', enum: deliberationDepths, description: 'standard for ordinary multi-step judgment; deep only for genuinely difficult reasoning.' }
    }
  }
} as const;

function headers(c: LettaConfig) {
  const key = modelApiKey(c);
  return { 'content-type': 'application/json', ...(key === 'local-no-key' ? {} : { authorization: `Bearer ${key}` }) };
}

async function postJson(url: string, c: LettaConfig, body: Record<string, unknown>, signal: AbortSignal) {
  const response = await fetch(url, { method: 'POST', headers: headers(c), body: JSON.stringify(body), signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return await response.json() as any;
}

export async function probeAdaptiveThinking(c: LettaConfig, modelId: string): Promise<AdaptiveProbe> {
  if (c.provider !== 'llama-cpp') return { available: false, reason: '当前模型服务不是 llama.cpp，尚未验证请求级思考控制。' };
  const signal = AbortSignal.timeout(30000);
  const native = c.modelBaseUrl.replace(/\/v1\/?$/, '');
  const base = { model: modelId, messages: [{ role: 'user', content: 'Reply only with OK.' }] };
  try {
    const disabled = await postJson(`${native}/apply-template`, c, { ...base, chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } }, signal);
    const enabled = await postJson(`${native}/apply-template`, c, { ...base, chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } }, signal);
    if (typeof disabled.prompt !== 'string' || typeof enabled.prompt !== 'string' || disabled.prompt === enabled.prompt) {
      return { available: false, reason: '模型模板没有证明 enable_thinking 能逐请求切换。' };
    }
    const direct = await postJson(`${c.modelBaseUrl}/chat/completions`, c, {
      ...base, stream: false, temperature: 0, max_tokens: 64,
      chat_template_kwargs: { enable_thinking: false, preserve_thinking: true }
    }, signal);
    const directMessage = direct?.choices?.[0]?.message;
    if (typeof directMessage?.content !== 'string' || !directMessage.content.trim() || (typeof directMessage.reasoning_content === 'string' && directMessage.reasoning_content.trim())) {
      return { available: false, reason: '关闭思考的请求仍产生 reasoning，或没有得到可见正文。' };
    }
    const budgetPrompt = { model: modelId, messages: [{ role: 'user', content: 'Privately solve: find the smallest positive n divisible by 7 where n+1 is divisible by 11. Return only n.' }] };
    const withBudget = async (thinkingBudget: number) => postJson(`${c.modelBaseUrl}/chat/completions`, c, {
      ...budgetPrompt, stream: false, temperature: 0, max_tokens: thinkingBudget + 128,
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
      thinking_budget_tokens: thinkingBudget
    }, signal);
    const [low, high] = await Promise.all([withBudget(64), withBudget(256)]);
    const lowMessage = low?.choices?.[0]?.message, highMessage = high?.choices?.[0]?.message;
    const lowReasoning = typeof lowMessage?.reasoning_content === 'string' ? lowMessage.reasoning_content.trim() : '';
    const highReasoning = typeof highMessage?.reasoning_content === 'string' ? highMessage.reasoning_content.trim() : '';
    if (!lowReasoning || !highReasoning || highReasoning.length <= lowReasoning.length || typeof highMessage?.content !== 'string' || !highMessage.content.trim()) {
      return { available: false, reason: 'reasoning 事件没有随 thinking_budget_tokens 改变，无法确认预算控制生效。' };
    }
    return { available: true };
  } catch (error) {
    return { available: false, reason: `自适应思考能力验证失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

export function parseDeliberationInput(input: Record<string, unknown>): DeliberationInput {
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  const depth = input.depth;
  if (!question || question.length > 4000) throw new Error('question 必须是 1 到 4000 字符的文本。');
  if (!deliberationDepths.includes(depth as DeliberationDepth)) throw new Error('depth 必须是 standard 或 deep。');
  return { question, depth: depth as DeliberationDepth };
}

function compactHistory(history: ChatMessage[]) {
  let remaining = 12000;
  const rows: Array<{ role: string; content: string }> = [];
  for (const item of history.slice(-16).reverse()) {
    const content = item.text.slice(-remaining);
    if (!content) break;
    rows.unshift({ role: item.role, content }); remaining -= content.length;
    if (remaining <= 0) break;
  }
  return rows;
}

export async function runDeliberation(input: {
  config: LettaConfig; modelId: string; args: DeliberationInput; history: ChatMessage[];
  userText: string; visibleOpening: string; signal: AbortSignal;
}) {
  const budget = input.args.depth === 'deep' ? 4096 : 1024;
  const conclusion = input.args.depth === 'deep' ? 768 : 512;
  const context = compactHistory(input.history);
  const payload = await postJson(`${input.config.modelBaseUrl}/chat/completions`, input.config, {
    model: input.modelId,
    messages: [
      { role: 'system', content: 'You are the private deliberation process of the same assistant. Think carefully, but perform no tools, make no external changes, and do not claim unverified facts. Return only a concise internal conclusion for the assistant: the key judgment, uncertainties, and any evidence it still needs. Do not address the user and do not repeat the visible opening.' },
      ...context,
      { role: 'user', content: `Current user message:\n${input.userText}\n\nVisible response already spoken:\n${input.visibleOpening || '(none)'}\n\nIssue to deliberate:\n${input.args.question}` }
    ],
    stream: false,
    max_tokens: budget + conclusion,
    chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
    thinking_budget_tokens: budget,
    reasoning_budget_message: 'Conclude the private analysis now and state the useful internal result.'
  }, input.signal);
  const message = payload?.choices?.[0]?.message;
  const text = typeof message?.content === 'string' ? message.content.trim() : '';
  if (!text) throw new Error('内部思考没有形成可供续答使用的结论。');
  return { text, budget, usage: payload?.usage ?? null };
}

export function removeExactRepeatedOpening(opening: string, continuation: string) {
  if (!opening || !continuation.startsWith(opening)) return continuation;
  return continuation.slice(opening.length).replace(/^\s+/, '');
}
