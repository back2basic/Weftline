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
test('MCP closes a client that floods requests without reading responses',{timeout:15000},async t=>{
 const f=await fixture(t),args=[server,'--enable','--endpoint',`https://127.0.0.1:${f.port}`,'--ca',f.cert,'--actor','alice','--board','b','--guard','0'];
 const child=spawn(process.execPath,args,{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},stdio:['pipe','pipe','pipe']});
 child.stdin.on('error',()=>{});child.stderr.resume();t.after(()=>{child.stdin.destroy();child.kill();});
 const initial=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n';
 const ready=new Promise((resolve,reject)=>{let s='';child.stdout.on('data',function read(b){s+=b;if(s.includes('\n')){child.stdout.off('data',read);child.stdout.pause();resolve();}});child.once('exit',()=>reject(Error('server closed before initialize')));});
 child.stdin.write(initial);await ready;
 const ended=new Promise(resolve=>child.once('exit',()=>resolve(true)));
 const batch=Array.from({length:100},(_,i)=>JSON.stringify({jsonrpc:'2.0',id:i+2,method:'ping'})+'\n').join('');
 for(let i=0;i<200&&child.exitCode===null;i++){child.stdin.write(batch);await new Promise(r=>setTimeout(r,2));}
 const closed=await Promise.race([ended,new Promise(r=>setTimeout(()=>r(false),2000))]);
 assert.equal(closed,true,'non-reading client must be disconnected');
 assert.equal(child.exitCode,73,'disconnect must be caused by the output queue limit');
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
