import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import http from 'node:http';
import {startVersionedProvider} from './fixtures/knowledge-versioned-scoped-provider.js';

const origin='https://app.example.test',endpoint='https://provider.example.test/v1',project='synthetic-project';
async function stopChild(child){
 if(child.exitCode!==null||child.signalCode!==null)return;
 const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');
 let timer;try{await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('listener cleanup timed out')),3000);})]);}finally{clearTimeout(timer);}
}
function waitFixtureEvent(child,event='late-account-delivered',timeout=3000){
 return new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit);};
  const onMessage=m=>{if(m?.event===event){cleanup();resolve(m);}};
  const onExit=()=>{cleanup();reject(Error('listener exited before fixture event'));};
  const timer=setTimeout(()=>{cleanup();reject(Error(`fixture event not observed: ${event}`));},timeout);
  child.on('message',onMessage);child.once('exit',onExit);
 });
}
test('opt-in proxy listener gates and serves synthetic versioned workflow', {timeout:35000}, async t=>{
 const provider=await startVersionedProvider();t.after(()=>provider.close());
 const dir=mkdtempSync(join(process.env.TMPDIR,'proxy-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const api=join(dir,'api');writeFileSync(api,`apikey:synthetic-key\nprojectID:${project}\nendpoint:${endpoint}\n`);
 const preload=join(dir,'preload.mjs');writeFileSync(preload,`await import(${JSON.stringify(new URL('./fixtures/knowledge-versioned-scoped-cli-proxy.js',import.meta.url).href)});const fetch0=globalThis.fetch;globalThis.fetch=(u,o)=>String(u).endsWith('/account/sessions/email')?Promise.resolve(new Response('{}',{status:201,headers:{'set-cookie':'a_session_synthetic-project=creatorSentinel83; Path=/; Secure; HttpOnly'}})):fetch0(u,o);`);
 const secret=randomBytes(32).toString('hex');
 const env={PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:`--import ${preload}`,VERSIONED_FIXTURE_PORT:String(provider.port),WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_AUTH:'1',WEFTLINE_REVIEW_UI:'1',WEFTLINE_REVIEW_PROXY:'1',WEFTLINE_PROXY_SECRET:secret,WEFTLINE_PUBLIC_ORIGIN:origin,WEFTLINE_REVIEW_HOST:'127.0.0.1',PORT:'0',WEFTLINE_REVIEW_BOARD:'board',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED:'1',WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_READ:'1',WEFTLINE_REVIEW_KNOWLEDGE_READER_DENY_WRITES:'1',WEFTLINE_KNOWLEDGE_VERSIONED_UI:'1',WEFTLINE_KNOWLEDGE_VERSIONED_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_VERSIONED_TABLE_ID:'versions',WEFTLINE_KNOWLEDGE_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_TABLE_ID:'legacy',WEFTLINE_KNOWLEDGE_TEAM_ID:'team',WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES:'1024',APPWRITE_KEY_FILE:api};
 for(const change of [{WEFTLINE_PROXY_SECRET:''},{WEFTLINE_PUBLIC_ORIGIN:'http://app.example.test'},{WEFTLINE_REVIEW_KNOWLEDGE_V2:'1'},{WEFTLINE_REVIEW_PROXY:'0'},{WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_READ:'0'},{WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED:undefined}]){const r=spawnSync(process.execPath,['experimental/review-v1-cli.js'],{env:{...env,...change,APPWRITE_KEY_FILE:'/missing/must-not-read'},timeout:3000});assert.notEqual(r.status,0);assert.match(r.stderr.toString(),/Disabled or invalid configuration/);}
 const child=spawn(process.execPath,['src/server.js'],{env,stdio:['ignore','pipe','pipe','ipc']});let output='';const starts=[];child.on('message',m=>{if(m?.event==='downstream-fetch-start')starts.push(m.kind);});child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);t.after(()=>stopChild(child));
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(output)),5000);child.once('exit',()=>{clearTimeout(timer);reject(Error(`listener exit: ${output}`));});child.stdout.on('data',()=>{const m=output.match(/listener .*:(\d+)/);if(m){clearTimeout(timer);resolve(+m[1]);}});});
 const send=(path,{body,headers={},method=body?'POST':'GET'}={})=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path,method,headers:{host:'app.example.test','x-weftline-proxy-secret':secret,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty',...(body?{'content-type':'application/json'}:{}),...headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 const raw=(extra,credential=true)=>new Promise((resolve,reject)=>{let out='';const s=net.connect(port,'127.0.0.1',()=>s.end(`GET /health HTTP/1.1\r\nHost: app.example.test\r\n${credential?`X-Weftline-Proxy-Secret: ${secret}\r\n`:''}${extra}Connection: close\r\n\r\n`));s.on('data',x=>out+=x);s.on('end',()=>resolve(out));s.on('error',reject);});
 for(const extra of [`X-Weftline-Proxy-Secret: ${secret}\r\n`,'Host: app.example.test\r\n','Forwarded: for=1.2.3.4\r\n','Origin: https://evil.example\r\n'])assert.match(await raw(extra),/^HTTP\/1\.1 (400|403)\b/);
 assert.equal((await send('/health',{headers:{'x-weftline-proxy-secret':randomBytes(32).toString('hex')}})).status,403);
 assert.match(await raw('',false),/^HTTP\/1\.1 403\b/);
 assert.equal((await send('/health',{headers:{host:'evil.example'}})).status,403);
 assert.equal((await send('/health',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
 assert.equal((await send('/health')).status,200);
 assert.equal((await send('/knowledge/v2/read',{body:{},headers:{cookie:'__Host-weftline=alice'}})).status,404);
 const login=await send('/login',{body:{email:'alice@example.test',password:'synthetic'}});assert.equal(login.status,201);const cookie=login.headers['set-cookie'][0].split(';')[0];
 const draft={expectedActor:'creatorSentinel83',documentId:'documentSentinel83',operationId:'00000000000000000000000000000001',title:'titleSentinel83',html:'privateBodySentinel83'};
 const firstCreate=await send('/knowledge/versioned/create',{body:draft,headers:{cookie}});assert.equal(JSON.parse(firstCreate.text).status,'confirmed',JSON.stringify(firstCreate));
 assert.equal(JSON.parse((await send('/knowledge/versioned/read',{body:{expectedActor:'creatorSentinel83',documentId:'documentSentinel83',generation:0},headers:{cookie}})).text).version.html,'privateBodySentinel83');
 const otherAgent=await send('/knowledge/versioned/read',{body:{expectedActor:'bob',documentId:'documentSentinel83',generation:0},headers:{cookie:'__Host-weftline=bob'}});
 assert.equal(otherAgent.status,200);const shared=JSON.parse(otherAgent.text);assert.equal(shared.status,'advisory');assert.equal(shared.version.html,'privateBodySentinel83');assert.equal(shared.version.creator,'creatorSentinel83');
 const scope={endpoint,project,database:'db',table:'versions',boardId:'board',teamId:'team'};
 const intent={expectedActor:'bob',documentId:'documentSentinel83',generation:0};
 const safeResponse=r=>{for(const value of [secret,'synthetic-key','synthetic-provider-secret-marker','scopeSentinel83','privateBodySentinel83','titleSentinel83','creatorSentinel83','documentSentinel83','__Host-weftline=bob',...Object.values(scope)])assert.equal(r.text.includes(value),false);};
 const exactFailure=(r,status,kind)=>{assert.equal(r.status,status);assert.deepEqual(JSON.parse(r.text),{status:kind});safeResponse(r);};
 const scoped=await send('/knowledge/versioned/scoped-read',{body:{scope,intent},headers:{cookie:'__Host-weftline=bob'}});
 assert.equal(scoped.status,200);assert.equal(JSON.parse(scoped.text).version.html,'privateBodySentinel83');
 const beforeScoped=(await provider.control('metrics')).requests.filter(r=>r.path.includes('/tablesdb/')).length;
 for(const key of Object.keys(scope)){
  const mismatch=await send('/knowledge/versioned/scoped-read',{body:{scope:{...scope,[key]:'scopeSentinel83'},intent},headers:{cookie:'__Host-weftline=bob'}});
  exactFailure(mismatch,202,'unknown');
 }
 assert.equal((await provider.control('metrics')).requests.filter(r=>r.path.includes('/tablesdb/')).length,beforeScoped);
 const outsiderScoped={expectedActor:'outsider',documentId:'documentSentinel83',generation:0};
 const deniedScoped=await send('/knowledge/versioned/scoped-read',{body:{scope,intent:outsiderScoped},headers:{cookie:'__Host-weftline=outsider'}});
 const deniedMismatch=await send('/knowledge/versioned/scoped-read',{body:{scope:{...scope,table:'scopeSentinel83'},intent:outsiderScoped},headers:{cookie:'__Host-weftline=outsider'}});
 exactFailure(deniedScoped,403,'denied');exactFailure(deniedMismatch,403,'denied');assert.equal(deniedScoped.text,deniedMismatch.text);
 // Every denial below crosses the real HTTP listener and synthetic provider.
 const readPath='/knowledge/versioned/scoped-read', bobCookie='__Host-weftline=bob';
 const privateCount=async()=>(await provider.control('metrics')).requests.filter(r=>r.path.includes('/tablesdb/')).length;
 const denyBaseline=await privateCount();
 for(const badScope of [null,[],42,'scope',{},Object.fromEntries(Object.entries(scope).filter(([k])=>k!=='table')),{...scope,extra:'synthetic-provider-secret-marker'},{...scope,table:42}]){
  const r=await send(readPath,{body:{scope:badScope,intent},headers:{cookie:bobCookie}});
  exactFailure(r,202,'unknown');
 }
 const missing=await send(readPath,{body:{intent},headers:{cookie:bobCookie}});exactFailure(missing,400,'unavailable');
 for(const body of [{scope,intent,extra:'synthetic-provider-secret-marker'},{scope,intent:{...intent,extra:'synthetic-provider-secret-marker'}}]){const r=await send(readPath,{body,headers:{cookie:bobCookie}});exactFailure(r,400,'unavailable');}
 // Alice's valid session cannot be used to impersonate Bob, and vice versa.
 for(const [session,actor] of [['creatorSentinel83','bob'],['bob','creatorSentinel83']]){
  const r=await send(readPath,{body:{scope,intent:{...intent,expectedActor:actor}},headers:{cookie:`__Host-weftline=${session}`}});
  exactFailure(r,403,'denied');
 }
 for(const badSession of ['outsider','invalid-session']){
  const results=[];for(const candidate of [scope,{...scope,table:'scopeSentinel83'},null]){
   const r=await send(readPath,{body:{scope:candidate,intent:{...intent,expectedActor:badSession}},headers:{cookie:`__Host-weftline=${badSession}`}});
   exactFailure(r,403,'denied');results.push(r.text);
  }assert.equal(new Set(results).size,1);
 }
 await provider.control('fail-next-account');
 const failedAccount=await send(readPath,{body:{scope,intent},headers:{cookie:bobCookie}});exactFailure(failedAccount,202,'unknown');
 assert.equal(await privateCount(),denyBaseline);
 const positive=await send(readPath,{body:{scope,intent},headers:{cookie:bobCookie}});assert.equal(positive.status,200);assert.equal(JSON.parse(positive.text).version.html,'privateBodySentinel83');
 // A reader role dominates an ordinary writer role on the same confirmed membership.
 const creatorCookie='__Host-weftline=creatorSentinel83',beforeReaderWrites=await provider.control('metrics');
 await provider.control('roles',{actor:'creatorSentinel83',roles:['member','reader']});
 const guardedIntent={expectedActor:'creatorSentinel83',documentId:'documentSentinel83',operationId:'1'.repeat(32),title:'denied',html:'denied'};
 for(const action of ['create','edit','reconcile']){const body={...guardedIntent,...(action==='edit'?{previousGeneration:0}:action==='reconcile'?{previousGeneration:-1}:{})};assert.equal((await send('/knowledge/versioned/'+action,{body,headers:{cookie:creatorCookie}})).status,403,`direct ${action}`);}
 await provider.control('roles',{actor:'creatorSentinel83',roles:['owner','reader']});
 assert.equal((await send('/knowledge/versioned/create',{body:{...guardedIntent,operationId:'3'.repeat(32)},headers:{cookie:creatorCookie}})).status,403,'reader dominates owner too');
 const afterReaderWrites=await provider.control('metrics');assert.equal(afterReaderWrites.commits,beforeReaderWrites.commits,'reader-denied attempts must not commit');
 const readerCanRead=await send('/knowledge/versioned/read',{body:{expectedActor:'creatorSentinel83',documentId:'documentSentinel83',generation:0},headers:{cookie:creatorCookie}});assert.equal(readerCanRead.status,200);
 await provider.control('roles',{actor:'creatorSentinel83',roles:['member']});
 const writerAgain=await send('/knowledge/versioned/create',{body:{...guardedIntent,documentId:'writer-control',operationId:'2'.repeat(32)},headers:{cookie:creatorCookie}});assert.equal(writerAgain.status,200);assert.equal(JSON.parse(writerAgain.text).status,'confirmed');
 // Hold the actual provider account response, then terminate the listener request.
 const waitHeld=async()=>{const end=Date.now()+3000;while(Date.now()<end){if(await provider.control('account-held'))return;await new Promise(r=>setTimeout(r,10));}throw Error('account request never reached provider');};
 const postHeld=()=>{const req=http.request({host:'127.0.0.1',port,path:readPath,method:'POST',headers:{host:'app.example.test','x-weftline-proxy-secret':secret,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:bobCookie}});const response=new Promise((resolve,reject)=>{req.once('response',res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,text}));});req.once('error',reject);});req.setTimeout(15000,()=>req.destroy(Error('request timed out')));req.end(JSON.stringify({scope,intent}));return {req,response};};
 for(const mode of ['disconnect','timeout']){
  const barrier=waitFixtureEvent(child,'fixture-barrier');child.send('fixture-barrier');await barrier;
  const beforeStarts=starts.length;
  const beforePending=(await provider.control('metrics')).requests.length;
  // Client disconnect can be observed before the listener propagates abort.
  // Arm the next account fetch and wait for its signal before releasing it.
  const armed=waitFixtureEvent(child,'fixture-account-armed');child.send('fixture-arm-account');await armed;
  const aborted=waitFixtureEvent(child,'fixture-account-aborted',15000);aborted.catch(()=>{});
  await provider.control('hold-next-account');const pending=postHeld();pending.response.catch(()=>{});await waitHeld();
  if(mode==='disconnect'){pending.req.destroy();await assert.rejects(pending.response);}else{const r=await pending.response;exactFailure(r,202,'unknown');}
  await aborted;
  const delivered=waitFixtureEvent(child);await provider.control('release-account');assert.deepEqual(await delivered,{event:'late-account-delivered',aborted:true});
  await new Promise(r=>setTimeout(r,200));
  const flush=waitFixtureEvent(child,'fixture-barrier');child.send('fixture-barrier');await flush;
  assert.deepEqual(starts.slice(beforeStarts),[],`${mode} started a downstream fetch`);
  const later=(await provider.control('metrics')).requests.slice(beforePending);
  assert.equal(later.filter(r=>r.path==='/v1/account').length,1,mode);
  assert.equal(later.some(r=>r.path.includes('/memberships')||r.path.includes('/tablesdb/')),false,`${mode} dispatched downstream after cancellation`);
 }
 const recovered=await send(readPath,{body:{scope,intent},headers:{cookie:bobCookie}});assert.equal(recovered.status,200);assert.equal(JSON.parse(recovered.text).version.html,'privateBodySentinel83');
 const {WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_READ:ignored,...disabledEnv}=env;
 const disabledChild=spawn(process.execPath,['src/server.js'],{env:disabledEnv});let disabledOutput='';disabledChild.stdout.on('data',x=>disabledOutput+=x);disabledChild.stderr.on('data',x=>disabledOutput+=x);
 t.after(()=>stopChild(disabledChild));
 const disabledPort=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(disabledOutput)),5000);disabledChild.once('exit',()=>{clearTimeout(timer);reject(Error(`listener exit: ${disabledOutput}`));});disabledChild.stdout.on('data',()=>{const m=disabledOutput.match(/listener .*:(\d+)/);if(m){clearTimeout(timer);resolve(+m[1]);}});});
 const disabledStatus=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:disabledPort,path:'/knowledge/versioned/scoped-read',method:'POST',headers:{host:'app.example.test','x-weftline-proxy-secret':secret,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:'__Host-weftline=bob'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({scope,intent}));});
 assert.equal(disabledStatus,404);
 const outsider=await send('/knowledge/versioned/read',{body:{expectedActor:'outsider',documentId:'documentSentinel83',generation:0},headers:{cookie:'__Host-weftline=outsider'}});
 exactFailure(outsider,403,'denied');
 const before=(await provider.control('metrics')).requests.length;
 assert.equal((await send('/knowledge/versioned/read',{body:{expectedActor:'creatorSentinel83',documentId:'documentSentinel83',generation:0},headers:{cookie,origin:'https://evil.example'}})).status,403);
 assert.equal((await send('/knowledge/versioned/read',{body:{expectedActor:'creatorSentinel83',documentId:'documentSentinel83',generation:0},headers:{cookie,'x-forwarded-for':'1.2.3.4'}})).status,403);
 assert.equal((await provider.control('metrics')).requests.length,before);for(const value of [secret,'synthetic-key','synthetic-provider-secret-marker',bobCookie])assert(!output.includes(value));
});
