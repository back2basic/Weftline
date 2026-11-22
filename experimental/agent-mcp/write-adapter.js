// Explicitly enabled local mutation adapter. The listener, response path and journal are trusted.
import https from 'node:https';
import {readFileSync} from 'node:fs';
import {createJournal} from './intent-journal.js';
import {parseGuardedJson} from '../guarded-strict-json.js';

export function createWriteAdapter({args,session,journalDir,backendScope}) {
 const options=Object.fromEntries(Array.from({length:5},(_,i)=>[args[1+i*2],args[2+i*2]]));
 const origin=options['--endpoint'];
 // Write mode intentionally excludes remote HTTPS until separately reviewed.
 if(!/^https:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin))throw Error('configuration');
 const url=new URL(origin),ca=readFileSync(options['--ca']);
 const actor=options['--actor'],board=options['--board'],journal=createJournal(journalDir,backendScope);
 const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
 const gen=(x,max)=>Number.isSafeInteger(x)&&x>=0&&x<=max;
 let busy=false;
 const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
 function send(route,intent,signal){
  return new Promise((resolve)=>{
   let done=false,req,timer;const finish=x=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(!x)req?.destroy();resolve(x);};
   const abort=()=>finish(null);if(signal?.aborted)return finish(null);signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,10000);
   const body=JSON.stringify({scope:backendScope,intent});
   try{req=https.request({hostname:'127.0.0.1',port:Number(url.port),path:'/review/scoped-'+route,method:'POST',agent:false,ca,rejectUnauthorized:true,headers:{host:url.host,origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json','content-length':Buffer.byteLength(body),cookie:`__Host-weftline=${session}`}},res=>{
    if(![200,201].includes(res.statusCode)||res.headers['content-type']?.split(';')[0]!=='application/json'){res.destroy();return finish(null);}
    let size=0;const chunks=[];res.on('data',c=>{size+=c.length;if(size>65536){res.destroy();finish(null);}else chunks.push(c);});res.on('error',abort);res.on('aborted',abort);res.on('end',()=>{try{const value=parseGuardedJson(Buffer.concat(chunks));if(!exact(value,['status','receipt']))return finish(null);finish({code:res.statusCode,...value});}catch{finish(null);}});
   });req.on('error',abort);req.end(body);}catch{finish(null);}
  });
 }
 return async function run(action,args,signal){
  if(busy)return {status:'blocked'};busy=true;
  try{
   let intent,route;
   if(action==='reconcile'){
    if(!exact(args,['currentGuardGeneration'])||!gen(args.currentGuardGeneration,999998))return {status:'invalid'};
    const prior=journal.inspect();if(prior.status!=='pending')return {status:'blocked'};
    intent=prior.intent;if(intent.expectedActor!==actor||intent.board!==board)return {status:'blocked'};
    route='receipt';
   }else{
    if(!['claim','submit'].includes(action)||!exact(args,['operation','task','guardGeneration','taskGeneration'])||![args.operation,args.task].every(id)||!gen(args.guardGeneration,999997)||!gen(args.taskGeneration,999998))return {status:'invalid'};
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
