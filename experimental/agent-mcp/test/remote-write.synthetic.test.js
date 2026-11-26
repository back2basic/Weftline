// Synthetic TLS ingress, spawned real proxy receiver, synthetic Appwrite provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=resolve(import.meta.dirname,'../../..');
test('explicit remote scoped writes cross TLS ingress and real proxy with durable reconciliation',{timeout:30000},async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'wf-remote-write-'));let child,ingress,port,closed;const clients=[];
 t.after(async()=>{for(const c of clients)await c.close();if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await closed;}if(ingress?.listening){ingress.closeAllConnections();await new Promise(r=>ingress.close(r));}rmSync(dir,{recursive:true,force:true});});
 const key=join(dir,'key'),cert=join(dir,'cert'),badkey=join(dir,'badkey'),badcert=join(dir,'badcert'),api=join(dir,'api'),writes=join(dir,'writes'),snapshot=join(dir,'snapshot');
 for(const [k,c] of [[key,cert],[badkey,badcert]])execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',k,'-out',c,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const endpoint='https://provider.example.test/v1',project='synthetic-project',secret=randomBytes(32).toString('hex');writeFileSync(api,`apikey:synthetic\nprojectID:${project}\nendpoint:${endpoint}\n`);
 let redirect=false,ingressCount=0,connections=0,loseReview=false,forgeReceipt=false;
 ingress=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{ingressCount++;if(redirect){res.writeHead(302,{location:`${origin}/stolen`});return res.end();}const upstream=http.request({host:'127.0.0.1',port,path:req.url,method:req.method,headers:{...req.headers,'x-weftline-proxy-secret':secret}},r=>{if(loseReview&&req.url==='/review/scoped-transition'){loseReview=false;r.resume();r.on('end',()=>res.destroy());return;}if(forgeReceipt&&req.url==='/review/scoped-receipt'){let body='';r.on('data',x=>body+=x);r.on('end',()=>{const value=JSON.parse(body);value.receipt.action='approve';const output=JSON.stringify(value);res.writeHead(r.statusCode,{'content-type':'application/json','content-length':Buffer.byteLength(output)});res.end(output);});return;}res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>res.destroy());req.pipe(upstream);});
 ingress.on('connection',()=>connections++);await new Promise(r=>ingress.listen(0,'127.0.0.1',r));assert.equal(ingress.address().address,'127.0.0.1');const origin=`https://127.0.0.1:${ingress.address().port}`;
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./experimental/agent-mcp/test/write-provider.js',WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_AGENT_SCOPED_WRITES:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_PROXY:'1',WEFTLINE_PROXY_SECRET:secret,WEFTLINE_PUBLIC_ORIGIN:origin,WEFTLINE_REVIEW_HOST:'127.0.0.1',PORT:'0',WEFTLINE_REVIEW_BOARD:'b',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',APPWRITE_KEY_FILE:api,REVIEW_TEST_WRITES_FILE:writes,REVIEW_TEST_SNAPSHOT_FILE:snapshot,REVIEW_TEST_LOSE_SECOND:'1',REVIEW_TEST_GUARD_FILE:join(dir,'guard-overrides')};
 child=spawn(process.execPath,['experimental/review-v1-cli.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});closed=new Promise(r=>child.once('close',r));
 port=await new Promise((ok,bad)=>{let output='';const timer=setTimeout(()=>bad(Error('startup timeout')),5000);child.stderr.on('data',x=>output+=x);child.once('close',()=>{clearTimeout(timer);bad(Error(`proxy startup failed: ${output}`));});child.stdout.on('data',x=>{const m=x.toString().match(/listener 127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);ok(Number(m[1]));}});});
 const post=(path,body)=>new Promise((ok,bad)=>{const req=https.request(`${origin}${path}`,{method:'POST',ca:readFileSync(cert),headers:{origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:'__Host-weftline=alice'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});req.on('error',bad);req.end(JSON.stringify(body));});
 assert.equal(await post('/review/genesis',{board:'b',expectedActor:'alice',guardGeneration:0,operation:'create',task:'task',taskGeneration:0,action:'genesis'}),202);
 const baseline=readFileSync(writes,'utf8');let n=0;
 const deniedProxy=await new Promise((ok,bad)=>{const req=http.request({host:'127.0.0.1',port,path:'/review/scoped-transition',method:'POST',headers:{host:new URL(origin).host,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:'__Host-weftline=alice','x-weftline-proxy-secret':'0'.repeat(64)}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});req.on('error',bad);req.end('{}');});assert.equal(deniedProxy,403);assert.equal(readFileSync(writes,'utf8'),baseline);
 async function connect({url=origin,ca=cert,session='alice',actor='alice',scopeProject=project,journal}={}){journal??=join(dir,`j${n++}`);if(!journal.includes('/shared'))mkdirSync(journal,{mode:0o700});const transport=new StdioClientTransport({command:process.execPath,args:[resolve(root,'experimental/agent-mcp/server.js'),'--enable','--remote-https','--endpoint',url,'--ca',ca,'--actor',actor,'--board','b','--guard','1','--enable-writes','--journal',journal,'--backend-endpoint',endpoint,'--backend-project',scopeProject,'--backend-database','db','--backend-table','review'],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--dns-result-order=ipv4first',WEFTLINE_AGENT_SESSION:session},stderr:'pipe'});const client=new Client({name:'remote-write-test',version:'1'});await client.connect(transport);clients.push(client);return client;}
 const claim=async c=>JSON.parse((await c.callTool({name:'claim',arguments:{operation:'claim1',task:'task',guardGeneration:1,taskGeneration:0}})).content[0].text).status;
 for(const opts of [{session:'bob'},{session:'invalid'},{scopeProject:'wrong'},{ca:badcert},{url:origin.replace('127.0.0.1','localhost')}]){const c=await connect(opts),beforeConnections=connections,beforeRequests=ingressCount;assert.equal(await claim(c),'unknown');assert.equal(readFileSync(writes,'utf8'),baseline);if(opts.ca||opts.url){assert.equal(connections,beforeConnections+1);assert.equal(ingressCount,beforeRequests);}}
 redirect=true;const redirected=await connect();const beforeRedirect=ingressCount;assert.equal(await claim(redirected),'unknown');assert.equal(ingressCount,beforeRedirect+1);redirect=false;assert.equal(readFileSync(writes,'utf8'),baseline);
 const shared=join(dir,'shared');mkdirSync(shared,{mode:0o700});const alice=await connect({journal:shared});assert.equal(await claim(alice),'unknown');assert.notEqual(readFileSync(writes,'utf8'),baseline);await alice.close();
 const restarted=await connect({journal:shared});assert.equal(JSON.parse((await restarted.callTool({name:'submit',arguments:{operation:'submit1',task:'task',guardGeneration:2,taskGeneration:1}})).content[0].text).status,'blocked');
 assert.equal(JSON.parse((await restarted.callTool({name:'reconcile',arguments:{currentGuardGeneration:2}})).content[0].text).status,'recorded');
 assert.equal(JSON.parse((await restarted.callTool({name:'submit',arguments:{operation:'submit1',task:'task',guardGeneration:2,taskGeneration:1}})).content[0].text).status,'recorded');
 assert(Object.values(JSON.parse(readFileSync(snapshot))).some(r=>r.kind==='review-task-v1'&&r.state==='review'));assert(ingressCount>0);
 const worker=await connect({session:'charlie',actor:'charlie'});const beforeDenied=readFileSync(snapshot,'utf8'),beforeDeniedWrites=readFileSync(writes,'utf8');
 assert.equal(JSON.parse((await worker.callTool({name:'approve',arguments:{operation:'denied',task:'task',guardGeneration:0,taskGeneration:2}})).content[0].text).status,'unknown');
 assert.equal(readFileSync(snapshot,'utf8'),beforeDenied);assert.equal(readFileSync(writes,'utf8'),beforeDeniedWrites);
 assert.equal(JSON.parse((await worker.callTool({name:'reconcile',arguments:{currentGuardGeneration:0}})).content[0].text).status,'unknown');
 assert.equal(JSON.parse((await worker.callTool({name:'reject',arguments:{operation:'denied2',task:'task',guardGeneration:0,taskGeneration:2}})).content[0].text).status,'blocked');
 const workerReject=await connect({session:'charlie',actor:'charlie'});const rejectBefore=readFileSync(snapshot,'utf8'),rejectWrites=readFileSync(writes,'utf8');
 assert.equal(JSON.parse((await workerReject.callTool({name:'reject',arguments:{operation:'denied-reject',task:'task',guardGeneration:0,taskGeneration:2}})).content[0].text).status,'unknown');
 assert.equal(readFileSync(snapshot,'utf8'),rejectBefore);assert.equal(readFileSync(writes,'utf8'),rejectWrites);
 // The synthetic provider overrides this guard read; it does not provision a real role.
 writeFileSync(join(dir,'guard-overrides'),JSON.stringify([{kind:'review-guard-v1',board:'b',user:'alice',generation:3,state:'active',role:'reviewer'}]));
 for(const action of ['approve','reject']){const self=await connect();const before=readFileSync(snapshot,'utf8'),beforeWrites=readFileSync(writes,'utf8');
  assert.equal(JSON.parse((await self.callTool({name:action,arguments:{operation:'self-'+action,task:'task',guardGeneration:3,taskGeneration:2}})).content[0].text).status,'unknown');
  assert.equal(readFileSync(snapshot,'utf8'),before);assert.equal(readFileSync(writes,'utf8'),beforeWrites);
 }
 writeFileSync(join(dir,'guard-overrides'),JSON.stringify([{kind:'review-guard-v1',board:'b',user:'alice',generation:3,state:'active',role:'worker'}]));
 const bobJournal=join(dir,'shared-bob');mkdirSync(bobJournal,{mode:0o700});const bob=await connect({session:'bob',actor:'bob',journal:bobJournal});
 const tools=(await bob.listTools()).tools.map(x=>x.name);assert(tools.includes('approve'));assert(tools.includes('reject'));
 const approval=JSON.parse((await bob.callTool({name:'approve',arguments:{operation:'review2',task:'task',guardGeneration:0,taskGeneration:2}})).content[0].text);assert.equal(approval.status,'recorded');
 assert(Object.values(JSON.parse(readFileSync(snapshot))).some(r=>r.kind==='review-task-v1'&&r.task==='task'&&r.generation===3&&r.state==='completed'&&r.claimant==='alice'));
 assert.equal(await post('/review/genesis',{board:'b',expectedActor:'alice',guardGeneration:3,operation:'create2',task:'task2',taskGeneration:0,action:'genesis'}),201);
 const call=async(c,name,args)=>JSON.parse((await c.callTool({name,arguments:args})).content[0].text);
 assert.equal((await call(restarted,'claim',{operation:'claim2',task:'task2',guardGeneration:4,taskGeneration:0})).status,'recorded');
 assert.equal((await call(restarted,'submit',{operation:'submit2',task:'task2',guardGeneration:5,taskGeneration:1})).status,'recorded');
 loseReview=true;assert.equal((await call(bob,'reject',{operation:'review3',task:'task2',guardGeneration:1,taskGeneration:2})).status,'unknown');
 assert(Object.values(JSON.parse(readFileSync(snapshot))).some(r=>r.kind==='review-task-v1'&&r.task==='task2'&&r.generation===3&&r.state==='claimed'&&r.claimant==='alice'));
 assert.equal((await call(bob,'approve',{operation:'blocked',task:'task2',guardGeneration:2,taskGeneration:3})).status,'blocked');
 await bob.close();const bobRestarted=await connect({session:'bob',actor:'bob',journal:bobJournal});
 forgeReceipt=true;assert.equal((await call(bobRestarted,'reconcile',{currentGuardGeneration:2})).status,'unknown');forgeReceipt=false;
 assert.equal((await call(bobRestarted,'reconcile',{currentGuardGeneration:2})).status,'recorded');
});
