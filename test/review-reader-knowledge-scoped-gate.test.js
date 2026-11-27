import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import http from 'node:http';
import {startVersionedProvider} from './fixtures/knowledge-versioned-scoped-provider.js';

const origin='https://app.example.test',endpoint='https://provider.example.test/v1',project='synthetic-project';
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;const closed=new Promise(r=>child.once('close',r));child.kill('SIGKILL');await closed;}
async function start(env){const child=spawn(process.execPath,['src/server.js'],{env,stdio:['ignore','pipe','pipe','ipc']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(output)),5000);child.once('exit',()=>{clearTimeout(timer);reject(Error(output));});child.stdout.on('data',()=>{const m=output.match(/listener .*:(\d+)/);if(m){clearTimeout(timer);resolve(+m[1]);}});});return {child,port};}
function send(port,secret,path,body,actor='bob'){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path,method:'POST',headers:{host:'app.example.test','x-weftline-proxy-secret':secret,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:`__Host-weftline=${actor}`}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end(JSON.stringify(body));});}

test('reader-dominates gate denies scoped writes; missing roles fail closed and disabled flag preserves behavior',{timeout:30000},async t=>{
 const provider=await startVersionedProvider();t.after(()=>provider.close());
 const dir=mkdtempSync(join(process.env.TMPDIR,'reader-scoped-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const api=join(dir,'api');writeFileSync(api,`apikey: synthetic-key\nprojectID: ${project}\nendpoint: ${endpoint}\n`);
 const preload=join(dir,'preload.mjs');writeFileSync(preload,`await import(${JSON.stringify(new URL('./fixtures/knowledge-versioned-scoped-cli-proxy.js',import.meta.url).href)});`);
 const secret=randomBytes(32).toString('hex'),scope={endpoint,project,database:'db',table:'versions',boardId:'board',teamId:'team'};
 const base={PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:`--import ${preload}`,VERSIONED_FIXTURE_PORT:String(provider.port),WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_PROXY:'1',WEFTLINE_PROXY_SECRET:secret,WEFTLINE_PUBLIC_ORIGIN:origin,WEFTLINE_REVIEW_HOST:'127.0.0.1',PORT:'0',WEFTLINE_REVIEW_BOARD:'board',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED:'1',WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_READ:'1',WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_WRITE:'1',WEFTLINE_KNOWLEDGE_VERSIONED_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_VERSIONED_TABLE_ID:'versions',WEFTLINE_KNOWLEDGE_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_TABLE_ID:'legacy',WEFTLINE_KNOWLEDGE_TEAM_ID:'team',WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES:'1024',APPWRITE_KEY_FILE:api};
 const env={...base,WEFTLINE_REVIEW_KNOWLEDGE_READER_DENY_WRITES:'1'};
 const {child,port}=await start(env);t.after(()=>stop(child));
 const intent={expectedActor:'bob',documentId:'reader-check',operationId:'a'.repeat(32),title:'title',html:'<p>body</p>'};
 await provider.control('roles',{actor:'bob',roles:['member','reader']});
 const writes=async()=>{const m=await provider.control('metrics');return m.requests.filter(x=>x.method==='POST'&&(x.path.includes('/tablesdb/')||x.path==='/v1/tablesdb/transactions')).length;};
 for(const action of ['create','edit','reconcile']){
  const writeIntent={...intent,...(action==='edit'?{previousGeneration:0}:action==='reconcile'?{previousGeneration:-1}:{})};
  const before=await writes();const response=await send(port,secret,`/knowledge/versioned/scoped-${action}`,{scope,intent:writeIntent});
  assert.equal(response.status,403,action);assert.equal(await writes(),before,`${action} dispatched no provider writes`);
 }
 const read=await send(port,secret,'/knowledge/versioned/scoped-read',{scope,intent:{expectedActor:'bob',documentId:'reader-check',generation:0}});
 assert.equal(read.status,202,'reads retain the existing membership-based path even if no row exists');
 for(const malformed of [undefined,'member',{},['member',4],[],['member','reader '],['member',' '],['member','reader\n'],['member','rea\nder']]){
  await provider.control('roles',{actor:'bob',roles:malformed});const before=await writes();
  const response=await send(port,secret,'/knowledge/versioned/scoped-create',{scope,intent});
  assert.equal(response.status,403,'missing or malformed role arrays fail closed');assert.equal(await writes(),before);
 }
 for(const readerRoles of [['reader'],['reader','writer']]){
  await provider.control('roles',{actor:'bob',roles:readerRoles});const before=await writes();
  const response=await send(port,secret,'/knowledge/versioned/scoped-create',{scope,intent:{...intent,operationId:'e'.repeat(32)}});
  assert.equal(response.status,403,'exact reader role denies, including when writer is also assigned');assert.equal(await writes(),before);
 }
 await provider.control('roles',{actor:'bob',roles:['writer:automation team']});
 const writer=await send(port,secret,'/knowledge/versioned/scoped-create',{scope,intent:{...intent,operationId:'b'.repeat(32)}});
 assert.equal(writer.body.status,'confirmed','ordinary writer remains authorized');
 const writerEdit=await send(port,secret,'/knowledge/versioned/scoped-edit',{scope,intent:{...intent,operationId:'d'.repeat(32),previousGeneration:0,html:'<p>edited</p>'}});
 assert.equal(writerEdit.body.status,'confirmed','ordinary writer edit remains authorized');
 const writerReconcile=await send(port,secret,'/knowledge/versioned/scoped-reconcile',{scope,intent:{...intent,operationId:'b'.repeat(32),previousGeneration:-1}});
 assert.equal(writerReconcile.body.status,'confirmed','ordinary writer reconciliation remains authorized');
 await provider.control('roles',{actor:'bob',roles:['member','reader']});
 const noFlag=await start({...base});t.after(()=>stop(noFlag.child));
 const legacyBehavior=await send(noFlag.port,secret,'/knowledge/versioned/scoped-create',{scope,intent:{...intent,documentId:'flag-off',operationId:'c'.repeat(32)}});
 assert.equal(legacyBehavior.body.status,'confirmed','unset flag preserves previous membership behavior');
});
