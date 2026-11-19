// Bounded advisory discovery for a shared private review-v1 table.
import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {guardId,taskVersionId} from './guarded-transition-receiver.js';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
const gen=x=>Number.isSafeInteger(x)&&x>=0&&x<1000000;
const hash=(...x)=>createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,32);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const title=x=>typeof x==='string'&&x.length>0&&x.trim().length>0;
function recognized(row,board) {
 const x=row.data;if(!x||x.board!==board||Buffer.byteLength(JSON.stringify(x))>1024)return false;
 switch(x.kind) {
 case 'review-guard-v1':return exact(x,['kind','board','user','generation','state','role'])&&id(x.user)&&gen(x.generation)&&['active','revoked'].includes(x.state)&&['worker','reviewer'].includes(x.role)&&row.id===guardId(board,x.user,x.generation);
 case 'review-task-v1':return exact(x,['kind','board','task','generation','state','claimant'])&&id(x.task)&&gen(x.generation)&&((x.generation===0&&x.state==='ready'&&x.claimant===null)||(x.generation>0&&['claimed','review','completed'].includes(x.state)&&id(x.claimant)))&&row.id===taskVersionId(board,x.task,x.generation);
 case 'review-receipt-v1': {
  const keys=['kind','board','expectedActor','guardGeneration','operation','task','taskGeneration','action','user'];if(Object.hasOwn(x,'title'))keys.push('title');
  return exact(x,keys)&&[x.user,x.operation,x.task].every(id)&&x.expectedActor===x.user&&gen(x.guardGeneration)&&x.guardGeneration<999998&&gen(x.taskGeneration)&&x.taskGeneration<999999&&['genesis','claim','submit','approve','reject'].includes(x.action)&&(x.action!=='genesis'||x.taskGeneration===0)&&(!Object.hasOwn(x,'title')||(x.action==='genesis'&&title(x.title)))&&row.id===hash('review-receipt-v1',board,x.user,x.operation);
 }
 case 'review-admin-receipt-v1': {
  const keys=['kind','board','actor','operation','action','generation','role','admin'];if(x.action==='change')keys.push('newRole');
  return exact(x,keys)&&[x.actor,x.operation,x.admin].every(id)&&gen(x.generation)&&x.generation<=999998&&['worker','reviewer'].includes(x.role)&&['bootstrap','change','revoke'].includes(x.action)&&(x.action!=='bootstrap'||x.generation===0)&&(x.action!=='change'||(['worker','reviewer'].includes(x.newRole)&&x.newRole!==x.role&&x.generation<999998))&&row.id===hash('review-admin-receipt-v1',board,x.admin,x.operation);
 }
 default:return false;
 }
}
export function createReviewDiscovery({store,board}) {
 const key=randomBytes(32),life=300000;
 const seal=(cursor,user,generation)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),p=Buffer.alloc(256);Buffer.from(JSON.stringify({cursor,user,board,generation,expires:Date.now()+life})).copy(p);const v=Buffer.concat([c.update(p),c.final()]);return Buffer.concat([iv,c.getAuthTag(),v]).toString('base64url');};
 const open=(token,user,generation)=>{try {if(typeof token!=='string'||!/^[\w-]+$/.test(token))throw 0;const b=Buffer.from(token,'base64url');if(b.length!==284||b.toString('base64url')!==token)throw 0;const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));const p=Buffer.concat([d.update(b.subarray(28)),d.final()]),i=p.indexOf(0);if(i<0||p.subarray(i).some(x=>x!==0))throw 0;const x=JSON.parse(p.subarray(0,i));if(!exact(x,['cursor','user','board','generation','expires'])||!id(x.cursor)||x.user!==user||x.board!==board||x.generation!==generation||!Number.isSafeInteger(x.expires)||x.expires<=Date.now()||x.expires>Date.now()+life)throw 0;return x.cursor;}catch{throw Error('invalid continuation');}};
 return async (x,session,signal,onCheckpoint)=>{
  const keys=['board','expectedActor','guardGeneration'];if(x&&Object.hasOwn(x,'continuation'))keys.push('continuation');
  if(!exact(x,keys)||x.board!==board||!id(x.expectedActor)||!gen(x.guardGeneration)||x.guardGeneration>999998)return {code:400,status:'invalid'};
  const check=()=>signal?.throwIfAborted();
  let cursor,authorized=false;
  try {
   check();const account=await store.account(session,{signal});check();
   if(!account||account.status!==true||account.$id!==x.expectedActor)return {code:403,status:'denied'};
   const g=await store.get(guardId(board,x.expectedActor,x.guardGeneration),{signal});check();
   const next=await store.get(guardId(board,x.expectedActor,x.guardGeneration+1),{signal});check();
   if(!recognized({id:guardId(board,x.expectedActor,x.guardGeneration),data:g},board)||g.kind!=='review-guard-v1'||g.user!==x.expectedActor||g.generation!==x.guardGeneration||g.state!=='active'||next!==null)return {code:403,status:'denied'};
   try {if(Object.hasOwn(x,'continuation'))cursor=open(x.continuation,x.expectedActor,x.guardGeneration);}catch{return {code:400,status:'invalid'};}
   authorized=true;
   if(cursor&&onCheckpoint)onCheckpoint(x.continuation);
   const rows=await store.listPage({limit:25,...(cursor?{cursor}:{}),signal});check();
   if(!Array.isArray(rows)||rows.length>25)throw Error();
   let prev=cursor;for(const r of rows){if(!r||!id(r.id)||(prev!==undefined&&r.id<=prev)||!id(r.data?.board)||!recognized(r,r.data.board))throw Error();prev=r.id;}
   const tasks=[];
   for(const {data:r} of rows){if(r.board!==board||r.kind!=='review-receipt-v1'||r.action!=='genesis')continue;
    let last=null,missing=false,bad=false;
    for(let n=0;n<5;n++){const v=await store.get(taskVersionId(board,r.task,n),{signal});check();if(v===null){missing=true;continue;}if(missing||!recognized({id:taskVersionId(board,r.task,n),data:v},board)||v.kind!=='review-task-v1'||v.task!==r.task||v.generation!==n){bad=true;break;}
     if(last&&!((last.state==='ready'&&v.state==='claimed')||(last.state==='claimed'&&v.state==='review'&&v.claimant===last.claimant)||(last.state==='review'&&['claimed','completed'].includes(v.state)&&v.claimant===last.claimant))){bad=true;break;}last=v;
    }
    const metadata=Object.hasOwn(r,'title')?'title-available':'legacy-title-unavailable';
    if(!last||bad)tasks.push({task:r.task,metadata,...(metadata==='title-available'?{title:r.title}:{}),state:'unknown'});
    else tasks.push({task:r.task,metadata,...(metadata==='title-available'?{title:r.title}:{}),state:'unknown',observed:{state:last.state,claimant:last.claimant,generation:last.generation}});
   }
   return {code:200,status:'partial',consistency:'advisory-non-snapshot',tasks,...(rows.length===25?{continuation:seal(prev,x.expectedActor,x.guardGeneration)}:{})};
  }catch{return {code:202,status:'unknown',consistency:'advisory-non-snapshot',...(authorized&&cursor?{continuation:x.continuation}:{})};}
 };
}
