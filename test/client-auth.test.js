import { test } from 'node:test';
import { createServer } from 'node:http';
import { once, getEventListeners } from 'node:events';
import { connect } from 'node:net';
import assert from 'node:assert/strict';
import { createClientAuth } from '../src/client-auth.js';

test('rejecting a login with an invalid Host cancels its stalled incoming body without waiting', async () => {
 let cancelled=false, calls=0;
 const stream=new ReadableStream({cancel(){cancelled=true; return new Promise(()=>{});}});
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{calls++;}});
 const response=await Promise.race([handler(makeRequest('https://board.example/login',{method:'POST',headers:{host:'evil.example',origin:'https://board.example'},body:stream,duplex:'half'})),new Promise(resolve=>setTimeout(()=>resolve('stalled'),300))]);
 assert.notEqual(response,'stalled'); assert.equal(response.status,403); assert.equal(cancelled,true); assert.equal(calls,0);
});

test('accepted logout cancels its incoming body before awaiting upstream', async () => {
 let cancelled=false, release;
 const stream=new ReadableStream({cancel(){cancelled=true; return new Promise(()=>{});}});
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:()=>new Promise(resolve=>{release=resolve;})});
 const pending=handler(makeRequest('https://board.example/logout',{method:'POST',headers:{origin:'https://board.example',cookie:'__Host-weftline=valid'},body:stream,duplex:'half'}));
 await new Promise(resolve=>setImmediate(resolve));
 try { assert.equal(cancelled,true); } finally { release(new Response(null,{status:204})); }
 const result=await pending; assert.equal(result.status,204); assert.match(result.headers.get('set-cookie'),/Max-Age=0/);
});

test('other early rejections cancel stalled incoming bodies without upstream access', async () => {
 for (const [path,method,headers,status] of [
  ['/login','POST',{origin:'https://evil.example'},403],
  ['/login','PUT',{origin:'https://board.example'},404],
  ['/unknown','POST',{origin:'https://board.example'},404],
  ['/logout','POST',{origin:'https://board.example'},401]
 ]) {
  let cancelled=false, calls=0;
  const stream=new ReadableStream({cancel(){cancelled=true;return new Promise(()=>{});}});
  const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{calls++;}});
  const result=await Promise.race([handler(makeRequest('https://board.example'+path,{method,headers,body:stream,duplex:'half'})),new Promise(resolve=>setTimeout(()=>resolve('stalled'),300))]);
  assert.notEqual(result,'stalled'); assert.equal(result.status,status,`${method} ${path}`); assert.equal(cancelled,true); assert.equal(calls,0);
 }
});

test('illustrative loopback Node stream bridge closes a peer sending a rejected stalled body', async () => {
 let handled;
 const finished=new Promise(resolve=>{handled=resolve;});
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{throw Error('unexpected');}});
 const server=createServer(async (req,res)=>{
  req.on('error',()=>{}); res.on('error',()=>{});
  let onData;
  const body=new ReadableStream({start(controller){onData=chunk=>controller.enqueue(chunk);req.on('data',onData);},cancel(){req.removeListener('data',onData);req.destroy();}});
  const request=new Request('https://board.example/login',{method:'POST',headers:req.headers,body,duplex:'half'});
  const result=await handler(request); handled(result.status);
  if (!res.destroyed) res.end();
 });
 server.listen(0,'127.0.0.1'); await once(server,'listening');
 const peer=connect(server.address().port,'127.0.0.1');
 peer.on('error',()=>{});
 try {
  await once(peer,'connect');
  const closed=once(peer,'close');
  peer.write('POST /login HTTP/1.1\r\nHost: evil.example\r\nOrigin: https://board.example\r\nContent-Length: 100000\r\n\r\nx');
  let timer;
  try {
   assert.equal(await Promise.race([finished,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('handler stalled')),2000);})]),403);
   clearTimeout(timer);
   await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('peer remained open')),2000);})]);
  } finally { clearTimeout(timer); }
 } finally { peer.destroy(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});

