import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import https from 'node:https';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=resolve(import.meta.dirname,'../../..');
const scopeArgs=(endpoint,project)=>['--backend-endpoint',endpoint,'--backend-project',project,'--backend-database','db','--backend-table','review'];
test('opt-in MCP claims and submits through listener with persisted exact receipts',{timeout:20000},async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'wf-write-')),key=join(dir,'key'),cert=join(dir,'cert'),journal=join(dir,'journal');mkdirSync(journal,{mode:0o700});
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const endpoint='https://provider.example.test/v1',project='synthetic-project';writeFileSync(join(dir,'api'),`apikey:synthetic\nprojectID:${project}\nendpoint:${endpoint}\n`);
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./experimental/agent-mcp/test/write-provider.js',WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_AGENT_SCOPED_WRITES:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_HOST:'127.0.0.1',WEFTLINE_REVIEW_PORT:'0',WEFTLINE_REVIEW_BOARD:'b',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_TLS_KEY_FILE:key,WEFTLINE_TLS_CERT_FILE:cert,APPWRITE_KEY_FILE:join(dir,'api'),REVIEW_TEST_WRITES_FILE:join(dir,'writes'),REVIEW_TEST_SNAPSHOT_FILE:join(dir,'snapshot'),REVIEW_TEST_READS_FILE:join(dir,'reads')};
 const child=spawn(process.execPath,['experimental/review-v1-cli.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stderr.resume();let output='';
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const closed=new Promise(r=>child.once('close',r));child.kill();await closed;}rmSync(dir,{recursive:true,force:true});});
 const port=await new Promise((ok,bad)=>{const timer=setTimeout(()=>bad(Error('listener startup')),5000);child.once('close',()=>bad(Error('listener closed')));child.stdout.on('data',x=>{output+=x;const m=output.match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);ok(+m[1]);}});});
 const origin=`https://127.0.0.1:${port}`;
 const post=(path,body)=>new Promise((ok,bad)=>{const req=https.request({host:'127.0.0.1',port,path,method:'POST',ca:readFileSync(cert),headers:{host:`127.0.0.1:${port}`,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:'__Host-weftline=alice'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});req.on('error',bad);req.end(JSON.stringify(body));});
 await post('/review/genesis',{board:'b',expectedActor:'alice',guardGeneration:0,operation:'create',task:'task',taskGeneration:0,action:'genesis'});
 // Compare listener responses before actor/guard authorization.
 const query=(path,scope,intent,session)=>new Promise((ok,bad)=>{const req=https.request({host:'127.0.0.1',port,path,method:'POST',ca:readFileSync(cert),headers:{host:`127.0.0.1:${port}`,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:`__Host-weftline=${session}`}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>ok({code:res.statusCode,body}));});req.on('error',bad);req.end(JSON.stringify({scope,intent}));});
 const testScope={endpoint,project,database:'db',table:'review'},badScope={...testScope,project:'wrong'};
 const testIntent={board:'b',expectedActor:'alice',guardGeneration:1,operation:'oracle',task:'task',taskGeneration:0,action:'claim'};
 for(const [session,intent,limit] of [['invalid',testIntent,0],['bob',testIntent,0],['outsider',{...testIntent,expectedActor:'outsider'},1],['alice',{...testIntent,guardGeneration:0},2]]){
  for(const route of ['transition','receipt']){
   const actualIntent=route==='receipt'?{...intent,currentGuardGeneration:intent.guardGeneration}:intent;
   const readCount=()=>{try{return readFileSync(join(dir,'reads'),'utf8').trim().split('\n').length;}catch{return 0;}};
   const writes=readFileSync(join(dir,'writes'),'utf8'),before=readCount();
   const match=await query('/review/scoped-'+route,testScope,actualIntent,session),after=readCount();
   const mismatch=await query('/review/scoped-'+route,badScope,actualIntent,session),end=readCount();
   assert.deepEqual(mismatch,match,`${session} ${route} scope oracle`);
   assert.equal(after-before,limit);assert.equal(end-after,limit);
   assert.equal(readFileSync(join(dir,'writes'),'utf8'),writes);
  }
 }
 const genesisReceipt={board:'b',expectedActor:'alice',guardGeneration:0,currentGuardGeneration:1,operation:'create',task:'task',taskGeneration:0,action:'genesis'};
 const goodReceipt=await query('/review/scoped-receipt',testScope,genesisReceipt,'alice');
 assert.equal(goodReceipt.code,200);assert.equal(JSON.parse(goodReceipt.body).status,'recorded');
 const badReceipt=await query('/review/scoped-receipt',badScope,genesisReceipt,'alice');
 assert.equal(badReceipt.code,202);assert.equal(JSON.parse(badReceipt.body).status,'unavailable');
 const base=[resolve(root,'experimental/agent-mcp/server.js'),'--enable','--endpoint',origin,'--ca',cert,'--actor','alice','--board','b','--guard','1'];
 const childEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'};
 const beforeMissing=readFileSync(join(dir,'snapshot'),'utf8'),writesBeforeMissing=readFileSync(join(dir,'writes'),'utf8');
 const scope={endpoint,project,database:'db',table:'review'},intent={board:'b',expectedActor:'alice',guardGeneration:1,operation:'forged',task:'task',taskGeneration:0,action:'claim'};
 for(const key of Object.keys(scope))assert.equal(await post('/review/scoped-transition',{scope:{...scope,[key]:'wrong'},intent}),403);
 const unauth=await new Promise((ok,bad)=>{const req=https.request({host:'127.0.0.1',port,path:'/review/scoped-transition',method:'POST',ca:readFileSync(cert),headers:{host:`127.0.0.1:${port}`,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});req.on('error',bad);req.end(JSON.stringify({scope,intent}));});assert.notEqual(unauth,201);
 assert.equal(readFileSync(join(dir,'snapshot'),'utf8'),beforeMissing);assert.equal(readFileSync(join(dir,'writes'),'utf8'),writesBeforeMissing);
 for(const invalid of [[...base,'--enable-writes','--journal',journal],[...base,...scopeArgs(endpoint,project)]]) {const failed=spawnSync(process.execPath,invalid,{env:childEnv,encoding:'utf8',timeout:5000});assert.equal(failed.status,1);assert.equal(failed.stdout,'');}
 assert.equal(readFileSync(join(dir,'snapshot'),'utf8'),beforeMissing);assert.equal(readFileSync(join(dir,'writes'),'utf8'),writesBeforeMissing);
 const wrongJournal=join(dir,'wrong-journal');mkdirSync(wrongJournal,{mode:0o700});
 const wrongTransport=new StdioClientTransport({command:process.execPath,args:[...base,'--enable-writes','--journal',wrongJournal,...scopeArgs(endpoint,'different-project')],env:childEnv,stderr:'pipe'});
 const wrongClient=new Client({name:'fresh-mismatch-test',version:'1'});t.after(()=>wrongClient.close());await wrongClient.connect(wrongTransport);
 const wrong=await wrongClient.callTool({name:'claim',arguments:{operation:'wrong',task:'task',guardGeneration:1,taskGeneration:0}});assert.notEqual(JSON.parse(wrong.content[0].text).status,'recorded');
 const wrongPending=readFileSync(join(wrongJournal,'intent.json'),'utf8');
 const wrongReceipt=await wrongClient.callTool({name:'reconcile',arguments:{currentGuardGeneration:1}});assert.notEqual(JSON.parse(wrongReceipt.content[0].text).status,'recorded');assert.equal(readFileSync(join(wrongJournal,'intent.json'),'utf8'),wrongPending);
 assert.equal(readFileSync(join(dir,'snapshot'),'utf8'),beforeMissing);assert.equal(readFileSync(join(dir,'writes'),'utf8'),writesBeforeMissing);
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve(root,'experimental/agent-mcp/server.js'),'--enable','--endpoint',origin,'--ca',cert,'--actor','alice','--board','b','--guard','1','--enable-writes','--journal',journal,...scopeArgs(endpoint,project)],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},stderr:'pipe'});
 const client=new Client({name:'write-test',version:'1'});t.after(()=>client.close());await client.connect(transport);
 const tools=(await client.listTools()).tools.map(x=>x.name);assert(tools.includes('claim'));assert(tools.includes('submit'));assert(tools.includes('reconcile'));
 const invalid=await client.callTool({name:'claim',arguments:{operation:'claim1',task:'task',guardGeneration:1,taskGeneration:0,expectedActor:'bob'}});assert.equal(JSON.parse(invalid.content[0].text).status,'invalid');
 const claim=await client.callTool({name:'claim',arguments:{operation:'claim1',task:'task',guardGeneration:1,taskGeneration:0}});assert.equal(JSON.parse(claim.content[0].text).status,'recorded');
 assert.equal((await client.callTool({name:'resolve',arguments:{task:'task'}})).isError,true);
 const newerBase=[...base];newerBase[newerBase.indexOf('--guard')+1]='2';
 const newTransport=new StdioClientTransport({command:process.execPath,args:[...newerBase,'--enable-writes','--journal',journal,...scopeArgs(endpoint,project)],env:childEnv,stderr:'pipe'});
 const newClient=new Client({name:'new-guard-test',version:'1'});t.after(()=>newClient.close());await newClient.connect(newTransport);
 const resolved=await newClient.callTool({name:'resolve',arguments:{task:'task'}});assert.notEqual(resolved.isError,true);assert.equal(JSON.parse(resolved.content[0].text).observed.state,'claimed');
 const submit=await client.callTool({name:'submit',arguments:{operation:'submit1',task:'task',guardGeneration:2,taskGeneration:1}});assert.equal(JSON.parse(submit.content[0].text).status,'recorded');
 const rows=Object.values(JSON.parse(readFileSync(join(dir,'snapshot'))));assert(rows.some(r=>r.kind==='review-task-v1'&&r.generation===2&&r.state==='review'));
 const beforeMismatch=readFileSync(join(dir,'snapshot'),'utf8'),writesBeforeMismatch=readFileSync(join(dir,'writes'),'utf8'),journalBeforeMismatch=readFileSync(join(journal,'intent.json'),'utf8');
 assert.deepEqual(JSON.parse(readFileSync(join(journal,'journal.marker'),'utf8')).scope,{endpoint,project,database:'db',table:'review'});
 const mismatchTransport=new StdioClientTransport({command:process.execPath,args:[...base,'--enable-writes','--journal',journal,...scopeArgs(endpoint,'different-project')],env:childEnv,stderr:'pipe'});
 const mismatch=new Client({name:'mismatch-test',version:'1'});t.after(()=>mismatch.close());await mismatch.connect(mismatchTransport);
 const denied=await mismatch.callTool({name:'claim',arguments:{operation:'other',task:'task',guardGeneration:3,taskGeneration:2}});assert.equal(JSON.parse(denied.content[0].text).status,'unknown');
 assert.equal(readFileSync(join(dir,'snapshot'),'utf8'),beforeMismatch);assert.equal(readFileSync(join(dir,'writes'),'utf8'),writesBeforeMismatch);assert.equal(readFileSync(join(journal,'intent.json'),'utf8'),journalBeforeMismatch);

});

