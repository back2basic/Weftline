// Isolated development listener. The process, local host and transport are trusted.
import https from 'node:https';
import {types} from 'node:util';
import {pathToFileURL} from 'node:url';
import {createNodeAuthAdapter} from './node-auth-adapter.js';
import {createActorBoundPrivateKnowledge,createClosedPrivateKnowledge,createKnowledgeOutcome,createKnowledgeReceiptOutcome,lookupKnowledgeReceiptOutcome} from './private-knowledge.js';
import {parseGuardedJson} from '../experimental/guarded-strict-json.js';
import {knowledgePage} from './private-knowledge-ui.js';

const reply=(text,status)=>new Response(text,{status,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow'}});
const loopback=x=>x==='127.0.0.1';
// Keep the raw target exact: URL normalization must not select a protected route.
export const isKnowledgeApiTarget=target=>['/knowledge/create','/knowledge/read','/knowledge/preflight','/knowledge/create-with-receipt','/knowledge/receipt'].includes(target);
async function body(request,strict=false){
 const reader=request.body.getReader();let timer,abort;
 try {
  const stop=new Promise((_,reject)=>{abort=()=>reject(Error('aborted'));request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();timer=setTimeout(()=>reject(Error('deadline')),1000);});
  let size=0;const chunks=[];
  for(;;){const {value,done}=await Promise.race([reader.read(),stop]);if(done)break;size+=value.length;if(size>24000)throw Error('large');chunks.push(value);}
  const bytes=Buffer.concat(chunks);return strict?parseGuardedJson(bytes):JSON.parse(bytes.toString('utf8'));
 }catch(e){try{void reader.cancel().catch(()=>{});}catch{}throw e;}finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);}
}
// service is an injectable test seam; production-like composition is below.
export function createKnowledgeAdapter(options={}){ return knowledgeAdapter(options,false); }
function knowledgeAdapter({enabled=false,service,boardId,knowledgePayloadMaxBytes}={},v2=false){
 if(enabled===true&&(!service||typeof service.create!=='function'||typeof service.read!=='function'||typeof boardId!=='string'))throw Error('Invalid configuration');
 return (req,res)=>{
  const reject=(status,text)=>{res.writeHead(status,{'connection':'close','cache-control':'no-store'});res.end(text);req.resume();};
  if(enabled!==true)return reject(503,'Knowledge unavailable');
  const address=req.socket.server.address();
  if(!address||typeof address==='string'||!loopback(address.address)||!loopback(req.socket.localAddress)||!loopback(req.socket.remoteAddress)||req.socket.encrypted!==true)return reject(403,'Forbidden');
  const origin=`https://127.0.0.1:${address.port}`;
  const raw=req.rawHeaders; const count=name=>raw.filter((_,i)=>i%2===0&&raw[i].toLowerCase()===name).length;
  const forwarded=Object.keys(req.headers).some(x=>x==='forwarded'||x.startsWith('x-forwarded-')||x==='x-real-ip');
  if(!v2&&req.url==='/knowledge'&&req.method==='GET'){
   if(forwarded||count('host')!==1||req.headers.host!==`127.0.0.1:${address.port}`||count('origin')>1||(count('origin')===1&&req.headers.origin!==origin)||count('sec-fetch-site')!==1||!['none','same-origin'].includes(req.headers['sec-fetch-site'])||count('sec-fetch-mode')!==1||req.headers['sec-fetch-mode']!=='navigate'||count('sec-fetch-dest')!==1||req.headers['sec-fetch-dest']!=='document')return reject(403,'Forbidden');
   const page=knowledgePage(boardId,knowledgePayloadMaxBytes);
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':page.csp,'cache-control':'no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow','referrer-policy':'no-referrer'});res.end(page.html);return;
  }
  if(Object.keys(req.headers).some(x=>x==='forwarded'||x.startsWith('x-forwarded-')||x==='x-real-ip')||count('host')!==1||req.headers.host!==`127.0.0.1:${address.port}`||count('origin')!==1||req.headers.origin!==origin||count('sec-fetch-site')!==1||req.headers['sec-fetch-site']!=='same-origin'||count('sec-fetch-mode')!==1||req.headers['sec-fetch-mode']!=='cors'||count('sec-fetch-dest')!==1||req.headers['sec-fetch-dest']!=='empty')return reject(403,'Forbidden');
  const path=v2&&req.url?.startsWith('/knowledge/v2/')?'/knowledge/'+req.url.slice('/knowledge/v2/'.length):req.url;
  if(v2 ? !req.url?.startsWith('/knowledge/v2/')||!isKnowledgeApiTarget(path) : !isKnowledgeApiTarget(path))return reject(404,'Not found');
  if(req.method!=='POST')return reject(405,'Method not allowed');
  if(count('content-type')!==1||req.headers['content-type']!=='application/json'||count('cookie')!==1)return reject(400,'Invalid request');
  const cookies=req.headers.cookie.split(';').map(x=>x.trim()).filter(x=>x.startsWith('__Host-weftline='));
  const session=cookies.length===1?cookies[0].slice('__Host-weftline='.length):'';
  if(!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(session))return reject(401,'Authentication required');
  const handler=async request=>{
   const create=path==='/knowledge/create', preflight=path==='/knowledge/preflight', receipt=path==='/knowledge/create-with-receipt', lookup=path==='/knowledge/receipt';
   const unknown=()=>new Response(JSON.stringify({status:'unknown'}),{status:200,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
   let data;try{data=await body(request,v2);}catch{return lookup?unknown():reply('Invalid request',400);}
   let keys=lookup?['boardId','operationId','fingerprint']:receipt?['boardId','id','title','html','operationId','expectedFingerprint']:preflight?['boardId','id','title','html','operationId']:create?['boardId','id','title','html']:['boardId','id'];
   if(v2)keys=[...keys,'expectedActor'];
   if(v2&&(!data||typeof data.expectedActor!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(data.expectedActor)))return lookup?unknown():reply('Invalid request',400);
   if(lookup&&(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==keys.length||keys.some(k=>!Object.hasOwn(data,k))||data.boardId!==boardId||typeof data.operationId!=='string'||!/^[a-f0-9]{32}$/.test(data.operationId)||typeof data.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(data.fingerprint)))return unknown();
   if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==keys.length||keys.some(k=>!Object.hasOwn(data,k)))return reply('Invalid request',400);
   if(data.boardId!==boardId)return reply('Forbidden',403);
   if((preflight||receipt)&&(typeof data.operationId!=='string'||!/^[a-f0-9]{32}$/.test(data.operationId)||(receipt&&(typeof data.expectedFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(data.expectedFingerprint)))))return reply('Invalid request',400);
   const controller=new AbortController();let timer,onAbort;
   try{
    const stop=new Promise((_,reject)=>{onAbort=()=>{controller.abort();reject(Error('interrupted'));};request.signal.addEventListener('abort',onAbort,{once:true});if(request.signal.aborted)onAbort();timer=setTimeout(onAbort,10000);});
    const operation=Promise.resolve().then(()=>{controller.signal.throwIfAborted();const actor=v2?{expectedActor:data.expectedActor}:{};const input={session,id:data.id,title:data.title,html:data.html,operationId:data.operationId,signal:controller.signal,...actor};return lookup?lookupKnowledgeReceiptOutcome(service,{session,operationId:data.operationId,fingerprint:data.fingerprint,signal:controller.signal,...actor}):receipt?createKnowledgeReceiptOutcome(service,{...input,expectedFingerprint:data.expectedFingerprint}):preflight?service.preflightCreate(input):create?createKnowledgeOutcome(service,{session,id:data.id,title:data.title,html:data.html,signal:controller.signal,...actor}):service.read({session,id:data.id,signal:controller.signal,...actor});});
    const result=await Promise.race([operation,stop]);
    if(lookup){if(result?.status!=='confirmed')return unknown();return new Response(JSON.stringify({status:'confirmed',operationId:data.operationId,fingerprint:data.fingerprint}),{status:200,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});}
    if(receipt){if(result?.status!=='confirmed'||result.fingerprint!==data.expectedFingerprint)return reply('Write outcome unknown; do not blindly retry',502);return new Response(JSON.stringify({status:'confirmed',operationId:data.operationId,fingerprint:result.fingerprint}),{status:201,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});}
    if(preflight){if(typeof result?.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(result.fingerprint))return reply('Denied or unavailable',403);return new Response(JSON.stringify({fingerprint:result.fingerprint}),{status:200,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});}
    return create?(result?reply('Created',201):reply('Forbidden',403)):result;
   }catch{return lookup?unknown():create||receipt?reply('Write outcome unknown; do not blindly retry',502):reply('Denied or unavailable',403);}finally{clearTimeout(timer);request.signal.removeEventListener('abort',onAbort);}
  };
  return createNodeAuthAdapter({origin},handler)(req,res);
 };
}
export function createKnowledgeV2Adapter(config){
 if(!config||types.isProxy(config)||Object.getPrototypeOf(config)!==Object.prototype)throw Error('Invalid configuration');
 const copy={};for(const key of Reflect.ownKeys(config)){const d=Object.getOwnPropertyDescriptor(config,key);if(!d||!Object.hasOwn(d,'value'))throw Error('Invalid configuration');copy[key]=d.value;}
 const service=createActorBoundPrivateKnowledge(copy);
 return knowledgeAdapter({enabled:true,service,boardId:copy.boardId},true);
}
export function createKnowledgeListener({tls,v2,...options}={}){
 if(!tls)throw Error('TLS required');
 // Header deadlines are checked periodically, not at an exact instant.
 const actorBound=v2===undefined?null:createKnowledgeV2Adapter(v2);
 // Actor-bound mode never mounts the legacy, actor-unbound adapter or UI.
 const legacy=actorBound?null:createKnowledgeAdapter(options);
 const server=https.createServer({...tls,connectionsCheckingInterval:1000},(req,res)=>{
  if(actorBound){if(req.url?.startsWith('/knowledge/v2/'))return actorBound(req,res);res.writeHead(404,{'cache-control':'no-store','connection':'close'});res.end('Not found');req.resume();return;}
  return legacy(req,res);
 });
 server.headersTimeout=5000;server.requestTimeout=5000;
 return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const e=process.env;
  if(e.WEFTLINE_LOCAL_KNOWLEDGE!=='1'||(e.HOST!==undefined&&e.HOST!=='127.0.0.1')||!/^[1-9][0-9]{0,4}$/.test(e.PORT??'')||Number(e.PORT)>65535||e.WEFTLINE_ORIGIN!==`https://127.0.0.1:${e.PORT}`||!e.WEFTLINE_TLS_KEY||!e.WEFTLINE_TLS_CERT)throw Error();
  if(!/^[1-9][0-9]{0,3}$/.test(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES??''))throw Error();
  const service=createClosedPrivateKnowledge({knowledgePayloadMaxBytes:Number(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES),enabled:true,endpoint:e.WEFTLINE_ENDPOINT,project:e.WEFTLINE_PROJECT,boardId:e.WEFTLINE_BOARD_ID,teamId:e.WEFTLINE_TEAM_ID,database:e.WEFTLINE_DATABASE_ID,table:e.WEFTLINE_TABLE_ID,key:e.WEFTLINE_API_KEY});
  const server=createKnowledgeListener({enabled:true,tls:{key:e.WEFTLINE_TLS_KEY,cert:e.WEFTLINE_TLS_CERT},service,boardId:e.WEFTLINE_BOARD_ID,knowledgePayloadMaxBytes:Number(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES)});
  server.on('error',()=>{console.error('Local knowledge listener unavailable');process.exitCode=1;});server.listen(Number(e.PORT),'127.0.0.1',()=>console.log('Listening on local knowledge TLS'));
 }catch{console.error('Invalid local knowledge configuration');process.exitCode=1;}
}
