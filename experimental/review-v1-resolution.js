// Advisory, bounded traversal. Tokens are per-listener, confidential checkpoints, not write authority.
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {guardId,taskVersionId} from './guarded-transition-receiver.js';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
const exact=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===k.length&&k.every(y=>Object.hasOwn(x,y));
const generation=x=>Number.isSafeInteger(x)&&x>=0&&x<=999999;
const valid=(v,board,task,n)=>exact(v,['kind','board','task','generation','state','claimant'])&&v.kind==='review-task-v1'&&v.board===board&&v.task===task&&v.generation===n&&Buffer.byteLength(JSON.stringify(v))<=1024&&(n===0?v.state==='ready'&&v.claimant===null:['claimed','review','completed'].includes(v.state)&&id(v.claimant));
const follows=(a,b)=>(a.state==='ready'&&b.state==='claimed')||(a.state==='claimed'&&b.state==='review'&&a.claimant===b.claimant)||(a.state==='review'&&['claimed','completed'].includes(b.state)&&a.claimant===b.claimant);
export function createReviewResolution({store,board}) {
 if(!id(board)||!store||typeof store.account!=='function'||typeof store.get!=='function')throw Error('Invalid configuration');
 const key=randomBytes(32),life=300000;
 function seal(x,last){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),p=Buffer.alloc(512),data=Buffer.from(JSON.stringify({purpose:'review-resolution-v1',board,actor:x.expectedActor,guard:x.guardGeneration,task:x.task,last,expires:Date.now()+life}));if(data.length>=p.length)throw Error();data.copy(p);const encrypted=Buffer.concat([c.update(p),c.final()]);return Buffer.concat([iv,c.getAuthTag(),encrypted]).toString('base64url');}
 function open(token,x){if(typeof token!=='string'||token.length!==720||!/^[\w-]+$/.test(token))throw Error();const b=Buffer.from(token,'base64url');if(b.length!==540||b.toString('base64url')!==token)throw Error();const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));const p=Buffer.concat([d.update(b.subarray(28)),d.final()]),i=p.indexOf(0);if(i<0||p.subarray(i).some(v=>v!==0))throw Error();const v=JSON.parse(p.subarray(0,i));if(!exact(v,['purpose','board','actor','guard','task','last','expires'])||v.purpose!=='review-resolution-v1'||v.board!==board||v.actor!==x.expectedActor||v.guard!==x.guardGeneration||v.task!==x.task||!Number.isSafeInteger(v.expires)||v.expires<=Date.now()||v.expires>Date.now()+life||(v.last!==null&&(!generation(v.last.generation)||!valid(v.last,board,x.task,v.last.generation))))throw Error();return v.last;}
 return async (x,session,signal,onCheckpoint)=>{
  const keys=['board','expectedActor','guardGeneration','task'];if(x&&Object.hasOwn(x,'continuation'))keys.push('continuation');
  if(!exact(x,keys)||x.board!==board||!id(x.expectedActor)||!id(x.task)||!generation(x.guardGeneration)||x.guardGeneration>999998)return {code:400,status:'invalid'};
  let last=null,checkpoint,authorized=false;
  const check=()=>signal?.throwIfAborted();
  try{check();const account=await store.account(session,{signal});check();if(!account||account.status!==true||account.$id!==x.expectedActor)return {code:403,status:'denied'};
   const guard=await store.get(guardId(board,x.expectedActor,x.guardGeneration),{signal});check();const successor=await store.get(guardId(board,x.expectedActor,x.guardGeneration+1),{signal});check();
   if(!exact(guard,['kind','board','user','generation','state','role'])||guard.kind!=='review-guard-v1'||guard.board!==board||guard.user!==x.expectedActor||guard.generation!==x.guardGeneration||guard.state!=='active'||!['worker','reviewer','reader'].includes(guard.role)||successor!==null)return {code:403,status:'denied'};
   try{if(Object.hasOwn(x,'continuation'))last=open(x.continuation,x);}catch{return {code:400,status:'invalid'};}
   authorized=true;checkpoint=x.continuation||seal(x,last);onCheckpoint?.(checkpoint);
   for(let count=0;count<5;count++){const n=last===null?0:last.generation+1;if(n>999999)break;const v=await store.get(taskVersionId(board,x.task,n),{signal});check();if(v===null)break;if(!valid(v,board,x.task,n)||(last&&!follows(last,v)))throw Error();last=v;checkpoint=seal(x,last);onCheckpoint?.(checkpoint);}
   return {code:200,status:'partial',state:'unknown',consistency:'advisory-non-snapshot',actor:x.expectedActor,board,task:x.task,...(last?{observed:{generation:last.generation,state:last.state,claimant:last.claimant}}:{}),continuation:checkpoint};
  }catch{return {code:202,status:'unknown',consistency:'advisory-non-snapshot',...(authorized&&checkpoint?{continuation:checkpoint}:{})};}
 };
}
