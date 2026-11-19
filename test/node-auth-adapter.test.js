import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createNodeAuthAdapter } from '../src/node-auth-adapter.js';

const origin = 'https://board.example';
const config = { origin, endpoint:'https://appwrite.example.test/v1', project:'project', approvedEndpoint:'https://appwrite.example.test/v1', approvedProject:'project' };
async function fixture(t, transport) {
  const server = http.createServer(createNodeAuthAdapter({...config, transport}));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return server.address().port;
}
function request(port, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1',port,...options}, res => {
      const chunks=[]; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks).toString()}));
      res.on('error', reject);
    }); req.on('error',reject); req.end(body);
  });
}
test('real HTTP login reaches fake provider and delivers session cookie', async t => {
  const seen=[];
  const port=await fixture(t, async (url,options) => { seen.push([url,options]); return new Response(null,{status:201,headers:{'set-cookie':'a_session_project=abc; Path=/'}}); });
  const result=await request(port,{method:'POST',path:'/login',headers:{host:'board.example',origin,'content-type':'application/json'}},JSON.stringify({email:'a',password:'b'}));
  assert.equal(result.status,201); assert.match(result.headers['set-cookie'][0],/^__Host-weftline=abc;/); assert.equal(seen.length,1); assert.equal(seen[0][0],'https://appwrite.example.test/v1/account/sessions/email');
});

test('rejected stalled upload receives 403 and its socket closes', async t => {
  const port=await fixture(t, async () => { throw Error('unexpected provider'); });
  const socket=net.connect(port,'127.0.0.1'); socket.setTimeout(2000,()=>socket.destroy(new Error('socket deadline')));
  const chunks=[]; socket.on('data',c=>chunks.push(c));
  await once(socket,'connect');
  socket.write('POST /login HTTP/1.1\r\nHost: evil.example\r\nOrigin: https://board.example\r\nContent-Length: 100000\r\n\r\nx');
  await once(socket,'close');
  assert.match(Buffer.concat(chunks).toString(),/^HTTP\/1\.1 403 /);
});

test('disconnect after response headers cancels the outgoing web stream', async t => {
  let cancelled; const cancelledPromise=new Promise(r=>cancelled=r);
  const fake = () => new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('first'));}, cancel(){cancelled();}}));
  const server=http.createServer(createNodeAuthAdapter(config, fake));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const req=http.get({host:'127.0.0.1',port:server.address().port,path:'/account',headers:{host:'board.example'}},res=>res.once('data',()=>res.destroy()));
  req.on('error',()=>{});
  let timer; try { await Promise.race([cancelledPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('response stream not cancelled')),1000);})]); } finally {clearTimeout(timer);}
});

test('stalled response stream is cancelled and socket is closed by a deadline', async t => {
  let cancel; const cancelled=new Promise(r=>cancel=r);
  const server=http.createServer(createNodeAuthAdapter(config,()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('first'));},cancel(){cancel();}}))));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const socket=net.connect(server.address().port,'127.0.0.1'); socket.setTimeout(2200,()=>socket.destroy(new Error('stream deadline')));
  await once(socket,'connect'); socket.write('GET /account HTTP/1.1\r\nHost: board.example\r\n\r\n');
  socket.resume(); await once(socket,'close'); await cancelled;
});

async function raw(port, text) {
  const socket=net.connect(port,'127.0.0.1');
  socket.setTimeout(2500,()=>socket.destroy(new Error('socket deadline')));
  const chunks=[]; socket.on('data',c=>chunks.push(c));
  await once(socket,'connect'); socket.write(text); await once(socket,'close');
  return Buffer.concat(chunks).toString();
}

test('duplicate Host and mismatched Host cannot be rescued by forwarded headers', async t => {
  let calls=0; const port=await fixture(t,async()=>{calls++; return new Response('{}');});
  for (const host of ['Host: board.example\r\nHost: board.example','Host: evil.example']) {
    const reply=await raw(port,`GET /account HTTP/1.1\r\n${host}\r\nX-Forwarded-Host: board.example\r\nX-Forwarded-Proto: https\r\nCookie: __Host-weftline=valid\r\nConnection: close\r\n\r\n`);
    assert.match(reply,/^HTTP\/1\.1 403 /);
  }
  assert.equal(calls,0);
});

