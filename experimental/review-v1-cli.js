// Direct loopback TLS by default; proxy mode requires an authenticated trusted ingress.
import https from 'node:https';
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createSecureContext} from 'node:tls';
import {createGuardedAppwriteStore,validateGuardedAuthority} from './guarded-appwrite-composition.js';
import {parseGuardedJson} from './guarded-strict-json.js';
import {createReviewService} from './review-v1-service.js';
import {createReviewDiscovery} from './review-v1-discovery.js';
import {createReviewResolution} from './review-v1-resolution.js';
import {reviewBoardPage} from './review-v1-ui.js';
import {createNodeAuthAdapter} from '../src/node-auth-adapter.js';
import {createKnowledgeV2Adapter} from '../src/private-knowledge-listener.js';
import {createTeamMembershipProvider} from '../src/appwrite-team-membership.js';
import {knowledgeV2Page} from '../src/private-knowledge-v2-ui.js';
import {boundedKnowledgeTransport} from './knowledge-transport.js';
import {createAppwriteKnowledgeV2Discovery} from './knowledge-v2-discovery.js';
import {createVersionedKnowledgeComposition} from './knowledge-versioned-composition.js';
import {versionedKnowledgeReadPage} from './knowledge-versioned-read-ui.js';
const versionedRoutes=new Set(['create','edit','reconcile','read','list','resolve'].map(x=>'/knowledge/versioned/'+x));
const versionedKeys={create:['expectedActor','documentId','operationId','title','html'],edit:['expectedActor','documentId','operationId','title','html','previousGeneration'],reconcile:['expectedActor','documentId','operationId','title','html','previousGeneration'],read:['expectedActor','documentId','generation'],list:['expectedActor'],resolve:['expectedActor','documentId']};

