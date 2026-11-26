// Unwired exact-version read. An observed version is advisory, never a head or snapshot.
// Dependencies and runtime are trusted; membership is not fenced against revocation.
import {types} from 'node:util';
import {id,snap,validGeneration,rowId,version} from './knowledge-versioned-schema.js';
import {bridgeSignal} from '../src/abort-signal.js';
import {createTeamMembershipProvider} from '../src/appwrite-team-membership.js';
import {appwriteStore} from './appwrite-store.js';
import {knowledgeTransportFor} from './knowledge-transport.js';

const session=x=>typeof x==='string'&&/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(x);
export function createVersionedRead(options={}) {
 const c=snap(options,['enabled','boardId','teamId','membership','store','maxPayloadBytes','deadlineMs','backendScope'],false);
 if(c.enabled!==true)return Object.freeze({read:async()=>({status:'disabled'}),readScoped:async()=>({status:'disabled'})});
 if(!id(c.boardId)||!id(c.teamId)||typeof c.membership!=='function'||!Number.isSafeInteger(c.maxPayloadBytes)||c.maxPayloadBytes<1||c.maxPayloadBytes>1024)throw Error('invalid configuration');
 const scopeKeys=['endpoint','project','database','table','boardId','teamId'];
 let boundScope;
 if(c.backendScope!==undefined){
  boundScope=snap(c.backendScope,scopeKeys);
  if(Object.keys(boundScope).length!==scopeKeys.length||![boundScope.project,boundScope.database,boundScope.table,boundScope.boardId,boundScope.teamId].every(id)||boundScope.boardId!==c.boardId||boundScope.teamId!==c.teamId)throw Error('invalid configuration');
  let endpoint;try{endpoint=new URL(boundScope.endpoint);}catch{throw Error('invalid configuration');}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/v1'||endpoint.href!==boundScope.endpoint)throw Error('invalid configuration');
 }
 const store=snap(c.store,['get','transaction'],false);if(typeof store.get!=='function')throw Error('invalid store');
 const deadline=c.deadlineMs===undefined?10000:c.deadlineMs;if(!Number.isSafeInteger(deadline)||deadline<1||deadline>30000)throw Error('invalid deadline');
 let active=0;
 async function read(input,scoped=false){
  if(scoped&&!boundScope)return {status:'disabled'};
  if(active>=4)return {status:'unknown'};active++;
  const end=performance.now()+deadline,controller=new AbortController();let bridge,timer,onAbort;
  try {if(types.isProxy(input))throw Error();const d=Object.getOwnPropertyDescriptor(input,'signal');if(d&&!Object.hasOwn(d,'value'))throw Error();bridge=bridgeSignal(d?.value);}catch{active--;return {status:'unknown'};}
  const check=()=>{if(controller.signal.aborted||performance.now()>=end){controller.abort();throw Error('deadline');}};
  const interrupted=new Promise(resolve=>{onAbort=()=>{controller.abort();resolve({status:'unknown'});};bridge.signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(onAbort,deadline);});
  const work=(async()=>{try{
   const keys=['session','expectedActor','documentId','generation',...(scoped?['scope']:[]),...(Object.hasOwn(input,'signal')?['signal']:[])];
   const r=snap(input,keys);
   if(!session(r.session)||!id(r.expectedActor)||!id(r.documentId)||!validGeneration(r.generation))return {status:'invalid'};
   check();const raw=await c.membership({session:r.session,expectedActor:r.expectedActor,boardId:c.boardId,signal:controller.signal,deadline:end});check();
   if(raw===null)return {status:'denied'};
   const member=snap(raw,['active','boardId','teamId','userId']);
   if(member.active!==true||member.boardId!==c.boardId||member.teamId!==c.teamId||member.userId!==r.expectedActor)return {status:'denied'};
   if(scoped){const supplied=snap(r.scope,scopeKeys);if(Object.keys(supplied).length!==scopeKeys.length||!scopeKeys.every(k=>supplied[k]===boundScope[k]))return {status:'unknown'};}
   check();const rawVersion=await store.get(rowId(c.boardId,r.documentId,r.generation),{signal:controller.signal,deadline:end});check();
   const item=version(rawVersion,c.boardId,r.documentId,r.generation,c.maxPayloadBytes);check();
   return item?{status:'advisory',version:{...item}}:{status:'unknown'};
  }catch{return {status:'unknown'};}})();
  work.finally(()=>active--).catch(()=>{});
  try{const result=await Promise.race([work,interrupted]);check();return result;}catch{return {status:'unknown'};}finally{clearTimeout(timer);bridge.signal?.removeEventListener('abort',onAbort);bridge.dispose();controller.abort();}
 }
 return Object.freeze({read:input=>read(input),readScoped:input=>read(input,true)});
}
export function createAppwriteVersionedRead(options={},sharedGate) {
 const c=snap(options,['enabled','endpoint','approvedEndpoint','project','database','table','legacyTable','legacyDatabase','boardId','teamId','key','maxPayloadBytes','transport','deadlineMs'],false);
 if(c.enabled!==true)return createVersionedRead();
 if(!id(c.database)||!id(c.table)||!id(c.legacyTable)||(c.legacyDatabase!==undefined&&!id(c.legacyDatabase))||(c.table===c.legacyTable&&(c.legacyDatabase===undefined||c.database===c.legacyDatabase))||typeof c.key!=='string'||! /^[\x21-\x7e]{1,4096}$/.test(c.key)||typeof c.transport!=='function')throw Error('invalid configuration');
 const transport=knowledgeTransportFor(c.transport,sharedGate);
 const membership=createTeamMembershipProvider({endpoint:c.endpoint,approvedEndpoint:c.approvedEndpoint,project:c.project,boardId:c.boardId,teamId:c.teamId,transport});
 const store=appwriteStore({endpoint:c.endpoint,project:c.project,database:c.database,table:c.table,key:c.key,fetchImpl:transport});
 const backendScope={endpoint:c.endpoint,project:c.project,database:c.database,table:c.table,boardId:c.boardId,teamId:c.teamId};
 return createVersionedRead({enabled:true,boardId:c.boardId,teamId:c.teamId,backendScope,membership,store:{get:store.get},maxPayloadBytes:c.maxPayloadBytes,...(c.deadlineMs===undefined?{}:{deadlineMs:c.deadlineMs})});
}