test('restart reconciles a lost claim response against its independent receipt',{timeout:20000},async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'wf-write-')),key=join(dir,'key'),cert=join(dir,'cert'),journal=join(dir,'journal');mkdirSync(journal,{mode:0o700});
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const endpoint='https://provider.example.test/v1',project='synthetic-project';writeFileSync(join(dir,'api'),`apikey:synthetic\nprojectID:${project}\nendpoint:${endpoint}\n`);
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./experimental/agent-mcp/test/write-provider.js',WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_AGENT_SCOPED_WRITES:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_HOST:'127.0.0.1',WEFTLINE_REVIEW_PORT:'0',WEFTLINE_REVIEW_BOARD:'b',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_TLS_KEY_FILE:key,WEFTLINE_TLS_CERT_FILE:cert,APPWRITE_KEY_FILE:join(dir,'api'),REVIEW_TEST_WRITES_FILE:join(dir,'writes'),REVIEW_TEST_SNAPSHOT_FILE:join(dir,'snapshot'),REVIEW_TEST_LOSE_SECOND:'1'};
 const child=spawn(process.execPath,['experimental/review-v1-cli.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stderr.resume();let output='';
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const closed=new Promise(r=>child.once('close',r));child.kill();await closed;}rmSync(dir,{recursive:true,force:true});});
 const port=await new Promise((ok,bad)=>{const timer=setTimeout(()=>bad(Error('listener startup')),5000);child.once('close',()=>bad(Error('listener closed')));child.stdout.on('data',x=>{output+=x;const m=output.match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);ok(+m[1]);}});});
 const origin=`https://127.0.0.1:${port}`;
 const post=(path,body)=>new Promise((ok,bad)=>{const req=https.request({host:'127.0.0.1',port,path,method:'POST',ca:readFileSync(cert),headers:{host:`127.0.0.1:${port}`,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:'__Host-weftline=alice'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});req.on('error',bad);req.end(JSON.stringify(body));});
 await post('/review/genesis',{board:'b',expectedActor:'alice',guardGeneration:0,operation:'create',task:'task',taskGeneration:0,action:'genesis'});
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve(root,'experimental/agent-mcp/server.js'),'--enable','--endpoint',origin,'--ca',cert,'--actor','alice','--board','b','--guard','1','--enable-writes','--journal',journal,...scopeArgs(endpoint,project)],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},stderr:'pipe'});
 const client=new Client({name:'write-test',version:'1'});t.after(()=>client.close());await client.connect(transport);
 const tools=(await client.listTools()).tools.map(x=>x.name);assert(tools.includes('claim'));assert(tools.includes('submit'));assert(tools.includes('reconcile'));
 const claim=await client.callTool({name:'claim',arguments:{operation:'claim1',task:'task',guardGeneration:1,taskGeneration:0}});assert.equal(JSON.parse(claim.content[0].text).status,'unknown');
 await client.close();
 const transport2=new StdioClientTransport({command:process.execPath,args:[resolve(root,'experimental/agent-mcp/server.js'),'--enable','--endpoint',origin,'--ca',cert,'--actor','alice','--board','b','--guard','2','--enable-writes','--journal',journal,...scopeArgs(endpoint,project)],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},stderr:'pipe'});
 const restarted=new Client({name:'restart-test',version:'1'});t.after(()=>restarted.close());await restarted.connect(transport2);
 const transport3=new StdioClientTransport({command:process.execPath,args:[resolve(root,'experimental/agent-mcp/server.js'),'--enable','--endpoint',origin,'--ca',cert,'--actor','alice','--board','b','--guard','2','--enable-writes','--journal',journal,...scopeArgs(endpoint,project)],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},stderr:'pipe'});
 const competing=new Client({name:'competing-test',version:'1'});t.after(()=>competing.close());await competing.connect(transport3);
 const blocked=await Promise.all([restarted,competing].map(c=>c.callTool({name:'submit',arguments:{operation:'submit1',task:'task',guardGeneration:2,taskGeneration:1}})));assert.deepEqual(blocked.map(x=>JSON.parse(x.content[0].text).status),['blocked','blocked']);
 const proof=await restarted.callTool({name:'reconcile',arguments:{currentGuardGeneration:2}});assert.equal(JSON.parse(proof.content[0].text).status,'recorded');
 const submit=await restarted.callTool({name:'submit',arguments:{operation:'submit1',task:'task',guardGeneration:2,taskGeneration:1}});assert.equal(JSON.parse(submit.content[0].text).status,'recorded');
});

