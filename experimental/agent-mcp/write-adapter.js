// Explicitly enabled local mutation adapter. The listener, response path and journal are trusted.
import https from 'node:https';
import {createJournal,snapshot} from './intent-journal.js';
import {parseGuardedJson} from '../guarded-strict-json.js';
import {parseInput,validateConfig,validatedConnection} from '../review-agent-connector.js';

export function createWriteAdapter({args,session,journalDir,backendScope}) {
 const config=validatedConnection(validateConfig(args));
 if(typeof session!=='string')throw Error('configuration');
 parseInput(Buffer.from(JSON.stringify({session,operation:'discover'})));
 backendScope=snapshot(backendScope,['endpoint','project','database','table']);
 const actor=config.actor,board=config.board,journal=createJournal(journalDir,backendScope);
 const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
 const gen=(x,max)=>Number.isSafeInteger(x)&&x>=0&&x<=max;
 let busy=false;
 const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
 function send(route,intent,signal){
  return new Promise((resolve)=>{
   let done=false,req,timer;const finish=x=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(!x)req?.destroy();resolve(x);};
   const abort=()=>finish(null);if(signal?.aborted)return finish(null);signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,10000);
   const body=JSON.stringify({scope:backendScope,intent});
   try{req=https.request({hostname:config.hostname,port:config.port,path:'/review/scoped-'+route,method:'POST',agent:false,ca:config.ca,rejectUnauthorized:true,headers:{host:config.host,origin:config.endpoint,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json','content-length':Buffer.byteLength(body),cookie:`__Host-weftline=${session}`}},res=>{
    if(![200,201].includes(res.statusCode)||res.headers['content-type']?.split(';')[0]!=='application/json'){res.destroy();return finish(null);}
    let size=0;const chunks=[];res.on('data',c=>{size+=c.length;if(size>65536){res.destroy();finish(null);}else chunks.push(c);});res.on('error',abort);res.on('aborted',abort);res.on('end',()=>{try{const value=parseGuardedJson(Buffer.concat(chunks));if(!exact(value,['status','receipt']))return finish(null);finish({code:res.statusCode,...value});}catch{finish(null);}});
   });req.on('error',abort);req.end(body);}catch{finish(null);}
  });
 }
 return async function run(action,args,signal){
  if(busy)return {status:'blocked'};busy=true;
  try{
   try{args=snapshot(args,action==='reconcile'?['currentGuardGeneration']:['operation','task','guardGeneration','taskGeneration']);}catch{return {status:'invalid'};}
   let intent,route;
   if(action==='reconcile'){
    if(!exact(args,['currentGuardGeneration'])||!gen(args.currentGuardGeneration,999998))return {status:'invalid'};
    const prior=journal.inspect();if(prior.status!=='pending')return {status:'blocked'};
    intent=prior.intent;if(intent.expectedActor!==actor||intent.board!==board)return {status:'blocked'};
    route='receipt';
   }else{
    if(!['claim','submit','approve','reject'].includes(action)||!exact(args,['operation','task','guardGeneration','taskGeneration'])||![args.operation,args.task].every(id)||!gen(args.guardGeneration,999997)||!gen(args.taskGeneration,999998))return {status:'invalid'};
    intent={board,expectedActor:actor,guardGeneration:args.guardGeneration,operation:args.operation,task:args.task,taskGeneration:args.taskGeneration,action};
    if(signal?.aborted)return {status:'blocked'};
    if(journal.begin(intent).status!=='pending')return {status:'blocked'};
    route='transition';
   }
   const result=await send(route,route==='receipt'?{...intent,currentGuardGeneration:args.currentGuardGeneration}:intent,signal);
   if(!result)return {status:'unknown'};
   if(journal.reconcile(result).status!=='reconciled')return {status:'unknown'};
   return {status:'recorded',receipt:result.receipt};
  }catch{return {status:'unknown'};}finally{busy=false;}
 };
}
