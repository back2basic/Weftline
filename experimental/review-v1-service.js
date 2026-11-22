// Experimental: dedicated private table and exclusive trusted writers required.
import {createHash} from 'node:crypto';
import {guardId,taskVersionId} from './guarded-transition-receiver.js';
const hash=(...x)=>createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,32);
export const reviewRoleId=(board,user)=>hash('review-role-v1',board,user);
const receiptId=(board,user,op)=>hash('review-receipt-v1',board,user,op);
const id=x=>typeof x==='string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
const equal=(a,b)=>a && typeof a==='object' && !Array.isArray(a) && Object.keys(a).length===Object.keys(b).length && Object.keys(b).every(k=>Object.hasOwn(a,k)&&a[k]===b[k]);
const titleValid=x=>typeof x==='string' && x.length>0 && x.trim().length>0;
const fields=['board','expectedActor','guardGeneration','operation','task','taskGeneration','action'];
export function createReviewService({store,board}) {
 if(!id(board)||!store||!['account','get','transaction'].every(k=>typeof store[k]==='function'))throw Error('Invalid configuration');
 return async function run(route,x,session,signal,scopeCheck) {
  if(route==='task') {
   const keys=['board','expectedActor','guardGeneration','task','taskGeneration'];
   if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!keys.includes(k)&&k!=='creator'&&k!=='operation')||!keys.every(k=>Object.hasOwn(x,k))||(Object.hasOwn(x,'creator')!==Object.hasOwn(x,'operation'))||(Object.hasOwn(x,'creator')&&(!id(x.creator)||!id(x.operation)))||x.board!==board||![x.expectedActor,x.task].every(id)||!Number.isSafeInteger(x.guardGeneration)||x.guardGeneration<0||x.guardGeneration>999998||!Number.isSafeInteger(x.taskGeneration)||x.taskGeneration<0||x.taskGeneration>999999)return {code:400,status:'invalid'};
   const check=()=>signal?.throwIfAborted();
   try {
    check();const account=await store.account(session,{signal});check();
    if(!account||account.status!==true||account.$id!==x.expectedActor)return {code:403,status:'denied'};
    const user=account.$id,guard=await store.get(guardId(board,user,x.guardGeneration),{signal});check();
    if(!['worker','reviewer'].some(role=>equal(guard,{kind:'review-guard-v1',board,user,generation:x.guardGeneration,state:'active',role})))return {code:403,status:'denied'};
    const guardSuccessor=await store.get(guardId(board,user,x.guardGeneration+1),{signal});check();
    if(guardSuccessor!==null)return {code:403,status:'denied'};
    const task=await store.get(taskVersionId(board,x.task,x.taskGeneration),{signal});check();
    if(!task||!equal(task,{kind:'review-task-v1',board,task:x.task,generation:x.taskGeneration,state:task.state,claimant:task.claimant})||!((x.taskGeneration===0&&task.state==='ready'&&task.claimant===null)||(x.taskGeneration>0&&['claimed','review','completed'].includes(task.state)&&id(task.claimant))))return {code:202,status:'unknown'};
    const successor=await store.get(taskVersionId(board,x.task,x.taskGeneration+1),{signal});check();
    if(successor!==null)return {code:202,status:'unknown'};
    let metadata='legacy-title-unavailable',title;
    if(Object.hasOwn(x,'creator')) {
     const proof=await store.get(receiptId(board,x.creator,x.operation),{signal});check();
     if(proof!==null) {
      const expected={kind:'review-receipt-v1',board,expectedActor:x.creator,guardGeneration:proof.guardGeneration,operation:x.operation,task:x.task,taskGeneration:0,action:'genesis',user:x.creator};
      if(!Number.isSafeInteger(proof.guardGeneration)||proof.guardGeneration<0||proof.guardGeneration>=999998)return {code:202,status:'unknown'};
      if(Object.hasOwn(proof,'title'))expected.title=proof.title;
      if(!equal(proof,expected)||(Object.hasOwn(proof,'title')&&!titleValid(proof.title))||Buffer.byteLength(JSON.stringify(proof),'utf8')>1024)return {code:202,status:'unknown'};
      if(Object.hasOwn(proof,'title')){metadata='title-available';title=proof.title;}
     }
    }
    return {code:200,status:'current',consistency:'non-snapshot',metadata,...(title===undefined?{}:{title}),task:{board,task:x.task,generation:x.taskGeneration,state:task.state,claimant:task.claimant}};
   } catch{return {code:202,status:'unknown'};}
  }
  if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!fields.includes(k)&&k!=='currentGuardGeneration'&&k!=='title')||!fields.every(k=>Object.hasOwn(x,k))||x.board!==board||![x.expectedActor,x.operation,x.task].every(id)||!Number.isSafeInteger(x.guardGeneration)||x.guardGeneration<0||x.guardGeneration>=999998||(Object.hasOwn(x,'currentGuardGeneration')&&(!Number.isSafeInteger(x.currentGuardGeneration)||x.currentGuardGeneration<0||x.currentGuardGeneration>999998))||!Number.isSafeInteger(x.taskGeneration)||x.taskGeneration<0||x.taskGeneration>=999999||!['genesis','claim','submit','approve','reject'].includes(x.action)||(route==='genesis')!==(x.action==='genesis') && route!=='receipt'||(x.action==='genesis'&&x.taskGeneration!==0)||(Object.hasOwn(x,'title')&&(x.action!=='genesis'||!titleValid(x.title)))||Buffer.byteLength(JSON.stringify({kind:'review-receipt-v1',...Object.fromEntries(fields.map(k=>[k,x[k]])),user:x.expectedActor,...(Object.hasOwn(x,'title')?{title:x.title}:{})}),'utf8')>1024) return {code:400,status:'invalid'};
  const check=()=>signal?.throwIfAborted();
  try {
   check();const account=await store.account(session,{signal});check();
   if(!account||account.status!==true||account.$id!==x.expectedActor)return route==='receipt'?{code:202,status:'unknown'}:{code:403,status:'denied'};
   const user=account.$id,role=x.action==='approve'||x.action==='reject'?'reviewer':'worker',current=Object.hasOwn(x,'currentGuardGeneration')?x.currentGuardGeneration:x.guardGeneration;
   const guard=await store.get(guardId(board,user,current),{signal});check();
   if(!equal(guard,{kind:'review-guard-v1',board,user,generation:current,state:'active',role}))return route==='receipt'?{code:202,status:'unknown'}:{code:403,status:'denied'};
   const successor=await store.get(guardId(board,user,current+1),{signal});check();
   if(successor!==null)return route==='receipt'?{code:202,status:'unknown'}:{code:403,status:'denied'};
   // Only disclose scope mismatch after authenticating the actor and current guard.
   if(scopeCheck&&!scopeCheck())return {code:route==='receipt'?202:403,status:'unavailable'};
   const expected={kind:'review-receipt-v1',...Object.fromEntries(fields.map(k=>[k,x[k]])),user,...(Object.hasOwn(x,'title')?{title:x.title}:{})};
   const rid=receiptId(board,user,x.operation),previous=await store.get(rid,{signal});check();
   if(previous!==null)return equal(previous,expected)?{code:200,status:'recorded',receipt:expected}:{code:409,status:'unknown'};
   if(route==='receipt'||current!==x.guardGeneration)return {code:202,status:'unknown'};

   let next;
   if(x.action==='genesis')next={kind:'review-task-v1',board,task:x.task,generation:0,state:'ready',claimant:null};
   else {
    const task=await store.get(taskVersionId(board,x.task,x.taskGeneration),{signal});check();
    if(!task||!equal(task,{kind:'review-task-v1',board,task:x.task,generation:x.taskGeneration,state:task.state,claimant:task.claimant})||!((x.action==='claim'&&task.state==='ready'&&task.claimant===null)||(x.action==='submit'&&task.state==='claimed'&&task.claimant===user)||(['approve','reject'].includes(x.action)&&task.state==='review'&&id(task.claimant)&&task.claimant!==user)))return {code:403,status:'denied'};
    next={...task,generation:x.taskGeneration+1,state:({claim:'claimed',submit:'review',approve:'completed',reject:'claimed'})[x.action],claimant:x.action==='claim'?user:task.claimant};
   }
   check();
   try {
    await store.transaction([{id:guardId(board,user,x.guardGeneration+1),data:{...guard,generation:x.guardGeneration+1}},{id:taskVersionId(board,x.task,next.generation),data:next},{id:rid,data:expected}],{signal});check();
    if(!equal(await store.get(rid,{signal}),expected))throw Error('unconfirmed');check();
    return {code:201,status:'recorded',receipt:expected};
   } catch{return {code:202,status:'unknown'};}
  } catch{return {code:202,status:'unknown'};}
 };
}
