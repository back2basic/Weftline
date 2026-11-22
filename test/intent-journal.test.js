import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync,mkdirSync,writeFileSync,chmodSync,unlinkSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createJournal as openJournal} from '../experimental/agent-mcp/intent-journal.js';

const intent={board:'b',expectedActor:'alice',guardGeneration:0,operation:'op',task:'task',taskGeneration:0,action:'claim'};
const scope={endpoint:'https://example.invalid',project:'p',database:'d',table:'t'};
const createJournal=dir=>openJournal(dir,scope);
test('explicit backend scope is required and mismatches cannot reuse a journal',()=>{
 const noScope=mkdtempSync(join(process.env.TMPDIR,'intent-journal-'));
 try {assert.throws(()=>openJournal(noScope));} finally {rmSync(noScope,{recursive:true,force:true});}
 for(const key of Object.keys(scope)) {
  const dir=mkdtempSync(join(process.env.TMPDIR,'intent-journal-'));
  try {createJournal(dir).begin(intent);const other=openJournal(dir,{...scope,[key]:scope[key]+'-other'});assert.throws(()=>other.inspect());assert.notEqual(createJournal(dir).begin({...intent,operation:'other'}).status,'pending');}
  finally {rmSync(dir,{recursive:true,force:true});}
 }
});
test('duplicate decoded keys at top level or nested intent fail closed',()=>{
 for(const rewrite of [s=>s.replace('"status":"pending"','"status":"pending","status":"reconciled"'),s=>s.replace('"board":"b"','"board":"b","bo\\u0061rd":"b"')]) {
  const dir=mkdtempSync(join(process.env.TMPDIR,'intent-journal-'));
  try {const j=createJournal(dir);j.begin(intent);const path=join(dir,'intent.json');writeFileSync(path,rewrite(readFileSync(path,'utf8')));assert.throws(()=>createJournal(dir).begin({...intent,operation:'other'}));}
  finally {rmSync(dir,{recursive:true,force:true});}
 }
});
test('deleted record after dispatch remains unknown across restart',()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'intent-journal-'));
 try {
  assert.equal(createJournal(dir).begin(intent).status,'pending');
  unlinkSync(join(dir,'intent.json'));
  const url=pathToFileURL(join(process.cwd(),'experimental/agent-mcp/intent-journal.js')).href;
  const code=`import {createJournal} from ${JSON.stringify(url)};const j=createJournal(process.argv[1],${JSON.stringify(scope)});console.log(JSON.stringify([j.inspect(),j.begin({...${JSON.stringify(intent)},operation:'other'})]));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code,dir],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),[{status:'unknown'},{status:'unknown'}]);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('durably recorded intent blocks another intent until its exact receipt',()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'intent-journal-'));
 try {
  const journal=createJournal(dir);
  assert.equal(journal.begin(intent).status,'pending');
  assert.equal(createJournal(dir).begin({...intent,operation:'other'}).status,'blocked');
  assert.equal(journal.reconcile({status:'unknown'}).status,'unknown');
  const receipt={kind:'review-receipt-v1',...intent,user:'alice'};
  assert.equal(journal.reconcile({code:201,status:'recorded',receipt}).status,'reconciled');
  assert.equal(journal.begin({...intent,operation:'other'}).status,'pending');
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('restart exposes the exact pending intent for explicit receipt lookup',()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'intent-journal-'));
 try {
  createJournal(dir).begin(intent);
  const url=pathToFileURL(join(process.cwd(),'experimental/agent-mcp/intent-journal.js')).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {createJournal} from ${JSON.stringify(url)};console.log(JSON.stringify(createJournal(process.argv[1],${JSON.stringify(scope)}).inspect()))`,dir],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),{status:'pending',intent});
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('competing subprocesses permit exactly one pending intent',async()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'intent-journal-'));
 try {
  const url=pathToFileURL(join(process.cwd(),'experimental/agent-mcp/intent-journal.js')).href;
  const code=`import {createJournal} from ${JSON.stringify(url)};process.stdin.once('data',()=>{let j=createJournal(process.argv[1],${JSON.stringify(scope)});console.log(JSON.stringify(j.begin({...${JSON.stringify(intent)},operation:process.argv[2]})));});`;
  const children=['one','two'].map(op=>spawn(process.execPath,['--input-type=module','-e',code,dir,op],{stdio:['pipe','pipe','pipe']}));
  const done=children.map(child=>new Promise((resolve,reject)=>{let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(out)):reject(Error(err)));}));
  for(const c of children)c.stdin.end('go');
  const results=await Promise.all(done);assert.deepEqual(results.map(r=>r.status).sort(),['blocked','pending']);
  const saved=createJournal(dir).inspect();assert.equal(saved.status,'pending');assert.ok(['one','two'].includes(saved.intent.operation));
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('stale lock is never recovered automatically',()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'intent-journal-'));
 try {mkdirSync(join(dir,'intent.lock'));const journal=createJournal(dir);assert.equal(journal.begin(intent).status,'blocked');assert.equal(journal.inspect().status,'blocked');assert.equal(journal.reconcile({}).status,'blocked');}
 finally {rmSync(dir,{recursive:true,force:true});}
});

