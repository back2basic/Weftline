import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createBoardHandler } from './board.js';
import { parseAppwriteResponse } from './appwrite.js';

const landing = readFileSync(new URL('../public/index.html', import.meta.url));

const { BOARD_ORIGIN: origin, APPWRITE_ENDPOINT: endpoint, APPWRITE_PROJECT: project, APPWRITE_API_KEY: apiKey } = process.env;
let board;
try {
  if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('Invalid origin');
  const upstream = new URL(endpoint);
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Invalid endpoint');
  if (project !== '6afa1a52001753a01f2a' || !apiKey) throw new Error('Invalid project configuration');
  const appwrite = async (path, options = {}) => {
    const headers = {'X-Appwrite-Project': project, 'Content-Type': 'application/json'};
    if (options.admin) headers['X-Appwrite-Key'] = apiKey;
    if (options.session) headers['X-Appwrite-Session'] = options.session;
    const response = await fetch(endpoint.replace(/\/$/, '') + path, {method: options.method ?? 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined, redirect:'error', signal:AbortSignal.timeout(10000)});
    return parseAppwriteResponse(response);
  };
  board = createBoardHandler({origin, appwrite});
} catch { /* Fail closed when configuration is absent or invalid. */ }

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (req.url === '/board' || req.url?.startsWith('/board/')) {
    if (!board || (req.url !== '/board/login' && req.url !== '/board/logout')) { res.writeHead(503); res.end('Board unavailable'); return; }
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 8192) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
      const request = new Request(origin + req.url, {method:req.method, headers:req.headers, ...(length ? {body:Buffer.concat(chunks), duplex:'half'} : {})});
      const response = await board(request);
      for (const [key, value] of response.headers) res.setHeader(key, value);
      res.writeHead(response.status); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(502); res.end('Board request failed'); }
    return;
  }
  if ((req.url === '/' || req.url === '/health') && req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    res.end();
    return;
  }
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(landing);
    return;
  }
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const host = process.env.HOST ?? '127.0.0.1';
server.listen(process.env.PORT ?? 3000, host, () => {
  console.log(`Listening on ${host}:${server.address().port}`);
});
