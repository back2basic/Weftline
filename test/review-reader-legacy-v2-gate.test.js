import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import https from 'node:https';
import {ephemeralTls} from './fixtures/local-tls.js';
import {knowledgeIntentFingerprint} from '../src/private-knowledge.js';

async function startCli(env,t,tls){
 const child=spawn(process.execPath,['experimental/review-v1-cli.js'],{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>child.once('exit',r));}});
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(err)),5000);child.once('exit',()=>{clearTimeout(timer);reject(Error(err));});child.stdout.on('data',()=>{const m=out.match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolve(+m[1]);}});});
 const send=(path,body,actor)=>new Promise((resolve,reject)=>{const req=https.request({host:'127.0.0.1',port,path,method:'POST',ca:tls.cert,servername:'localhost',headers:{host:`127.0.0.1:${port}`,origin:`https://127.0.0.1:${port}`,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:`__Host-weftline=${actor}`}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',reject);req.end(JSON.stringify(body));});
 return {child,port,send};
}
const rowId=(board,id)=>'k'+createHash('sha256').update(JSON.stringify([board,id])).digest('base64url').slice(0,32);
const receiptId=(board,actor,operationId)=>'r'+createHash('sha256').update(JSON.stringify(['knowledge-receipt-actor-v2',board,actor,operationId])).digest('base64url').slice(0,32);

test('spawned review CLI denies legacy v2 create routes for reader plus member before any provider write',{timeout:20000},async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR??tmpdir(),'review-reader-v2-')),tls=ephemeralTls();t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const endpoint='https://provider.example.test/v1',project='synthetic-project',roles=join(dir,'roles'),writes=join(dir,'writes'),snapshot=join(dir,'knowledge-rows');
 for(const [name,value] of [['key',tls.key],['cert',tls.cert],['api',`apikey:synthetic\nprojectID:${project}\nendpoint:${endpoint}\n`],['roles',JSON.stringify({alice:['member'],reader:['member','reader']})],['writes',''],['knowledge-rows','{}']])writeFileSync(join(dir,name),value);
 const env={PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./test/fixtures/review-v1-provider.js',WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_AUTH:'1',WEFTLINE_REVIEW_UI:'1',WEFTLINE_REVIEW_HOST:'127.0.0.1',WEFTLINE_REVIEW_PORT:'0',WEFTLINE_REVIEW_BOARD:'b',WEFTLINE_REVIEW_KNOWLEDGE_V2:'1',WEFTLINE_REVIEW_KNOWLEDGE_READER_DENY_WRITES:'1',WEFTLINE_KNOWLEDGE_DATABASE_ID:'db',WEFTLINE_KNOWLEDGE_TABLE_ID:'legacy',WEFTLINE_KNOWLEDGE_TEAM_ID:'team',WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES:'1024',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_TLS_KEY_FILE:join(dir,'key'),WEFTLINE_TLS_CERT_FILE:join(dir,'cert'),APPWRITE_KEY_FILE:join(dir,'api'),REVIEW_TEST_MEMBERSHIP_ROLES_FILE:roles,REVIEW_TEST_WRITES_FILE:writes,REVIEW_TEST_KNOWLEDGE_ROWS_FILE:snapshot};
 const {send}=await startCli(env,t,tls);
 for(const path of ['/knowledge/v2/create','/knowledge/v2/create-with-receipt']){
  const body={boardId:'b',expectedActor:'reader',id:'reader-doc',title:'Reader',html:'<p>private</p>',...(path.endsWith('receipt')?{operationId:'a'.repeat(32),expectedFingerprint:'b'.repeat(64)}:{})};
  assert.equal((await send(path,body,'reader')).status,403,path);
  assert.equal(readFileSync(writes,'utf8'),'','reader denial issued no Appwrite write request');
 }
 // A valid writer gets confirmed results and independently inspectable synthetic rows.
 const writer={boardId:'b',expectedActor:'alice',id:'writer-doc',title:'Writer',html:'<p>allowed</p>'};
 const response=await send('/knowledge/v2/create',writer,'alice');
 assert.equal(response.status,201);assert.equal(response.text,'Created');
 let stored=JSON.parse(readFileSync(snapshot,'utf8'));
 assert.deepEqual(stored[`db/legacy/${rowId('b','writer-doc')}`],{kind:'knowledge-document-v1',boardId:'b',id:'writer-doc',title:'Writer',html:'<p>allowed</p>'});
 const operationId='c'.repeat(32),receiptDoc={boardId:'b',expectedActor:'alice',id:'receipt-doc',title:'Receipt title',html:'<p>receipt</p>',operationId};
 const fingerprint=knowledgeIntentFingerprint({boardId:'b',id:receiptDoc.id,title:receiptDoc.title,html:receiptDoc.html,actor:'alice',operationId});
 const receiptResponse=await send('/knowledge/v2/create-with-receipt',{...receiptDoc,expectedFingerprint:fingerprint},'alice');
 assert.equal(receiptResponse.status,201);assert.deepEqual(JSON.parse(receiptResponse.text),{status:'confirmed',operationId,fingerprint});
 stored=JSON.parse(readFileSync(snapshot,'utf8'));
 assert.deepEqual(stored[`db/legacy/${rowId('b','receipt-doc')}`],{kind:'knowledge-document-v1',boardId:'b',id:'receipt-doc',title:'Receipt title',html:'<p>receipt</p>'});
 assert.deepEqual(stored[`db/legacy/${receiptId('b','alice',operationId)}`],{kind:'knowledge-create-receipt-v1',boardId:'b',operationId,actor:'alice',fingerprint});
 assert.notEqual(readFileSync(writes,'utf8').length,0,'successful writer requests dispatched synthetic provider writes');

 // With the feature flag absent, the reader role does not alter legacy membership behavior.
 const {WEFTLINE_REVIEW_KNOWLEDGE_READER_DENY_WRITES:unused,...flagOffEnv}=env;
 const flagOff=await startCli(flagOffEnv,t,tls);
 const flagOffBody={boardId:'b',expectedActor:'reader',id:'flag-off-doc',title:'Flag off',html:'<p>legacy behavior</p>'};
 const flagOffResponse=await flagOff.send('/knowledge/v2/create',flagOffBody,'reader');
 assert.equal(flagOffResponse.status,201);assert.equal(flagOffResponse.text,'Created');
 const flagOffRows=JSON.parse(readFileSync(snapshot,'utf8'));
 assert.deepEqual(flagOffRows[`db/legacy/${rowId('b','flag-off-doc')}`],{kind:'knowledge-document-v1',boardId:'b',id:'flag-off-doc',title:'Flag off',html:'<p>legacy behavior</p>'});
});
