import { validateGuardedAuthority } from '../experimental/guarded-appwrite-composition.js';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';
import { createHumanBoardAdapter } from './team-human-board-slice.js';
import { createKnowledgeAdapter, createKnowledgeV2Adapter } from './private-knowledge-listener.js';
import { createClosedPrivateKnowledge } from './private-knowledge.js';
import { readFileSync } from 'node:fs';
import { createBoardHandler } from './board.js';
import { parseAppwriteResponse } from './appwrite.js';

const landing = readFileSync(new URL('../public/index.html', import.meta.url));

export function createAppServer(options = {}) {
if (!options || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) throw new Error('Invalid configuration');
const config = Object.create(null);
for (const key of Reflect.ownKeys(options)) {
  const descriptor = Object.getOwnPropertyDescriptor(options, key);
  if (!['human', 'tls', 'knowledge', 'knowledgeV2'].includes(key) || !descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid configuration');
  config[key] = descriptor.value;
}
const {human, tls} = config;
let knowledge;
if (config.knowledge !== undefined) {
  const input = config.knowledge;
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) throw Error('Invalid configuration');
  knowledge = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!['enabled', 'service', 'boardId', 'knowledgePayloadMaxBytes'].includes(key) || !descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('Invalid configuration');
    knowledge[key] = descriptor.value;
  }
  if (knowledge.enabled === true) {
    const service = knowledge.service;
    if (!service || typeof service !== 'object' || types.isProxy(service) || Object.getPrototypeOf(service) !== Object.prototype) throw Error('Invalid configuration');
    for (const key of ['create', 'read']) {
      const descriptor = Object.getOwnPropertyDescriptor(service, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') throw Error('Invalid configuration');
    }
  }
}
let origin, board, humanAdapter, humanEnabled = false;
if (human !== undefined) {
  if (!human || types.isProxy(human)) throw new Error('Invalid configuration');
  const enabled = Object.getOwnPropertyDescriptor(human, 'enabled');
  humanAdapter = createHumanBoardAdapter(human);
  humanEnabled = enabled?.value === true;
  if (enabled?.value === true && !tls) throw new Error('Human board requires direct TLS');
} else {
const { BOARD_ORIGIN, APPWRITE_ENDPOINT: endpoint, APPWRITE_PROJECT: project, APPWRITE_API_KEY: apiKey } = process.env;
origin = BOARD_ORIGIN;
try {
  if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('Invalid origin');
  validateGuardedAuthority(endpoint,project,process.env.WEFTLINE_APPROVED_APPWRITE_ENDPOINT,process.env.WEFTLINE_APPROVED_APPWRITE_PROJECT);
  if (!apiKey) throw new Error('Invalid project configuration');
  const appwrite = async (path, options = {}) => {
    const headers = {'X-Appwrite-Project': project, 'Content-Type': 'application/json'};
    if (options.admin) headers['X-Appwrite-Key'] = apiKey;
    if (options.session) headers['X-Appwrite-Session'] = options.session;
    const response = await fetch(endpoint.replace(/\/$/, '') + path, {method: options.method ?? 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined, redirect:'error', signal:AbortSignal.timeout(10000)});
    return parseAppwriteResponse(response);
  };
  board = createBoardHandler({origin, appwrite});
} catch { /* Fail closed when configuration is absent or invalid. */ }
}

// Actor-bound mode is exclusive: never construct or mount the legacy adapter.
const knowledgeAdapter = knowledge === undefined || config.knowledgeV2 !== undefined ? null : (()=>{
  if (!humanEnabled || !tls) throw Error('Knowledge requires local board TLS');
  return createKnowledgeAdapter(knowledge);
})();
const knowledgeV2Adapter = config.knowledgeV2 === undefined ? null : (()=>{
  if (!humanEnabled || !tls) throw Error('Knowledge requires local board TLS');
  return createKnowledgeV2Adapter(config.knowledgeV2);
})();
const listener = async (req, res) => {
  if (knowledgeV2Adapter && req.url?.startsWith('/knowledge/v2/')) return knowledgeV2Adapter(req,res);
  if (knowledgeV2Adapter && (req.url === '/knowledge' || req.url?.startsWith('/knowledge/') || req.url?.startsWith('/knowledge?'))) { res.writeHead(404, {'cache-control':'no-store','connection':'close'}); res.end('Not found'); req.resume(); return; }
  if (knowledgeAdapter && (req.url === '/knowledge' || req.url?.startsWith('/knowledge/') || req.url?.startsWith('/knowledge?'))) return knowledgeAdapter(req,res);
  if (humanAdapter && (humanEnabled || !['/health', '/'].includes(req.url?.split('?')[0]))) return humanAdapter(req, res);
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
};

// Bound incomplete headers on the local human/knowledge TLS listener. Node
// checks deadlines periodically, so closure is not an exact five-second timer.
if (tls && humanEnabled) return https.createServer({...tls, headersTimeout:5000, requestTimeout:5000, connectionsCheckingInterval:1000}, listener);
return tls ? https.createServer(tls, listener) : http.createServer(listener);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // There is no trusted-proxy receiver yet. Never silently accept an apparent
  // production opt-in and fall back to a different, potentially public mode.
  if (process.env.WEFTLINE_PRODUCTION_INGRESS !== undefined) {
    console.error('Production ingress unavailable');
    process.exitCode = 1;
  } else if (process.env.WEFTLINE_REVIEW_PROXY !== undefined) {
    // The proxy receiver validates its complete configuration before listening.
    await import('../experimental/review-v1-cli.js');
  } else if (process.env.WEFTLINE_LOCAL_HUMAN_BOARD === undefined && process.env.WEFTLINE_LOCAL_REAL_LOGIN === undefined && process.env.WEFTLINE_LOCAL_BOARD_KNOWLEDGE === undefined && process.env.WEFTLINE_LOCAL_BOARD_KNOWLEDGE_V2 === undefined) {
    const server = createAppServer();
    const host = process.env.HOST ?? '127.0.0.1';
    server.listen(process.env.PORT ?? 3000, host, () => {
      console.log(`Listening on ${host}:${server.address().port}`);
    });
  } else {
    // Development only: loopback is not origin proof. Trust the host and all
    // local processes: a local relay can expose this listener to remote users.
    // This is not production-ready. Real login requires a separate opt-in.
    try {
      const e=process.env;
      if (e.WEFTLINE_LOCAL_HUMAN_BOARD !== '1' || (e.HOST !== undefined && e.HOST !== '127.0.0.1')) throw Error();
      if (e.WEFTLINE_LOCAL_REAL_LOGIN !== undefined && e.WEFTLINE_LOCAL_REAL_LOGIN !== '1') throw Error();
      if (!/^[1-9][0-9]{0,4}$/.test(e.PORT ?? '') || Number(e.PORT)>65535) throw Error();
      const origin=new URL(e.WEFTLINE_ORIGIN);
      if (origin.origin !== e.WEFTLINE_ORIGIN || origin.protocol !== 'https:' || origin.hostname !== '127.0.0.1' || Number(origin.port || '443') !== Number(e.PORT)) throw Error();
      if (!e.WEFTLINE_TLS_KEY || !e.WEFTLINE_TLS_CERT) throw Error();
      validateGuardedAuthority(e.WEFTLINE_ENDPOINT,e.WEFTLINE_PROJECT,e.WEFTLINE_APPROVED_APPWRITE_ENDPOINT,e.WEFTLINE_APPROVED_APPWRITE_PROJECT);
      const human={enabled:true,origin:e.WEFTLINE_ORIGIN,endpoint:e.WEFTLINE_ENDPOINT,approvedEndpoint:e.WEFTLINE_APPROVED_APPWRITE_ENDPOINT,project:e.WEFTLINE_PROJECT,approvedProject:e.WEFTLINE_APPROVED_APPWRITE_PROJECT,boardId:e.WEFTLINE_BOARD_ID,teamId:e.WEFTLINE_TEAM_ID,databaseId:e.WEFTLINE_DATABASE_ID,tableId:e.WEFTLINE_TABLE_ID,key:e.WEFTLINE_API_KEY,transport:fetch};
      if(e.WEFTLINE_LOCAL_REAL_LOGIN==='1')human.localRealLogin=true;
      let knowledge;
      if(e.WEFTLINE_LOCAL_BOARD_KNOWLEDGE!==undefined){
        if(e.WEFTLINE_LOCAL_BOARD_KNOWLEDGE!=='1'||!/^[1-9][0-9]{0,3}$/.test(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES??'')||!e.WEFTLINE_KNOWLEDGE_DATABASE_ID||!e.WEFTLINE_KNOWLEDGE_TABLE_ID||(e.WEFTLINE_KNOWLEDGE_DATABASE_ID===e.WEFTLINE_DATABASE_ID&&e.WEFTLINE_KNOWLEDGE_TABLE_ID===e.WEFTLINE_TABLE_ID))throw Error();
        if(e.WEFTLINE_LOCAL_BOARD_KNOWLEDGE_V2===undefined){
          const cap=Number(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES);
          const service=createClosedPrivateKnowledge({enabled:true,endpoint:e.WEFTLINE_ENDPOINT,approvedEndpoint:e.WEFTLINE_APPROVED_APPWRITE_ENDPOINT,project:e.WEFTLINE_PROJECT,approvedProject:e.WEFTLINE_APPROVED_APPWRITE_PROJECT,boardId:e.WEFTLINE_BOARD_ID,teamId:e.WEFTLINE_TEAM_ID,database:e.WEFTLINE_KNOWLEDGE_DATABASE_ID,table:e.WEFTLINE_KNOWLEDGE_TABLE_ID,key:e.WEFTLINE_API_KEY,knowledgePayloadMaxBytes:cap});
          knowledge={enabled:true,service,boardId:e.WEFTLINE_BOARD_ID,knowledgePayloadMaxBytes:cap};
        }
      }
      let knowledgeV2;
      if(e.WEFTLINE_LOCAL_BOARD_KNOWLEDGE_V2!==undefined){
        if(e.WEFTLINE_LOCAL_BOARD_KNOWLEDGE_V2!=='1'||!/^[1-9][0-9]{0,3}$/.test(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES??'')||!e.WEFTLINE_KNOWLEDGE_DATABASE_ID||!e.WEFTLINE_KNOWLEDGE_TABLE_ID||(e.WEFTLINE_KNOWLEDGE_DATABASE_ID===e.WEFTLINE_DATABASE_ID&&e.WEFTLINE_KNOWLEDGE_TABLE_ID===e.WEFTLINE_TABLE_ID))throw Error();
        knowledgeV2={enabled:true,endpoint:e.WEFTLINE_ENDPOINT,approvedEndpoint:e.WEFTLINE_APPROVED_APPWRITE_ENDPOINT,project:e.WEFTLINE_PROJECT,boardId:e.WEFTLINE_BOARD_ID,teamId:e.WEFTLINE_TEAM_ID,database:e.WEFTLINE_KNOWLEDGE_DATABASE_ID,table:e.WEFTLINE_KNOWLEDGE_TABLE_ID,key:e.WEFTLINE_API_KEY,knowledgePayloadMaxBytes:Number(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES),transport:fetch};
      }
      const server=createAppServer({human,...(knowledgeV2?{knowledgeV2}:{}),tls:{key:e.WEFTLINE_TLS_KEY,cert:e.WEFTLINE_TLS_CERT},...(knowledge?{knowledge}:{})});
      server.on('error',()=>{console.error('Local development server unavailable');process.exitCode=1;});
      server.listen(Number(e.PORT),'127.0.0.1',()=>console.log('Listening on local development TLS'));
    } catch {
      console.error('Invalid local development configuration');
      process.exitCode=1;
    }
  }
}
