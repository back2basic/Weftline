// Experimental read-only discovery. The injected membership and store are trusted server
// seams, not authority boundaries: production composition must pin endpoint,
// project, team and a logically dedicated private table. All writers must obey
// the immutable v1 schemas and deterministic IDs. Any other row poisons its
// page (unknown, no partial output); a mutable board label proves no ownership.
// Pages are advisory, not snapshots. Membership may be revoked after checking;
// count/timing can leak table activity. Restart invalidates in-memory tokens.
// Injected seams are trusted: Promise assimilation may access a then getter.
// A checkpoint is 12-byte IV + 512-byte ciphertext + 16-byte tag, encoded
// as exactly 720 ASCII base64url characters; reject other lengths before scan.
import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {types} from 'node:util';
import {boundedKnowledgeTransport} from './knowledge-transport.js';
import {appwriteStore} from './appwrite-store.js';
import {createTeamMembershipProvider} from '../src/appwrite-team-membership.js';
import {bridgeSignal} from '../src/abort-signal.js';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('base64url').slice(0,32);
const exact=(x,keys)=>{if(!x||types.isProxy(x)||Object.getPrototypeOf(x)!==Object.prototype)return false;const k=Reflect.ownKeys(x);return k.length===keys.length&&k.every(n=>keys.includes(n)&&Object.hasOwn(Object.getOwnPropertyDescriptor(x,n),'value'));};
function snapshot(x){if(!x||typeof x!=='object'||types.isProxy(x)||Object.getPrototypeOf(x)!==Object.prototype)throw Error();const out=Object.create(null);for(const k of Reflect.ownKeys(x)){const d=Object.getOwnPropertyDescriptor(x,k);if(typeof k!=='string'||!d||!Object.hasOwn(d,'value'))throw Error();out[k]=d.value;}return out;}
function pageSnapshot(rows){if(types.isProxy(rows)||!Array.isArray(rows)||Object.getPrototypeOf(rows)!==Array.prototype)throw Error();const length=Object.getOwnPropertyDescriptor(rows,'length').value;if(length>25)throw Error();const keys=Reflect.ownKeys(rows);if(keys.length!==length+1)throw Error();const result=[];for(let i=0;i<length;i++){const d=Object.getOwnPropertyDescriptor(rows,String(i));if(!d||!Object.hasOwn(d,'value'))throw Error();result.push(d.value);}return result;}
function classify(row){
 if(Object.keys(row).length!==2||!Object.hasOwn(row,'data')||!id(row.id))throw Error();const x=snapshot(row.data);
 if(x.kind==='knowledge-document-v1'){
  if(!exact({...x},['kind','boardId','id','title','html'])||!id(x.boardId)||!id(x.id)||typeof x.title!=='string'||!x.title.trim()||Buffer.byteLength(x.title)>200||typeof x.html!=='string'||Buffer.byteLength(x.html)>16384||Buffer.byteLength(JSON.stringify(x))>1024||row.id!=='k'+hash([x.boardId,x.id]))throw Error();
 }else if(x.kind==='knowledge-create-receipt-v1'){
  if(!exact({...x},['kind','boardId','operationId','actor','fingerprint'])||!id(x.boardId)||!id(x.actor)||typeof x.operationId!=='string'||!/^[a-f0-9]{32}$/.test(x.operationId)||typeof x.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(x.fingerprint)||Buffer.byteLength(JSON.stringify(x))>1024||row.id!=='r'+hash(['knowledge-receipt-actor-v2',x.boardId,x.actor,x.operationId]))throw Error();
 }else throw Error();return x;
}
export function createKnowledgeV2Discovery({boardId,teamId,membership,store,deadlineMs=10000}){
 if(!id(boardId)||!id(teamId)||typeof membership!=='function'||typeof store?.listPage!=='function'||!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>30000)throw Error('Invalid configuration');
 const key=randomBytes(32),life=300000;
 function seal(cursor,actor){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),p=Buffer.alloc(512);Buffer.from(JSON.stringify({cursor,actor,boardId,teamId,purpose:'knowledge-v2-list',expires:Date.now()+life})).copy(p);return Buffer.concat([iv,cipher.update(p),cipher.final(),cipher.getAuthTag()]).toString('base64url');}
 function open(token,actor){if(typeof token!=='string'||token.length!==720||!/^[\w-]+$/.test(token))throw Error();const b=Buffer.from(token,'base64url');if(b.length!==540||b.toString('base64url')!==token)throw Error();const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(524));const p=Buffer.concat([d.update(b.subarray(12,524)),d.final()]),i=p.indexOf(0);if(i<0||p.subarray(i).some(Boolean))throw Error();const x=JSON.parse(p.subarray(0,i));if(!exact({...x},['cursor','actor','boardId','teamId','purpose','expires'])||!id(x.cursor)||x.actor!==actor||x.boardId!==boardId||x.teamId!==teamId||x.purpose!=='knowledge-v2-list'||!Number.isSafeInteger(x.expires)||x.expires<=Date.now()||x.expires>Date.now()+life)throw Error();return x.cursor;}
 return async input=>{
  const controller=new AbortController(),start=performance.now();let timer,bridge,onAbort;
  try{input=snapshot(input);}catch{return {status:'denied'};}
  try{bridge=bridgeSignal(Object.hasOwn(input,'signal')?input.signal:undefined);}catch{return {status:'unknown'};}
  const check=()=>{if(controller.signal.aborted||performance.now()-start>=deadlineMs)throw Error();};
  const work=async()=>{try{
   const keys=['session','expectedActor',...(Object.hasOwn(input,'continuation')?['continuation']:[]),...(Object.hasOwn(input,'signal')?['signal']:[])];if(!exact({...input},keys)||!id(input.expectedActor)||typeof input.session!=='string')return {status:'denied'};
   check();const m=await membership({session:input.session,expectedActor:input.expectedActor,boardId,signal:controller.signal});check();
   let member;try{member=snapshot(m);}catch{return {status:'denied'};}if(member.active!==true||member.boardId!==boardId||member.teamId!==teamId||member.userId!==input.expectedActor)return {status:'denied'};
   let cursor;try{if(Object.hasOwn(input,'continuation'))cursor=open(input.continuation,input.expectedActor);}catch{return {status:'invalid'};}check();
   const page=await store.listPage({limit:25,...(cursor?{cursor}:{}),signal:controller.signal});check();const rows=pageSnapshot(page);check();
   const documents=[];let prev=cursor;for(const original of rows){const row=snapshot(original),x=classify(row);if(prev!==undefined&&row.id<=prev)throw Error();prev=row.id;if(x.boardId===boardId&&x.kind==='knowledge-document-v1')documents.push({id:x.id,title:x.title});}check();
   return {status:'partial',consistency:'advisory-non-snapshot',documents,...(rows.length===25?{continuation:seal(prev,input.expectedActor)}:{})};
  }catch{return {status:'unknown'};}};
  try{const canceled=new Promise(resolve=>{onAbort=()=>{controller.abort();resolve({status:'unknown'});};bridge.signal?.addEventListener('abort',onAbort,{once:true});if(bridge.signal?.aborted)onAbort();});const result=await Promise.race([work(),canceled,new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({status:'unknown'});},deadlineMs);})]);try{check();return result;}catch{return {status:'unknown'};}}finally{clearTimeout(timer);bridge.signal?.removeEventListener('abort',onAbort);bridge.dispose();controller.abort();}
 };
}

// This composition shares a transport gate; arbitrary injected seams may start
// detached work outside it. The review CLI can mount it only with explicit opt-in;
// this says nothing about deployment.
export function createAppwriteKnowledgeV2Discovery({endpoint,approvedEndpoint,project,boardId,teamId,database,table,key,fetchImpl=globalThis.fetch,deadlineMs}){
 const {transport}=boundedKnowledgeTransport(fetchImpl,4);
 const membership=createTeamMembershipProvider({endpoint,approvedEndpoint,project,boardId,teamId,transport});
 const store=appwriteStore({endpoint,project,database,table,key,fetchImpl:transport});
 return createKnowledgeV2Discovery({boardId,teamId,membership,store,deadlineMs});
}
