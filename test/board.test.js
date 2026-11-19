import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoardHandler } from '../src/board.js';

test('unauthenticated board requests are denied without contacting Appwrite', async () => {
  let calls = 0;
  const handle = createBoardHandler({ origin: 'https://board.example', appwrite: async () => { calls++; } });
  const response = await handle(new Request('https://board.example/board'));
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});


test('foreign origin login is rejected before contacting Appwrite', async () => {
  let calls = 0;
  const handle = createBoardHandler({ origin: 'https://board.example', appwrite: async () => { calls++; } });
  const r = await handle(new Request('https://board.example/board/login', {method:'POST', headers:{origin:'https://evil.example','content-type':'application/x-www-form-urlencoded'}, body:'email=a&password=b'}));
  assert.equal(r.status, 403);
  assert.equal(calls, 0);
});


test('authenticated board renders escaped persisted task titles', async () => {
  const calls=[];
  const handle=createBoardHandler({origin:'https://board.example',appwrite:async(path,options)=>{ calls.push([path,options]); return {ok:true,data:{rows:[{title:'<script>evil</script>',status:'ready'}]}}; }});
  const r=await handle(new Request('https://board.example/board',{headers:{cookie:'__Host-weftline=opaque-session'}}));
  assert.equal(r.status,200); const html=await r.text();
  assert.match(html,/&lt;script&gt;evil&lt;\/script&gt;/); assert.doesNotMatch(html,/<script>evil/);
  assert.equal(calls[0][1].session,'opaque-session'); assert.ok(!calls[0][1].admin);
});


test('authenticated human creates a ready task under their session', async () => {
  const calls=[];
  const handle=createBoardHandler({origin:'https://board.example',appwrite:async(path,options)=>{calls.push([path,options]);return {ok:true,data:{}};}});
  const r=await handle(new Request('https://board.example/board/tasks',{method:'POST',headers:{origin:'https://board.example',cookie:'__Host-weftline=opaque-session','content-type':'application/x-www-form-urlencoded'},body:'title=First+task'}));
  assert.equal(r.status,303); assert.equal(calls[0][1].session,'opaque-session');
  assert.deepEqual(calls[0][1].body,{rowId:'unique()',data:{title:'First task',status:'ready'}});
});


test('login page and task form are reachable without exposing credentials', async () => {
  const handle=createBoardHandler({origin:'https://board.example',appwrite:async()=>({ok:true,data:{rows:[]}})});
  const login=await handle(new Request('https://board.example/board/login'));
  assert.equal(login.status,200); assert.match(await login.text(), /unavailable/i);
  const board=await handle(new Request('https://board.example/board',{headers:{cookie:'__Host-weftline=opaque-session'}}));
  assert.match(await board.text(),/action="\/board\/tasks"/);
});

test('login fails closed without contacting privileged authentication when abuse protection is unverified', async () => {
  let calls = 0;
  const handle = createBoardHandler({origin:'https://board.example', appwrite:async()=>{calls++; return {ok:true,data:{secret:'opaque-session',expire:'2035-01-01'}};}});
  const r = await handle(new Request('https://board.example/board/login',{method:'POST',headers:{origin:'https://board.example','content-type':'application/x-www-form-urlencoded'},body:'email=a&password=b'}));
  assert.equal(r.status,503); assert.equal(calls,0); assert.equal(r.headers.get('set-cookie'),null);
});

test('logout revokes the upstream current session before expiring the browser cookie', async () => {
 const handle=createBoardHandler({origin:'https://board.example',appwrite:async(path,options)=>{assert.equal(path,'/account/sessions/current');assert.equal(options.method,'DELETE');assert.equal(options.session,'opaque-session');return {ok:true,data:{}};}});
 const r=await handle(new Request('https://board.example/board/logout',{method:'POST',headers:{origin:'https://board.example',cookie:'__Host-weftline=opaque-session'}}));
 assert.equal(r.status,303);assert.match(r.headers.get('set-cookie'),/__Host-weftline=;.*Max-Age=0;.*Secure;.*HttpOnly;.*SameSite=Strict/);
});

