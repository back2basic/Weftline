// Local synthetic provider, TLS ingress, real proxy listener and stdio MCP client.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startVersionedProvider} from '../../../test/fixtures/knowledge-versioned-http-provider.js';
import {rowId} from '../../knowledge-versioned-schema.js';
const root=resolve(import.meta.dirname,'../../..');

test('opt-in exact knowledge reads cross stdio and scoped TLS receiver', {timeout:40000}, async t=>{
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
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./test/fixtures/knowledge-versioned-cli-proxy.js',VERSIONED_FIXTURE_PORT:String(provider.port),WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_PROXY:'1',WEFTLINE_PROXY_SECRET:secret,WEFTLINE_PUBLIC_ORIGIN:origin,WEFTLINE_REVIEW_HOST:'127.0.0.1',PORT:'0',WEFTLINE_REVIEW_BOARD:'board',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED:'1',WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_READ:'1',WEFTLINE_KNOWLEDGE_VERSIONED_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_VERSIONED_TABLE_ID:'versions',WEFTLINE_KNOWLEDGE_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_TABLE_ID:'legacy',WEFTLINE_KNOWLEDGE_TEAM_ID:'team',WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES:'1024',APPWRITE_KEY_FILE:api};
 child=spawn(process.execPath,['experimental/review-v1-cli.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});closed=new Promise(r=>child.once('close',r));let logs='';child.stderr.on('data',c=>logs+=c);
 port=await new Promise((ok,bad)=>{let output='';const timer=setTimeout(()=>bad(Error('listener startup timeout')),5000);child.once('close',()=>{clearTimeout(timer);bad(Error('listener startup failed'));});child.stdout.on('data',c=>{output+=c;const m=output.match(/listener 127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);ok(+m[1]);}});});
 const scope={endpoint,project,database:'db',table:'versions',boardId:'board',teamId:'team'};
 const journal=join(dir,'journal');mkdirSync(journal,{mode:0o700});
 const baseArgs=[resolve(root,'experimental/agent-mcp/server.js'),'--enable','--remote-https','--endpoint',origin,'--ca',cert,'--actor','alice','--board','board','--guard','0'];
 const knowledgeArgs=['--enable-knowledge-read','--knowledge-endpoint',endpoint,'--knowledge-project',project,'--knowledge-database','db','--knowledge-table','versions','--knowledge-team','team'];
 const writeArgs=['--enable-writes','--journal',journal,'--backend-endpoint',endpoint,'--backend-project',project,'--backend-database','db','--backend-table','review'];
 async function connect({enabled=true,write=false,reverse=false,actor='alice',session='alice',scopeOverride={},board='board',url=origin,ca=cert}={}){
  const s={...scope,...scopeOverride};const args=[resolve(root,'experimental/agent-mcp/server.js'),'--enable','--remote-https','--endpoint',url,'--ca',ca,'--actor',actor,'--board',board,'--guard','0'];
  const knowledgeGroup=['--enable-knowledge-read','--knowledge-endpoint',s.endpoint,'--knowledge-project',s.project,'--knowledge-database',s.database,'--knowledge-table',s.table,'--knowledge-team',s.teamId];
  if(reverse&&write)args.push(...writeArgs);if(enabled)args.push(...knowledgeGroup);if(!reverse&&write)args.push(...writeArgs);
  const transport=new StdioClientTransport({command:process.execPath,args,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--dns-result-order=ipv4first',WEFTLINE_AGENT_SESSION:session},stderr:'pipe'});let stderr='',stdout='';transport.stderr.on('data',c=>stderr+=c);const client=new Client({name:'knowledge-test',version:'1'});await client.connect(transport);transport._process.stdout.on('data',c=>stdout+=c);clients.push({client,stderr:()=>stderr,stdout:()=>stdout});return client;
 }
 const call=async(c,args={documentId:'doc',generation:0})=>c.callTool({name:'knowledge_read_version',arguments:args});
 const disabled=await connect({enabled:false});assert.deepEqual((await disabled.listTools()).tools.map(x=>x.name),['discover','resolve']);
 const writeOnly=await connect({enabled:false,write:true});assert.deepEqual((await writeOnly.listTools()).tools.map(x=>x.name),['discover','resolve','claim','submit','approve','reject','reconcile']);
 const writeBefore=requests;assert.equal(JSON.parse((await writeOnly.callTool({name:'claim',arguments:{operation:'bad!',task:'task',guardGeneration:0,taskGeneration:0}})).content[0].text).status,'invalid');assert.equal(requests,writeBefore);
 for(const reverse of [false,true]){
  const combined=await connect({write:true,reverse});assert.deepEqual((await combined.listTools()).tools.map(x=>x.name),['discover','resolve','knowledge_read_version','claim','submit','approve','reject','reconcile']);
  assert.deepEqual(JSON.parse((await call(combined)).content[0].text),{status:'advisory',version});
  const beforeCall=requests;const invalid=await combined.callTool({name:'claim',arguments:{operation:'op',task:'task',guardGeneration:0,taskGeneration:0,session:'bob',expectedActor:'bob',board:'wrong'}});assert.equal(JSON.parse(invalid.content[0].text).status,'invalid');assert.equal(requests,beforeCall);
  for(const args of [{documentId:'doc',generation:0,expectedActor:'bob'},{documentId:'doc',generation:0,guardGeneration:999999},{documentId:'doc',generation:0,session:'bob'}]){const r=await call(combined,args);assert.equal(JSON.parse(r.content[0].text).status,'invalid');}assert.equal(requests,beforeCall);
 }
 const mismatchCombined=await connect({write:true,scopeOverride:{table:'wrong'}});assert.equal(JSON.parse((await call(mismatchCombined)).content[0].text).status,'unknown');
 const otherCombined=await connect({write:true,actor:'alice',session:'bob'});assert.equal(JSON.parse((await call(otherCombined)).content[0].text).status,'denied');
 const childEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'};
 for(const flags of [[...knowledgeArgs,...knowledgeArgs],[...writeArgs,...writeArgs],[...knowledgeArgs,...writeArgs,...knowledgeArgs],[...writeArgs,...knowledgeArgs,...writeArgs],knowledgeArgs.slice(0,-2),writeArgs.slice(0,-2),[...knowledgeArgs.slice(0,5),'--knowledge-project','duplicate',...knowledgeArgs.slice(7)]]){
  const r=spawnSync(process.execPath,[...baseArgs,...flags],{env:childEnv,encoding:'utf8',timeout:4000});assert.equal(r.status,1);assert.equal(r.stdout,'');
 }
 const alice=await connect();assert.deepEqual((await alice.listTools()).tools.map(x=>x.name),['discover','resolve','knowledge_read_version']);
 for(const c of [alice,await connect({actor:'bob',session:'bob'})]){const r=await call(c);assert.equal(r.isError,undefined);assert(!JSON.stringify(r).includes(secret));assert(!JSON.stringify(r).includes('synthetic-key'));assert.deepEqual(JSON.parse(r.content[0].text),{status:'advisory',version});}
 for(const documentId of ['oversize','missing'])assert.equal(JSON.parse((await call(alice,{documentId,generation:0})).content[0].text).status,'unknown');
 const privateReads=async()=>(await provider.control('metrics')).requests.filter(r=>r.path.includes('/tablesdb/')).length;
 const before=await privateReads();
 for(const options of [{actor:'outsider',session:'outsider'},{actor:'alice',session:'bob'}]){
  const result=await call(await connect(options));assert.equal(JSON.parse(result.content[0].text).status,'denied');
 }
 for(const options of [{board:'wrong'},...Object.keys(scope).filter(k=>k!=='boardId').map(k=>({scopeOverride:{[k]:k==='endpoint'?'https://other.example.test/v1':'wrong'}}))]){
  const result=await call(await connect(options));assert.equal(JSON.parse(result.content[0].text).status,'unknown');
 }
 assert.equal(await privateReads(),before);
 const injected=await call(alice,{documentId:'doc',generation:0,session:'bob'});assert(injected.isError||JSON.parse(injected.content[0].text).status!=='advisory');assert.equal(await privateReads(),before);
 for(const opts of [{ca:badcert},{url:origin.replace('127.0.0.1','localhost')}]){const c=await connect(opts),n=requests,open=connections;await call(c);assert.equal(connections,open+1);assert.equal(requests,n);}
 redirect=true;const n=requests;await call(alice);assert.equal(requests,n+1);redirect=false;
 const sessionSentinel='synthetic-session-secret-42';const invalidSession=await connect({session:sessionSentinel});assert.equal(JSON.parse((await call(invalidSession)).content[0].text).status,'denied');
 for(const {stderr,stdout} of clients){for(const value of [secret,'synthetic-key',sessionSentinel]){assert(!stderr().includes(value));assert(!stdout().includes(value));}}assert(!logs.includes(secret)&&!logs.includes('synthetic-key'));
});
