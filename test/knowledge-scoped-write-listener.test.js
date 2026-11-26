import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import http from 'node:http';
import {startVersionedProvider} from './fixtures/knowledge-versioned-scoped-provider.js';

const endpoint='https://provider.example.test/v1',project='synthetic-project',origin='https://app.example.test',secret='a'.repeat(64);
const scope={endpoint,project,database:'db',table:'versions',boardId:'board',teamId:'team'};
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;const closed=new Promise(r=>child.once('close',r));child.kill('SIGKILL');await closed;}
async function start(env){const child=spawn(process.execPath,['src/server.js'],{env,stdio:['ignore','pipe','pipe','ipc']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(output)),5000);child.once('exit',()=>{clearTimeout(timer);reject(Error(output));});child.stdout.on('data',()=>{const m=output.match(/listener .*:(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});});return {child,port};}
function send(port,path,body,actor='bob'){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path,method:'POST',headers:{host:'app.example.test','x-weftline-proxy-secret':secret,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:`__Host-weftline=${actor}`}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({code:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end(JSON.stringify(body));});}
test('scoped write opt-in reaches real listener and fences legacy versioned mutations', {timeout:30000},async t=>{
 const provider=await startVersionedProvider();t.after(()=>provider.close());
 const dir=mkdtempSync(join(process.env.TMPDIR,'scoped-write-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const api=join(dir,'api');writeFileSync(api,`apikey: synthetic-key\nprojectID: ${project}\nendpoint: ${endpoint}\n`);
 const env={PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:`--import ${new URL('./fixtures/knowledge-versioned-scoped-cli-proxy.js',import.meta.url).pathname}`,VERSIONED_FIXTURE_PORT:String(provider.port),WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_PROXY:'1',WEFTLINE_PROXY_SECRET:secret,WEFTLINE_PUBLIC_ORIGIN:origin,WEFTLINE_REVIEW_HOST:'127.0.0.1',PORT:'0',WEFTLINE_REVIEW_BOARD:'board',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED:'1',WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_READ:'1',WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_WRITE:'1',WEFTLINE_KNOWLEDGE_VERSIONED_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_VERSIONED_TABLE_ID:'versions',WEFTLINE_KNOWLEDGE_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_TABLE_ID:'legacy',WEFTLINE_KNOWLEDGE_TEAM_ID:'team',WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES:'1024',APPWRITE_KEY_FILE:api};
 for(const change of [{WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_WRITE:'0'},{WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED:undefined}]){const r=spawnSync(process.execPath,['experimental/review-v1-cli.js'],{env:{...env,...change,APPWRITE_KEY_FILE:'/missing/must-not-read'},timeout:3000});assert.notEqual(r.status,0);assert.match(r.stderr.toString(),/Disabled or invalid configuration/);}
 const {child,port}=await start(env);t.after(()=>stop(child));
 const create={expectedActor:'bob',documentId:'doc',operationId:'a'.repeat(32),title:'Title',html:'First'};
 const edit={...create,operationId:'b'.repeat(32),previousGeneration:0,html:'Second'};
 for(const [name,intent] of [['create',create],['edit',edit],['reconcile',{...create,previousGeneration:-1}]]){
  const before=(await provider.control('metrics')).requests.length;
  assert.equal((await send(port,`/knowledge/versioned/${name}`,intent)).code,404);
  assert.equal((await provider.control('metrics')).requests.length,before);
  for(const key of Object.keys(scope)){
   const n=(await provider.control('metrics')).requests.length;
   assert.deepEqual((await send(port,`/knowledge/versioned/scoped-${name}`,{scope:{...scope,[key]:'wrong'},intent})).body,{status:'unknown'});
   assert.deepEqual((await provider.control('metrics')).requests.slice(n).map(x=>x.path),['/v1/account','/v1/teams/team/memberships']);
  }
  for(const bad of [scope,{...scope,table:'wrong'},null]){
   const n=(await provider.control('metrics')).requests.length;
   assert.deepEqual((await send(port,`/knowledge/versioned/scoped-${name}`,{scope:bad,intent:{...intent,expectedActor:'outsider'}},'outsider')).body,{status:'denied'});
   assert.deepEqual((await provider.control('metrics')).requests.slice(n).map(x=>x.path),['/v1/account','/v1/teams/team/memberships']);
  }
  for(const body of [{scope,intent,extra:1},{scope,intent:{...intent,extra:1}},{intent}]){const n=(await provider.control('metrics')).requests.length;assert.equal((await send(port,`/knowledge/versioned/scoped-${name}`,body)).code,400);assert.equal((await provider.control('metrics')).requests.length,n);}
 }
 await provider.control('lose-next-commit');
 assert.deepEqual((await send(port,'/knowledge/versioned/scoped-create',{scope,intent:create})).body,{status:'unknown'});
 assert.deepEqual((await send(port,'/knowledge/versioned/scoped-reconcile',{scope,intent:{...create,previousGeneration:-1}})).body,{status:'confirmed'});
 assert.deepEqual((await send(port,'/knowledge/versioned/scoped-edit',{scope,intent:edit})).body,{status:'confirmed'});
 assert.deepEqual((await send(port,'/knowledge/versioned/scoped-reconcile',{scope,intent:edit})).body,{status:'confirmed'});
 assert.equal((await provider.control('metrics')).commits,2);
 const {WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_READ:unusedRead,...writeOnlyEnv}=env;
 const writeOnly=await start(writeOnlyEnv);t.after(()=>stop(writeOnly.child));
 const independent={...create,documentId:'independent',operationId:'e'.repeat(32)};
 assert.equal((await send(writeOnly.port,'/knowledge/versioned/scoped-read',{scope,intent:{expectedActor:'bob',documentId:'independent',generation:0}})).code,404);
 assert.deepEqual((await send(writeOnly.port,'/knowledge/versioned/scoped-create',{scope,intent:independent})).body,{status:'confirmed'});
 const {WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_READ:unused,WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_WRITE:unused2,...legacyEnv}=env;
 const legacy=await start(legacyEnv);t.after(()=>stop(legacy.child));
 assert.equal((await send(legacy.port,'/knowledge/versioned/scoped-create',{scope,intent:create})).code,404);
 const legacyCreate={...create,documentId:'legacydoc',operationId:'c'.repeat(32)};
 assert.deepEqual((await send(legacy.port,'/knowledge/versioned/create',legacyCreate)).body,{status:'confirmed'});
 assert.deepEqual((await send(legacy.port,'/knowledge/versioned/reconcile',{...legacyCreate,previousGeneration:-1})).body,{status:'confirmed'});
 assert.deepEqual((await send(legacy.port,'/knowledge/versioned/edit',{...legacyCreate,operationId:'d'.repeat(32),previousGeneration:0})).body,{status:'confirmed'});
});
