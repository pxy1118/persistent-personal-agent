import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startModelBridge } from '../src/model-bridge.js';

test('model bridge hides native discovery so /props vision is read, and forwards the rest verbatim', async () => {
  const upstream = createServer((req, res) => {
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'm' }] })); return; }
    if (req.url?.startsWith('/props')) { res.setHeader('Content-Type', 'application/json'); res.end('{"modalities":{"vision":true}}'); return; }
    if (req.url === '/v1/chat/completions') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"chunk":1}\n\n'); res.end('data: [DONE]\n\n'); return; }
    res.writeHead(200); res.end('ok:' + req.url);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const realPort = (upstream.address() as { port: number }).port;
  const bridge = await startModelBridge(`http://127.0.0.1:${realPort}/v1`);
  try {
    assert.equal(bridge.baseUrl.endsWith('/v1'), true);
    const origin = bridge.baseUrl.slice(0, -3);
    const native = await fetch(`${origin}/models`);           // letta llama-cpp native discovery probe
    assert.equal(native.status, 404);
    const list = await fetch(`${bridge.baseUrl}/models`);     // OpenAI-compatible /v1/models fallback
    assert.equal(list.status, 200);
    assert.equal((await list.json()).data[0].id, 'm');
    const props = await fetch(`${origin}/props?model=m`);     // /props vision metadata
    assert.equal((await props.json()).modalities.vision, true);
    const chat = await fetch(`${bridge.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [] }) });
    assert.equal(chat.status, 200);
    assert.ok((await chat.text()).includes('chunk'));
  } finally {
    bridge.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
