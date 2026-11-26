// Synthetic HTTPS ingress and provider; not a test of the deployed proxy.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join,resolve} from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=resolve(import.meta.dirname,'../../..');
test('remote MCP crosses synthetic HTTPS ingress into the actual proxy receiver',{timeout:20000},async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR??join(process.env.HOME,'.hermes/cache/scratch'),'wf-mcp-proxy-'));
 let receiverPort,child,ingress,childClosed;
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 t.after(async()=>{
  try{
   if(child&&childClosed&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([childClosed,wait(1000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await Promise.race([childClosed,wait(1000)]);}}
  }finally{
   try{if(ingress?.listening){ingress.closeAllConnections();await Promise.race([new Promise(r=>ingress.close(r)),wait(1000)]);}}finally{rmSync(dir,{recursive:true,force:true});}
  }
 });
 const key=join(dir,'key'),cert=join(dir,'cert'),api=join(dir,'api'),writes=join(dir,'writes');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 writeFileSync(api,'apikey:synthetic\nprojectID:project\nendpoint:https://provider.example.test/v1\n');
 const secret=randomBytes(32).toString('hex');
 ingress=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
  const headers={...req.headers,'x-weftline-proxy-secret':secret};
  const upstream=http.request({host:'127.0.0.1',port:receiverPort,path:req.url,method:req.method,headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
 });
 await new Promise((resolveListen,reject)=>{ingress.once('error',reject);ingress.listen(0,'127.0.0.1',()=>{ingress.off('error',reject);resolveListen();});});

 const origin=`https://127.0.0.1:${ingress.address().port}`;
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./experimental/agent-mcp/test/fake-provider.js',WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_PROXY:'1',WEFTLINE_PROXY_SECRET:secret,WEFTLINE_PUBLIC_ORIGIN:origin,WEFTLINE_REVIEW_HOST:'127.0.0.1',PORT:'0',WEFTLINE_REVIEW_BOARD:'b',APPWRITE_ENDPOINT:'https://provider.example.test/v1',APPWRITE_PROJECT:'project',WEFTLINE_APPROVED_APPWRITE_ENDPOINT:'https://provider.example.test/v1',WEFTLINE_APPROVED_APPWRITE_PROJECT:'project',APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',APPWRITE_KEY_FILE:api,REVIEW_TEST_WRITES_FILE:writes};
 child=spawn(process.execPath,['experimental/review-v1-cli.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 childClosed=new Promise(r=>child.once('close',r));
 receiverPort=await new Promise((resolvePort,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('proxy startup timed out')),5000);child.once('error',()=>{clearTimeout(timer);reject(Error('proxy startup failed'));});child.once('close',()=>{clearTimeout(timer);reject(Error('proxy startup failed'));});child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/listener 127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolvePort(Number(match[1]));}});child.stderr.resume();});
 async function connect(actor,session,guard='0'){
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve(root,'experimental/agent-mcp/server.js'),'--enable','--remote-https','--endpoint',origin,'--ca',cert,'--actor',actor,'--board','b','--guard',guard],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:session},stderr:'pipe'});
  const client=new Client({name:'synthetic-proxy-test',version:'1.0.0'});t.after(()=>transport.close());await client.connect(transport);return client;
 }
 const alice=await connect('alice','alice');
 const discovery=await alice.callTool({name:'discover',arguments:{}});assert.notEqual(discovery.isError,true);const page=JSON.parse(discovery.content[0].text);assert.equal(page.status,'partial');assert.equal(page.consistency,'advisory-non-snapshot');assert(page.tasks.some(task=>task.title==='Synthetic task'));
 const resolution=await alice.callTool({name:'resolve',arguments:{task:'task'}});assert.notEqual(resolution.isError,true);assert.equal(JSON.parse(resolution.content[0].text).state,'unknown');
 const wrongActor=await connect('alice','bob');assert.equal((await wrongActor.callTool({name:'discover',arguments:{}})).isError,true);
 const wrongGuard=await connect('alice','alice','1');assert.equal((await wrongGuard.callTool({name:'discover',arguments:{}})).isError,true);
 const disabled=await new Promise((ok,bad)=>{const req=http.request({host:'127.0.0.1',port:receiverPort,path:'/review/scoped-transition',method:'POST',headers:{host:new URL(origin).host,origin,'x-weftline-proxy-secret':secret,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json',cookie:'__Host-weftline=alice'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});req.on('error',bad);req.end('{}');});assert.equal(disabled,404);
 assert.equal(existsSync(writes),false);
});