const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
const path=x=>typeof x==='string'&&isAbsolute(x)&&!x.includes('\0');
try {
 const e=process.env;
 const proxy=e.WEFTLINE_REVIEW_PROXY==='1';
 const readOnly=e.WEFTLINE_REVIEW_READ_ONLY==='1';
 const scopedAgent=e.WEFTLINE_REVIEW_AGENT_SCOPED_WRITES==='1';
 const scopedKnowledge=e.WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_READ==='1';
 const scopedKnowledgeList=e.WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_LIST==='1';
 const scopedKnowledgeWrite=e.WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_WRITE==='1';
 const readerDominatesKnowledgeWrites=e.WEFTLINE_REVIEW_KNOWLEDGE_READER_DENY_WRITES==='1';
 if(e.WEFTLINE_REVIEW_KNOWLEDGE_READER_DENY_WRITES!==undefined&&!readerDominatesKnowledgeWrites)throw Error('Invalid configuration');
 if(e.WEFTLINE_REVIEW_AGENT_SCOPED_WRITES!==undefined&&(!scopedAgent||readOnly))throw Error('Invalid configuration');
 if(e.WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_READ!==undefined&&(!scopedKnowledge||readOnly||e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED!=='1'))throw Error('Invalid configuration');
 if(e.WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_LIST!==undefined&&(!scopedKnowledgeList||readOnly||e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED!=='1'))throw Error('Invalid configuration');
 if(e.WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_WRITE!==undefined&&(!scopedKnowledgeWrite||readOnly||e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED!=='1'||e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED_WRITE_UI!==undefined))throw Error('Invalid configuration');
 if(e.WEFTLINE_REVIEW_READ_ONLY!==undefined&&!readOnly)throw Error('Invalid configuration');
 if(readOnly&&(proxy||['WEFTLINE_REVIEW_AUTH','WEFTLINE_REVIEW_UI','WEFTLINE_REVIEW_KNOWLEDGE_V2','WEFTLINE_REVIEW_KNOWLEDGE_LIST_V2','WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED','WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED_UI','WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED_WRITE_UI'].some(k=>e[k]!==undefined)))throw Error('Invalid configuration');
 if(e.WEFTLINE_REVIEW_PROXY!==undefined&&!proxy)throw Error('Invalid configuration');
 let publicOrigin,proxySecret,listenPort;
 if(proxy){
  if(!/^[0-9a-f]{64}$/.test(e.WEFTLINE_PROXY_SECRET??'')||!isIP(e.WEFTLINE_REVIEW_HOST??'')||!/^(0|[1-9][0-9]{0,4})$/.test(e.PORT??'')||Number(e.PORT)>65535||e.WEFTLINE_REVIEW_KNOWLEDGE_V2!==undefined||e.WEFTLINE_REVIEW_KNOWLEDGE_LIST_V2!==undefined)throw Error('Invalid configuration');
  const u=new URL(e.WEFTLINE_PUBLIC_ORIGIN);if(u.protocol!=='https:'||u.origin!==e.WEFTLINE_PUBLIC_ORIGIN||u.username||u.password)throw Error('Invalid configuration');
  publicOrigin=u.origin;proxySecret=Buffer.from(e.WEFTLINE_PROXY_SECRET,'ascii');listenPort=Number(e.PORT);
 }
 const endpoint=e.APPWRITE_ENDPOINT,project=e.APPWRITE_PROJECT,approvedEndpoint=e.WEFTLINE_APPROVED_APPWRITE_ENDPOINT,approvedProject=e.WEFTLINE_APPROVED_APPWRITE_PROJECT;
 validateGuardedAuthority(endpoint,project,approvedEndpoint,approvedProject);
 if(e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED_WRITE_UI!==undefined&&(e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED_WRITE_UI!=='1'||e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED_UI!=='1'))throw Error('Invalid configuration');
 if(e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED_UI!==undefined&&(e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED_UI!=='1'||e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED!=='1'||e.WEFTLINE_REVIEW_UI!=='1'||e.WEFTLINE_REVIEW_AUTH!=='1'))throw Error('Invalid configuration');
 if(e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED!==undefined&&(e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED!=='1'||![e.WEFTLINE_KNOWLEDGE_VERSIONED_DATABASE_ID,e.WEFTLINE_KNOWLEDGE_VERSIONED_TABLE_ID,e.WEFTLINE_KNOWLEDGE_DATABASE_ID,e.WEFTLINE_KNOWLEDGE_TABLE_ID,e.WEFTLINE_KNOWLEDGE_TEAM_ID].every(id)||!/^[1-9][0-9]{0,3}$/.test(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES??'')||Number(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES)>1024||(e.WEFTLINE_KNOWLEDGE_VERSIONED_DATABASE_ID===e.APPWRITE_DATABASE&&e.WEFTLINE_KNOWLEDGE_VERSIONED_TABLE_ID===e.APPWRITE_TABLE)||(e.WEFTLINE_KNOWLEDGE_VERSIONED_DATABASE_ID===e.WEFTLINE_KNOWLEDGE_DATABASE_ID&&e.WEFTLINE_KNOWLEDGE_VERSIONED_TABLE_ID===e.WEFTLINE_KNOWLEDGE_TABLE_ID)))throw Error('Invalid configuration');
 if((e.WEFTLINE_REVIEW_AUTH!==undefined&&e.WEFTLINE_REVIEW_AUTH!=='1')||(e.WEFTLINE_REVIEW_UI!==undefined&&(e.WEFTLINE_REVIEW_UI!=='1'||e.WEFTLINE_REVIEW_AUTH!=='1')))throw Error('Invalid configuration');
 if(e.WEFTLINE_REVIEW_KNOWLEDGE_LIST_V2!==undefined&&(e.WEFTLINE_REVIEW_KNOWLEDGE_LIST_V2!=='1'||e.WEFTLINE_REVIEW_KNOWLEDGE_V2!=='1'))throw Error('Invalid configuration');
 if(e.WEFTLINE_REVIEW_KNOWLEDGE_V2!==undefined&&(e.WEFTLINE_REVIEW_KNOWLEDGE_V2!=='1'||e.WEFTLINE_REVIEW_UI!=='1'||e.WEFTLINE_REVIEW_AUTH!=='1'||![e.WEFTLINE_KNOWLEDGE_DATABASE_ID,e.WEFTLINE_KNOWLEDGE_TABLE_ID,e.WEFTLINE_KNOWLEDGE_TEAM_ID].every(id)||!/^[1-9][0-9]{0,3}$/.test(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES??'')||Number(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES)>1024||(e.WEFTLINE_KNOWLEDGE_DATABASE_ID===e.APPWRITE_DATABASE&&e.WEFTLINE_KNOWLEDGE_TABLE_ID===e.APPWRITE_TABLE)))throw Error('Invalid configuration');
 if(e.WEFTLINE_REVIEW_ENABLE!=='1'||e.WEFTLINE_REVIEW_PROTOCOL!=='review-v1'||process.argv.length!==2||(!proxy&&(e.WEFTLINE_REVIEW_HOST!=='127.0.0.1'||!/^(0|[1-9][0-9]{0,4})$/.test(e.WEFTLINE_REVIEW_PORT??'')||Number(e.WEFTLINE_REVIEW_PORT)>65535))||![e.WEFTLINE_REVIEW_BOARD,e.APPWRITE_DATABASE,e.APPWRITE_TABLE].every(id)||!path(e.APPWRITE_KEY_FILE)||(!proxy&&![e.WEFTLINE_TLS_KEY_FILE,e.WEFTLINE_TLS_CERT_FILE].every(path)))throw Error('Invalid configuration');
 const tls=proxy?null:{key:readFileSync(e.WEFTLINE_TLS_KEY_FILE),cert:readFileSync(e.WEFTLINE_TLS_CERT_FILE)};if(tls)createSecureContext(tls);
 const values=Object.create(null),lines=readFileSync(e.APPWRITE_KEY_FILE,'utf8').trim().split(/\r?\n/);
 if(lines.length!==3)throw Error('Invalid credentials');
 for(const line of lines){const i=line.indexOf(':'),name=line.slice(0,i);if(i<1||!['apikey','projectID','endpoint'].includes(name)||Object.hasOwn(values,name))throw Error('Invalid credentials');values[name]=line.slice(i+1).trim();}
 if(values.endpoint!==endpoint||values.projectID!==project||!values.apikey||/\s/.test(values.apikey))throw Error('Invalid credentials');
 const backendScope=Object.freeze({endpoint,project,database:e.APPWRITE_DATABASE,table:e.APPWRITE_TABLE});
 const store=createGuardedAppwriteStore({enabled:true,endpoint,project,approvedEndpoint,approvedProject,key:values.apikey,database:backendScope.database,table:backendScope.table}),service=createReviewService({store,board:e.WEFTLINE_REVIEW_BOARD}),discovery=createReviewDiscovery({store,board:e.WEFTLINE_REVIEW_BOARD}),resolution=createReviewResolution({store,board:e.WEFTLINE_REVIEW_BOARD});
 let active=0,auth;
 const enabledKnowledge=e.WEFTLINE_REVIEW_KNOWLEDGE_V2==='1';
 if(readerDominatesKnowledgeWrites&&(!enabledKnowledge&&e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED!=='1'||!id(e.WEFTLINE_KNOWLEDGE_TEAM_ID)))throw Error('Invalid configuration');
 // One bounded gate accounts for knowledge fetches even after a client aborts;
 // its slots remain occupied until the underlying fetch and response settle.
 const knowledgeGate=boundedKnowledgeTransport(globalThis.fetch);
 const knowledgeTransport=knowledgeGate.transport;
 const knowledgeRoleMembership=readerDominatesKnowledgeWrites?createTeamMembershipProvider({endpoint,approvedEndpoint:approvedEndpoint??endpoint,project,boardId:e.WEFTLINE_REVIEW_BOARD,teamId:e.WEFTLINE_KNOWLEDGE_TEAM_ID,transport:knowledgeTransport,includeRoles:true}):null;
 const allowKnowledgeWrite=async({session,expectedActor,signal})=>{
  if(!knowledgeRoleMembership)return true;
  const member=await knowledgeRoleMembership({session,expectedActor,boardId:e.WEFTLINE_REVIEW_BOARD,signal});
  return !!member&&Array.isArray(member.roles)&&!member.roles.includes('reader');
 };
 const versioned=e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED==='1'?createVersionedKnowledgeComposition({enabled:true,scopedWrite:scopedKnowledgeWrite,endpoint,approvedEndpoint:approvedEndpoint ?? endpoint,project,database:e.WEFTLINE_KNOWLEDGE_VERSIONED_DATABASE_ID,table:e.WEFTLINE_KNOWLEDGE_VERSIONED_TABLE_ID,legacyDatabase:e.WEFTLINE_KNOWLEDGE_DATABASE_ID,legacyTable:e.WEFTLINE_KNOWLEDGE_TABLE_ID,boardDatabase:e.APPWRITE_DATABASE,boardTable:e.APPWRITE_TABLE,boardId:e.WEFTLINE_REVIEW_BOARD,teamId:e.WEFTLINE_KNOWLEDGE_TEAM_ID,key:values.apikey,maxPayloadBytes:Number(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES),transport:globalThis.fetch}):null;
 const knowledge=enabledKnowledge?createKnowledgeV2Adapter({enabled:true,endpoint,approvedEndpoint:approvedEndpoint ?? endpoint,project,boardId:e.WEFTLINE_REVIEW_BOARD,teamId:e.WEFTLINE_KNOWLEDGE_TEAM_ID,database:e.WEFTLINE_KNOWLEDGE_DATABASE_ID,table:e.WEFTLINE_KNOWLEDGE_TABLE_ID,key:values.apikey,knowledgePayloadMaxBytes:Number(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES),transport:knowledgeTransport,...(readerDominatesKnowledgeWrites?{writeAuthorizer:allowKnowledgeWrite}:{})}):null;
 const knowledgeList=e.WEFTLINE_REVIEW_KNOWLEDGE_LIST_V2==='1'?createAppwriteKnowledgeV2Discovery({endpoint,approvedEndpoint:approvedEndpoint ?? endpoint,project,boardId:e.WEFTLINE_REVIEW_BOARD,teamId:e.WEFTLINE_KNOWLEDGE_TEAM_ID,database:e.WEFTLINE_KNOWLEDGE_DATABASE_ID,table:e.WEFTLINE_KNOWLEDGE_TABLE_ID,key:values.apikey}):null;
 // Listing has its own four-slot transport gate, but shares request admission.
 const page=e.WEFTLINE_REVIEW_UI==='1'?reviewBoardPage(e.WEFTLINE_REVIEW_BOARD):null;
 const knowledgePage=enabledKnowledge?knowledgeV2Page(e.WEFTLINE_REVIEW_BOARD,Number(e.WEFTLINE_KNOWLEDGE_PAYLOAD_MAX_BYTES),!!knowledgeList):null;
 const versionedPage=e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED_UI==='1'?versionedKnowledgeReadPage({write:e.WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED_WRITE_UI==='1',boardId:e.WEFTLINE_REVIEW_BOARD}):null;
 if(page&&versionedPage)page.html=page.html.replace('<h1>Review local board</h1>','<h1>Review local board</h1><nav><a href="/knowledge/versioned/page">Versioned knowledge</a></nav>');
 if(page&&knowledge)page.html=page.html.replace('<h1>Review local board</h1>','<h1>Review local board</h1><nav><a href="/knowledge/v2/page">Private knowledge</a></nav>');
 if(knowledgePage)knowledgePage.html=knowledgePage.html.replace('<title>Private knowledge v2</title>','<title>Private knowledge v2</title><nav><a href="/">Review board</a></nav>');
 const server=(proxy?http:https).createServer({...tls,connectionsCheckingInterval:1000},(req,res)=>{
  const reply=(code,body)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(code,{'content-type':'application/json','cache-control':'no-store','connection':'close'});res.end(JSON.stringify(body));}};
  const reject=code=>{reply(code,{status:'unavailable'});req.resume();};
  const addr=server.address(),sock=req.socket,count=n=>req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===n).length;
  if(!addr||typeof addr==='string')return reject(403);
  if(readOnly&&(req.method!=='POST'||!['/review/discovery','/review/resolve'].includes(req.url)))return reject(404);
  const expectedOrigin=proxy?publicOrigin:`https://127.0.0.1:${addr.port}`,expectedHost=new URL(expectedOrigin).host;
  if(proxy){
   const names=req.rawHeaders.filter((_,i)=>i%2===0).map(x=>x.toLowerCase());
   const supplied=req.headers['x-weftline-proxy-secret'];
   if(new Set(names).size!==names.length||typeof supplied!=='string'||!(/^[0-9a-f]{64}$/.test(supplied))||!timingSafeEqual(Buffer.from(supplied,'ascii'),proxySecret)||count('host')!==1||req.headers.host!==expectedHost||count('origin')>1||(count('origin')===1&&req.headers.origin!==expectedOrigin)||names.some(x=>x==='forwarded'||x.startsWith('x-forwarded-')||x==='x-real-ip'))return reject(403);
   delete req.headers['x-weftline-proxy-secret'];
   for(let i=req.rawHeaders.length-2;i>=0;i-=2)if(req.rawHeaders[i].toLowerCase()==='x-weftline-proxy-secret')req.rawHeaders.splice(i,2);
   if(req.url==='/health'&&req.method==='GET'){if(count('transfer-encoding')||(count('content-length')&&req.headers['content-length']!=='0'))return reject(400);if((count('sec-fetch-site')&&!['none','same-origin'].includes(req.headers['sec-fetch-site']))||(count('sec-fetch-mode')&&!['navigate','cors'].includes(req.headers['sec-fetch-mode']))||(count('sec-fetch-dest')&&!['document','empty'].includes(req.headers['sec-fetch-dest'])))return reject(403);return reply(200,{status:'ok'});}
  }else if(addr.address!=='127.0.0.1'||!sock.encrypted||sock.localAddress!=='127.0.0.1'||sock.remoteAddress!=='127.0.0.1')return reject(403);
  const forwarded=Object.keys(req.headers).some(x=>x==='forwarded'||x.startsWith('x-forwarded-')||x==='x-real-ip');
  if((page&&req.url==='/'||knowledgePage&&req.url==='/knowledge/v2/page'||versionedPage&&req.url==='/knowledge/versioned/page')&&req.method==='GET') {const selected=req.url==='/'?page:req.url==='/knowledge/v2/page'?knowledgePage:versionedPage;const names=req.rawHeaders.filter((_,i)=>i%2===0).map(x=>x.toLowerCase());if(new Set(names).size!==names.length||forwarded||count('host')!==1||req.headers.host!==expectedHost||count('origin')>1||(count('origin')===1&&req.headers.origin!==expectedOrigin)||count('sec-fetch-site')!==1||!['none','same-origin'].includes(req.headers['sec-fetch-site'])||count('sec-fetch-mode')!==1||req.headers['sec-fetch-mode']!=='navigate'||count('sec-fetch-dest')!==1||req.headers['sec-fetch-dest']!=='document'||count('transfer-encoding')||(count('content-length')&&req.headers['content-length']!=='0'))return reject(403);res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':selected.csp,'cache-control':'no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow','referrer-policy':'no-referrer','x-frame-options':'DENY'});return res.end(selected.html);}
  if(knowledge&&['/knowledge/v2/create','/knowledge/v2/read','/knowledge/v2/preflight','/knowledge/v2/create-with-receipt','/knowledge/v2/receipt'].includes(req.url)){if(count('content-encoding'))return reject(400);if(active>=4||knowledgeGate.active>=4)return reject(503);active++;Promise.resolve().then(()=>knowledge(req,res)).finally(()=>active--).catch(()=>reject(503));return;}
  const isAuth=e.WEFTLINE_REVIEW_AUTH==='1'&&['/login','/account','/logout'].includes(req.url);
  const isList=!!knowledgeList&&req.url==='/knowledge/v2/list';
  const isScopedKnowledge=!!versioned&&scopedKnowledge&&req.url==='/knowledge/versioned/scoped-read';
  const isScopedKnowledgeList=!!versioned&&scopedKnowledgeList&&req.url==='/knowledge/versioned/scoped-list';
  const scopedWriteMethod=!!versioned&&scopedKnowledgeWrite&&['create','edit','reconcile'].find(x=>req.url==='/knowledge/versioned/scoped-'+x);
  if(scopedKnowledgeWrite&&['/knowledge/versioned/create','/knowledge/versioned/edit','/knowledge/versioned/reconcile'].includes(req.url))return reject(404);
  const isVersioned=!!versioned&&(versionedRoutes.has(req.url)||isScopedKnowledge||isScopedKnowledgeList||scopedWriteMethod);
  const isScoped=scopedAgent&&['/review/scoped-transition','/review/scoped-receipt'].includes(req.url);
  if(!isAuth&&!isList&&!isVersioned&&!isScoped&&!['/review/genesis','/review/transition','/review/receipt','/review/task','/review/discovery','/review/resolve'].includes(req.url))return reject(404);
  if(req.method!==(isAuth&&req.url==='/account'?'GET':'POST'))return reject(405);
  const originOk=count('origin')===1&&req.headers.origin===expectedOrigin||count('origin')===0&&isAuth&&req.url==='/account';
  if(forwarded||count('host')!==1||req.headers.host!==expectedHost||!originOk||count('sec-fetch-site')!==1||req.headers['sec-fetch-site']!=='same-origin'||count('sec-fetch-mode')!==1||req.headers['sec-fetch-mode']!=='cors'||count('sec-fetch-dest')!==1||req.headers['sec-fetch-dest']!=='empty')return reject(403);
  if((req.method==='POST'&&(count('content-type')!==1||req.headers['content-type']!=='application/json'))||count('content-encoding')||(isAuth&&req.url==='/login'?count('cookie')>1:isAuth&&req.url==='/account'?count('cookie')>1:count('cookie')!==1))return reject(400);
  if(isAuth&&req.url==='/login'&&count('cookie')&&req.headers.cookie.split(';').filter(x=>x.trim().startsWith('__Host-weftline=')).length>1)return reject(400);
  if(isAuth){if(active>=4)return reject(503);active++;if(!auth){const object=(bytes,keys)=>{const x=parseGuardedJson(bytes);if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||!keys.every(k=>Object.hasOwn(x,k)))throw Error('Invalid');return x;};auth=createNodeAuthAdapter({origin:expectedOrigin,endpoint,project,approvedEndpoint,approvedProject,parseLogin:b=>object(b,['email','password']),parseLogout:b=>object(b,[])});}Promise.resolve(auth(req,res)).finally(()=>active--).catch(()=>{});return;}
  const cookies=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('__Host-weftline=')),session=cookies.length===1?cookies[0].slice(16):'';
  if(!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(session))return reject(401);
  if(active>=4||(isVersioned&&readerDominatesKnowledgeWrites&&knowledgeGate.active>=4))return reject(503);active++;
  let checkpoint;
  const controller=new AbortController(),timer=setTimeout(()=>{controller.abort();reply(202,{status:'unknown',...(checkpoint?{consistency:'advisory-non-snapshot',continuation:checkpoint}:{})});if(!req.complete)req.destroy();},10000);
  const disconnect=()=>{if(!res.writableFinished)controller.abort();};res.once('close',disconnect);
  (async()=>{try{const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>4096)return reject(400);chunks.push(c);}controller.signal.throwIfAborted();let input;try{input=parseGuardedJson(Buffer.concat(chunks));}catch{return reject(400);}let scopeCheck;if(isScoped){const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));if(!exact(input,['scope','intent']))return reject(400);const scope=input.scope;scopeCheck=()=>!!exact(scope,['endpoint','project','database','table'])&&Object.keys(backendScope).every(k=>scope[k]===backendScope[k]);input=input.intent;}if(isVersioned){
   if(scopedWriteMethod){
    const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
    if(!exact(input,['scope','intent'])||!exact(input.intent,versionedKeys[scopedWriteMethod]))return reject(400);
    if(readerDominatesKnowledgeWrites){try{if(await allowKnowledgeWrite({session,expectedActor:input.intent.expectedActor,signal:controller.signal})!==true)return reject(403);}catch{return reject(403);}}
    const method=scopedWriteMethod+'Scoped';
    const result=await versioned[method]({...input.intent,scope:input.scope,session,signal:controller.signal});
    return reply(result.status==='confirmed'?200:result.status==='denied'?403:result.status==='invalid'?400:202,result);
   }
   if(isScopedKnowledgeList){
    const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
    if(!exact(input,['scope','intent'])||!input.intent||typeof input.intent!=='object'||Array.isArray(input.intent)||!Object.hasOwn(input.intent,'expectedActor')||Object.keys(input.intent).some(k=>!['expectedActor','continuation'].includes(k)))return reject(400);
    const result=await versioned.listScoped({...input.intent,scope:input.scope,session,signal:controller.signal});
    return reply(result.status==='partial'?200:result.status==='denied'?403:result.status==='invalid'?400:202,result);
   }
   if(isScopedKnowledge){
   const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
   if(!exact(input,['scope','intent'])||!exact(input.intent,versionedKeys.read))return reject(400);
   const result=await versioned.readScoped({...input.intent,scope:input.scope,session,signal:controller.signal});
   return reply(result.status==='advisory'?200:result.status==='denied'?403:result.status==='invalid'?400:202,result);
  }
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.hasOwn(input,'session')||Object.hasOwn(input,'signal'))return reject(400);
   const method=req.url.slice('/knowledge/versioned/'.length),keys=versionedKeys[method];
   if(!keys.every(k=>Object.hasOwn(input,k))||Object.keys(input).some(k=>!keys.includes(k)&&!((method==='list'||method==='resolve')&&k==='continuation')))return reject(400);
   if(readerDominatesKnowledgeWrites&&['create','edit','reconcile'].includes(method)){try{if(await allowKnowledgeWrite({session,expectedActor:input.expectedActor,signal:controller.signal})!==true)return reject(403);}catch{return reject(403);}}
   const result=await versioned[method]({...input,session,signal:controller.signal});
   return reply(result.status==='confirmed'||result.status==='advisory'||result.status==='partial'?200:result.status==='denied'?403:result.status==='invalid'?400:202,result);
  }if(isList){if(!input||typeof input!=='object'||Array.isArray(input)||!Object.hasOwn(input,'boardId')||input.boardId!==e.WEFTLINE_REVIEW_BOARD||!id(input.expectedActor)||Object.keys(input).some(k=>!['boardId','expectedActor','continuation'].includes(k)))return reject(400);const result=await knowledgeList({session,expectedActor:input.expectedActor,signal:controller.signal,...(Object.hasOwn(input,'continuation')?{continuation:input.continuation}:{})});return reply(result.status==='partial'?200:result.status==='denied'?403:result.status==='invalid'?400:202,result);}const result=await (req.url==='/review/discovery'?discovery(input,session,controller.signal,value=>{checkpoint=value;}):req.url==='/review/resolve'?resolution(input,session,controller.signal,value=>{checkpoint=value;}):service(isScoped?req.url.slice('/review/scoped-'.length):req.url.slice('/review/'.length),input,session,controller.signal,scopeCheck));const body=Object.fromEntries(Object.entries(result).filter(([k])=>k!=='code'));if(req.url==='/review/discovery'&&result.code===200)Object.assign(body,{actor:input.expectedActor,board:input.board});reply(result.code,body);}catch{reply(202,{status:'unknown'});}finally{clearTimeout(timer);res.removeListener('close',disconnect);active--;}})();
 });
 server.headersTimeout=5000;server.requestTimeout=5000;server.on('error',()=>{console.error('Listener unavailable');process.exitCode=1;});server.listen(proxy?listenPort:Number(e.WEFTLINE_REVIEW_PORT),proxy?e.WEFTLINE_REVIEW_HOST:'127.0.0.1',()=>console.log(`Review ${proxy?'proxy HTTP':'experimental TLS'} listener ${proxy?e.WEFTLINE_REVIEW_HOST:'127.0.0.1'}:${server.address().port}`));
} catch {console.error('Disabled or invalid configuration');process.exitCode=1;}
