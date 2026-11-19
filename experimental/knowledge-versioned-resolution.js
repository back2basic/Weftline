// Default-off, read-only advisory traversal. Runtime, dependencies and trusted writers
// are assumptions; authorization is not atomic with revocation or subsequent reads.
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {types} from 'node:util';
import {id,snap,validGeneration,rowId,version} from './knowledge-versioned-schema.js';
import {bridgeSignal} from '../src/abort-signal.js';
import {createTeamMembershipProvider} from '../src/appwrite-team-membership.js';
import {appwriteStore} from './appwrite-store.js';
import {knowledgeTransportFor} from './knowledge-transport.js';

const session=x=>typeof x==='string'&&/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(x);
const life=300000, padded=2048, tokenLength=2768;
export function createVersionedResolution(options={}) {
 const c=snap(options,['enabled','boardId','teamId','membership','store','maxPayloadBytes','deadlineMs'],false);
 if(c.enabled!==true)return Object.freeze({resolve:async()=>({status:'disabled'})});
 if(!id(c.boardId)||!id(c.teamId)||typeof c.membership!=='function'||!Number.isSafeInteger(c.maxPayloadBytes)||c.maxPayloadBytes<1||c.maxPayloadBytes>1024)throw Error('invalid configuration');
 const store=snap(c.store,['get','transaction'],false);if(typeof store.get!=='function')throw Error('invalid store');
 const deadline=c.deadlineMs===undefined?10000:c.deadlineMs;if(!Number.isSafeInteger(deadline)||deadline<1||deadline>30000)throw Error('invalid deadline');
 const key=randomBytes(32);let active=0;
 function seal(r,last){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),plain=Buffer.alloc(padded);const data=Buffer.from(JSON.stringify({purpose:'knowledge-resolution-v1',board:c.boardId,team:c.teamId,actor:r.expectedActor,document:r.documentId,expires:Date.now()+life,last}));if(data.length>=plain.length)throw Error();data.copy(plain);return Buffer.concat([iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]).toString('base64url');}
 function open(token,r){if(typeof token!=='string'||token.length!==tokenLength||!/^[A-Za-z0-9_-]+$/.test(token))throw Error();const b=Buffer.from(token,'base64url');if(b.length!==padded+28||b.toString('base64url')!==token)throw Error();const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));const p=Buffer.concat([d.update(b.subarray(12,-16)),d.final()]);const i=p.indexOf(0);if(i<0||p.subarray(i).some(v=>v!==0))throw Error();const v=snap(JSON.parse(p.subarray(0,i)),['purpose','board','team','actor','document','expires','last']);if(v.purpose!=='knowledge-resolution-v1'||v.board!==c.boardId||v.team!==c.teamId||v.actor!==r.expectedActor||v.document!==r.documentId||!Number.isSafeInteger(v.expires)||v.expires<=Date.now()||v.expires>Date.now()+life||!v.last||!validGeneration(v.last.generation))throw Error();const last=version(v.last,c.boardId,r.documentId,v.last.generation,c.maxPayloadBytes);if(!last)throw Error();return last;}
 async function resolve(input){
  if(active>=4)return {status:'unknown'};active++;
  const end=performance.now()+deadline,controller=new AbortController();let bridge,timer,onAbort;
  try{if(types.isProxy(input))throw Error();const d=Object.getOwnPropertyDescriptor(input,'signal');if(d&&!Object.hasOwn(d,'value'))throw Error();bridge=bridgeSignal(d?.value);}catch{active--;return {status:'unknown'};}
  const check=()=>{if(controller.signal.aborted||performance.now()>=end){controller.abort();throw Error('deadline');}};
  const interrupted=new Promise(resolve=>{onAbort=()=>{controller.abort();resolve({status:'unknown'});};bridge.signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(onAbort,deadline);});
  const work=(async()=>{try{
   const r=snap(input,['session','expectedActor','documentId',...(Object.hasOwn(input,'continuation')?['continuation']:[]),...(Object.hasOwn(input,'signal')?['signal']:[])]);
   if(!session(r.session)||!id(r.expectedActor)||!id(r.documentId))return {status:'invalid'};
   check();const raw=await c.membership({session:r.session,expectedActor:r.expectedActor,boardId:c.boardId,signal:controller.signal,deadline:end});check();
   if(raw===null)return {status:'denied'};const member=snap(raw,['active','boardId','teamId','userId']);
   if(member.active!==true||member.boardId!==c.boardId||member.teamId!==c.teamId||member.userId!==r.expectedActor)return {status:'denied'};
   let last=null;if(Object.hasOwn(r,'continuation')){try{last=open(r.continuation,r);}catch{check();return {status:'invalid'};}}check();
   for(let count=0;count<5;count++){const n=last===null?0:last.generation+1;if(!validGeneration(n))break;check();const rawVersion=await store.get(rowId(c.boardId,r.documentId,n),{signal:controller.signal,deadline:end});check();if(rawVersion===null)break;const next=version(rawVersion,c.boardId,r.documentId,n,c.maxPayloadBytes);check();if(!next||(last?next.creator!==last.creator:next.creator!==next.editor))return {status:'unknown'};last=next;}
   check();if(!last)return {status:'unknown'};const continuation=seal(r,last);check();return {status:'partial',state:'unknown',consistency:'advisory-non-snapshot',candidate:{...last},continuation};
  }catch{return {status:'unknown'};}})();
  work.finally(()=>active--).catch(()=>{});
  try{const result=await Promise.race([work,interrupted]);check();return result;}catch{return {status:'unknown'};}finally{clearTimeout(timer);bridge.signal?.removeEventListener('abort',onAbort);bridge.dispose();controller.abort();}
 }
 return Object.freeze({resolve});
}
export function createAppwriteVersionedResolution(options={},sharedGate) {
 const c=snap(options,['enabled','endpoint','approvedEndpoint','project','database','table','legacyTable','legacyDatabase','boardId','teamId','key','maxPayloadBytes','transport','deadlineMs'],false);
 if(c.enabled!==true)return createVersionedResolution();
 if(!id(c.database)||!id(c.table)||!id(c.legacyTable)||(c.legacyDatabase!==undefined&&!id(c.legacyDatabase))||(c.table===c.legacyTable&&(c.legacyDatabase===undefined||c.database===c.legacyDatabase))||typeof c.key!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(c.key)||typeof c.transport!=='function')throw Error('invalid configuration');
 const transport=knowledgeTransportFor(c.transport,sharedGate);
 const membership=createTeamMembershipProvider({endpoint:c.endpoint,approvedEndpoint:c.approvedEndpoint,project:c.project,boardId:c.boardId,teamId:c.teamId,transport});
 const store=appwriteStore({endpoint:c.endpoint,project:c.project,database:c.database,table:c.table,key:c.key,fetchImpl:transport});
 return createVersionedResolution({enabled:true,boardId:c.boardId,teamId:c.teamId,membership,store:{get:store.get},maxPayloadBytes:c.maxPayloadBytes,...(c.deadlineMs===undefined?{}:{deadlineMs:c.deadlineMs})});
}
