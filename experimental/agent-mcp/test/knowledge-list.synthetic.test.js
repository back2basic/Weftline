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

test('knowledge discovery crosses stdio and TLS between actors', {timeout:40000}, async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'wf-knowledge-mcp-'));const clients=[];let child,closed,ingress,port;
 const provider=await startVersionedProvider();
 t.after(async()=>{for(const {client} of clients)await client.close();if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await closed;}if(ingress?.listening){ingress.closeAllConnections();await new Promise(r=>ingress.close(r));}await provider.close();rmSync(dir,{recursive:true,force:true});});
 const key=join(dir,'key'),cert=join(dir,'cert'),badkey=join(dir,'badkey'),badcert=join(dir,'badcert'),api=join(dir,'api');
 for(const [k,c] of [[key,cert],[badkey,badcert]])execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',k,'-out',c,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const endpoint='https://provider.example.test/v1',project='synthetic-project',secret=randomBytes(32).toString('hex');
 writeFileSync(api,`apikey:synthetic-key\nprojectID:${project}\nendpoint:${endpoint}\n`);
 const version={kind:'knowledge-version-v1',boardId:'board',documentId:'doc',generation:0,creator:'alice',editor:'alice',title:'Title',html:'<p>Shared &amp; exact</p>'};
 await provider.control('seed',[{$id:rowId('board','doc',0),payload:JSON.stringify(version),$permissions:[]}]);
 await provider.control('seed',Array.from({length:30},(_,i)=>{const documentId='seed'+i;return {$id:rowId('board',documentId,0),payload:JSON.stringify({...version,documentId}),$permissions:[]};}));
 let redirect=false,requests=0,connections=0;ingress=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{requests++;if(redirect){res.writeHead(302,{location:'/stolen'});return res.end();}const upstream=http.request({host:'127.0.0.1',port,path:req.url,method:req.method,headers:{...req.headers,'x-weftline-proxy-secret':secret}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>res.destroy());req.pipe(upstream);});
 ingress.on('connection',()=>connections++);await new Promise(r=>ingress.listen(0,'127.0.0.1',r));assert.equal(ingress.address().address,'127.0.0.1');const origin=`https://127.0.0.1:${ingress.address().port}`;
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./test/fixtures/knowledge-versioned-cli-proxy.js',VERSIONED_FIXTURE_PORT:String(provider.port),WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_PROXY:'1',WEFTLINE_PROXY_SECRET:secret,WEFTLINE_PUBLIC_ORIGIN:origin,WEFTLINE_REVIEW_HOST:'127.0.0.1',PORT:'0',WEFTLINE_REVIEW_BOARD:'board',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED:'1',WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_READ:'1',WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_LIST:'1',WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_WRITE:'1',WEFTLINE_KNOWLEDGE_VERSIONED_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_VERSIONED_TABLE_ID:'versions',WEFTLINE_KNOWLEDGE_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_TABLE_ID:'legacy',WEFTLINE_KNOWLEDGE_TEAM_ID:'team',WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES:'1024',APPWRITE_KEY_FILE:api};
 child=spawn(process.execPath,['experimental/review-v1-cli.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});closed=new Promise(r=>child.once('close',r));let logs='';child.stderr.on('data',c=>logs+=c);
 port=await new Promise((ok,bad)=>{let output='';const timer=setTimeout(()=>bad(Error('listener startup timeout')),5000);child.once('close',()=>{clearTimeout(timer);bad(Error('listener startup failed'));});child.stdout.on('data',c=>{output+=c;const m=output.match(/listener 127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);ok(+m[1]);}});});
 const scope={endpoint,project,database:'db',table:'versions',boardId:'board',teamId:'team'};

 const journal=join(dir,'journal');mkdirSync(journal,{mode:0o700});
 const group=['--enable-knowledge-write','--knowledge-journal',journal,'--knowledge-write-endpoint',endpoint,'--knowledge-write-project',project,'--knowledge-write-database','db','--knowledge-write-table','versions','--knowledge-write-team','team'];
 const readGroup=['--enable-knowledge-read','--knowledge-endpoint',endpoint,'--knowledge-project',project,'--knowledge-database','db','--knowledge-table','versions','--knowledge-team','team'];
 async function connect(actor,flags,session=actor){const args=[resolve(root,'experimental/agent-mcp/server.js'),'--enable','--remote-https','--endpoint',origin,'--ca',cert,'--actor',actor,'--board','board','--guard','0',...flags];const transport=new StdioClientTransport({command:process.execPath,args,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:session},stderr:'pipe'});const client=new Client({name:'test',version:'1'});await client.connect(transport);clients.push({client,transport});return client;}
 const listGroup=['--enable-knowledge-list','--knowledge-list-endpoint',endpoint,'--knowledge-list-project',project,'--knowledge-list-database','db','--knowledge-list-table','versions','--knowledge-list-team','team'];
 const alice=await connect('alice',group);const bob=await connect('bob',[...readGroup,...listGroup]);
 const call=async(c,name,args)=>JSON.parse((await c.callTool({name,arguments:args})).content[0].text);
 const created=await call(alice,'knowledge_create',{documentId:'newdoc',title:'New title',html:'<p>Initial</p>'});assert.equal(created.status,'confirmed');
 assert.deepEqual(await call(alice,'knowledge_ack',{operationId:created.operationId,operation:'create',documentId:'newdoc',previousGeneration:-1,title:'New title',html:'<p>Initial</p>'}),{status:'acknowledged'});
 const page=await call(bob,'knowledge_list',{});assert.equal(page.status,'partial');assert.equal(page.consistency,'advisory-non-snapshot');assert(page.documents.length<=25);assert.equal(page.continuation.length,720);
 const other=await connect('alice',listGroup);assert.deepEqual(await call(other,'knowledge_list',{continuation:page.continuation}),{status:'invalid'});
 const altered=(page.continuation[0]==='A'?'B':'A')+page.continuation.slice(1);assert.deepEqual(await call(bob,'knowledge_list',{continuation:altered}),{status:'invalid'});
 const outsider=await connect('outsider',listGroup);assert.deepEqual(await call(outsider,'knowledge_list',{continuation:page.continuation}),{status:'denied'});
 assert.deepEqual(await call(outsider,'knowledge_list',{continuation:'bad'}),{status:'denied'});
 const next=await call(bob,'knowledge_list',{continuation:page.continuation});assert.equal(next.status,'partial');assert([...page.documents,...next.documents].some(x=>x.id==='newdoc'&&x.title==='New title'));
 const post=async(session,body)=>new Promise((ok,bad)=>{const req=https.request(origin+'/knowledge/versioned/scoped-list',{method:'POST',ca:readFileSync(cert),headers:{host:new URL(origin).host,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:`__Host-weftline=${session}`}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>ok({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',bad);req.end(JSON.stringify(body));});
 const scanCount=async()=>(await provider.control('metrics')).requests.filter(r=>r.path.includes('/tablesdb/')).length;
 for(const key of Object.keys(scope)){const before=await scanCount();assert.deepEqual(await post('bob',{scope:{...scope,[key]:'wrong'},intent:{expectedActor:'bob'}}),{status:202,body:{status:'unknown'}});assert.equal(await scanCount(),before);}
 for(const session of ['outsider','bad']){const before=await scanCount();const responses=[];for(const value of [page.continuation,altered,'bad'])responses.push(await post(session,{scope:{...scope,table:'wrong'},intent:{expectedActor:session,continuation:value}}));assert.deepEqual(responses,[{status:403,body:{status:'denied'}},{status:403,body:{status:'denied'}},{status:403,body:{status:'denied'}}]);assert.equal(await scanCount(),before);}
 for(const index of [2,4,6,8,10]){const wrong=[...listGroup];wrong[index]=index===2?'https://other.example.test/v1':'wrong';const c=await connect('bob',wrong);const before=(await provider.control('metrics')).requests.filter(r=>r.path.includes('/tablesdb/')).length;assert.deepEqual(await call(c,'knowledge_list',{}),{status:'unknown'});assert.equal((await provider.control('metrics')).requests.filter(r=>r.path.includes('/tablesdb/')).length,before);}
 assert(!(await alice.listTools()).tools.some(x=>x.name==='knowledge_list'));
 const read=await call(bob,'knowledge_read_version',{documentId:'newdoc',generation:0});assert.equal(read.version.html,'<p>Initial</p>');
});