test('login oversized and stalled bodies receive bounded error responses and close', async t => {
  let calls=0; const port=await fixture(t,async()=>{calls++; return new Response(null,{status:201});});
  const base='POST /login HTTP/1.1\r\nHost: board.example\r\nOrigin: https://board.example\r\nContent-Length: 20000\r\n\r\n';
  const oversized=await raw(port,base+'x'.repeat(9000));
  assert.match(oversized,/^HTTP\/1\.1 413 /);
  const start=performance.now();
  const stalled=await raw(port,base+'x');
  assert.match(stalled,/^HTTP\/1\.1 408 /);
  assert.ok(performance.now()-start<2200);
  assert.equal(calls,0);
});

test('account GET response and normal keepalive reuse use actual Host', async t => {
  let calls=0; const port=await fixture(t,async()=>{calls++; return new Response('{"id":"ok"}',{headers:{'content-type':'application/json'}});});
  const agent=new http.Agent({keepAlive:true,maxSockets:1}); t.after(()=>agent.destroy());
  const options={method:'GET',path:'/account',agent,headers:{host:'board.example',cookie:'__Host-weftline=valid','x-forwarded-host':'evil.example'}};
  const first=await request(port,options); const reused=Object.values(agent.freeSockets).flat()[0];
  const second=await request(port,options); const reusedAgain=Object.values(agent.freeSockets).flat()[0];
  assert.equal(first.status,200); assert.equal(first.body,'{"id":"ok"}'); assert.equal(second.status,200); assert.ok(reused); assert.equal(reused,reusedAgain); assert.equal(calls,2);
});

test('stalled logout delivers 204 while provider completes and releases peer', async t => {
  let calls=0; const port=await fixture(t,async()=>{calls++; return new Response(null,{status:204});});
  const reply=await raw(port,'POST /logout HTTP/1.1\r\nHost: board.example\r\nOrigin: https://board.example\r\nCookie: __Host-weftline=valid\r\nContent-Length: 1000\r\n\r\nx');
  assert.match(reply,/^HTTP\/1\.1 204 /); assert.match(reply,/set-cookie: __Host-weftline=/i); assert.equal(calls,1);
});

test('continuously trickled login still meets elapsed deadline', async t => {
  const port=await fixture(t,async()=>{throw Error('unexpected provider');});
  const socket=net.connect(port,'127.0.0.1'); socket.setTimeout(2500,()=>socket.destroy(new Error('socket deadline')));
  const chunks=[]; socket.on('data',c=>chunks.push(c)); await once(socket,'connect');
  socket.write('POST /login HTTP/1.1\r\nHost: board.example\r\nOrigin: https://board.example\r\nContent-Length: 1000\r\n\r\n');
  const interval=setInterval(()=>socket.write(' '),100);
  try {await once(socket,'close');} finally {clearInterval(interval);}
  assert.match(Buffer.concat(chunks).toString(),/^HTTP\/1\.1 408 /);
});


test('client disconnect aborts the pending loopback provider request', async t => {
  let arrived, closed;
  const received = new Promise(r => arrived = r);
  const disconnected = new Promise(r => closed = r);
  const provider = http.createServer((req, res) => { arrived(); res.on('close', closed); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(async () => { provider.closeAllConnections(); await new Promise(r => provider.close(r)); });
  const port = await fixture(t, (_url, options) => fetch(`http://127.0.0.1:${provider.address().port}/account`, options));
  const client = http.get({host:'127.0.0.1', port, path:'/account', headers:{host:'board.example', cookie:'__Host-weftline=valid'}});
  client.on('error', () => {});
  await received; client.destroy();
  let timer;
  try { await Promise.race([disconnected, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('provider connection not aborted')), 500); })]); }
  finally { clearTimeout(timer); }
});


