import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeliberationInput, probeAdaptiveThinking, removeExactRepeatedOpening, runDeliberation } from '../src/adaptive-thinking.js';
import type { LettaConfig } from '../src/ppa-runtime.js';

const config: LettaConfig = {
  provider: 'llama-cpp', modelBaseUrl: 'http://127.0.0.1:18080/v1', modelId: 'qwen.gguf', contextWindow: 32768, maxTokens: 4096
};

test('deliberation input accepts only one bounded standard/deep request',()=>{
  assert.deepEqual(parseDeliberationInput({question:' 比较两个方案 ',depth:'deep'}),{question:'比较两个方案',depth:'deep'});
  assert.throws(()=>parseDeliberationInput({question:'',depth:'standard'}),/1 到 4000/);
  assert.throws(()=>parseDeliberationInput({question:'问题',depth:'extreme'}),/standard 或 deep/);
});

test('continuation removes only a byte-for-byte repeated opening',()=>{
  assert.equal(removeExactRepeatedOpening('我理解你的担心。','我理解你的担心。\n接下来分析。'),'接下来分析。');
  assert.equal(removeExactRepeatedOpening('我理解你的担心。','我明白你的担心。接下来分析。'),'我明白你的担心。接下来分析。');
});

test('adaptive capability probe verifies template switching and budgeted visible output',async()=>{
  const original=globalThis.fetch; const requests:any[]=[];
  globalThis.fetch=(async (input:URL|string|Request,init?:RequestInit)=>{
    const url=String(input),body=JSON.parse(String(init?.body)); requests.push({url,body});
    if(url.endsWith('/apply-template')) return Response.json({prompt:body.chat_template_kwargs.enable_thinking?'THINKING':'DIRECT'});
    const enabled=body.chat_template_kwargs.enable_thinking;
    const size=body.thinking_budget_tokens===256?240:60;
    return Response.json({choices:[{message:{content:'OK',reasoning_content:enabled?'x'.repeat(size):''}}],usage:{completion_tokens:size+1}});
  }) as typeof fetch;
  try {
    assert.deepEqual(await probeAdaptiveThinking(config,'qwen.gguf'),{available:true});
    const completions=requests.filter(row=>row.url.endsWith('/v1/chat/completions'));
    assert.equal(completions.length,3);
    assert.equal(completions[0].body.chat_template_kwargs.enable_thinking,false);
    assert.deepEqual(completions.slice(1).map(row=>row.body.thinking_budget_tokens),[64,256]);
  } finally { globalThis.fetch=original; }
});

test('private deliberation applies the selected independent token budget',async()=>{
  const original=globalThis.fetch; let sent:any;
  globalThis.fetch=(async (_input:URL|string|Request,init?:RequestInit)=>{
    sent=JSON.parse(String(init?.body));
    return Response.json({choices:[{message:{content:'关键判断；仍需核对证据。',reasoning_content:'hidden'}}],usage:{completion_tokens:1200}});
  }) as typeof fetch;
  try {
    const result=await runDeliberation({config,modelId:'qwen.gguf',args:{question:'哪种方案更稳妥？',depth:'deep'},history:[],userText:'请比较',visibleOpening:'我明白你需要一个稳妥判断。',signal:AbortSignal.timeout(1000)});
    assert.equal(sent.thinking_budget_tokens,4096);
    assert.equal(sent.max_tokens,4864);
    assert.equal(sent.chat_template_kwargs.enable_thinking,true);
    assert.equal(result.text,'关键判断；仍需核对证据。');
  } finally { globalThis.fetch=original; }
});

test('non-llama providers fail closed instead of pretending adaptive mode works',async()=>{
  const result=await probeAdaptiveThinking({...config,provider:'openai-compatible'},'model');
  assert.equal(result.available,false); assert.match(result.reason??'',/不是 llama\.cpp/);
});
