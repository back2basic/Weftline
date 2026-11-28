import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {request as httpsRequest} from 'node:https';
import {ephemeralTls} from './fixtures/local-tls.js';

test('spawned review listener classifies absent, malformed, duplicate, valid, and stale cookies', {timeout:30000}, async()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'auth-preflight-listener-')),tls=ephemeralTls(),endpoint='https://provider.example.test/v1',project='synthetic-project';
 for(const [n,v] of [['key',tls.key],['cert',tls.cert],['api',`apikey:***\nprojectID:${project}\nendpoint:${endpoint}\n`]])writeFileSync(join(dir,n),v);
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./test/fixtures/review-ui-provider.js',WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_AUTH:'1',WEFTLINE_REVIEW_UI:'1',WEFTLINE_REVIEW_HOST:'127.0.0.1',WEFTLINE_REVIEW_PORT:'0',WEFTLINE_REVIEW_BOARD:'b',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_TLS_KEY_FILE:join(dir,'key'),WEFTLINE_TLS_CERT_FILE:join(dir,'cert'),APPWRITE_KEY_FILE:join(dir,'api')};
 const child=spawn(process.execPath,['experimental/review-v1-cli.js'],{env,stdio:['ignore','pipe','pipe']});let output='',stderr='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>stderr+=x);
 const stop=async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>child.once('exit',r));}rmSync(dir,{recursive:true,force:true});};
 try{
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('listener timeout '+stderr)),5000);child.once('exit',()=>{clearTimeout(timer);reject(Error('listener exited '+stderr));});child.stdout.on('data',()=>{const m=output.match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolve(+m[1]);}});});
  const call=(path,cookie,method='GET')=>new Promise((resolve,reject)=>{const headers={origin:`https://127.0.0.1:${port}`,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty'};if(cookie!==undefined)headers.cookie=cookie;if(method==='POST'){headers['content-type']='application/json';headers['content-length']='2';}const req=httpsRequest({host:'127.0.0.1',port,path,method,headers,rejectUnauthorized:false},res=>{let body='';res.setEncoding('utf8');res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,marker:res.headers['x-weftline-session-state'],body,setCookie:res.headers['set-cookie']}));});req.on('error',reject);req.end(method==='POST'?'{}':undefined);});
  const absent=await call('/account');assert.equal(absent.status,401);assert.equal(absent.marker,'absent');
  const unrelated=await call('/account','theme=dark');assert.equal(unrelated.status,401);assert.equal(unrelated.marker,'absent');
  for(const cookie of ['theme=bad value','__Host-weftline=','__Host-weftline=one; __Host-weftline=two']){const r=await call('/account',cookie);assert.equal(r.status,401);assert.equal(r.marker,undefined);}
  const valid=await call('/account','__Host-weftline=alice');assert.equal(valid.status,200);assert.equal(JSON.parse(valid.body).$id,'alice');assert.equal(valid.marker,undefined);
  const quoted=await call('/account','__Host-weftline=alice; theme="123"');assert.equal(quoted.status,200);assert.equal(JSON.parse(quoted.body).$id,'alice');assert.equal(quoted.marker,undefined);
  const quotedLogout=await call('/logout','__Host-weftline=alice; theme="123"','POST');assert.equal(quotedLogout.status,204);assert.match(quotedLogout.setCookie.join('; '),/Max-Age=0/);assert.equal(quotedLogout.marker,undefined);
  const stale=await call('/account','__Host-weftline=stale-session');assert.equal(stale.status,401);assert.equal(stale.marker,undefined);
 }finally{await stop();}
});
