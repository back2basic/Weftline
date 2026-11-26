// Local synthetic provider, TLS ingress, real proxy listener and stdio MCP client.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startVersionedProvider} from '../../../test/fixtures/knowledge-versioned-http-provider.js';
import {rowId} from '../../knowledge-versioned-schema.js';
const root=resolve(import.meta.dirname,'../../..');

test('knowledge create crosses real stdio and scoped TLS listener and can be read by Bob', {timeout:40000}, async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'wf-knowledge-mcp-'));const clients=[];let child,closed,ingress,port;
 const provider=await startVersionedProvider();
 t.after(async()=>{for(const {client} of clients)await client.close();if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await closed;}if(ingress?.listening){ingress.closeAllConnections();await new Promise(r=>ingress.close(r));}await provider.close();rmSync(dir,{recursive:true,force:true});});
 const key=join(dir,'key'),cert=join(dir,'cert'),badkey=join(dir,'badkey'),badcert=join(dir,'badcert'),api=join(dir,'api');
 for(const [k,c] of [[key,cert],[badkey,badcert]])execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',k,'-out',c,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const endpoint='https://provider.example.test/v1',project='synthetic-project',secret=randomBytes(32).toString('hex');
 writeFileSync(api,`apikey:synthetic-key\nprojectID:${project}\nendpoint:${endpoint}\n`);
 const version={kind:'knowledge-version-v1',boardId:'board',documentId:'doc',generation:0,creator:'alice',editor:'alice',title:'Title',html:'<p>Shared &amp; exact</p>'};
 await provider.control('seed',[{$id:rowId('board','doc',0),payload:JSON.stringify(version),$permissions:[]},{$id:rowId('board','oversize',0),payload:JSON.stringify({...version,documentId:'oversize',html:'x'.repeat(2048)}),$permissions:[]}]);
 let redirect=false,requests=0,connections=0;ingress=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{requests++;if(redirect){res.writeHead(302,{location:'/stolen'});return res.end();}const upstream=http.request({host:'127.0.0.1',port,path:req.url,method:req.method,headers:{...req.headers,'x-weftline-proxy-secret':secret}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>res.destroy());req.pipe(upstream);});
 ingress.on('connection',()=>connections++);await new Promise(r=>ingress.listen(0,'127.0.0.1',r));assert.equal(ingress.address().address,'127.0.0.1');const origin=`https://127.0.0.1:${ingress.address().port}`;
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./test/fixtures/knowledge-versioned-cli-proxy.js',VERSIONED_FIXTURE_PORT:String(provider.port),WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_PROXY:'1',WEFTLINE_PROXY_SECRET:secret,WEFTLINE_PUBLIC_ORIGIN:origin,WEFTLINE_REVIEW_HOST:'127.0.0.1',PORT:'0',WEFTLINE_REVIEW_BOARD:'board',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED:'1',WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_READ:'1',WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_WRITE:'1',WEFTLINE_KNOWLEDGE_VERSIONED_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_VERSIONED_TABLE_ID:'versions',WEFTLINE_KNOWLEDGE_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_TABLE_ID:'legacy',WEFTLINE_KNOWLEDGE_TEAM_ID:'team',WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES:'1024',APPWRITE_KEY_FILE:api};
 child=spawn(process.execPath,['experimental/review-v1-cli.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});closed=new Promise(r=>child.once('close',r));let logs='';child.stderr.on('data',c=>logs+=c);
 port=await new Promise((ok,bad)=>{let output='';const timer=setTimeout(()=>bad(Error('listener startup timeout')),5000);child.once('close',()=>{clearTimeout(timer);bad(Error('listener startup failed'));});child.stdout.on('data',c=>{output+=c;const m=output.match(/listener 127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);ok(+m[1]);}});});
 const scope={endpoint,project,database:'db',table:'versions',boardId:'board',teamId:'team'};

 const journal=join(dir,'journal');mkdirSync(journal,{mode:0o700});
 const group=['--enable-knowledge-write','--knowledge-journal',journal,'--knowledge-write-endpoint',endpoint,'--knowledge-write-project',project,'--knowledge-write-database','db','--knowledge-write-table','versions','--knowledge-write-team','team'];
 const readGroup=['--enable-knowledge-read','--knowledge-endpoint',endpoint,'--knowledge-project',project,'--knowledge-database','db','--knowledge-table','versions','--knowledge-team','team'];
 async function connect(actor,flags,session=actor){const args=[resolve(root,'experimental/agent-mcp/server.js'),'--enable','--remote-https','--endpoint',origin,'--ca',cert,'--actor',actor,'--board','board','--guard','0',...flags];const transport=new StdioClientTransport({command:process.execPath,args,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:session},stderr:'pipe'});const client=new Client({name:'test',version:'1'});await client.connect(transport);clients.push({client,transport});return client;}
 let alice=await connect('alice',group);const bob=await connect('bob',readGroup);
 const call=async(c,name,args)=>JSON.parse((await c.callTool({name,arguments:args})).content[0].text);
 const beforeInvalid=(await provider.control('metrics')).requests.length;
 for(const bad of [{documentId:'newdoc',title:'x',html:'x',session:'bob'},{documentId:'newdoc',title:'x',html:'x',expectedActor:'bob'},{documentId:'newdoc',title:'x',html:'x',operationId:'a'.repeat(32)},{documentId:'newdoc',title:'x',html:'x'.repeat(1025)},{documentId:'bad!',title:'x',html:'x'}])assert.deepEqual(await call(alice,'knowledge_create',bad),{status:'invalid'});
 assert.equal((await provider.control('metrics')).requests.length,beforeInvalid);assert.equal(existsSync(join(journal,'state.json')),false);
 // Drop the actual stdio MCP result after the durable confirmation, then restart.
 const transport=clients.find(x=>x.client===alice).transport;const original=transport.onmessage;let dropping=true,dropped=false;transport.onmessage=message=>{if(dropping&&message.id!==undefined&&message.result){dropped=true;return;}original(message);};
 const lostCall=call(alice,'knowledge_create',{documentId:'lost-mcp',title:'Secret title',html:'<p>Secret body</p>'}).catch(()=>null);
 const until=Date.now()+10000;while(!dropped&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.equal(dropped,true);assert.equal(JSON.parse(readFileSync(join(journal,'state.json'),'utf8')).status,'reconciled');dropping=false;
 process.kill(transport.pid,'SIGKILL');await alice.close();await lostCall;const recovered=await connect('alice',group);const beforeRecovery=await provider.control('metrics');const count=beforeRecovery.transactions.length;
 assert.deepEqual(await call(recovered,'knowledge_create',{documentId:'blocked-mcp',title:'x',html:'x'}),{status:'blocked'});
 const confirmation=await call(recovered,'knowledge_reconcile',{});assert.equal(confirmation.status,'confirmed');assert.match(confirmation.operationId,/^[a-f0-9]{32}$/);assert.deepEqual(confirmation,{status:'confirmed',operationId:confirmation.operationId,operation:'create',documentId:'lost-mcp',generation:0});
 const lostIntent={operationId:confirmation.operationId,operation:'create',documentId:'lost-mcp',previousGeneration:-1,title:'Secret title',html:'<p>Secret body</p>'};
 for(const mismatch of [{operationId:'f'.repeat(32)},{operation:'edit',previousGeneration:0},{documentId:'wrong'},{previousGeneration:0},{title:'wrong'},{html:'wrong'}]){assert.deepEqual(await call(recovered,'knowledge_ack',{...lostIntent,...mismatch}),{status:'unknown'});assert.deepEqual(await call(recovered,'knowledge_create',{documentId:'still-blocked',title:'x',html:'x'}),{status:'blocked'});}
 assert.deepEqual(await call(recovered,'knowledge_ack',{operationId:confirmation.operationId}),{status:'invalid'});
 const afterRecovery=await provider.control('metrics');assert.equal(afterRecovery.transactions.length,count);assert.equal(afterRecovery.requests.length,beforeRecovery.requests.length);
 assert.deepEqual(await call(recovered,'knowledge_ack',{...lostIntent,operationId:'f'.repeat(32)}),{status:'unknown'});
 const ackTransport=clients.find(x=>x.client===recovered).transport;const ackOriginal=ackTransport.onmessage;let ackDropped=false;ackTransport.onmessage=message=>{if(message.id!==undefined&&message.result){ackDropped=true;return;}ackOriginal(message);};
 const lostAck=call(recovered,'knowledge_ack',lostIntent).catch(()=>null);const ackUntil=Date.now()+10000;while(!ackDropped&&Date.now()<ackUntil)await new Promise(r=>setTimeout(r,10));assert.equal(ackDropped,true);assert.equal(JSON.parse(readFileSync(join(journal,'state.json'),'utf8')).status,'acknowledged');process.kill(ackTransport.pid,'SIGKILL');await recovered.close();await lostAck;
 alice=await connect('alice',group);assert.deepEqual(await call(alice,'knowledge_ack',lostIntent),{status:'acknowledged'});
 const created=await call(alice,'knowledge_create',{documentId:'newdoc',title:'New title',html:'<p>Initial</p>'});assert.deepEqual(created,{status:'confirmed',operationId:created.operationId,operation:'create',documentId:'newdoc',generation:0});assert.match(created.operationId,/^[a-f0-9]{32}$/);assert.deepEqual(await call(alice,'knowledge_ack',lostIntent),{status:'unknown'});assert.deepEqual(await call(alice,'knowledge_ack',{operationId:created.operationId,operation:'create',documentId:'newdoc',previousGeneration:-1,title:'New title',html:'<p>Initial</p>'}),{status:'acknowledged'});
 const read=await call(bob,'knowledge_read_version',{documentId:'newdoc',generation:0});assert.equal(read.status,'advisory');assert.equal(read.version.html,'<p>Initial</p>');
 assert.equal((await provider.control('metrics')).commits,2);
 const edit=await call(alice,'knowledge_edit',{documentId:'newdoc',previousGeneration:0,title:'New title',html:'<p>Edited</p>'});assert.deepEqual(edit,{status:'confirmed',operationId:edit.operationId,operation:'edit',documentId:'newdoc',generation:1});assert.deepEqual(await call(alice,'knowledge_ack',{operationId:edit.operationId,operation:'edit',documentId:'newdoc',previousGeneration:0,title:'New title',html:'<p>Edited</p>'}),{status:'acknowledged'});
 const edited=await call(bob,'knowledge_read_version',{documentId:'newdoc',generation:1});assert.equal(edited.status,'advisory');assert.equal(edited.version.html,'<p>Edited</p>');
 assert.equal((await provider.control('metrics')).commits,3);
 const transactionsBefore=(await provider.control('metrics')).transactions.length;
 await provider.control('lose-next-commit');
 assert.deepEqual(await call(alice,'knowledge_create',{documentId:'lost',title:'Private title',html:'<p>Private</p>'}),{status:'unknown'});
 assert.equal((await provider.control('metrics')).commits,4);
 await alice.close();const reopened=await connect('alice',group);
 assert.deepEqual(await call(reopened,'knowledge_create',{documentId:'blocked',title:'Blocked',html:'body'}),{status:'blocked'});assert.deepEqual(await call(reopened,'knowledge_ack',{operationId:edit.operationId,operation:'edit',documentId:'newdoc',previousGeneration:0,title:'New title',html:'<p>Edited</p>'}),{status:'unknown'});assert.deepEqual(await call(reopened,'knowledge_create',{documentId:'blocked-again',title:'Blocked',html:'body'}),{status:'blocked'});
 const receipt=await call(reopened,'knowledge_reconcile',{});assert.deepEqual(receipt,{status:'confirmed',operationId:receipt.operationId,operation:'create',documentId:'lost',generation:0});assert.match(receipt.operationId,/^[a-f0-9]{32}$/);assert.deepEqual(await call(reopened,'knowledge_ack',{operationId:receipt.operationId,operation:'create',documentId:'lost',previousGeneration:-1,title:'Private title',html:'<p>Private</p>'}),{status:'acknowledged'});
 assert.equal((await provider.control('metrics')).commits,4);
 assert.equal((await provider.control('metrics')).transactions.length,transactionsBefore+1);
 for(const variant of ['actor','scope']){
  const d=join(dir,variant);mkdirSync(d,{mode:0o700});const flags=[...group];flags[2]=d;if(variant==='scope')flags[10]='wrong';
  const c=await connect('alice',flags,variant==='actor'?'bob':'alice');
  assert.deepEqual(await call(c,'knowledge_create',{documentId:variant,title:'No',html:'No'}),{status:'unknown'});
  assert.equal((await provider.control('metrics')).commits,4);
 }
 // A separately configured second actor also writes, not merely reads Alice's work.
 const bobJournal=join(dir,'bob-journal');mkdirSync(bobJournal,{mode:0o700});const bobFlags=[...group];bobFlags[2]=bobJournal;const bobWriter=await connect('bob',bobFlags);
 const bobEdit=await call(bobWriter,'knowledge_edit',{documentId:'newdoc',previousGeneration:1,title:'Bob title',html:'<p>Bob edit</p>'});
 assert.deepEqual(bobEdit,{status:'confirmed',operationId:bobEdit.operationId,operation:'edit',documentId:'newdoc',generation:2});
 const bobIntent={operationId:bobEdit.operationId,operation:'edit',documentId:'newdoc',previousGeneration:1,title:'Bob title',html:'<p>Bob edit</p>'};
 for(const mismatch of [{previousGeneration:0},{operation:'create',previousGeneration:-1},{title:'wrong'},{html:'wrong'},{documentId:'other'},{operationId:'e'.repeat(32)}]){assert.deepEqual(await call(bobWriter,'knowledge_ack',{...bobIntent,...mismatch}),{status:'unknown'});assert.deepEqual(await call(bobWriter,'knowledge_create',{documentId:'blocked-bob',title:'x',html:'x'}),{status:'blocked'});}
 assert.deepEqual(await call(bobWriter,'knowledge_ack',bobIntent),{status:'acknowledged'});
 const bobCreate=await call(bobWriter,'knowledge_create',{documentId:'bob-doc',title:'Bob create',html:'<p>Bob content</p>'});assert.deepEqual(bobCreate,{status:'confirmed',operationId:bobCreate.operationId,operation:'create',documentId:'bob-doc',generation:0});
 assert.deepEqual(await call(bobWriter,'knowledge_ack',{operationId:bobCreate.operationId,operation:'create',documentId:'bob-doc',previousGeneration:-1,title:'Bob create',html:'<p>Bob content</p>'}),{status:'acknowledged'});
 const bobVersion=await call(bob,'knowledge_read_version',{documentId:'newdoc',generation:2});assert.equal(bobVersion.version.html,'<p>Bob edit</p>');
 assert(!logs.includes('Secret title'));assert(!logs.includes('Secret body'));assert(!logs.includes('Bob content'));
});
