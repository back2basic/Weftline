import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {ephemeralTls} from './fixtures/local-tls.js';
import {createGuardedAppwriteStore} from '../experimental/guarded-appwrite-composition.js';

test('explicit dual-pinned authority starts; mismatches fail before credential read',async()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'authority-cli-')),tls=ephemeralTls();
 const endpoint='https://provider.example/v1',project='production-test';
 for(const [name,value] of [['key',tls.key],['cert',tls.cert],['api',`apikey:synthetic\nprojectID:${project}\nendpoint:${endpoint}\n`]])writeFileSync(join(dir,name),value);
 const preload=join(dir,'tripwire.mjs');
 writeFileSync(preload,`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const read=fs.readFileSync; fs.readFileSync=function(p,...a){if(p===process.env.APPWRITE_KEY_FILE)console.error('CREDENTIAL_READ');return read.call(this,p,...a)};syncBuiltinESMExports();globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN')};`);
 const env={PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:`--import ${preload}`,WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_HOST:'127.0.0.1',WEFTLINE_REVIEW_PORT:'0',WEFTLINE_REVIEW_BOARD:'b',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_TLS_KEY_FILE:join(dir,'key'),WEFTLINE_TLS_CERT_FILE:join(dir,'cert'),APPWRITE_KEY_FILE:join(dir,'api')};
 try {
  for(const change of [{WEFTLINE_APPROVED_APPWRITE_ENDPOINT:'https://other.example/v1'},{WEFTLINE_APPROVED_APPWRITE_PROJECT:'other'},{WEFTLINE_APPROVED_APPWRITE_ENDPOINT:''},{WEFTLINE_APPROVED_APPWRITE_PROJECT:undefined},{WEFTLINE_APPROVED_APPWRITE_ENDPOINT:undefined,WEFTLINE_APPROVED_APPWRITE_PROJECT:undefined},{APPWRITE_ENDPOINT:'http://provider.example/v1',WEFTLINE_APPROVED_APPWRITE_ENDPOINT:'http://provider.example/v1'},{APPWRITE_ENDPOINT:'https://user@provider.example/v1',WEFTLINE_APPROVED_APPWRITE_ENDPOINT:'https://user@provider.example/v1'},{APPWRITE_PROJECT:'bad/project',WEFTLINE_APPROVED_APPWRITE_PROJECT:'bad/project'}]){
   const r=spawnSync(process.execPath,['experimental/review-v1-cli.js'],{env:{...env,...change},encoding:'utf8',timeout:5000});assert.notEqual(r.status,0);assert.doesNotMatch(r.stderr,/CREDENTIAL_READ|NETWORK_FORBIDDEN/);
  }
  const child=spawn(process.execPath,['experimental/review-v1-cli.js'],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
  try {await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout '+stderr)),5000);child.once('exit',code=>{clearTimeout(timer);reject(Error('exited '+code+' '+stderr));});child.stdout.on('data',()=>{if(stdout.includes('Review experimental TLS listener')){clearTimeout(timer);resolve();}});});assert.match(stderr,/CREDENTIAL_READ/);assert.doesNotMatch(stderr,/NETWORK_FORBIDDEN/);}
  finally {if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}}
  for(const metadata of [`apikey:synthetic\nprojectID:other\nendpoint:${endpoint}\n`,`apikey:synthetic\nprojectID:${project}\nendpoint:https://other.example/v1\n`]){
   writeFileSync(join(dir,'api'),metadata);
   const r=spawnSync(process.execPath,['experimental/review-v1-cli.js'],{env,encoding:'utf8',timeout:5000});assert.notEqual(r.status,0);assert.match(r.stderr,/CREDENTIAL_READ/);assert.doesNotMatch(r.stderr,/NETWORK_FORBIDDEN/);
  }
  const original=globalThis.fetch;let requested;
  globalThis.fetch=async(url,options)=>{requested={url,options};return new Response(JSON.stringify({$id:'alice'}),{status:200});};
  try {
   const config={enabled:true,endpoint,project,approvedEndpoint:endpoint,approvedProject:project,key:'synthetic',database:'db',table:'review'};
   for(const change of [{approvedEndpoint:'https://other.example/v1'},{approvedProject:'other'},{approvedProject:undefined}])assert.throws(()=>createGuardedAppwriteStore({...config,...change}));
   assert.equal(requested,undefined);
   await createGuardedAppwriteStore(config).account('synthetic-session');
   assert.equal(requested.url,`${endpoint}/account`);assert.equal(requested.options.headers['X-Appwrite-Project'],project);
  } finally {globalThis.fetch=original;}
 } finally {rmSync(dir,{recursive:true,force:true});}
});