test('unused upstream bodies are cancelled without waiting across response branches', async () => {
 for (const [path, status, cookie, expected] of [['/login',201,'a_session_project=valid',201], ['/login',201,null,502], ['/logout',200,null,204], ['/account',302,null,502], ['/account',429,null,429]]) {
  let cancelled=false;
  const stream=new ReadableStream({cancel(){cancelled=true; return new Promise(()=>{});}});
  const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>new Response(stream,{status,headers:cookie?{'set-cookie':cookie}:{}})});
  const headers={origin:'https://board.example',cookie:'__Host-weftline=valid'};
  const options=path==='/account'?{headers}:{method:'POST',headers,body:path==='/login'?JSON.stringify({email:'a',password:'b'}):undefined};
  const result=await Promise.race([handler(makeRequest('https://board.example'+path,options)),new Promise(resolve=>setTimeout(()=>resolve('stalled'),300))]);
  assert.notEqual(result,'stalled'); assert.equal(result.status,expected); assert.equal(cancelled,true,`${path} ${status}`);
 }
});

test('preserves valid HTTP-date Retry-After while rejecting malformed dates', async () => {
 for (const [value, expected] of [['Sunday, 06-Nov-94 08:49:37 GMT','Sunday, 06-Nov-94 08:49:37 GMT'], ['Sun Nov  6 08:49:37 1994','Sun Nov  6 08:49:37 1994'], ['Wed, 21 Oct 2015 07:28:00 GMT','Wed, 21 Oct 2015 07:28:00 GMT'], ['Wed, 32 Oct 2015 07:28:00 GMT',null], ['Wed, 21 Oct 2015 07:28:00 GMT, secret',null], ['tomorrow',null], ['60','60']]) {
  const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>new Response('private',{status:429,headers:{'retry-after':value}})});
  const result=await handler(makeRequest('https://board.example/account',{headers:{cookie:'__Host-weftline=valid'}}));
  assert.equal(result.headers.get('retry-after'),expected,value);
 }
});