test('task list explicitly warns that only the first page is shown', async () => {
 const handle=createBoardHandler({origin:'https://board.example',appwrite:async()=>({ok:true,data:{rows:[],total:30}})});
 const r=await handle(new Request('https://board.example/board',{headers:{cookie:'__Host-weftline=opaque-session'}}));
 assert.match(await r.text(),/first page.*additional tasks/i);
});

test('empty successful Appwrite responses support session revocation', async () => {
 const { parseAppwriteResponse } = await import('../src/appwrite.js');
 assert.deepEqual(await parseAppwriteResponse(new Response(null,{status:204})),{ok:true,data:null});
});

test('logout failure does not claim revocation or clear the session cookie', async () => {
 for (const appwrite of [async()=>({ok:false,data:{}}),async()=>{throw new Error('offline');}]) {
  const handle=createBoardHandler({origin:'https://board.example',appwrite});
  const r=await handle(new Request('https://board.example/board/logout',{method:'POST',headers:{origin:'https://board.example',cookie:'__Host-weftline=opaque-session'}}));
  assert.equal(r.status,503); assert.equal(r.headers.get('set-cookie'),null);
 }
});

test('cross-origin logout is forbidden before upstream access', async () => {
 let calls=0;const handle=createBoardHandler({origin:'https://board.example',appwrite:async()=>{calls++;}});
 const r=await handle(new Request('https://board.example/board/logout',{method:'POST',headers:{origin:'https://evil.example',cookie:'__Host-weftline=opaque-session'}}));
 assert.equal(r.status,403);assert.equal(calls,0);
});

test('login page explains sign-in is unavailable', async () => {
 const handle=createBoardHandler({origin:'https://board.example',appwrite:async()=>{throw new Error('unexpected');}});
 const r=await handle(new Request('https://board.example/board/login'));
 assert.match(await r.text(),/sign.in.*unavailable/i);
});

test('board groups persisted tasks into ordered workflow columns, including empty columns', async () => {
 const rows=[{title:'Review task',status:'review'},{title:'Ready task',status:'ready'},{title:'Blocked task',status:'blocked'},{title:'Another ready task',status:'ready'},{title:'Done task',status:'done'}];
 const handle=createBoardHandler({origin:'https://board.example',appwrite:async()=>({ok:true,data:{rows}})});
 const r=await handle(new Request('https://board.example/board',{headers:{cookie:'__Host-weftline=opaque-session'}}));
 const html=await r.text();
 const sections=[...html.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)].map(match=>match[1]);
 assert.equal(sections.length,5);
 for (const [i,heading] of ['Ready','In progress','Review','Blocked','Done'].entries()) assert.match(sections[i],new RegExp(`<h2[^>]*>${heading}</h2>`,'i'));
 assert.match(sections[0],/Ready task/); assert.match(sections[0],/Another ready task/);
 assert.match(sections[1],/No tasks/i);
 for (const [i,title] of [[2,'Review task'],[3,'Blocked task'],[4,'Done task']]) assert.match(sections[i],new RegExp(title));
 for (const [i,section] of sections.entries()) for (const row of rows) assert.equal(section.includes(row.title), ['ready','in_progress','review','blocked','done'][i]===row.status);
});

test('board visibly preserves tasks with unexpected statuses and escapes their content', async () => {
 const rows=[{title:'<img src=x onerror="evil()"> & \'title\'',status:'<script>bad & "status"</script>'},{title:'Missing status'},{title:'Prototype status',status:'__proto__'}];
 const handle=createBoardHandler({origin:'https://board.example',appwrite:async()=>({ok:true,data:{rows}})});
 const r=await handle(new Request('https://board.example/board',{headers:{cookie:'__Host-weftline=opaque-session'}}));
 const html=await r.text();
 const section=[...html.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)].map(match=>match[1]).find(value=>/<h2[^>]*>Unexpected status<\/h2>/i.test(value));
 assert.ok(section,'unexpected-status column is visible');
 assert.match(section,/&lt;img src=x onerror=&quot;evil\(\)&quot;&gt; &amp; &#39;title&#39;/);
 assert.match(section,/&lt;script&gt;bad &amp; &quot;status&quot;&lt;\/script&gt;/);
 assert.match(section,/Missing status/); assert.match(section,/Prototype status/); assert.match(section,/__proto__/);
 assert.doesNotMatch(html,/<img src=x|<script>bad/);
});
