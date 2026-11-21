import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import https from 'node:https';
import {ephemeralTls} from './fixtures/local-tls.js';

const hash=(...x)=>createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,32);
test('revoked and missing guards do not reveal checkpoint validity on real TLS routes',{timeout:45000},async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'review-oracle-')),tls=ephemeralTls(),endpoint='https://provider.example.test/v1',project='synthetic-project';
 for(const [n,v] of [['key',tls.key],['cert',tls.cert],['api',`apikey:synthetic\nprojectID:${project}\nendpoint:${endpoint}\n`],['trace',''],['clock','0']])writeFileSync(join(dir,n),v);
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./test/fixtures/review-oracle-provider.js',WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_HOST:'127.0.0.1',WEFTLINE_REVIEW_PORT:'0',WEFTLINE_REVIEW_BOARD:'b',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_TLS_KEY_FILE:join(dir,'key'),WEFTLINE_TLS_CERT_FILE:join(dir,'cert'),APPWRITE_KEY_FILE:join(dir,'api'),REVIEW_TEST_GUARD_FILE:join(dir,'guard'),REVIEW_TEST_ROWS_FILE:join(dir,'rows'),REVIEW_TEST_LIST_FILE:join(dir,'list'),REVIEW_TEST_TRACE_FILE:join(dir,'trace'),REVIEW_TEST_CLOCK_FILE:join(dir,'clock')};
 const extras=Array.from({length:30},(_,n)=>{const user='u'+n,board='other';return {id:hash('guard',board,user,0),data:{kind:'review-guard-v1',board,user,generation:0,state:'active',role:'worker'}}});writeFileSync(env.REVIEW_TEST_LIST_FILE,JSON.stringify({extras}));
 const p=spawn(process.execPath,['experimental/review-v1-cli.js'],{env,stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>out+=x);t.after(async()=>{if(p.exitCode===null&&p.signalCode===null){p.kill();await new Promise(r=>p.once('exit',r));}rmSync(dir,{recursive:true,force:true});});
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(out)),5000);p.once('exit',()=>reject(Error(out)));p.stdout.on('data',()=>{const m=out.match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolve(+m[1]);}});});
 const req=(path,body,actor='alice')=>new Promise((resolve,reject)=>{const r=https.request({host:'127.0.0.1',port,path,method:'POST',ca:tls.cert,servername:'localhost',headers:{host:`127.0.0.1:${port}`,origin:`https://127.0.0.1:${port}`,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:`__Host-weftline=${actor}`}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});r.on('error',reject);r.end(JSON.stringify(body));});
 for(const path of (process.env.ORACLE_ROUTE?[process.env.ORACLE_ROUTE]:['/review/discovery','/review/resolve'])){
  writeFileSync(env.REVIEW_TEST_GUARD_FILE,JSON.stringify([{kind:'review-guard-v1',board:'b',user:'alice',generation:0,state:'active',role:'worker'}]));writeFileSync(env.REVIEW_TEST_CLOCK_FILE,'0');
  const base={board:'b',expectedActor:'alice',guardGeneration:0,...(path.endsWith('resolve')?{task:'task'}:{})};
  const initial=await req(path,base);assert.equal(initial.status,200);const token=initial.body.continuation;assert.ok(token);
  const other=await req(path,{...base,expectedActor:'bob'},'bob');assert.equal(other.status,200);const wrong=other.body.continuation;
  const tampered=(token[0]==='A'?'B':'A')+token.slice(1);
  assert.equal((await req(path,{...base,continuation:token})).status,200);assert.equal((await req(path,{...base,continuation:tampered})).status,400);
  writeFileSync(env.REVIEW_TEST_CLOCK_FILE,'301000');assert.equal((await req(path,{...base,continuation:token})).status,400);writeFileSync(env.REVIEW_TEST_CLOCK_FILE,'0');
  const expiredToken=token; // Move clock only for the expired case; all other inputs remain identical.
  for(const mode of ['revoked','missing']){
   writeFileSync(env.REVIEW_TEST_GUARD_FILE,JSON.stringify([{kind:'review-guard-v1',board:'b',user:'alice',generation:0,state:'revoked',role:'worker'}]));
   const input=mode==='missing'?{...base,guardGeneration:1}:base;
   let candidate=token;
   if(mode==='missing'){writeFileSync(env.REVIEW_TEST_GUARD_FILE,JSON.stringify([{kind:'review-guard-v1',board:'b',user:'alice',generation:1,state:'active',role:'worker'}]));const issued=await req(path,input);assert.equal(issued.status,200);candidate=issued.body.continuation;writeFileSync(env.REVIEW_TEST_ROWS_FILE,JSON.stringify({id:hash('guard','b','alice',1),missing:true}));}
   const responses=[];writeFileSync(env.REVIEW_TEST_TRACE_FILE,'');
   for(const [v,clock] of [[candidate,'0'],[tampered,'0'],[wrong,'0'],[mode==='missing'?candidate:expiredToken,'301000']]){writeFileSync(env.REVIEW_TEST_CLOCK_FILE,clock);responses.push(await req(path,{...input,continuation:v}));}
   for(const response of responses){assert.deepEqual(response,responses[0],`${path} ${mode}`);assert.equal(response.status,403);}
   writeFileSync(env.REVIEW_TEST_ROWS_FILE,'{}');
   const allowed=new Set([hash('guard','b','alice',input.guardGeneration),hash('guard','b','alice',input.guardGeneration+1)]);
   const reads=readFileSync(env.REVIEW_TEST_TRACE_FILE,'utf8').trim().split('\n').filter(Boolean);assert.ok(reads.length);for(const read of reads)assert.ok(allowed.has(read.split('/').at(-1)),`private data read: ${read}`);
  }
  // The outer listener deadline must not echo an input checkpoint before guard validation.
  writeFileSync(env.REVIEW_TEST_CLOCK_FILE,'0');
  writeFileSync(env.REVIEW_TEST_GUARD_FILE,JSON.stringify([{kind:'review-guard-v1',board:'b',user:'alice',generation:0,state:'active',role:'worker'}]));
  writeFileSync(env.REVIEW_TEST_ROWS_FILE,JSON.stringify({id:hash('guard','b','alice',0),hang:true}));
  const timed=await req(path,{...base,continuation:tampered});assert.equal(timed.status,202);assert.equal(Object.hasOwn(timed.body,'continuation'),false);
  writeFileSync(env.REVIEW_TEST_ROWS_FILE,'{}');
 }
});
