// Synthetic Appwrite transport; TLS is verified against the generated CA.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,existsSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import https from 'node:https';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=resolve(import.meta.dirname,'../../..'), server=resolve(import.meta.dirname,'../server.js');
async function fixture(t,readOnly=false){
 const dir=mkdtempSync(join(process.env.TMPDIR,'weftline-mcp-')),key=join(dir,'key'),cert=join(dir,'cert');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const endpoint='https://provider.example.test/v1',project='project';
 writeFileSync(join(dir,'api'),`apikey:synthetic\nprojectID:${project}\nendpoint:${endpoint}\n`);
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./experimental/agent-mcp/test/fake-provider.js',WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_HOST:'127.0.0.1',WEFTLINE_REVIEW_PORT:'0',WEFTLINE_REVIEW_BOARD:'b',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_TLS_KEY_FILE:key,WEFTLINE_TLS_CERT_FILE:cert,APPWRITE_KEY_FILE:join(dir,'api'),REVIEW_TEST_WRITES_FILE:join(dir,'writes')};
 if(readOnly)env.WEFTLINE_REVIEW_READ_ONLY='1';
 const child=spawn(process.execPath,['experimental/review-v1-cli.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>child.once('exit',r));}rmSync(dir,{recursive:true,force:true});});
 const port=await new Promise((resolvePort,reject)=>{const timer=setTimeout(()=>reject(Error('listener timeout')),5000);child.once('exit',()=>{clearTimeout(timer);reject(Error('listener exited'));});child.stdout.on('data',()=>{const m=output.match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolvePort(+m[1]);}});});
 return {dir,cert,port};
}
async function client(t,f,actor='alice',session='alice',board='b',guard='0'){
 const transport=new StdioClientTransport({command:process.execPath,args:[server,'--enable','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor',actor,'--board',board,'--guard',guard],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:session},stderr:'pipe'});
 let stderr='';transport.stderr.on('data',x=>stderr+=x);const client=new Client({name:'weftline-integration-test',version:'1.0.0'});await client.connect(transport);t.after(()=>client.close());return {client,stderr:()=>stderr};
}
test('MCP discovers and resolves through the real local listener without exposing its session or writing',{timeout:20000},async t=>{
 const f=await fixture(t),c=await client(t,f,'alice','synthetic-private-session');
 const tools=await c.client.listTools();assert.deepEqual(tools.tools.map(x=>x.name).sort(),['discover','resolve']);
 const d=await c.client.callTool({name:'discover',arguments:{}});assert.notEqual(d.isError,true);const discovery=JSON.parse(d.content[0].text);assert.equal(discovery.status,'partial');assert.equal(discovery.consistency,'advisory-non-snapshot');assert.ok(discovery.tasks.some(t=>t.task==='task'&&t.title==='Synthetic task'));
 const r=await c.client.callTool({name:'resolve',arguments:{task:'task'}});assert.notEqual(r.isError,true);const value=JSON.parse(r.content[0].text);assert.equal(value.state,'unknown');assert.equal(value.observed.generation,4);
 const next=await c.client.callTool({name:'resolve',arguments:{task:'task',continuation:value.continuation}});assert.equal(JSON.parse(next.content[0].text).observed.generation,8);
 assert.equal(existsSync(join(f.dir,'writes')),false);assert.doesNotMatch(JSON.stringify([d,r,next])+c.stderr(),/WEFTLINE_AGENT_SESSION|synthetic-private-session/);
});
test('read-only listener rejects mutation routes while MCP discovery remains usable',{timeout:20000},async t=>{
 const f=await fixture(t,true),c=await client(t,f);
 const discovery=await c.client.callTool({name:'discover',arguments:{}});assert.equal(JSON.parse(discovery.content[0].text).status,'partial');
 const resolved=await c.client.callTool({name:'resolve',arguments:{task:'task'}});assert.equal(JSON.parse(resolved.content[0].text).state,'unknown');
 for(const path of ['/review/genesis','/review/transition','/review/receipt','/review/task','/login','/knowledge/v2/create','/review/discovery?x=1','/review/resolve?x=1']){
  const status=await new Promise((resolveStatus,reject)=>{const req=https.request({hostname:'127.0.0.1',port:f.port,path,method:'POST',ca:readFileSync(f.cert),headers:{host:`127.0.0.1:${f.port}`,origin:`https://127.0.0.1:${f.port}`,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:'__Host-weftline=alice'}},res=>{res.resume();res.on('end',()=>resolveStatus(res.statusCode));});req.on('error',reject);req.end('{}');});
  assert.equal(status,404,`read-only listener must reject ${path}`);
 }
 assert.equal(existsSync(join(f.dir,'writes')),false);
});
test('MCP explicit HTTPS mode calls the synthetic read-only listener',{timeout:20000},async t=>{
 const f=await fixture(t,true);
 const transport=new StdioClientTransport({command:process.execPath,args:[server,'--enable','--remote-https','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor','alice','--board','b','--guard','0'],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},stderr:'pipe'});
 const c=new Client({name:'weftline-remote-test',version:'1.0.0'});await c.connect(transport);t.after(()=>c.close());
 const result=await c.callTool({name:'discover',arguments:{}});
 assert.equal(result.isError,undefined);assert.equal(JSON.parse(result.content[0].text).status,'partial');
 assert.equal(existsSync(join(f.dir,'writes')),false);
});
test('read-only listener refuses a mismatched actor, board and guard',{timeout:20000},async t=>{
 const f=await fixture(t,true);
 for(const [actor,session,board,guard] of [['alice','bob','b','0'],['alice','alice','other','0'],['alice','alice','b','1']]){
  const c=await client(t,f,actor,session,board,guard);
  for(const [name,args] of [['discover',{}],['resolve',{task:'task'}]]){const r=await c.client.callTool({name,arguments:args});assert.equal(r.isError,true);}
 }
 assert.equal(existsSync(join(f.dir,'writes')),false);
});
test('MCP returns a generic error when actor and session do not match',{timeout:20000},async t=>{
 const f=await fixture(t),c=await client(t,f,'alice','bob');const r=await c.client.callTool({name:'discover',arguments:{}});assert.equal(r.isError,true);assert.doesNotMatch(JSON.stringify(r)+c.stderr(),/bob|alice|session/i);assert.equal(existsSync(join(f.dir,'writes')),false);
});
test('MCP refuses wrong board or guard without writing',{timeout:20000},async t=>{
 const f=await fixture(t);
 for(const [board,guard] of [['other','0'],['b','1']]){const c=await client(t,f,'alice','alice',board,guard);const r=await c.client.callTool({name:'discover',arguments:{}});assert.equal(r.isError,true);assert.doesNotMatch(JSON.stringify(r)+c.stderr(),/alice|session/i);}
 assert.equal(existsSync(join(f.dir,'writes')),false);
});
test('MCP rejects unsupported tools and extra fields without writing',{timeout:20000},async t=>{
 const f=await fixture(t),c=await client(t,f);
 const malformed=await c.client.callTool({name:'discover',arguments:{session:'must-not-be-used'}});assert.equal(malformed.isError,true);
 const write=await c.client.callTool({name:'claim',arguments:{task:'task'}});assert.equal(write.isError,true);assert.equal(existsSync(join(f.dir,'writes')),false);
});
test('MCP does not reflect secrets in invalid tool names or argument keys',{timeout:20000},async t=>{
 const f=await fixture(t),c=await client(t,f),marker='synthetic-secret-marker';
 const invalid=await c.client.callTool({name:'discover',arguments:{[marker]:true}});
 const unknown=await c.client.callTool({name:marker,arguments:{}});
 assert.equal(invalid.isError,true);assert.equal(unknown.isError,true);
 assert.doesNotMatch(JSON.stringify([invalid,unknown])+c.stderr(),/synthetic-secret-marker/);
 assert.equal(existsSync(join(f.dir,'writes')),false);
});
test('MCP refuses missing or malformed session at startup without exposing it',{timeout:20000},async t=>{
 const f=await fixture(t),args=[server,'--enable','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor','alice','--board','b','--guard','0'];
 for(const session of [undefined,'bad;private-token']){
  const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,...(session===undefined?{}:{WEFTLINE_AGENT_SESSION:session})};
  const r=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:5000});
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/Weftline agent unavailable/);assert.doesNotMatch(r.stderr,/private-token/);
 }
 assert.equal(existsSync(join(f.dir,'writes')),false);
});
test('MCP protocol validation does not reflect untrusted extension keys',{timeout:20000},async t=>{
 const f=await fixture(t),args=[server,'--enable','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor','alice','--board','b','--guard','0'];
 const child=spawn(process.execPath,args,{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 t.after(()=>{child.stdin.destroy();child.kill();});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{extensions:{'synthetic-secret-marker':1}},clientInfo:{name:'test',version:'1'}}})+'\n');
 const output=await new Promise((resolve,reject)=>{let buffer='';const timer=setTimeout(()=>reject(Error('no response')),5000);child.stdout.on('data',x=>{buffer+=x.toString();if(buffer.includes('\n')){clearTimeout(timer);resolve(buffer.slice(0,buffer.indexOf('\n')));}});child.once('exit',()=>{clearTimeout(timer);reject(Error('server exited'));});});
 const response=JSON.parse(output);assert.equal(response.id,1);assert.equal(typeof response.error.code,'number');assert.equal(response.error.message,'Request unavailable.');assert.equal(Object.hasOwn(response.error,'data'),false);assert.doesNotMatch(output+stderr,/synthetic-secret-marker/);
});
async function awaitClosedWithin(closed,ms){
 let timer;try{return await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms);})]);}finally{clearTimeout(timer);}
}
test('malformed JSON does not expose input or prevent a following ping',{timeout:10000},async t=>{
 const f=await fixture(t),args=[server,'--enable','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor','alice','--board','b','--guard','0'];
 const child=spawn(process.execPath,args,{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));t.after(()=>stopStdioChild(child,closed));child.stdin.on('error',()=>{});
 let output='',stderr='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>stderr+=x);
 child.stdin.write('{"synthetic-secret-invalid-json":\n'+JSON.stringify({jsonrpc:'2.0',id:7,method:'ping'})+'\n');
 const until=performance.now()+4000;while(!output.includes('\n')&&performance.now()<until&&child.exitCode===null)await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(JSON.parse(output.trim()),{jsonrpc:'2.0',id:7,result:{}});assert.doesNotMatch(output+stderr,/synthetic-secret-invalid-json/);
 child.stdin.end();assert.deepEqual(await awaitClosedWithin(closed,3000),{code:0,signal:null});
});
test('closed stdout retains the SDK stream-error termination behavior',{timeout:10000},async t=>{
 const f=await fixture(t),args=[server,'--enable','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor','alice','--board','b','--guard','0'];
 const child=spawn(process.execPath,args,{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));t.after(()=>stopStdioChild(child,closed));child.stdin.on('error',()=>{});
 let stderr='';child.stderr.on('data',x=>stderr+=x);
 const ready=new Promise(resolve=>child.stdout.once('data',resolve));
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})+'\n');await ready;child.stdout.destroy();
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'ping'})+'\n');
 const outcome=await awaitClosedWithin(closed,3000);
 assert.deepEqual(outcome,{code:1,signal:null});assert.match(stderr,/EPIPE/);assert.doesNotMatch(stderr,/WEFTLINE_AGENT_SESSION|alice/);
});
test('watched output preserves SDK send and stream error behavior',{timeout:10000},async()=>{
 const {StdioServerTransport}=await import('@modelcontextprotocol/sdk/server/stdio.js');
 const {Writable}=await import('node:stream');
 const source=readFileSync(server,'utf8');
 const definition=source.slice(source.indexOf('class RedactedTransport '),source.indexOf('\n\ntry {'));
 const Watched=new Function('StdioServerTransport',definition+';return RedactedTransport')(StdioServerTransport);
 async function run(Transport,highWaterMark,fail){
  const seen=[];let data='';
  const out=new Writable({highWaterMark,write(chunk,encoding,callback){data+=chunk;setTimeout(()=>callback(fail?Error('synthetic-stream-error'):null),20);}});
  out.on('error',error=>seen.push(error.message));
  const transport=new Transport(process.stdin,out,{maxBufferSize:65536});let settled=false,rejected=false;
  transport.send({jsonrpc:'2.0',id:1,result:{}}).then(()=>{settled=true;},()=>{settled=true;rejected=true;});
  await new Promise(resolve=>setTimeout(resolve,5));const before=settled;
  await new Promise(resolve=>setTimeout(resolve,60));
  const result={before,settled,rejected,seen,data:JSON.parse(data),drainListeners:out.listenerCount('drain')};
  out.destroy();return result;
 }
 for(const hwm of [1,65536])for(const fail of [false,true]){
  const original=await run(StdioServerTransport,hwm,fail),watched=await run(Watched,hwm,fail);
  assert.deepEqual(watched,original,`SDK semantics changed for highWaterMark=${hwm}, error=${fail}`);
 }
});
test('expired callback is not accepted when its timer was delayed',{timeout:7000},()=>{
 const script=`import {readFileSync} from 'node:fs';import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
const source=readFileSync(${JSON.stringify(server)},'utf8');const definition=source.slice(source.indexOf('class RedactedTransport '),source.indexOf('\\n\\ntry {'));
const T=new Function('StdioServerTransport',definition+';return RedactedTransport')(StdioServerTransport);
const out={write(data,done){setTimeout(()=>{const until=performance.now()+300;while(performance.now()<until){}done();},1900);return true},once(){}};
new T(process.stdin,out,{}).send({jsonrpc:'2.0',id:1,result:{}});`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:resolve(root,'experimental/agent-mcp'),env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR},encoding:'utf8',timeout:5000});
 assert.equal(r.error,undefined);assert.equal(r.status,74);assert.equal(r.signal,null);
});
test('a synchronous drain registration error releases its waiter slot',{timeout:5000},()=>{
 const script=`import {readFileSync} from 'node:fs';import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
const source=readFileSync(${JSON.stringify(server)},'utf8');const definition=source.slice(source.indexOf('class RedactedTransport '),source.indexOf('\\n\\ntry {'));
const T=new Function('StdioServerTransport',definition+';return RedactedTransport')(StdioServerTransport);
const out={write(data,done){done();return false},once(){throw Error('registration')}};const t=new T(process.stdin,out,{});
for(let i=0;i<2050;i++){try{await t.send({jsonrpc:'2.0',id:i,result:{}});process.exit(2)}catch(e){if(e.message!=='registration')process.exit(3)}}`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:resolve(root,'experimental/agent-mcp'),env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR},encoding:'utf8',timeout:4000});
 assert.equal(r.error,undefined);assert.equal(r.status,0);assert.equal(r.signal,null);
});
test('completed drain cycles release listener slots and watchdog timers',{timeout:5000},()=>{
 const script=`import {readFileSync} from 'node:fs';import {EventEmitter} from 'node:events';import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
const source=readFileSync(${JSON.stringify(server)},'utf8');const definition=source.slice(source.indexOf('class RedactedTransport '),source.indexOf('\\n\\ntry {'));
const T=new Function('StdioServerTransport',definition+';return RedactedTransport')(StdioServerTransport);
class Output extends EventEmitter{write(data,done){setImmediate(()=>{done();this.emit('drain')});return false}};const output=new Output();const t=new T(process.stdin,output,{});
for(let i=0;i<2050;i++){await t.send({jsonrpc:'2.0',id:i,result:{}});if(output.listenerCount('drain'))process.exit(2)}`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:resolve(root,'experimental/agent-mcp'),env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR},encoding:'utf8',timeout:4000});
 assert.equal(r.error,undefined);assert.equal(r.status,0);assert.equal(r.signal,null);
});
test('pending SDK drain waiters are bounded even as write callbacks complete',{timeout:10000},()=>{
 const script=`import {readFileSync} from 'node:fs';import {EventEmitter} from 'node:events';import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
const source=readFileSync(${JSON.stringify(server)},'utf8');const definition=source.slice(source.indexOf('class RedactedTransport '),source.indexOf('\\n\\ntry {'));
const T=new Function('StdioServerTransport',definition+';return RedactedTransport')(StdioServerTransport);
class Output extends EventEmitter{write(data,done){setImmediate(done);return false}};const output=new Output();output.setMaxListeners(0);const transport=new T(process.stdin,output,{});
for(let i=0;i<2049;i++){transport.send({jsonrpc:'2.0',id:i,result:{}});await new Promise(resolve=>setImmediate(resolve));}`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:resolve(root,'experimental/agent-mcp'),env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR},encoding:'utf8',timeout:5000});
 assert.equal(r.error,undefined);assert.equal(r.status,75);assert.equal(r.signal,null);
});
test('pending callback limit exits 75 before retaining another callback',{timeout:10000},()=>{
 const script=`import {readFileSync} from 'node:fs';import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
const source=readFileSync(${JSON.stringify(server)},'utf8');const definition=source.slice(source.indexOf('class RedactedTransport '),source.indexOf('\\n\\ntry {'));
const T=new Function('StdioServerTransport',definition+';return RedactedTransport')(StdioServerTransport);
const out={write(){return true},once(){}};const transport=new T(process.stdin,out,{});
for(let i=0;i<2049;i++)transport.send({jsonrpc:'2.0',id:i,result:{}});`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:resolve(root,'experimental/agent-mcp'),env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR},encoding:'utf8',timeout:5000});
 assert.equal(r.error,undefined);assert.equal(r.status,75);assert.equal(r.signal,null);
});
test('output queue threshold checks the actual transport before each send',{timeout:10000},()=>{
 // Evaluate the exact class definition from server.js without starting its CLI.
 // The SDK transport and its send implementation remain real; only the observed
 // stdout queue length is controlled so both sides of the boundary are repeatable.
 const script=`import {readFileSync} from 'node:fs';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
const source=readFileSync(${JSON.stringify(server)},'utf8');
const definition=source.slice(source.indexOf('class RedactedTransport '),source.indexOf('\\n\\ntry {'));
if(!definition.startsWith('class RedactedTransport ')||!definition.endsWith('}'))throw Error('transport definition not found');
const Transport=new Function('StdioServerTransport',definition+';return RedactedTransport')(StdioServerTransport);
let queued=65536;Object.defineProperty(process.stdout,'writableLength',{get:()=>queued});
const transport=new Transport(process.stdin,process.stdout,{maxBufferSize:65536});
await transport.send({jsonrpc:'2.0',id:1,result:{}});
process.stderr.write('at-limit-sent\\n');queued=65537;
await transport.send({jsonrpc:'2.0',id:2,result:{}});
process.stderr.write('above-limit-sent\\n');`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:resolve(root,'experimental/agent-mcp'),env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR},encoding:'utf8',timeout:5000});
 assert.equal(r.error,undefined);assert.match(r.stderr,/at-limit-sent/);
 assert.equal(r.status,73,'the next send above the output queue limit must exit 73');assert.doesNotMatch(r.stderr,/above-limit-sent/);
 assert.equal(JSON.parse(r.stdout).id,1);
});
async function floodUntilExit(child,batch,deadline,signal){
 const exited=()=>child.exitCode!==null||child.signalCode!==null;
 const stopped=()=>signal?.aborted||performance.now()>=deadline;
 const wait=(delay,drain=false)=>new Promise(resolve=>{
  const target=drain?deadline:Math.min(performance.now()+delay,deadline);let timer;
  const finish=()=>{clearTimeout(timer);child.off('exit',finish);if(drain)child.stdin.off('drain',finish);signal?.removeEventListener('abort',finish);resolve();};
  const tick=()=>{const remaining=target-performance.now();if(remaining>0)timer=setTimeout(tick,Math.ceil(remaining));else finish();};
  timer=setTimeout(tick,Math.max(0,Math.ceil(target-performance.now())));
  child.once('exit',finish);if(drain)child.stdin.once('drain',finish);signal?.addEventListener('abort',finish,{once:true});
  if(exited()||stopped())finish();
 });
 for(let i=0;i<200;i++){
  if(stopped())return 'timeout';
  if(exited())return 'exit';
  if(!child.stdin.write(batch))await wait(deadline-performance.now(),true);
  if(stopped())return 'timeout';
  if(exited())return 'exit';
  await wait(2);
 }
 if(!exited()&&!stopped())await wait(deadline-performance.now());
 return stopped()?'timeout':exited()?'exit':'timeout';
}
test('flood deadline stops stalled writes and removes exit/drain listeners',{timeout:2000},async()=>{
 const {EventEmitter}=await import('node:events');
 const child=new EventEmitter();child.stdin=new EventEmitter();child.exitCode=null;child.signalCode=null;
 let writes=0;child.stdin.write=()=>{writes++;return false;};
 const start=performance.now();
 assert.equal(await floodUntilExit(child,'batch',start+80),'timeout');
 assert.ok(performance.now()-start<600,'stalled drain must respect the shared budget');
 assert.equal(writes,1);assert.equal(child.listenerCount('exit'),0);assert.equal(child.stdin.listenerCount('drain'),0);
 const exiting=new EventEmitter();exiting.stdin=new EventEmitter();exiting.exitCode=null;exiting.signalCode=null;
 let exitWrites=0;exiting.stdin.write=()=>{exitWrites++;setImmediate(()=>{exiting.exitCode=73;exiting.emit('exit',73,null);});return false;};
 assert.equal(await floodUntilExit(exiting,'batch',performance.now()+500),'exit');
 assert.equal(exitWrites,1);assert.equal(exiting.listenerCount('exit'),0);assert.equal(exiting.stdin.listenerCount('drain'),0);
 const aborting=new EventEmitter();aborting.stdin=new EventEmitter();aborting.exitCode=null;aborting.signalCode=null;let abortWrites=0;
 const controller=new AbortController();aborting.stdin.write=()=>{abortWrites++;setImmediate(()=>controller.abort());return false;};
 assert.equal(await floodUntilExit(aborting,'batch',performance.now()+500,controller.signal),'timeout');
 assert.equal(abortWrites,1);assert.equal(aborting.listenerCount('exit'),0);assert.equal(aborting.stdin.listenerCount('drain'),0);
});
async function stopStdioChild(child,closed){
 // Drain output so an already-exited child's close event can be delivered.
 child.stdout.resume();child.stderr.resume();child.stdin.destroy();
 const wait=ms=>new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),ms);closed.then(result=>{clearTimeout(timer);resolve(result);});});
 let result=await wait(200);if(result)return result;
 if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
 result=await wait(200);if(result)return result;
 if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
 result=await wait(1500);
 if(!result)throw Error('stdio child closure not observed after SIGKILL');
 return result;
}
test('stdio teardown escalates and awaits the exact stubborn child close',{timeout:5000},async t=>{
 const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdin.resume();process.stdout.write('ready\\n');setInterval(()=>{},1000)"],{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR},stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 child.stdin.on('error',()=>{});child.stderr.resume();
 t.after(()=>stopStdioChild(child,closed));
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child ready timeout')),2000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});});
 const result=await stopStdioChild(child,closed);
 assert.deepEqual(result,{code:null,signal:'SIGKILL'});
});
test('last backpressured stdio send exits without another request',{timeout:15000},async t=>{
 const f=await fixture(t),probe=join(f.dir,'observe-write.cjs');
 // Observe the real write result without changing it or bypassing the guard.
 writeFileSync(probe,"const out=process.stdout,write=out.write;let n=0;out.write=function(chunk,...args){const id=++n,original=typeof args.at(-1)==='function'?args.pop():null;const result=write.call(this,chunk,...args,function(...values){process.stderr.write('DONE '+id+'\\n');if(original)original.apply(this,values);});process.stderr.write('WRITE '+id+' '+result+'\\n');return result;};");
 const args=[server,'--enable','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor','alice','--board','b','--guard','0'];
 const child=spawn(process.execPath,args,{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice',NODE_OPTIONS:`--require ${probe}`},stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 t.after(()=>stopStdioChild(child,closed));child.stdin.on('error',()=>{});
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 let output='';child.stdout.on('data',chunk=>output+=chunk);
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
 const wait=async(predicate,ms)=>{const end=performance.now()+ms;while(!predicate()&&performance.now()<end&&child.exitCode===null)await new Promise(r=>setTimeout(r,10));return predicate();};
 assert.ok(await wait(()=>output.includes('\n'),5000),'initial response');child.stdout.pause();
 let blocked=false;
 for(let i=0;i<50&&!blocked&&child.exitCode===null;i++){
  const id=i+2;
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:String(i).padStart(60000,'x'),method:'ping'})+'\n');
  assert.ok(await wait(()=>stderr.includes(`WRITE ${id} `),1000),'write observed');
  await new Promise(r=>setTimeout(r,100));
  blocked=stderr.includes(`WRITE ${id} false\n`)&&!stderr.includes(`DONE ${id}\n`);
 }
 assert.ok(blocked,'the last write must return false and remain incomplete');
 assert.ok(await wait(()=>child.exitCode!==null||child.signalCode!==null,4000),'last send must not remain stuck indefinitely');
 assert.equal(child.exitCode,74);assert.equal(child.signalCode,null);
});
test('last accepted small stdio write cannot strand transport close',{timeout:15000},async t=>{
 const f=await fixture(t),probe=join(f.dir,'observe-small-write.mjs');
 writeFileSync(probe,`import {StdioServerTransport} from ${JSON.stringify(new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',import.meta.url).href)};\nconst close=StdioServerTransport.prototype.close;StdioServerTransport.prototype.close=function(...args){process.stderr.write('INPUT_CLOSED\\n');return close.apply(this,args);};\nconst out=process.stdout,write=out.write;let n=0;out.write=function(chunk,...args){const id=++n,original=typeof args.at(-1)==='function'?args.pop():null;const result=write.call(this,chunk,...args,function(...values){process.stderr.write('DONE '+id+'\\n');if(original)original.apply(this,values);});if(result&&out.writableLength>0)process.stderr.write('PENDING_SMALL '+id+'\\n');return result;};`);
 const args=[server,'--enable','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor','alice','--board','b','--guard','0'];
 const child=spawn(process.execPath,args,{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice',NODE_OPTIONS:`--import ${probe}`},stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));t.after(()=>stopStdioChild(child,closed));child.stdin.on('error',()=>{});
 let stderr='',output='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.on('data',chunk=>output+=chunk);
 const wait=async(predicate,ms)=>{const end=performance.now()+ms;while(!predicate()&&performance.now()<end&&child.exitCode===null)await new Promise(r=>setTimeout(r,5));return predicate();};
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
 assert.ok(await wait(()=>output.includes('\n'),5000));child.stdout.pause();
 for(let i=0;i<1000&&!stderr.includes('PENDING_SMALL')&&child.exitCode===null;i++){
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:String(i).padStart(1024,'x'),method:'ping'})+'\n');await new Promise(r=>setTimeout(r,5));
 }
 const match=stderr.match(/PENDING_SMALL (\d+)\n/);assert.ok(match,'a small write must be queued but accepted');
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.ok(!stderr.includes(`DONE ${match[1]}\n`),'the accepted write must still be incomplete');
 // An oversized unterminated input triggers the SDK buffer-error close.
 child.stdin.write('x'.repeat(65537));
 assert.ok(await wait(()=>stderr.includes('INPUT_CLOSED'),2000),'SDK must close after input overflow');
 assert.ok(await wait(()=>child.exitCode!==null||child.signalCode!==null,4000),'input close must not leave accepted output permanently pending');
 assert.equal(child.exitCode,74);assert.equal(child.signalCode,null);
});
test('a genuinely blocked output recovers and watchdog cleanup permits normal shutdown',{timeout:15000},async t=>{
 const f=await fixture(t),probe=join(f.dir,'observe-recovery.cjs');
 writeFileSync(probe,"const out=process.stdout,write=out.write;let n=0;out.write=function(chunk,...args){const id=++n,original=typeof args.at(-1)==='function'?args.pop():null;const result=write.call(this,chunk,...args,function(...values){process.stderr.write('DONE '+id+'\\n');if(original)original.apply(this,values);});process.stderr.write('WRITE '+id+' '+result+'\\n');return result;};");
 const args=[server,'--enable','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor','alice','--board','b','--guard','0'];
 const child=spawn(process.execPath,args,{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice',NODE_OPTIONS:`--require ${probe}`},stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));t.after(()=>stopStdioChild(child,closed));child.stdin.on('error',()=>{});
 let stderr='',buffer='',messages=[];child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))!==-1){messages.push(JSON.parse(buffer.slice(0,n)));buffer=buffer.slice(n+1);}});
 const wait=async(predicate,ms)=>{const end=performance.now()+ms;while(!predicate()&&performance.now()<end&&child.exitCode===null)await new Promise(r=>setTimeout(r,10));return predicate();};
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
 assert.ok(await wait(()=>messages.length===1,5000));child.stdout.pause();
 let blocked=false,sent=0;
 for(let i=0;i<50&&!blocked&&child.exitCode===null;i++){
  const id=i+2;sent++;
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:String(i).padStart(60000,'x'),method:'ping'})+'\n');
  assert.ok(await wait(()=>stderr.includes(`WRITE ${id} `),1000));await new Promise(r=>setTimeout(r,100));
  blocked=stderr.includes(`WRITE ${id} false\n`)&&!stderr.includes(`DONE ${id}\n`);
 }
 assert.ok(blocked,'a real write must still be pending');child.stdout.resume();
 assert.ok(await wait(()=>messages.length===sent+1,1000),'all queued responses arrive after recovery');
 await new Promise(r=>setTimeout(r,2300));assert.equal(child.exitCode,null,'no stale watchdog may fire');
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:999,method:'ping'})+'\n');
 assert.ok(await wait(()=>messages.some(m=>m.id===999),1000),'server remains usable');
 child.stdin.end();assert.deepEqual(await awaitClosedWithin(closed,3000),{code:0,signal:null});
});
test('MCP closes a client that floods requests without reading responses',{timeout:15000},async t=>{
 const f=await fixture(t),args=[server,'--enable','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor','alice','--board','b','--guard','0'];
 const child=spawn(process.execPath,args,{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 t.after(()=>stopStdioChild(child,closed));child.stdin.on('error',()=>{});child.stderr.resume();
 const initial=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n';
 const ready=new Promise((resolve,reject)=>{let s='';const finish=err=>{clearTimeout(timer);child.stdout.off('data',read);child.off('exit',closed);t.signal.removeEventListener('abort',aborted);if(err)reject(err);else{child.stdout.pause();resolve();}};const read=b=>{s+=b;if(s.includes('\n'))finish();};const closed=()=>finish(Error('server closed before initialize'));const aborted=()=>finish(Error('initialize cancelled'));const timer=setTimeout(()=>finish(Error('initialize timeout')),5000);child.stdout.on('data',read);child.once('exit',closed);t.signal.addEventListener('abort',aborted,{once:true});if(t.signal.aborted)aborted();});
 child.stdin.write(initial);await ready;
 // This bounded, paced stdio smoke may still hit the SDK's competing pre-split
 // input limit under scheduling delays; it does not prove output liveness.
 const batch=Array.from({length:10},(_,i)=>JSON.stringify({jsonrpc:'2.0',id:String(i).padStart(1024,'x'),method:'ping'})+'\n').join('');
 const result=await floodUntilExit(child,batch,performance.now()+7000,t.signal);
 assert.equal(result,'exit','non-reading client must exit before the flood deadline');
 assert.equal(child.exitCode,73,'non-reading client must exit 73 because of the output queue limit');
});
test('MCP serves pipelined requests after a temporary reader stall',{timeout:20000},async t=>{
 const f=await fixture(t),args=[server,'--enable','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor','alice','--board','b','--guard','0'];
 const child=spawn(process.execPath,args,{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 t.after(()=>stopStdioChild(child,closed));child.stdin.on('error',()=>{});child.stderr.resume();
 let buffer='',messages=[];child.stdout.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){messages.push(JSON.parse(buffer.slice(0,n)));buffer=buffer.slice(n+1);}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
 const until=async predicate=>{const end=Date.now()+5000;while(!predicate()&&Date.now()<end&&child.exitCode===null)await new Promise(r=>setTimeout(r,10));assert.ok(predicate(),'expected responses must arrive');};
 await until(()=>messages.length===1);assert.equal(messages[0].id,1);
 child.stdout.pause();
 const ids=Array.from({length:30},(_,i)=>String(i).padStart(1024,'p'));
 for(let i=0;i<ids.length;i+=10){child.stdin.write(ids.slice(i,i+10).map(id=>JSON.stringify({jsonrpc:'2.0',id,method:'ping'})+'\n').join(''));await new Promise(r=>setTimeout(r,2));}
 await new Promise(r=>setTimeout(r,100));child.stdout.resume();
 await until(()=>messages.length===31);assert.deepEqual(messages.slice(1).map(m=>m.id).sort(),ids.sort());
 assert.ok(messages.slice(1).every(m=>m.result&&!m.error));assert.equal(child.exitCode,null);
});
test('MCP remains usable across sequential requests from a reading client',{timeout:20000},async t=>{
 const f=await fixture(t),c=await client(t,f);
 for(let i=0;i<100;i++)await c.client.ping();
 const r=await c.client.callTool({name:'discover',arguments:{}});
 assert.equal(JSON.parse(r.content[0].text).status,'partial');
 assert.equal(existsSync(join(f.dir,'writes')),false);
});
test('isolated Hermes CLI discovers and calls the synthetic review tools',{skip:!process.env.WEFTLINE_HERMES_SOURCE_DIR,timeout:30000},async t=>{
 const f=await fixture(t),home=join(f.dir,'hermes-home');
 const args=[server,'--enable','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor','alice','--board','b','--guard','0'];
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,HERMES_HOME:home};
 const config={weftline:{command:process.execPath,args,env:{WEFTLINE_AGENT_SESSION:'alice'}}};
 const set=spawnSync('hermes',['config','set','mcp_servers',JSON.stringify(config)],{cwd:root,env,encoding:'utf8',timeout:10000});
 assert.equal(set.status,0,'isolated Hermes configuration must succeed');
 const result=spawnSync('hermes',['mcp','test','weftline'],{cwd:root,env,encoding:'utf8',timeout:20000});
 assert.equal(result.status,0,'Hermes MCP test must succeed');
 const output=result.stdout+'\n'+result.stderr;
 assert.match(output,/discover/i);assert.match(output,/resolve/i);assert.doesNotMatch(output,/WEFTLINE_AGENT_SESSION|synthetic-session/i);
 const script=`import json\nfrom tools.mcp_tool_discovery import discover_mcp_tools\nfrom tools.mcp_tool_handlers import _make_tool_handler\nfrom tools.mcp_tool_lifecycle import shutdown_mcp_servers\ndef partial(v):\n if isinstance(v,str):\n  try: return partial(json.loads(v))\n  except (ValueError,RecursionError): return False\n if isinstance(v,dict): return (v.get('status')=='partial' and v.get('consistency')=='advisory-non-snapshot') or any(partial(x) for x in v.values())\n if isinstance(v,list): return any(partial(x) for x in v)\n return False\ntry:\n names=discover_mcp_tools(allowed_mcp_names=['weftline'])\n result=_make_tool_handler('weftline','discover',10)({})\n print(json.dumps({'discover_registered':any('discover' in x for x in names),'partial':partial(result)}))\nfinally:\n shutdown_mcp_servers()\n`;
 const actual=spawnSync('python3',['-c',script],{cwd:process.env.WEFTLINE_HERMES_SOURCE_DIR,env:{...env,PYTHONPATH:process.env.WEFTLINE_HERMES_SOURCE_DIR},encoding:'utf8',timeout:20000});
 assert.equal(actual.status,0,'Hermes native MCP handler must finish');
 const evidence=actual.stdout.split('\n').filter(x=>x.startsWith('{')).map(x=>JSON.parse(x)).at(-1);
 assert.deepEqual(evidence,{discover_registered:true,partial:true});
 assert.equal(existsSync(join(f.dir,'writes')),false);
});
test('opt-in actual Codex client invokes synthetic discovery',{skip:process.env.WEFTLINE_CODEX_LIVE_PROBE!=='1',timeout:120000},async t=>{
 const f=await fixture(t),args=[server,'--enable','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor','alice','--board','b','--guard','0'];
 const config=`mcp_servers.weftline={command=${JSON.stringify(process.execPath)},args=[${args.map(x=>JSON.stringify(x)).join(',')}],env_vars=["WEFTLINE_AGENT_SESSION"]}`;
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice',...(process.env.CODEX_HOME?{CODEX_HOME:process.env.CODEX_HOME}:{})};
 const r=spawnSync('codex',['exec','--ignore-user-config','--sandbox','read-only','--skip-git-repo-check','--json','-c',config,'Use only the weftline discover MCP tool once, then report its status. Do not use shell commands.'],{cwd:root,env,encoding:'utf8',timeout:100000,maxBuffer:4*1024*1024});
 assert.equal(r.status,0,'Codex client did not complete');
 const events=r.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const calls=events.filter(e=>e.type==='item.completed'&&e.item?.type==='mcp_tool_call'&&e.item?.server==='weftline'&&e.item?.tool==='discover');
 assert.equal(calls.length,1,'Codex must invoke the actual discover tool once');
 assert.equal(calls[0].item.status,'completed');
 const result=calls[0].item.result;assert.ok(result&&!result.isError,'Codex tool result must succeed');
 const payload=JSON.parse(result.content.find(x=>x.type==='text').text);assert.equal(payload.status,'partial');
 assert.equal(existsSync(join(f.dir,'writes')),false);
});
