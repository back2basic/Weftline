import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import https from 'node:https';
import {ephemeralTls} from './fixtures/local-tls.js';

// Observe this exact child's close before any cleanup signal; escalation is bounded.
function registerChildCleanup(t,child){
 const closed=new Promise(resolve=>child.once('close',resolve));
 const within=async ms=>{let timer;try{return await Promise.race([closed.then(()=>true),new Promise(r=>{timer=setTimeout(()=>r(false),ms);})]);}finally{clearTimeout(timer);}};
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');if(await within(1000))return;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');assert.ok(await within(2000),'child did not close after SIGKILL');});
}

test('membership lookups share listener knowledge admission until abort-ignoring transport settles on v2 and versioned routes',{timeout:40000},async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'review-reader-admission-')),tls=ephemeralTls();
 const endpoint='https://provider.example.test/v1',project='synthetic-project',hold=join(dir,'hold'),pending=join(dir,'pending'),settled=join(dir,'settled'),aborted=join(dir,'aborted'),controlHold=join(dir,'control-hold'),controlPending=join(dir,'control-pending');
 for(const [name,value] of [['key',tls.key],['cert',tls.cert],['api',`apikey:synthetic\nprojectID:${project}\nendpoint:${endpoint}\n`],['roles',JSON.stringify({alice:['member']})],['writes',''],['hold','hold'],['pending',''],['settled',''],['aborted','']])writeFileSync(join(dir,name),value);
 const env={PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./test/fixtures/review-v1-provider.js',WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_AUTH:'1',WEFTLINE_REVIEW_UI:'1',WEFTLINE_REVIEW_HOST:'127.0.0.1',WEFTLINE_REVIEW_PORT:'0',WEFTLINE_REVIEW_BOARD:'b',WEFTLINE_REVIEW_KNOWLEDGE_V2:'1',WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED:'1',WEFTLINE_REVIEW_KNOWLEDGE_READER_DENY_WRITES:'1',WEFTLINE_KNOWLEDGE_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_TABLE_ID:'legacy',WEFTLINE_KNOWLEDGE_VERSIONED_DATABASE_ID:'versions',WEFTLINE_KNOWLEDGE_VERSIONED_TABLE_ID:'versioned',WEFTLINE_KNOWLEDGE_TEAM_ID:'team',WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES:'1024',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_TLS_KEY_FILE:join(dir,'key'),WEFTLINE_TLS_CERT_FILE:join(dir,'cert'),APPWRITE_KEY_FILE:join(dir,'api'),REVIEW_TEST_MEMBERSHIP_ROLES_FILE:join(dir,'roles'),REVIEW_TEST_WRITES_FILE:join(dir,'writes'),REVIEW_TEST_HOLD_MEMBERSHIPS_FILE:hold,REVIEW_TEST_PENDING_MEMBERSHIPS_FILE:pending,REVIEW_TEST_SETTLED_MEMBERSHIPS_FILE:settled,REVIEW_TEST_ABORTED_MEMBERSHIPS_FILE:aborted,REVIEW_TEST_CONTROL_HOLD_FILE:controlHold,REVIEW_TEST_CONTROL_PENDING_FILE:controlPending};
 const child=spawn(process.execPath,['experimental/review-v1-cli.js'],{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);registerChildCleanup(t,child);t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(err)),5000);child.once('exit',()=>{clearTimeout(timer);reject(Error(err));});child.stdout.on('data',()=>{const m=out.match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolve(+m[1]);}});});
 const post=(path,body,signal)=>new Promise((resolve,reject)=>{const req=https.request({signal,host:'127.0.0.1',port,path,method:'POST',ca:tls.cert,servername:'localhost',headers:{host:`127.0.0.1:${port}`,origin:`https://127.0.0.1:${port}`,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:'__Host-weftline=alice'}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',error=>signal?.aborted?resolve({aborted:true}):reject(error));req.end(JSON.stringify(body));});
 const waitFor=async predicate=>{for(let i=0;i<500;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error(`timed out waiting; output=${out} ${err}`);};
 const cases=[['/knowledge/v2/create',{boardId:'b',expectedActor:'alice',id:'v2-doc',title:'Title',html:'<p>body</p>'}],['/knowledge/versioned/create',{expectedActor:'alice',documentId:'versioned-doc',operationId:'a'.repeat(32),title:'Title',html:'<p>body</p>'}]];
 for(const [path,body] of cases){
  writeFileSync(pending,'');writeFileSync(settled,'');writeFileSync(aborted,'');writeFileSync(hold,'hold');
  const beforeAbortedWrites=readFileSync(join(dir,'writes'),'utf8');
  const controllers=Array.from({length:4},()=>new AbortController());
  const first=controllers.map(controller=>post(path,body,controller.signal));
  t.after(()=>controllers.forEach(controller=>controller.abort()));
  await waitFor(()=>readFileSync(pending,'utf8').trim().split('\n').filter(Boolean).length>=4);
  controllers.forEach(controller=>controller.abort());
  assert.deepEqual(await Promise.all(first),Array.from({length:4},()=>({aborted:true})),`${path} clients disconnected after all four membership calls were held`);
  await waitFor(()=>readFileSync(aborted,'utf8').trim().split('\n').filter(Boolean).length===4);
  writeFileSync(controlHold,'hold');writeFileSync(controlPending,'');
  const controlControllers=Array.from({length:4},()=>new AbortController());
  t.after(()=>controlControllers.forEach(c=>c.abort()));
  const controls=controlControllers.map(c=>new Promise((resolve,reject)=>{const req=https.request({signal:c.signal,host:'127.0.0.1',port,path:'/account',method:'GET',ca:tls.cert,servername:'localhost',headers:{host:`127.0.0.1:${port}`,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty',cookie:'__Host-weftline=alice'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',e=>c.signal.aborted?resolve('aborted'):reject(e));req.end();}));
  await waitFor(()=>readFileSync(controlPending,'utf8').trim().split('\n').filter(Boolean).length===4);
  assert.equal(readFileSync(settled,'utf8'),'');
  writeFileSync(controlHold,'release');
  assert.deepEqual(await Promise.all(controls),[401,401,401,401],`${path} all four ordinary request slots reached the synthetic account provider`);
  assert.equal(readFileSync(join(dir,'writes'),'utf8'),beforeAbortedWrites,`${path} aborted membership batch dispatched no private writes`);
  const response=await post(path,body,AbortSignal.timeout(2000));
  assert.equal(readFileSync(hold,'utf8'),'hold');
  assert.equal(readFileSync(settled,'utf8'),'');
  const membershipCalls=readFileSync(pending,'utf8').trim().split('\n').filter(Boolean).length;
  assert.equal(membershipCalls,4,`${path} does not dispatch a fifth membership request while the aborted fetches remain pending`);
  assert.equal(response.status,503,`${path} rejects while four underlying membership calls remain unsettled`);
  writeFileSync(hold,'release');
  await waitFor(()=>readFileSync(settled,'utf8').trim().split('\n').filter(Boolean).length>=4);
  await new Promise(r=>setTimeout(r,100));
  assert.equal(readFileSync(join(dir,'writes'),'utf8'),beforeAbortedWrites,`${path} no private writes observed during the 100ms post-release window`);
  const beforeMembership=readFileSync(pending,'utf8').trim().split('\n').filter(Boolean).length;
  const beforeWrites=readFileSync(join(dir,'writes'),'utf8').trim().split('\n').filter(Boolean).length;
  const recovered=await post(path,{...body,...(path==='/knowledge/versioned/create'?{documentId:`recovered-${body.documentId}`,operationId:'c'.repeat(32)}:{id:`recovered-${body.id}`})});
  if(path==='/knowledge/v2/create')assert.equal(recovered.status,502,'this admission fixture preserves the existing simulated lost-commit behavior');
  else assert.equal(recovered.status,200,'versioned CLI fixture confirms the authorized create');
  const membershipDelta=2;
  assert.equal(readFileSync(pending,'utf8').trim().split('\n').filter(Boolean).length,beforeMembership+membershipDelta,`${path} recovery request reached the expected role and service membership provider calls`);
  const afterWrites=readFileSync(join(dir,'writes'),'utf8').trim().split('\n').filter(Boolean).length;
  assert.ok(afterWrites>beforeWrites,`${path} authorized request reached a synthetic provider write path`);
 }
});

test('spawned TLS v2 listener keeps four accepted requests admitted while inbound bodies are incomplete, then recovers',{timeout:20000},async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'review-reader-inbound-')),tls=ephemeralTls();
 const endpoint='https://provider.example.test/v1',project='synthetic-project',writes=join(dir,'writes');
 for(const [name,value] of [['key',tls.key],['cert',tls.cert],['api',`apikey:synthetic\nprojectID:${project}\nendpoint:${endpoint}\n`],['roles',JSON.stringify({alice:['member']})],['writes','']])writeFileSync(join(dir,name),value);
 const env={PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./test/fixtures/review-v1-provider.js',WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_AUTH:'1',WEFTLINE_REVIEW_UI:'1',WEFTLINE_REVIEW_HOST:'127.0.0.1',WEFTLINE_REVIEW_PORT:'0',WEFTLINE_REVIEW_BOARD:'b',WEFTLINE_REVIEW_KNOWLEDGE_V2:'1',WEFTLINE_REVIEW_KNOWLEDGE_READER_DENY_WRITES:'1',WEFTLINE_KNOWLEDGE_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_TABLE_ID:'legacy',WEFTLINE_KNOWLEDGE_TEAM_ID:'team',WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES:'1024',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_TLS_KEY_FILE:join(dir,'key'),WEFTLINE_TLS_CERT_FILE:join(dir,'cert'),APPWRITE_KEY_FILE:join(dir,'api'),REVIEW_TEST_MEMBERSHIP_ROLES_FILE:join(dir,'roles'),REVIEW_TEST_WRITES_FILE:writes};
 const child=spawn(process.execPath,['experimental/review-v1-cli.js'],{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);registerChildCleanup(t,child);t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(err)),5000);child.once('exit',()=>{clearTimeout(timer);reject(Error(err));});child.stdout.on('data',()=>{const m=out.match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolve(+m[1]);}});});
 const body={boardId:'b',expectedActor:'alice',id:'slow-body',title:'Title',html:'<p>body</p>'},bytes=Buffer.from(JSON.stringify(body));
 const slow=()=>{let resolve;const result=new Promise(r=>resolve=r);const req=https.request({host:'127.0.0.1',port,path:'/knowledge/v2/create',method:'POST',ca:tls.cert,servername:'localhost',headers:{host:`127.0.0.1:${port}`,origin:`https://127.0.0.1:${port}`,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json','content-length':bytes.length,cookie:'__Host-weftline=alice'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',()=>resolve('connection-error'));req.write(bytes.subarray(0,4));return {req,result,finish(){req.end(bytes.subarray(4));},abort(){req.destroy();}};};
 const send=body=>new Promise((resolve,reject)=>{const req=https.request({host:'127.0.0.1',port,path:'/knowledge/v2/create',method:'POST',ca:tls.cert,servername:'localhost',headers:{host:`127.0.0.1:${port}`,origin:`https://127.0.0.1:${port}`,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:'__Host-weftline=alice'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify(body));});
 const requests=Array.from({length:4},slow);t.after(()=>requests.forEach(x=>x.abort()));
 await new Promise(r=>setTimeout(r,100));
 assert.equal(await send({...body,id:'fifth'}),503,'fifth request is rejected while the first four body reads remain pending');
 requests.forEach(x=>x.finish());
 const completed=await Promise.all(requests.map(x=>x.result));
 assert.ok(completed.every(code=>code===502),`accepted bodies passed admission and reached the synthetic writer path: ${completed.join(',')}`);
 const before=readFileSync(writes,'utf8').trim().split('\n').filter(Boolean).length;
 const recovery=await send({...body,id:'recovered'});
 assert.equal(recovery,201,'valid positive control is admitted after the four inbound bodies finish');
 assert.ok(readFileSync(writes,'utf8').trim().split('\n').filter(Boolean).length>before,'recovery request reached the synthetic provider write path');
});
