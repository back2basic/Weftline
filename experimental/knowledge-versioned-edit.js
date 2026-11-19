// Unwired synthetic experiment. Requires a separate private table in the SAME
// database, verified payload capacity, exclusive trusted writers and atomic
// create-only transaction collisions. Not compatible with legacy discovery.
// Membership is not transaction-fenced; revocation can race an authorized write.
// Injected dependencies and runtime are trusted, not a security sandbox.
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {appwriteStore} from './appwrite-store.js';
import {createTeamMembershipProvider} from '../src/appwrite-team-membership.js';
import {bridgeSignal} from '../src/abort-signal.js';
import {knowledgeTransportFor} from './knowledge-transport.js';
import {id,snap,size,validGeneration,rowId,receiptId,version,matchReceipt} from './knowledge-versioned-schema.js';

const op=x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x);
const session=x=>typeof x==='string'&&/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(x);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function createVersionedKnowledge(options={}){
 const c=snap(options,['enabled','boardId','teamId','membership','store','maxPayloadBytes','deadlineMs'],false);
 if(c.enabled!==true)return Object.freeze({create:async()=>({status:'disabled'}),edit:async()=>({status:'disabled'}),reconcile:async()=>({status:'disabled'})});
 if(!id(c.boardId)||!id(c.teamId)||typeof c.membership!=='function'||!Number.isSafeInteger(c.maxPayloadBytes)||c.maxPayloadBytes<1||c.maxPayloadBytes>1024)throw Error('invalid configuration');
 const s=snap(c.store,['get','transaction'],false);if(typeof s.get!=='function'||typeof s.transaction!=='function')throw Error('invalid store');
 const deadline=c.deadlineMs===undefined?10000:c.deadlineMs;if(!Number.isSafeInteger(deadline)||deadline<1||deadline>30000)throw Error('invalid deadline');
 let active=0;
 async function run(input,mode){
  if(active>=4)return {status:'unknown'};active++;
  const end=performance.now()+deadline,controller=new AbortController();let bridge,onAbort,timer;
  try{if(types.isProxy(input))throw Error();const d=Object.getOwnPropertyDescriptor(input,'signal');if(d&&!Object.hasOwn(d,'value'))throw Error();bridge=bridgeSignal(d?.value);}catch{active--;return {status:'unknown'};}
  const check=()=>{if(controller.signal.aborted||performance.now()>=end){controller.abort();throw Error('deadline');}};
  const interrupted=new Promise(resolve=>{onAbort=()=>{controller.abort();resolve({status:'unknown'});};bridge.signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(onAbort,deadline);});
  const work=(async()=>{try{
   const keys=['session','expectedActor','documentId','operationId','title','html',...(mode==='create'?[]:['previousGeneration']),...(Object.hasOwn(input,'signal')?['signal']:[])];
   const r=snap(input,keys);const prev=mode==='create'?-1:r.previousGeneration, gen=prev+1;
   if(!session(r.session)||!id(r.expectedActor)||!id(r.documentId)||!op(r.operationId)||!(prev===-1&&(mode==='create'||mode==='reconcile')||validGeneration(prev)&&validGeneration(gen))||typeof r.title!=='string'||!r.title.trim()||Buffer.byteLength(r.title)>200||typeof r.html!=='string'||Buffer.byteLength(r.html)>1024)return {status:'invalid'};
   check();const rawMember=await c.membership({session:r.session,expectedActor:r.expectedActor,boardId:c.boardId,signal:controller.signal,deadline:end});check();
   if(rawMember===null)return {status:'denied'};
   const member=snap(rawMember,['active','boardId','teamId','userId']);
   if(member.active!==true||member.boardId!==c.boardId||member.teamId!==c.teamId||member.userId!==r.expectedActor)return {status:'denied'};
   const fingerprint=hash(['knowledge-version-intent-v1',c.boardId,r.documentId,prev,gen,r.expectedActor,r.operationId,r.title,r.html]);
   const receipt={kind:'knowledge-version-receipt-v1',boardId:c.boardId,documentId:r.documentId,actor:r.expectedActor,operationId:r.operationId,previousGeneration:prev,generation:gen,fingerprint};
   if(size(receipt)>c.maxPayloadBytes)return {status:'invalid'};
   const rid=receiptId(c.boardId,r.expectedActor,r.operationId);
   const match=x=>matchReceipt(x,receipt,c.maxPayloadBytes);
   const existing=await s.get(rid,{signal:controller.signal,deadline:end});check();if(existing!==null)return {status:match(existing)?'confirmed':'unknown'};
   if(mode==='reconcile')return {status:'unknown'};
   let creator=r.expectedActor;
   if(mode==='edit'){const base=version(await s.get(rowId(c.boardId,r.documentId,prev),{signal:controller.signal,deadline:end}),c.boardId,r.documentId,prev,c.maxPayloadBytes);check();if(!base)return {status:'unknown'};creator=base.creator;}
   const doc={kind:'knowledge-version-v1',boardId:c.boardId,documentId:r.documentId,generation:gen,creator,editor:r.expectedActor,title:r.title,html:r.html};
   if(!version(doc,c.boardId,r.documentId,gen,c.maxPayloadBytes))return {status:'invalid'};
   check();try{await s.transaction([{id:rowId(c.boardId,r.documentId,gen),data:doc},{id:rid,data:receipt}],{signal:controller.signal,deadline:end});check();const stored=await s.get(rid,{signal:controller.signal,deadline:end});check();return {status:match(stored)?'confirmed':'unknown'};}catch{return {status:'unknown'};}
  }catch{return {status:'unknown'};}})();
  work.finally(()=>active--).catch(()=>{});
  try{const result=await Promise.race([work,interrupted]);check();return result;}catch{return {status:'unknown'};}finally{clearTimeout(timer);bridge.signal?.removeEventListener('abort',onAbort);bridge.dispose();controller.abort();}
 }
 return Object.freeze({create:x=>run(x,'create'),edit:x=>run(x,'edit'),reconcile:x=>run(x,'reconcile')});
}

