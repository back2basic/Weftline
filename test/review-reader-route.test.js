// Synthetic provider; exercises the actual spawned TLS listener, not live Appwrite.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import https from 'node:https';
import {ephemeralTls} from './fixtures/local-tls.js';

test('reader can use read routes but cannot dispatch task transitions',{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-reader-')),tls=ephemeralTls();
 const endpoint='https://provider.example.test/v1',project='synthetic-project';
 for(const [name,value] of [['key',tls.key],['cert',tls.cert],['api',`apikey:synthetic\nprojectID:${project}\nendpoint:${endpoint}\n`],['guard',JSON.stringify([{kind:'review-guard-v1',board:'b',user:'reader',generation:0,state:'active',role:'reader'}])]])writeFileSync(join(dir,name),value);
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./test/fixtures/review-resolution-provider.js',WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_HOST:'127.0.0.1',WEFTLINE_REVIEW_PORT:'0',WEFTLINE_REVIEW_BOARD:'b',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_TLS_KEY_FILE:join(dir,'key'),WEFTLINE_TLS_CERT_FILE:join(dir,'cert'),APPWRITE_KEY_FILE:join(dir,'api'),REVIEW_TEST_GUARD_FILE:join(dir,'guard'),REVIEW_TEST_WRITES_FILE:join(dir,'writes')};
 const child=spawn(process.execPath,['experimental/review-v1-cli.js'],{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
 try{
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('listener timeout '+err)),5000);child.once('exit',()=>{clearTimeout(timer);reject(Error('listener exit '+err));});child.stdout.on('data',()=>{const m=out.match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolve(+m[1]);}});});
  const req=(path,body,actor='reader')=>new Promise((resolve,reject)=>{const r=https.request({host:'127.0.0.1',port,path,method:'POST',rejectUnauthorized:false,headers:{host:`127.0.0.1:${port}`,origin:`https://127.0.0.1:${port}`,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:`__Host-weftline=${actor}`}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});r.on('error',reject);r.end(JSON.stringify(body));});
  const base={board:'b',expectedActor:'reader',guardGeneration:0};
  const discovery=await req('/review/discovery',base);assert.equal(discovery.status,200,JSON.stringify(discovery.body));assert.equal(discovery.body.status,'partial');
  const resolution=await req('/review/resolve',{...base,task:'task'});assert.equal(resolution.status,200,JSON.stringify(resolution.body));assert.equal(resolution.body.status,'partial');
  const pointRead=await req('/review/task',{...base,task:'task',taskGeneration:8});assert.equal(pointRead.status,200,JSON.stringify(pointRead.body));assert.equal(pointRead.body.status,'current');assert.equal(pointRead.body.task.state,'review');
  for(const action of ['genesis','claim','submit','approve','reject']){
   const result=await req(action==='genesis'?'/review/genesis':'/review/transition',{...base,operation:'op-'+action,task:'task',taskGeneration:0,action});
   assert.equal(result.status,403,action);assert.equal(result.body.status,'denied',action);
  }
  assert.equal(existsSync(env.REVIEW_TEST_WRITES_FILE),false,'read-only denial must dispatch no write');
  for(const actor of ['alice','bob']){
   const read=await req('/review/task',{board:'b',expectedActor:actor,guardGeneration:0,task:'task',taskGeneration:8},actor);
   assert.equal(read.status,200,actor);assert.equal(read.body.task.state,'review',actor);
  }
  const readRoutes=[['/review/discovery',base],['/review/resolve',{...base,task:'task'}],['/review/task',{...base,task:'task',taskGeneration:8}]];
  for(const [guards,expectedActor] of [
   [[{kind:'review-guard-v1',board:'b',user:'reader',generation:0,state:'revoked',role:'reader'}],'reader'],
   [[{kind:'review-guard-v1',board:'b',user:'reader',generation:0,state:'active',role:'reader'},{kind:'review-guard-v1',board:'b',user:'reader',generation:1,state:'revoked',role:'reader'}],'reader'],
   [[{kind:'review-guard-v1',board:'b',user:'reader',generation:0,state:'active',role:'reader'}],'alice']
  ]){
   writeFileSync(env.REVIEW_TEST_GUARD_FILE,JSON.stringify(guards));
   for(const [path,body] of readRoutes){const result=await req(path,{...body,expectedActor});assert.equal(result.status,403,`${path} must deny inactive, superseded, or mismatched readers`);}
  }
  assert.equal(existsSync(env.REVIEW_TEST_WRITES_FILE),false);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>child.once('exit',r));}rmSync(dir,{recursive:true,force:true});}
});