test('multiple loopback backpressure drains release losing listeners', async t => {
  const counts = []; let backpressures = 0;
  const chunk = new Uint8Array(128 * 1024);
  const adapter = createNodeAuthAdapter(config, () => new Response(new ReadableStream({
    start(c) { for (let i = 0; i < 20; i++) c.enqueue(chunk); c.close(); }
  })));
  const server = http.createServer((req, res) => {
    const write = res.write;
    res.write = function (...args) { counts.push(res.listenerCount('close')); const result = write.apply(this, args); if (!result) backpressures++; return result; };
    void adapter(req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const result = await request(server.address().port, {path:'/account', headers:{host:'board.example'}});
  assert.equal(result.body.length, 20 * chunk.length);
  assert.ok(backpressures > 2, `backpressure count: ${backpressures}`);
  assert.equal(Math.max(...counts), Math.min(...counts), `close listeners across writes: ${counts}`);
});


test('unsupported method with complete unread input delivers error and removes input listeners', async t => {
  let input, before, after, complete, ended;
  const adapter = createNodeAuthAdapter(config, () => { throw Error('unexpected handler'); });
  const server = http.createServer((req, res) => {
    input = req;
    setTimeout(() => {
      complete = req.complete; ended = req.readableEnded;
      before = ['data','end','error'].map(event => req.listenerCount(event));
      void adapter(req, res);
      after = ['data','end','error'].map(event => req.listeners(event).map(fn => fn.name));
    }, 30);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const reply = await raw(server.address().port, 'TRACE /login HTTP/1.1\r\nHost: board.example\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata');
  assert.match(reply, /^HTTP\/1\.1 502 /);
  assert.equal(complete, true); assert.equal(ended, false);
  assert.equal(after.flat().some(name => ['onData','onEnd','onError'].includes(name)), false, `adapter listeners retained: ${after}`);
});


test('handler error after locking input releases stream listeners and delivers 502', async t => {
  let after;
  const adapter = createNodeAuthAdapter(config, request => { request.body.getReader(); throw Error('handler failed'); });
  const server = http.createServer((req, res) => {
    void adapter(req, res).then(() => { after = ['data','end','error'].flatMap(event => req.listeners(event).map(fn => fn.name)); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const reply = await raw(server.address().port, 'POST /login HTTP/1.1\r\nHost: board.example\r\nContent-Length: 100\r\n\r\nx');
  assert.match(reply, /^HTTP\/1\.1 502 /);
  assert.equal(after.some(name => ['onData','onEnd','onError'].includes(name)), false, `adapter listeners retained: ${after}`);
});


test('disconnect during login input settles adapter and detaches input listeners promptly', async t => {
 let finished, received, input, calls=0;
 const completed=new Promise(resolve=>{finished=resolve;});
 const started=new Promise(resolve=>{received=resolve;});
 const adapter=createNodeAuthAdapter({...config,transport:async()=>{calls++;}});
 const server=http.createServer((req,res)=>{input=req;req.once('data',received);void adapter(req,res).then(finished);});
 server.listen(0,'127.0.0.1'); await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const client=net.connect(server.address().port,'127.0.0.1'); client.on('error',()=>{});
 await once(client,'connect');
 client.write('POST /login HTTP/1.1\r\nHost: board.example\r\nOrigin: https://board.example\r\nContent-Length: 1000\r\n\r\nx');
 await started; await new Promise(resolve=>setImmediate(resolve)); client.destroy();
 let timer;
 try {await Promise.race([completed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('adapter did not settle')),400);})]);}
 finally {clearTimeout(timer);client.destroy();}
 assert.equal(calls,0);
 assert.equal(['data','end','error'].flatMap(event=>input.listeners(event).map(fn=>fn.name)).some(name=>['onData','onEnd','onError'].includes(name)),false);
});

test('disconnect after provider headers promptly cancels abort-ignoring provider body', async t => {
 let started, cancelled, finished;
 const reading=new Promise(resolve=>{started=resolve;});
 const disposed=new Promise(resolve=>{cancelled=resolve;});
 const completed=new Promise(resolve=>{finished=resolve;});
 const adapter=createNodeAuthAdapter({...config,transport:async()=>new Response(new ReadableStream({pull(){started();},cancel(){cancelled();return Promise.reject(Error('cancel failed'));}}))});
 const server=http.createServer((req,res)=>{void adapter(req,res).then(finished);});
 server.listen(0,'127.0.0.1'); await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const client=http.get({host:'127.0.0.1',port:server.address().port,path:'/account',headers:{host:'board.example',cookie:'__Host-weftline=valid'}});
 client.on('error',()=>{}); await reading; await new Promise(resolve=>setImmediate(resolve)); client.destroy();
 let timer;
 try {await Promise.race([Promise.all([disposed,completed]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('body or adapter not cancelled')),400);})]);}
 finally {clearTimeout(timer);client.destroy();}
});

test('disconnect settles adapter even when provider ignores cancellation', async t => {
  let called, finished;
  const started = new Promise(r => called = r);
  const completed = new Promise(r => finished = r);
  const adapter = createNodeAuthAdapter({...config, transport: () => { called(); return new Promise(() => {}); }});
  const server = http.createServer((req, res) => { void adapter(req, res).then(finished); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const client = http.get({host:'127.0.0.1', port:server.address().port, path:'/account', headers:{host:'board.example',cookie:'__Host-weftline=valid'}});
  client.on('error', () => {}); await started; client.destroy();
  let timer; try { await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('adapter did not settle')), 500); })]); } finally { clearTimeout(timer); }
});
