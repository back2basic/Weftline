// Standalone, default-off discovery. Pages are partial, non-snapshot genesis
// candidates, never current versions. Unknown rows poison the whole page.
// Membership is not fenced against revocation; trusted writers and runtime are
// required. Table activity may leak through timing/counts. Restart loses cursors.
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {types} from 'node:util';
import {id,snap,validGeneration,rowId,receiptId,version,matchReceipt} from './knowledge-versioned-schema.js';
import {bridgeSignal} from '../src/abort-signal.js';
import {createTeamMembershipProvider} from '../src/appwrite-team-membership.js';
import {appwriteStore} from './appwrite-store.js';
import {knowledgeTransportFor} from './knowledge-transport.js';

const session=x=>typeof x==='string'&&/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(x);
function pageRows(rows){
 if(types.isProxy(rows)||!Array.isArray(rows)||Object.getPrototypeOf(rows)!==Array.prototype)throw Error();
 const n=Object.getOwnPropertyDescriptor(rows,'length').value;
 if(n>25||Reflect.ownKeys(rows).length!==n+1)throw Error();
 return Array.from({length:n},(_,i)=>{const d=Object.getOwnPropertyDescriptor(rows,String(i));if(!d||!Object.hasOwn(d,'value'))throw Error();return d.value;});
}
function classify(raw,max){
 const row=snap(raw,['id','data']);if(!id(row.id))throw Error();
 const x=snap(row.data,['kind','boardId','documentId','generation','creator','editor','title','html','actor','operationId','previousGeneration','fingerprint'],false);
 if(!id(x.boardId)||!id(x.documentId))throw Error();
 if(x.kind==='knowledge-version-v1'){
  if(!validGeneration(x.generation)||!version(row.data,x.boardId,x.documentId,x.generation,max)||row.id!==rowId(x.boardId,x.documentId,x.generation))throw Error();
 }else if(x.kind==='knowledge-version-receipt-v1'){
  if(!id(x.actor)||typeof x.operationId!=='string'||!/^[a-f0-9]{32}$/.test(x.operationId)||typeof x.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(x.fingerprint)||!validGeneration(x.generation)||!(x.previousGeneration===-1&&x.generation===0||validGeneration(x.previousGeneration)&&x.generation===x.previousGeneration+1)||!matchReceipt(row.data,x,max)||row.id!==receiptId(x.boardId,x.actor,x.operationId))throw Error();
 }else throw Error();
 return {row,x};
}
export function createVersionedDiscovery(options={}){
 const c=snap(options,['enabled','boardId','teamId','membership','store','maxPayloadBytes','deadlineMs'],false);
 if(c.enabled!==true)return Object.freeze({list:async()=>({status:'disabled'})});
 if(!id(c.boardId)||!id(c.teamId)||typeof c.membership!=='function'||!Number.isSafeInteger(c.maxPayloadBytes)||c.maxPayloadBytes<1||c.maxPayloadBytes>1024)throw Error('invalid configuration');
 const store=snap(c.store,['listPage','get','transaction'],false);if(typeof store.listPage!=='function')throw Error('invalid store');
 const deadline=c.deadlineMs===undefined?10000:c.deadlineMs;if(!Number.isSafeInteger(deadline)||deadline<1||deadline>30000)throw Error('invalid deadline');
 const key=randomBytes(32),life=300000;let active=0;
 function seal(cursor,actor){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),p=Buffer.alloc(512);Buffer.from(JSON.stringify({cursor,actor,boardId:c.boardId,teamId:c.teamId,purpose:'knowledge-versioned-discovery',expires:Date.now()+life})).copy(p);return Buffer.concat([iv,cipher.update(p),cipher.final(),cipher.getAuthTag()]).toString('base64url');}
 function open(token,actor){
  if(typeof token!=='string'||token.length!==720||!/^[A-Za-z0-9_-]+$/.test(token))throw Error();
  const b=Buffer.from(token,'base64url');if(b.length!==540||b.toString('base64url')!==token)throw Error();
  const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(524));const p=Buffer.concat([d.update(b.subarray(12,524)),d.final()]),i=p.indexOf(0);if(i<0||p.subarray(i).some(Boolean))throw Error();
  const x=snap(JSON.parse(p.subarray(0,i)),['cursor','actor','boardId','teamId','purpose','expires']);const now=Date.now();
  if(!id(x.cursor)||x.actor!==actor||x.boardId!==c.boardId||x.teamId!==c.teamId||x.purpose!=='knowledge-versioned-discovery'||!Number.isSafeInteger(x.expires)||x.expires<=now||x.expires>now+life)throw Error();return x.cursor;
 }
 async function list(input){
  if(active>=4)return {status:'unknown'};active++;
  const end=performance.now()+deadline,controller=new AbortController();let bridge,timer,onAbort;
  try{if(types.isProxy(input))throw Error();const d=Object.getOwnPropertyDescriptor(input,'signal');if(d&&!Object.hasOwn(d,'value'))throw Error();bridge=bridgeSignal(d?.value);}catch{active--;return {status:'unknown'};}
  const check=()=>{if(controller.signal.aborted||performance.now()>=end){controller.abort();throw Error();}};
  let interrupted;
  try{interrupted=new Promise(resolve=>{onAbort=()=>{controller.abort();resolve({status:'unknown'});};bridge.signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(onAbort,deadline);});}catch{bridge.dispose();active--;return {status:'unknown'};}
  const work=(async()=>{try{
   const keys=['session','expectedActor',...(Object.hasOwn(input,'continuation')?['continuation']:[]),...(Object.hasOwn(input,'signal')?['signal']:[])];const r=snap(input,keys);
   if(!session(r.session)||!id(r.expectedActor))return {status:'denied'};
   check();const raw=await c.membership({session:r.session,expectedActor:r.expectedActor,boardId:c.boardId,signal:controller.signal,deadline:end});check();
   if(raw===null)return {status:'denied'};const m=snap(raw,['active','boardId','teamId','userId']);
   if(m.active!==true||m.boardId!==c.boardId||m.teamId!==c.teamId||m.userId!==r.expectedActor)return {status:'denied'};
   let cursor;try{if(Object.hasOwn(r,'continuation'))cursor=open(r.continuation,r.expectedActor);}catch{check();return {status:'invalid'};}check();
   const rows=pageRows(await store.listPage({limit:25,...(cursor?{cursor}:{}),signal:controller.signal}));check();
   const documents=[];let prev=cursor;for(const rawRow of rows){const {row,x}=classify(rawRow,c.maxPayloadBytes);if(prev!==undefined&&row.id<=prev)throw Error();prev=row.id;if(x.boardId===c.boardId&&x.kind==='knowledge-version-v1'&&x.generation===0)documents.push({id:x.documentId,title:x.title,generation:0});}check();
   const result={status:'partial',consistency:'advisory-non-snapshot',documents,...(rows.length===25?{continuation:seal(prev,r.expectedActor)}:{})};check();return result;
  }catch{return {status:'unknown'};}})();
  work.finally(()=>active--).catch(()=>{});
  try{const result=await Promise.race([work,interrupted]);check();return result;}catch{return {status:'unknown'};}finally{clearTimeout(timer);bridge.signal?.removeEventListener('abort',onAbort);bridge.dispose();controller.abort();}
 }
 return Object.freeze({list});
}
export function createAppwriteVersionedDiscovery(options={},sharedGate){
 const c=snap(options,['enabled','endpoint','approvedEndpoint','project','database','table','legacyTable','legacyDatabase','boardId','teamId','key','maxPayloadBytes','transport','deadlineMs'],false);
 if(c.enabled!==true)return createVersionedDiscovery();
 if(!id(c.database)||!id(c.table)||!id(c.legacyTable)||(c.legacyDatabase!==undefined&&!id(c.legacyDatabase))||(c.table===c.legacyTable&&(c.legacyDatabase===undefined||c.database===c.legacyDatabase))||typeof c.key!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(c.key)||typeof c.transport!=='function')throw Error('invalid configuration');
 const transport=knowledgeTransportFor(c.transport,sharedGate);
 const membership=createTeamMembershipProvider({endpoint:c.endpoint,approvedEndpoint:c.approvedEndpoint,project:c.project,boardId:c.boardId,teamId:c.teamId,transport});
 const store=appwriteStore({endpoint:c.endpoint,project:c.project,database:c.database,table:c.table,key:c.key,fetchImpl:transport});
 return createVersionedDiscovery({enabled:true,boardId:c.boardId,teamId:c.teamId,membership,store:{listPage:store.listPage},maxPayloadBytes:c.maxPayloadBytes,...(c.deadlineMs===undefined?{}:{deadlineMs:c.deadlineMs})});
}