test('actor mismatch cannot mutate and leaves intent unknown',{timeout:20000},async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'wf-write-')),key=join(dir,'key'),cert=join(dir,'cert'),journal=join(dir,'journal');mkdirSync(journal,{mode:0o700});
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const endpoint='https://provider.example.test/v1',project='synthetic-project';writeFileSync(join(dir,'api'),`apikey:synthetic\nprojectID:${project}\nendpoint:${endpoint}\n`);
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./experimental/agent-mcp/test/write-provider.js',WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_AGENT_SCOPED_WRITES:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_HOST:'127.0.0.1',WEFTLINE_REVIEW_PORT:'0',WEFTLINE_REVIEW_BOARD:'b',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_TLS_KEY_FILE:key,WEFTLINE_TLS_CERT_FILE:cert,APPWRITE_KEY_FILE:join(dir,'api'),REVIEW_TEST_WRITES_FILE:join(dir,'writes'),REVIEW_TEST_SNAPSHOT_FILE:join(dir,'snapshot')};
 const child=spawn(process.execPath,['experimental/review-v1-cli.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stderr.resume();let output='';
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const closed=new Promise(r=>child.once('close',r));child.kill();await closed;}rmSync(dir,{recursive:true,force:true});});
 const port=await new Promise((ok,bad)=>{const timer=setTimeout(()=>bad(Error('listener startup')),5000);child.once('close',()=>bad(Error('listener closed')));child.stdout.on('data',x=>{output+=x;const m=output.match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);ok(+m[1]);}});});
 const origin=`https://127.0.0.1:${port}`;
 const post=(path,body)=>new Promise((ok,bad)=>{const req=https.request({host:'127.0.0.1',port,path,method:'POST',ca:readFileSync(cert),headers:{host:`127.0.0.1:${port}`,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:'__Host-weftline=alice'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});req.on('error',bad);req.end(JSON.stringify(body));});
 await post('/review/genesis',{board:'b',expectedActor:'alice',guardGeneration:0,operation:'create',task:'task',taskGeneration:0,action:'genesis'});
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve(root,'experimental/agent-mcp/server.js'),'--enable','--endpoint',origin,'--ca',cert,'--actor','alice','--board','b','--guard','1','--enable-writes','--journal',journal,...scopeArgs(endpoint,project)],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'bob'},stderr:'pipe'});
 const client=new Client({name:'write-test',version:'1'});t.after(()=>client.close());await client.connect(transport);
 const tools=(await client.listTools()).tools.map(x=>x.name);assert(tools.includes('claim'));assert(tools.includes('submit'));assert(tools.includes('reconcile'));
 const before=readFileSync(join(dir,'snapshot'),'utf8');
 const claim=await client.callTool({name:'claim',arguments:{operation:'claim1',task:'task',guardGeneration:1,taskGeneration:0}});assert.equal(JSON.parse(claim.content[0].text).status,'unknown');
 assert.equal(readFileSync(join(dir,'snapshot'),'utf8'),before);
 const proof=await client.callTool({name:'reconcile',arguments:{currentGuardGeneration:1}});assert.equal(JSON.parse(proof.content[0].text).status,'unknown');
 assert.equal(JSON.parse(readFileSync(join(journal,'intent.json'),'utf8')).status,'pending');
});
