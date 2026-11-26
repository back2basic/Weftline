import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import https from 'node:https';
import dns from 'node:dns';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {ephemeralTls} from '../../../test/fixtures/local-tls.js';
import {createKnowledgeRead} from '../knowledge-read.js';
import {createWriteAdapter} from '../write-adapter.js';

test('direct knowledge adapter rejects cookie delimiters before request dispatch',()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'wf-knowledge-validation-'));
 try{
  const cert=join(dir,'cert');writeFileSync(cert,ephemeralTls().cert);
  const args=['--enable','--endpoint','https://127.0.0.1:12345','--ca',cert,'--actor','alice','--board','board','--guard','0'];
  const scope={endpoint:'https://provider.example.test/v1',project:'project',database:'db',table:'versions',boardId:'board',teamId:'team'};
  for(const session of ['alice;other=bob','alice\r\nInjected: value',''])assert.throws(()=>createKnowledgeRead({args,session,scope}));
  assert.equal(typeof createKnowledgeRead({args,session:'alice',scope}),'function');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('direct knowledge reads reject accessor input without evaluating it',async()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'wf-knowledge-input-'));
 try{
  const cert=join(dir,'cert');writeFileSync(cert,ephemeralTls().cert);
  const args=['--enable','--endpoint','https://127.0.0.1:12345','--ca',cert,'--actor','alice','--board','board','--guard','0'];
  const scope={endpoint:'https://provider.example.test/v1',project:'project',database:'db',table:'versions',boardId:'board',teamId:'team'};
  const read=createKnowledgeRead({args,session:'alice',scope});let calls=0;
  const input={get documentId(){calls++;return 'doc';},generation:-1};
  assert.deepEqual(await read(input),{status:'invalid'});assert.equal(calls,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('knowledge adapter uses the CA snapshot it validated',()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'wf-knowledge-ca-'));const original=fs.readFileSync;
 try{
  const cert=join(dir,'cert');writeFileSync(cert,ephemeralTls().cert);
  const args=['--enable','--endpoint','https://127.0.0.1:12345','--ca',cert,'--actor','alice','--board','board','--guard','0'];
  const scope={endpoint:'https://provider.example.test/v1',project:'project',database:'db',table:'versions',boardId:'board',teamId:'team'};
  let reads=0;fs.readFileSync=function(path,...rest){if(path===cert)reads++;return original.call(this,path,...rest);};syncBuiltinESMExports();
  createKnowledgeRead({args,session:'alice',scope});assert.equal(reads,1);
 }finally{fs.readFileSync=original;syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true});}
});

test('direct write adapter validates its session and uses one CA snapshot',()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'wf-write-ca-'));const original=fs.readFileSync;
 try{
  const cert=join(dir,'cert');writeFileSync(cert,ephemeralTls().cert);
  const args=['--enable','--endpoint','https://127.0.0.1:12345','--ca',cert,'--actor','alice','--board','board','--guard','0'];
  const backendScope={endpoint:'https://provider.example.test/v1',project:'project',database:'db',table:'review'};
  for(const session of ['alice;other=bob','alice\r\nInjected: value',''])assert.throws(()=>createWriteAdapter({args,session,journalDir:dir,backendScope}));
  let reads=0;fs.readFileSync=function(path,...rest){if(path===cert)reads++;return original.call(this,path,...rest);};syncBuiltinESMExports();
  createWriteAdapter({args,session:'alice',journalDir:dir,backendScope});assert.equal(reads,1);
 }finally{fs.readFileSync=original;syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true});}
});

test('direct task writes reject accessor input without evaluating it',async()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'wf-write-input-'));
 try{
  const cert=join(dir,'cert');writeFileSync(cert,ephemeralTls().cert);
  const args=['--enable','--endpoint','https://127.0.0.1:12345','--ca',cert,'--actor','alice','--board','board','--guard','0'];
  const backendScope={endpoint:'https://provider.example.test/v1',project:'project',database:'db',table:'review'};
  const write=createWriteAdapter({args,session:'alice',journalDir:dir,backendScope});let calls=0;
  const input={get operation(){calls++;return 'op';},task:'!',guardGeneration:0,taskGeneration:0};
  assert.deepEqual(await write('claim',input),{status:'invalid'});assert.equal(calls,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('direct write adapter snapshots backend scope before dispatch', {timeout:10000},async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'wf-write-snapshot-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const tls=ephemeralTls(),cert=join(dir,'cert');writeFileSync(cert,tls.cert);
 let capture;const got=new Promise(resolve=>{capture=resolve;});
 const server=https.createServer(tls,(req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{capture(JSON.parse(body));res.writeHead(202,{'content-type':'application/json'});res.end('{"status":"unknown"}');});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const previous=dns.getDefaultResultOrder();dns.setDefaultResultOrder('ipv4first');t.after(()=>dns.setDefaultResultOrder(previous));
 const args=['--enable','--remote-https','--endpoint',`https://localhost:${server.address().port}`,'--ca',cert,'--actor','alice','--board','board','--guard','0'];
 const backendScope={endpoint:'https://provider.example.test/v1',project:'project',database:'db',table:'review'};
 const write=createWriteAdapter({args,session:'alice',journalDir:dir,backendScope});backendScope.table='other';
 assert.deepEqual(await write('claim',{operation:'op',task:'task',guardGeneration:0,taskGeneration:0}),{status:'unknown'});
 assert.equal((await got).scope.table,'review');
});

test('direct knowledge adapter snapshots startup scope and actor', {timeout:10000},async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'wf-knowledge-snapshot-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const tls=ephemeralTls(),cert=join(dir,'cert');writeFileSync(cert,tls.cert);
 let capture;const got=new Promise(resolve=>{capture=resolve;});
 const server=https.createServer(tls,(req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{capture(JSON.parse(body));res.writeHead(202,{'content-type':'application/json'});res.end('{"status":"unknown"}');});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const previous=dns.getDefaultResultOrder();dns.setDefaultResultOrder('ipv4first');t.after(()=>dns.setDefaultResultOrder(previous));
 const args=['--enable','--remote-https','--endpoint',`https://localhost:${server.address().port}`,'--ca',cert,'--actor','alice','--board','board','--guard','0'];
 const scope={endpoint:'https://provider.example.test/v1',project:'project',database:'db',table:'versions',boardId:'board',teamId:'team'};
 const read=createKnowledgeRead({args,session:'alice',scope});scope.table='other';args[args.indexOf('--actor')+1]='bob';
 assert.deepEqual(await read({documentId:'doc',generation:0}),{status:'unknown'});
 const body=await got;assert.equal(body.scope.table,'versions');assert.equal(body.intent.expectedActor,'alice');
});
