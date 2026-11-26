// Synthetic provider stores only. The actual CLI listener, TLS and MCP stdio are exercised.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import https from 'node:https';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startVersionedProvider} from '../../../test/fixtures/knowledge-versioned-http-provider.js';
import {rowId} from '../../knowledge-versioned-schema.js';

const root = resolve(import.meta.dirname, '../../..');

for(const order of ['knowledge-first','writes-first']) test(`combined stdio processes hand off a task and read the same knowledge version (${order})`, {timeout: 40000}, async t => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'wf-combined-'));
  const key = join(dir, 'key'), cert = join(dir, 'cert'), api = join(dir, 'api');
  const clients = []; const sessionSentinel='synthetic-session-secret-42'; let child, childClosed, provider, logs='';
  t.after(async () => {
    for (const {client, closed} of clients) { await client.close(); await closed; }
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (childClosed) await childClosed;
    if (provider) await provider.close();
    rmSync(dir, {recursive:true, force:true});
    for(const entry of clients) for(const secret of ['synthetic-key',sessionSentinel,'__Host-weftline=alice']) {assert(!entry.stderr().includes(secret));assert(!entry.stdout().includes(secret));}
    assert(!logs.includes('synthetic-key')&&!logs.includes(sessionSentinel));
  });
  const assertLoopback=port=>{
    const listeners=execFileSync('ss',['-ltnH',`sport = :${port}`],{encoding:'utf8'}).trim().split('\n');
    assert.equal(listeners.length,1);
    assert.equal(listeners[0].trim().split(/\s+/)[3],`127.0.0.1:${port}`);
  };
  provider = await startVersionedProvider();
  assertLoopback(provider.port);
  const version = {kind:'knowledge-version-v1',boardId:'b',documentId:'doc',generation:0,creator:'alice',editor:'alice',title:'Synthetic',html:'<p>Shared &amp; exact</p>'};
  await provider.control('seed', [{$id:rowId('b','doc',0),payload:JSON.stringify(version),$permissions:[]}]);
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  const endpoint='https://provider.example.test/v1', project='synthetic-project';
  writeFileSync(api, `apikey:synthetic\nprojectID:${project}\nendpoint:${endpoint}\n`);
  const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./test/fixtures/combined-workflow-provider.js',VERSIONED_FIXTURE_PORT:String(provider.port),WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_AGENT_SCOPED_WRITES:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_HOST:'127.0.0.1',WEFTLINE_REVIEW_PORT:'0',WEFTLINE_REVIEW_BOARD:'b',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_TLS_KEY_FILE:key,WEFTLINE_TLS_CERT_FILE:cert,APPWRITE_KEY_FILE:api,REVIEW_TEST_WRITES_FILE:join(dir,'writes'),REVIEW_TEST_SNAPSHOT_FILE:join(dir,'snapshot'),WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED:'1',WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_READ:'1',WEFTLINE_KNOWLEDGE_VERSIONED_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_VERSIONED_TABLE_ID:'versions',WEFTLINE_KNOWLEDGE_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_TABLE_ID:'legacy',WEFTLINE_KNOWLEDGE_TEAM_ID:'team',WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES:'1024'};
  child=spawn(process.execPath,['experimental/review-v1-cli.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  childClosed=new Promise(r=>child.once('close',r)); child.stderr.on('data',c=>logs+=c);
  const port=await new Promise((ok,bad)=>{let out='';const timer=setTimeout(()=>bad(Error('listener startup timeout')),5000);child.once('close',()=>{clearTimeout(timer);bad(Error('listener closed'));});child.stdout.on('data',c=>{out+=c;const m=out.match(/listener 127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);ok(Number(m[1]));}});});
  assertLoopback(port);
  const origin=`https://127.0.0.1:${port}`;
  const genesis=await new Promise((ok,bad)=>{const req=https.request({host:'127.0.0.1',port,path:'/review/genesis',method:'POST',ca:readFileSync(cert),headers:{host:`127.0.0.1:${port}`,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:'__Host-weftline=alice'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>ok({status:res.statusCode,body}));});req.on('error',bad);req.end(JSON.stringify({board:'b',expectedActor:'alice',guardGeneration:0,operation:'create',task:'task',taskGeneration:0,action:'genesis'}));});
  // The existing board fixture deliberately loses the first commit response.
  assert.equal(genesis.status,202);
  assert(Object.values(JSON.parse(readFileSync(join(dir,'snapshot'),'utf8'))).some(r=>r.kind==='review-task-v1'&&r.task==='task'&&r.generation===0));
  async function connect(actor,session,write=false,knowledgeTable='versions',boardTable='review'){
    const args=[resolve(root,'experimental/agent-mcp/server.js'),'--enable','--remote-https','--endpoint',origin,'--ca',cert,'--actor',actor,'--board','b','--guard','1'];
    const knowledge=['--enable-knowledge-read','--knowledge-endpoint',endpoint,'--knowledge-project',project,'--knowledge-database','db','--knowledge-table',knowledgeTable,'--knowledge-team','team'];
    let writes=[];if(write){const journal=join(dir,`journal-${clients.length}`);mkdirSync(journal,{mode:0o700});writes=['--enable-writes','--journal',journal,'--backend-endpoint',endpoint,'--backend-project',project,'--backend-database','db','--backend-table',boardTable];}
    args.push(...(order==='knowledge-first'?[...knowledge,...writes]:[...writes,...knowledge]));
    const transport=new StdioClientTransport({command:process.execPath,args,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:session},stderr:'pipe'});
    let stderr='',stdout='';transport.stderr.on('data',c=>stderr+=c);const client=new Client({name:`synthetic-${actor}`,version:'1'});await client.connect(transport);
    transport._process.stdout.on('data',c=>stdout+=c);const closed=new Promise(r=>transport._process.once('close',r));clients.push({client,closed,stderr:()=>stderr,stdout:()=>stdout});return client;
  }
  const alice=await connect('alice','alice',true), bob=await connect('bob','bob',true), mismatch=await connect('alice','bob',true);
  assert.deepEqual((await alice.listTools()).tools.map(x=>x.name),['discover','resolve','knowledge_read_version','claim','submit','approve','reject','reconcile']);
  const call=async(client,name,args)=>{const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true);return JSON.parse(result.content[0].text);};
  const read=client=>call(client,'knowledge_read_version',{documentId:'doc',generation:0});
  assert.deepEqual(await read(alice),{status:'advisory',version});
  assert.deepEqual(await read(bob),{status:'advisory',version});
  const versionReads=async()=>(await provider.control('metrics')).requests.filter(r=>r.path.includes('/tablesdb/db/tables/versions/rows/')).length;
  const beforeDenied=await versionReads();
  assert.equal((await read(mismatch)).status,'denied');
  assert.equal(await versionReads(),beforeDenied);
  const invalidSession=await connect('alice',sessionSentinel);
  assert.equal((await read(invalidSession)).status,'denied');
  assert.equal(await versionReads(),beforeDenied);
  const wrongKnowledge=await connect('alice','alice',true,'review','review');
  assert.equal((await read(wrongKnowledge)).status,'unknown');
  assert.equal(await versionReads(),beforeDenied);
  const wrongBoard=await connect('alice','alice',true,'versions','versions');
  const before=readFileSync(join(dir,'snapshot'),'utf8');
  assert.notEqual((await call(wrongBoard,'claim',{operation:'wrongscope',task:'task',guardGeneration:1,taskGeneration:0})).status,'recorded');
  assert.equal(readFileSync(join(dir,'snapshot'),'utf8'),before);
  assert.notEqual((await call(mismatch,'claim',{operation:'badclaim',task:'task',guardGeneration:1,taskGeneration:0})).status,'recorded');
  assert.equal(readFileSync(join(dir,'snapshot'),'utf8'),before);
  const claim=await call(alice,'claim',{operation:'claim1',task:'task',guardGeneration:1,taskGeneration:0});
  assert.deepEqual(claim,{status:'recorded',receipt:{kind:'review-receipt-v1',user:'alice',expectedActor:'alice',board:'b',task:'task',operation:'claim1',guardGeneration:1,taskGeneration:0,action:'claim'}});
  const submit=await call(alice,'submit',{operation:'submit1',task:'task',guardGeneration:2,taskGeneration:1});
  assert.deepEqual(submit,{status:'recorded',receipt:{kind:'review-receipt-v1',user:'alice',expectedActor:'alice',board:'b',task:'task',operation:'submit1',guardGeneration:2,taskGeneration:1,action:'submit'}});
  assert.deepEqual(await read(alice),{status:'advisory',version});
  const approval=await call(bob,'approve',{operation:'review1',task:'task',guardGeneration:0,taskGeneration:2});
  assert.deepEqual(approval,{status:'recorded',receipt:{kind:'review-receipt-v1',user:'bob',expectedActor:'bob',board:'b',task:'task',operation:'review1',guardGeneration:0,taskGeneration:2,action:'approve'}});
  assert.deepEqual(await read(bob),{status:'advisory',version});
  const rows=Object.values(JSON.parse(readFileSync(join(dir,'snapshot'),'utf8')));
  assert(rows.some(r=>r.kind==='review-task-v1'&&r.task==='task'&&r.generation===2&&r.state==='review'));
  assert(rows.some(r=>r.kind==='review-task-v1'&&r.task==='task'&&r.generation===3&&r.state==='completed'));
  const metrics=await provider.control('metrics');
  assert(metrics.requests.some(r=>r.path.includes('/tablesdb/db/tables/versions/rows/')));
});