test('loopback transport disconnects on oversized and stalled upstream bodies', async () => {
 for (const kind of ['oversized','stalled']) {
  let closed;
  const disconnected=new Promise(resolve=>{closed=resolve;});
  const server=createServer((req,res)=>{
   res.on('close',closed);
   res.writeHead(200,{'content-type':'application/json'});
   res.write(kind==='oversized'?Buffer.alloc(70000):'private');
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
   const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:(_url,options)=>fetch(`http://127.0.0.1:${server.address().port}/`,options)});
   const result=await handler(makeRequest('https://board.example/account',{headers:{cookie:'__Host-weftline=valid'}}));
   assert.equal(result.status,502); assert.doesNotMatch(await result.text(),/private/);
   let timer;
   try { await Promise.race([disconnected,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${kind}: peer did not disconnect`)),2000);})]); }
   finally { clearTimeout(timer); }
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
 }
});

function makeRequest(url, options = {}) {
 const headers=new Headers(options.headers);
 if (!headers.has('host')) headers.set('host','board.example');
 return new Request(url,{...options,headers});
}

test('Host validation requires exact configured host and port, ignoring forwarded host', async () => {
 let calls=0;
 const handler=createClientAuth({origin:'https://board.example:8443',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{calls++;return new Response('{}');}});
 for (const hosts of [['board.example'],['evil.example:8443'],['board.example:8443, evil.example'],['board.example:8443','board.example:8443'],['board.example:443']]) {
  const headers=new Headers([['cookie','__Host-weftline=valid'],['x-forwarded-host','board.example:8443'],...hosts.map(host=>['host',host])]);
  const r=await handler(new Request('https://board.example:8443/account',{headers}));
  assert.equal(r.status,403);
 }
 assert.equal(calls,0);
 const valid=await handler(new Request('https://board.example:8443/account',{headers:{host:'board.example:8443',cookie:'__Host-weftline=valid','x-forwarded-host':'evil.example'}}));
 assert.equal(valid.status,200); assert.equal(calls,1);
});

test('login elapsed deadline also applies when stream continuously resolves', async () => {
 let count=0, cancelled=false;
 const stream=new ReadableStream({pull(c){const until=performance.now()+15; while(performance.now()<until) {} if (++count===90) c.close(); else c.enqueue(new Uint8Array([32]));},cancel(){cancelled=true;}});
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{throw new Error('unexpected');}});
 const result=await handler(makeRequest('https://board.example/login',{method:'POST',headers:{origin:'https://board.example'},body:stream,duplex:'half'}));
 assert.equal(result.status,408); assert.equal(cancelled,true);
});

test('login deadline is total elapsed time even as chunks arrive', async () => {
 let calls=0, cancelled=false;
 const stream=new ReadableStream({async pull(c){await new Promise(resolve=>setTimeout(resolve,300)); if (!cancelled) c.enqueue(new Uint8Array([32]));},cancel(){cancelled=true;}});
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{calls++;}});
 const result=await Promise.race([handler(makeRequest('https://board.example/login',{method:'POST',headers:{origin:'https://board.example'},body:stream,duplex:'half'})),new Promise(resolve=>setTimeout(()=>resolve('stalled'),1600))]);
 assert.notEqual(result,'stalled'); assert.equal(result.status,408); assert.equal(cancelled,true); assert.equal(calls,0);
});

test('a delayed valid login body within the deadline is accepted', async () => {
 const stream=new ReadableStream({async start(c){await new Promise(resolve=>setTimeout(resolve,50));c.enqueue(new TextEncoder().encode('{"email":"a","password":"b"}'));c.close();}});
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>new Response('{}',{status:201,headers:{'set-cookie':'a_session_project=valid; Path=/'}})});
 const result=await handler(makeRequest('https://board.example/login',{method:'POST',headers:{origin:'https://board.example'},body:stream,duplex:'half'}));
 assert.equal(result.status,201);
});

test('oversized upstream account data is cancelled without waiting and never disclosed', async () => {
 let cancelled=false;
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('private'.repeat(10000)));},cancel(){cancelled=true;return new Promise(()=>{});}});
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>new Response(stream)});
 const result=await Promise.race([handler(makeRequest('https://board.example/account',{headers:{cookie:'__Host-weftline=valid'}})),new Promise(resolve=>setTimeout(()=>resolve('stalled'),500))]);
 assert.notEqual(result,'stalled'); assert.equal(result.status,502); assert.equal(cancelled,true); assert.doesNotMatch(await result.text(),/private/);
});

test('oversized login is cancelled without waiting before any upstream call', async () => {
 let cancelled=false, calls=0;
 const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(8193));},cancel(){cancelled=true;return new Promise(()=>{});}});
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{calls++;}});
 const result=await Promise.race([handler(makeRequest('https://board.example/login',{method:'POST',headers:{origin:'https://board.example'},body:stream,duplex:'half'})),new Promise(resolve=>setTimeout(()=>resolve('stalled'),500))]);
 assert.notEqual(result,'stalled'); assert.equal(result.status,413); assert.equal(cancelled,true); assert.equal(calls,0);
});

test('rejects missing actual Host even when the request URL is reconstructed', async () => {
 let calls=0;
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{calls++;return new Response('{}');}});
 const result=await handler(new Request('https://board.example/account',{headers:{cookie:'__Host-weftline=valid','x-forwarded-host':'board.example'}}));
 assert.equal(result.status,403); assert.equal(calls,0);
});

test('login body abort is prompt, cancels and removes its abort listener', async t => {
 const timers=[], original=setTimeout;
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{const timer=original(fn,ms,...args);if(ms===1000) timers.push(timer);return timer;});
 let cancelled=false, calls=0, started;
 const reading=new Promise(resolve=>{started=resolve;});
 const stream=new ReadableStream({pull(){started();},cancel(){cancelled=true;return Promise.reject(Error('cancel failed'));}});
 const controller=new AbortController();
 const request=makeRequest('https://board.example/login',{method:'POST',headers:{origin:'https://board.example'},body:stream,duplex:'half',signal:controller.signal});
 const baseline=getEventListeners(request.signal,'abort').length;
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{calls++;}});
 const pending=handler(request); await reading; await new Promise(resolve=>setImmediate(resolve)); controller.abort();
 let timer;
 try {
  const result=await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(()=>resolve('stalled'),300);})]);
  assert.notEqual(result,'stalled'); assert.equal(result.status,400); assert.equal(result.headers.get('cache-control'),'no-store');
  assert.equal(cancelled,true); assert.equal(calls,0); assert.equal(getEventListeners(request.signal,'abort').length,baseline);
  assert.equal(timers.length,1); assert.equal(timers[0]._destroyed,true);
 } finally {clearTimeout(timer);}
});

test('already-aborted login cancels without starting a read or upstream call', async () => {
 let cancelled=false, calls=0, pulls=0;
 const stream=new ReadableStream({pull(){pulls++;},cancel(){cancelled=true;return Promise.reject(Error('cancel failed'));}},{highWaterMark:0});
 const controller=new AbortController(); controller.abort();
 const request=makeRequest('https://board.example/login',{method:'POST',headers:{origin:'https://board.example'},body:stream,duplex:'half',signal:controller.signal});
 const baseline=getEventListeners(request.signal,'abort').length;
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{calls++;}});
 const result=await handler(request);
 assert.equal(result.status,400); assert.equal(cancelled,true); assert.equal(pulls,0); assert.equal(calls,0);
 assert.equal(getEventListeners(request.signal,'abort').length,baseline);
});

test('successful and oversized login reads remove abort listeners and clear their deadline timers', async t => {
 const timers=[];
 const original=setTimeout;
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{const timer=original(fn,ms,...args); if(ms===1000) timers.push(timer); return timer;});
 for (const [body,status] of [[JSON.stringify({email:'a',password:'b'}),201],['x'.repeat(8193),413]]) {
  const request=makeRequest('https://board.example/login',{method:'POST',headers:{origin:'https://board.example'},body});
  const baseline=getEventListeners(request.signal,'abort').length;
  const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>new Response(null,{status:201,headers:{'set-cookie':'a_session_project=valid'}})});
  assert.equal((await handler(request)).status,status);
  assert.equal(getEventListeners(request.signal,'abort').length,baseline);
 }
 assert.equal(timers.length,2); assert.ok(timers.every(timer=>timer._destroyed));
});

test('abort after upstream headers but before the account read cancels without reading', async () => {
 let cancelled=false, pulls=0;
 const controller=new AbortController();
 const body=new ReadableStream({pull(){pulls++;},cancel(){cancelled=true;}},{highWaterMark:0});
 const response=new Response(body);
 Object.defineProperty(response,'status',{get(){controller.abort();return 200;}});
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>response});
 const result=await handler(makeRequest('https://board.example/account',{headers:{cookie:'__Host-weftline=valid'},signal:controller.signal}));
 assert.equal(result.status,502); assert.equal(cancelled,true); assert.equal(pulls,0);
});

test('client abort promptly cancels an abort-ignoring upstream account body', async () => {
 let cancelled=false, started;
 const reading=new Promise(resolve=>{started=resolve;});
 const stream=new ReadableStream({pull(){started();},cancel(){cancelled=true;return Promise.reject(Error('cancel failed'));}});
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>new Response(stream)});
 const controller=new AbortController();
 const pending=handler(makeRequest('https://board.example/account',{headers:{cookie:'__Host-weftline=valid'},signal:controller.signal}));
 await reading; await new Promise(resolve=>setImmediate(resolve)); controller.abort();
 let timer;
 try {
  const result=await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(()=>resolve('stalled'),300);})]);
  assert.notEqual(result,'stalled'); assert.equal(result.status,502); assert.equal(result.headers.get('cache-control'),'no-store'); assert.equal(cancelled,true);
 } finally {clearTimeout(timer);}
});

test('stalled upstream account body fails closed without leaking partial data', async () => {
 let cancelled=false;
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('private-account'));},cancel(){cancelled=true; return new Promise(()=>{});}});
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>new Response(stream)});
 const result=await Promise.race([handler(makeRequest('https://board.example/account',{headers:{cookie:'__Host-weftline=valid'}})),new Promise(resolve=>setTimeout(()=>resolve('stalled'),1600))]);
 assert.notEqual(result,'stalled'); assert.equal(result.status,502); assert.equal(cancelled,true); assert.doesNotMatch(await result.text(),/private-account/);
});

test('stalled login body times out even when cancellation never completes', async () => {
 let called=0, cancelled=false;
 const stream=new ReadableStream({cancel(){cancelled=true; return new Promise(()=>{});}});
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{called++;}});
 const result=await Promise.race([handler(makeRequest('https://board.example/login',{method:'POST',headers:{origin:'https://board.example'},body:stream,duplex:'half'})),new Promise(resolve=>setTimeout(()=>resolve('stalled'),1600))]);
 assert.notEqual(result,'stalled'); assert.equal(result.status,408); assert.equal(cancelled,true); assert.equal(called,0);
});

test('rejects a foreign origin before making an upstream request', async () => {
  let called = false;
  const handler = createClientAuth({ origin:'https://board.example', endpoint:'https://baas.euregiohosting.nl/v1', project:'project', transport:async () => { called = true; } });
  const response = await handler(makeRequest('https://board.example/login', { method:'POST', headers:{ origin:'https://evil.example' }, body:JSON.stringify({email:'test@example.invalid',password:'password'}) }));
  assert.equal(response.status, 403);
  assert.equal(called, false);
});


test('client login maps an Appwrite cookie to a host-only cookie and uses it for account and revocation', async () => {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({url, options});
    if (url.endsWith('/account/sessions/email')) return new Response('{}', {status:201, headers:[['Set-Cookie','a_session_project_legacy=abc123; Path=/; Secure; HttpOnly'], ['Set-Cookie','a_session_project=abc123; Path=/; Secure; HttpOnly; SameSite=None']]});
    if (url.endsWith('/account')) return new Response('{"$id":"user"}', {status:200});
    return new Response(null, {status:204});
  };
  const handler = createClientAuth({ origin:'https://board.example', endpoint:'https://baas.euregiohosting.nl/v1', project:'project', transport });
  const login = await handler(makeRequest('https://board.example/login', {method:'POST',headers:{origin:'https://board.example','content-type':'application/json','x-appwrite-key':'attacker','x-forwarded-for':'1.2.3.4'},body:JSON.stringify({email:'test@example.invalid',password:'password'})}));
  assert.equal(login.status, 201);
  assert.match(login.headers.get('set-cookie'), /^__Host-weftline=abc123; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
  const headers = {origin:'https://board.example',cookie:'__Host-weftline=abc123; unrelated=private'};
  const account = await handler(makeRequest('https://board.example/account', {headers}));
  assert.equal(account.status, 200);
  const logout = await handler(makeRequest('https://board.example/logout', {method:'POST',headers}));
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(calls.length,3);
  assert.equal(calls[1].options.headers.cookie,'a_session_project=abc123');
  assert.equal(calls[2].options.headers.cookie,'a_session_project=abc123');
  assert.equal(calls[2].url,'https://baas.euregiohosting.nl/v1/account/sessions/current');
  assert.equal(calls[2].options.method,'DELETE');
  assert.equal(calls[0].options.headers['x-appwrite-key'],undefined);
  assert.equal(calls[0].options.headers['x-forwarded-for'],undefined);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
});


test('pins the exact approved Appwrite endpoint before any transport call', async () => {
 let calls=0;
 const transport=async()=>{calls++;return new Response('{}');};
 for (const endpoint of ['https://evil.example/v1','https://baas.euregiohosting.nl.evil.example/v1','https://baas.euregiohosting.nl@evil.example/v1','https://baas.euregiohosting.nl/v1/','https://baas.euregiohosting.nl/v1/../v1','https://baas.euregiohosting.nl:443/v1','https://baas.euregiohosting.nl/v1?x=1','http://baas.euregiohosting.nl/v1']) {
  assert.throws(()=>createClientAuth({origin:'https://board.example',endpoint,project:'project',transport}), /Invalid endpoint/);
 }
 assert.equal(calls,0);
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport});
 const response=await handler(makeRequest('https://board.example/account',{headers:{cookie:'__Host-weftline=valid'}}));
 assert.equal(response.status,200); assert.equal(calls,1);
});

test('rejects unsafe server configuration and request destinations', async () => {
  for (const endpoint of ['http://appwrite.example/v1','https://user@appwrite.example/v1','https://appwrite.example/v1?next=evil','https://appwrite.example/v1#x']) {
    assert.throws(() => createClientAuth({origin:'https://board.example',endpoint,project:'project'}));
  }
  for (const origin of ['http://board.example','https://board.example/path','https://user@board.example']) {
    assert.throws(() => createClientAuth({origin,endpoint:'https://baas.euregiohosting.nl/v1',project:'project'}));
  }
  assert.throws(() => createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'a;foo'}));
  let called = false;
  const handler = createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async () => {called=true;}});
  const result = await handler(makeRequest('https://evil.example/login',{method:'POST',headers:{origin:'https://board.example'},body:JSON.stringify({email:'test@example.invalid',password:'password'})}));
  assert.equal(result.status,403);
  assert.equal(called,false);
});


test('preserves upstream rate-limit status and safe retry metadata without leaking its body', async () => {
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>new Response('secret upstream details',{status:429,headers:{'retry-after':'60','x-ratelimit-limit':'10','x-ratelimit-remaining':'0','x-ratelimit-reset':'12345'}})});
 const r=await handler(makeRequest('https://board.example/login',{method:'POST',headers:{origin:'https://board.example'},body:JSON.stringify({email:'test@example.invalid',password:'password'})}));
 assert.equal(r.status,429); assert.equal(r.headers.get('retry-after'),'60'); assert.equal(r.headers.get('x-ratelimit-limit'),'10'); assert.equal(r.headers.get('x-ratelimit-remaining'),'0'); assert.equal(r.headers.get('x-ratelimit-reset'),'12345'); assert.doesNotMatch(await r.text(),/secret/); assert.equal(r.headers.get('cache-control'),'no-store');
});


test('rejects ambiguous and malformed browser session cookies without upstream access', async () => {
 let calls=0; const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{calls++;return new Response('{}')}});
 for (const cookie of ['__Host-weftline=one; __Host-weftline=two','__Host-weftline=bad value','__Host-weftline=','__Host-weftline="quoted"']) {
  const r=await handler(makeRequest('https://board.example/account',{headers:{origin:'https://board.example',cookie}})); assert.equal(r.status,401);
 }
 assert.equal(calls,0);
});


test('fails closed for redirects, transport errors and malformed upstream session cookies', async () => {
 for (const transport of [async()=>Response.redirect('https://evil.example',302), async()=>{throw Error('secret');}, async()=>new Response('{}',{status:201,headers:[['set-cookie','a_session_project=good; Path=/'],['set-cookie','a_session_project=other; Path=/']]})]) {
  const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport});
  const r=await handler(makeRequest('https://board.example/login',{method:'POST',headers:{origin:'https://board.example'},body:JSON.stringify({email:'test@example.invalid',password:'password'})}));
  assert.equal(r.status,502); assert.equal(r.headers.get('location'),null); assert.equal(r.headers.get('set-cookie'),null); assert.doesNotMatch(await r.text(),/secret/);
 }
});


test('rejects invalid or oversized login bodies before contacting Appwrite', async () => {
 let calls=0; const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{calls++;}});
 for(const body of ['{','null',JSON.stringify({email:3,password:'x'}),JSON.stringify({email:'x',password:'p'.repeat(9000)})]) {
  const r=await handler(makeRequest('https://board.example/login',{method:'POST',headers:{origin:'https://board.example'},body})); assert.ok(r.status===400||r.status===413);
 }
 assert.equal(calls,0);
});


test('all authentication responses forbid caching and a failed logout retains the cookie', async () => {
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>new Response('upstream secret',{status:503})});
 for(const request of [makeRequest('https://board.example/login',{method:'POST',headers:{origin:'https://board.example'},body:JSON.stringify({email:'x',password:'y'})}),makeRequest('https://board.example/logout',{method:'POST',headers:{origin:'https://board.example',cookie:'__Host-weftline=valid'}}),makeRequest('https://board.example/account',{headers:{origin:'https://evil.example'}})]) {
  const r=await handler(request); assert.equal(r.headers.get('cache-control'),'no-store'); assert.equal(r.headers.get('set-cookie'),null);
 }
});


test('POST login and logout reject missing, null and foreign Origin without upstream access', async () => {
 let calls=0;
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{calls++;}});
 for (const path of ['/login','/logout']) for (const origin of [undefined,'null','https://evil.example']) {
  const headers={cookie:'__Host-weftline=valid'}; if (origin !== undefined) headers.origin=origin;
  const r=await handler(makeRequest('https://board.example'+path,{method:'POST',headers,body:JSON.stringify({email:'a',password:'b'})}));
  assert.equal(r.status,403); assert.equal(r.headers.get('cache-control'),'no-store');
 }
 assert.equal(calls,0);
});

test('cross-site or same-site browser account reads cannot access session data', async () => {
 let calls=0;
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{calls++;return new Response('private account');}});
 for (const site of ['cross-site','same-site']) {
  const r=await handler(makeRequest('https://board.example/account',{headers:{cookie:'__Host-weftline=valid','sec-fetch-site':site}}));
  assert.equal(r.status,403); assert.equal(r.headers.get('cache-control'),'no-store'); assert.doesNotMatch(await r.text(),/private account/);
 }
 assert.equal(calls,0);
});

test('upstream account body read failures return a cache-safe error', async () => {
 const stream=new ReadableStream({start(controller){controller.error(new Error('private detail'));}});
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>new Response(stream,{status:200})});
 const r=await handler(makeRequest('https://board.example/account',{headers:{cookie:'__Host-weftline=valid'}}));
 assert.equal(r.status,502); assert.equal(r.headers.get('cache-control'),'no-store'); assert.doesNotMatch(await r.text(),/private detail/);
});

test('preserved incoming Host permits browser-style authenticated GET without Origin', async () => {
 let upstreamCalls=0;
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>{upstreamCalls++;return new Response('{}');}});
 const r=await handler(new Request('https://board.example/account',{headers:{host:'board.example',cookie:'__Host-weftline=valid'}}));
 assert.equal(r.status,200); assert.equal(r.headers.get('cache-control'),'no-store'); assert.equal(upstreamCalls,1);
});


test('header deadline rejects an abort-ignoring transport and disposes its late response', async () => {
 let resolveTransport, cancelled=false, signal;
 const transport=(_url, options)=>{signal=options.signal; return new Promise(resolve=>{resolveTransport=resolve;});};
 const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport});
 const pending=handler(makeRequest('https://board.example/account',{headers:{cookie:'__Host-weftline=valid'}}));
 let timer;
 try {
  const result=await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(()=>resolve('stalled'),10500);})]);
  assert.notEqual(result,'stalled'); assert.equal(result.status,502); assert.equal(signal.aborted,true);
 } finally {
  clearTimeout(timer);
  resolveTransport(new Response(new ReadableStream({cancel(){cancelled=true; return new Promise(()=>{});}})));
  await new Promise(resolve=>setImmediate(resolve));
 }
 assert.equal(cancelled,true);
});


test('body-forbidden successful account responses are forwarded without a body', async () => {
 for (const status of [204,205]) {
  const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>new Response(null,{status})});
  const result=await handler(makeRequest('https://board.example/account',{headers:{cookie:'__Host-weftline=valid'}}));
  assert.equal(result.status,status); assert.equal(result.body,null); assert.equal(result.headers.get('cache-control'),'no-store');
 }
});


test('RFC850 Retry-After resolves two-digit years using the rolling 50-year rule', async t => {
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-01-01T00:00:00Z')});
 for (const [value,expected] of [
  ['Wednesday, 01-Jan-70 00:00:00 GMT','Wednesday, 01-Jan-70 00:00:00 GMT'],
  ['Thursday, 01-Jan-70 00:00:00 GMT',null],
  ['Wednesday, 01-Jan-76 00:00:00 GMT','Wednesday, 01-Jan-76 00:00:00 GMT'],
  ['Saturday, 01-Jan-77 00:00:00 GMT','Saturday, 01-Jan-77 00:00:00 GMT']
 ]) {
  const handler=createClientAuth({origin:'https://board.example',endpoint:'https://baas.euregiohosting.nl/v1',project:'project',transport:async()=>new Response(null,{status:429,headers:{'retry-after':value}})});
  const result=await handler(makeRequest('https://board.example/account',{headers:{cookie:'__Host-weftline=valid'}}));
  assert.equal(result.headers.get('retry-after'),expected,value);
 }
});
