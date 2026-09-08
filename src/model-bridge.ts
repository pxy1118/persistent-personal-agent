import { createServer, request } from 'node:http';

export type ModelBridge = { baseUrl: string; close: () => void };

/**
 * Local capability bridge between the managed letta runtime and a local model service.
 *
 * letta-code 0.31.12's llama.cpp discovery parses the native `/models` response for
 * `architecture.input_modalities` only, but this service advertises visual capability
 * via `capabilities: ["completion","multimodal"]` (and `/props` modalities.vision).
 * Because the native parse still sees `meta.n_ctx`, discovery short-circuits and the
 * model is labelled text-only — images then degrade to a placeholder before reaching
 * the model. The bridge answers the native discovery probe with 404 so letta-code
 * falls through to the `/props` path (which reads vision correctly), and forwards
 * every other request verbatim. Only used for the `llama-cpp` provider.
 */
export async function startModelBridge(baseUrl: string): Promise<ModelBridge> {
  const upstream = new URL(baseUrl);
  const server = createServer((req, res) => {
    const body: Buffer[] = [];
    req.on('data', d => body.push(d));
    req.on('end', () => {
      const path = req.url ?? '/';
      if (req.method === 'GET' && ['/models', '/api/ps', '/api/tags', '/api/show', '/health'].includes(path)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      const proxied = request({
        host: upstream.hostname,
        port: upstream.port,
        path,
        method: req.method ?? 'GET',
        headers: { ...req.headers, host: upstream.host },
      }, r => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      proxied.on('error', e => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `model bridge: ${String(e)}` }));
      });
      const raw = Buffer.concat(body);
      if (raw.length) proxied.write(raw);
      proxied.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}${upstream.pathname}`,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}