// Configuration is operator supplied. Equality checks do not prove ACLs or
// exclude another privileged writer; those remain deployment gates.
export function createAppwriteVersionedKnowledge(options={},sharedGate){
 const c=snap(options,['enabled','endpoint','approvedEndpoint','project','database','table','legacyTable','legacyDatabase','boardId','teamId','key','maxPayloadBytes','transport','deadlineMs'],false);
 if(c.enabled!==true)return createVersionedKnowledge();
 if(!id(c.database)||!id(c.table)||!id(c.legacyTable)||(c.legacyDatabase!==undefined&&!id(c.legacyDatabase))||(c.table===c.legacyTable&&(c.legacyDatabase===undefined||c.database===c.legacyDatabase))||typeof c.key!=='string'||!/[\x21-\x7e]/.test(c.key)||! /^[\x21-\x7e]{1,4096}$/.test(c.key)||typeof c.transport!=='function')throw Error('invalid configuration');
 const transport=knowledgeTransportFor(c.transport,sharedGate);
 const membership=createTeamMembershipProvider({endpoint:c.endpoint,approvedEndpoint:c.approvedEndpoint,project:c.project,boardId:c.boardId,teamId:c.teamId,transport});
 const store=appwriteStore({endpoint:c.endpoint,project:c.project,database:c.database,table:c.table,key:c.key,fetchImpl:transport});
 return createVersionedKnowledge({enabled:true,boardId:c.boardId,teamId:c.teamId,membership,store:{get:store.get,transaction:store.transaction},maxPayloadBytes:c.maxPayloadBytes,...(c.deadlineMs===undefined?{}:{deadlineMs:c.deadlineMs})});
}