test('only an exact positive receipt clears a pending intent across restart',()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'intent-journal-'));
 try {
  createJournal(dir).begin(intent);const j=createJournal(dir);const receipt={kind:'review-receipt-v1',...intent,user:'alice'};
  for(const bad of [null,{code:202,status:'unknown'},{code:200,status:'recorded',receipt:{...receipt,action:'submit'}},{code:200,status:'recorded',receipt:{...receipt,user:'bob'}},{code:200,status:'recorded',receipt:{...receipt,operation:'other'}},{code:200,status:'recorded',receipt:{...receipt,board:'other'}},{code:200,status:'recorded',receipt:{...receipt,extra:1}},{code:200,status:'recorded',receipt,extra:1}]) {assert.equal(j.reconcile(bad).status,'unknown');assert.deepEqual(createJournal(dir).inspect(),{status:'pending',intent});}
  assert.equal(j.reconcile({code:200,status:'recorded',receipt}).status,'reconciled');assert.deepEqual(createJournal(dir).inspect(),{status:'reconciled',intent});
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('records are private and an unsafe directory or corrupted file fails closed',()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'intent-journal-'));
 try {
  const j=createJournal(dir);j.begin(intent);assert.equal(statSync(join(dir,'intent.json')).mode&0o777,0o600);assert.deepEqual(JSON.parse(readFileSync(join(dir,'intent.json'),'utf8')).intent,intent);
  writeFileSync(join(dir,'intent.json'),'{broken');assert.throws(()=>j.begin({...intent,operation:'other'}));assert.equal(j.begin(intent).status,'blocked');
  chmodSync(dir,0o755);assert.throws(()=>createJournal(dir));
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('intent created in a subprocess still blocks a later process',()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'intent-journal-'));
 try {
  const url=pathToFileURL(join(process.cwd(),'experimental/agent-mcp/intent-journal.js')).href;
  const run=code=>spawnSync(process.execPath,['--input-type=module','-e',code,dir],{encoding:'utf8'});
  const first=run(`import {createJournal} from ${JSON.stringify(url)};console.log(JSON.stringify(createJournal(process.argv[1],${JSON.stringify(scope)}).begin(${JSON.stringify(intent)})))`);
  assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(first.stdout).status,'pending');
  const second=run(`import {createJournal} from ${JSON.stringify(url)};let j=createJournal(process.argv[1],${JSON.stringify(scope)});console.log(JSON.stringify([j.inspect(),j.begin({...${JSON.stringify(intent)},operation:'other'})]))`);
  assert.equal(second.status,0,second.stderr);assert.deepEqual(JSON.parse(second.stdout),[{status:'pending',intent},{status:'blocked'}]);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('failed record fsync never returns dispatch permission and leaves lock',()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'intent-journal-'));
 try {
  const url=pathToFileURL(join(process.cwd(),'experimental/agent-mcp/intent-journal.js')).href;
  const code=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';let n=0;const original=fs.fsyncSync;fs.fsyncSync=(fd)=>{if(++n===2)throw Error('synthetic fsync failure');return original(fd)};syncBuiltinESMExports();const {createJournal}=await import(${JSON.stringify(url)});try {createJournal(process.argv[1],${JSON.stringify(scope)}).begin(${JSON.stringify(intent)});process.exitCode=2}catch {console.log('failed before dispatch')}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code,dir],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/failed before dispatch/);
  assert.equal(createJournal(dir).begin(intent).status,'blocked');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
