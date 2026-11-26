// Experimental adapter: trusted local runtime, journal and HTTPS response path.
import https from 'node:https';
import {randomBytes} from 'node:crypto';
import {createKnowledgeWriteJournal} from '../knowledge-write-journal.js';
import {snap,id,size,validGeneration} from '../knowledge-versioned-schema.js';
import {parseInput,validateConfig,validatedConnection} from '../review-agent-connector.js';

export function createKnowledgeWrite({args,session,journalDir,scope}) {
 const config=validatedConnection(validateConfig(args));
 parseInput(Buffer.from(JSON.stringify({session,operation:'discover'})));
 scope=snap(scope,['endpoint','project','database','table','boardId','teamId']);
 const endpoint=new URL(scope.endpoint);
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/v1'||endpoint.href!==scope.endpoint||![scope.project,scope.database,scope.table,scope.boardId,scope.teamId].every(id)||scope.boardId!==config.board)throw Error('configuration');
 const journal=createKnowledgeWriteJournal(journalDir,scope,config.actor);let busy=false;
 function send(intent,signal,reconcile=false){
  const {operation,previousGeneration,...fields}=intent;
  const body=JSON.stringify({scope,intent:{expectedActor:config.actor,...fields,...(reconcile||operation==='edit'?{previousGeneration}: {})}});
  return new Promise(resolve=>{
   let done=false,req,timer;const finish=value=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(!value)req?.destroy();resolve(value);};
   const abort=()=>finish(null);if(signal?.aborted)return finish(null);signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,10000);
   try{req=https.request({hostname:config.hostname,port:config.port,path:'/knowledge/versioned/scoped-'+(reconcile?'reconcile':operation),method:'POST',agent:false,ca:config.ca,rejectUnauthorized:true,headers:{host:config.host,origin:config.endpoint,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json','content-length':Buffer.byteLength(body),cookie:`__Host-weftline=${session}`}},res=>{
    if(res.statusCode!==200||res.headers['content-type']?.split(';')[0]!=='application/json'){res.destroy();return finish(null);}
    const chunks=[];let bytes=0;res.on('data',c=>{bytes+=c.length;if(bytes>256){res.destroy();finish(null);}else chunks.push(c);});res.on('error',abort);res.on('aborted',abort);res.on('end',()=>finish(Buffer.concat(chunks)));
   });req.on('error',abort);req.end(body);}catch{finish(null);}
  });
 }
 function confirmed(intent){return {status:'confirmed',operationId:intent.operationId,operation:intent.operation,documentId:intent.documentId,generation:intent.previousGeneration+1};}
 return async(action,input,signal)=>{
  if(busy)return {status:'blocked'};busy=true;
  try{
   if(action==='knowledge_ack'){try{input=snap(input,['operation','operationId','documentId','previousGeneration','title','html']);}catch{return {status:'invalid'};}return journal.acknowledge(input);}
   if(action==='knowledge_reconcile'){
    try{snap(input,[]);}catch{return {status:'invalid'};}
    const saved=journal.recoverPending();if(saved.status==='reconciled')return confirmed(saved.intent);if(saved.status!=='pending')return {status:'blocked'};
    const raw=await send(saved.intent,signal,true);if(!raw)return {status:'unknown'};
    return journal.confirm(saved.intent,raw).status==='reconciled'?confirmed(saved.intent):{status:'unknown'};
   }
   if(!['knowledge_create','knowledge_edit'].includes(action))return {status:'blocked'};
   const edit=action==='knowledge_edit';
   try{input=snap(input,['documentId','title','html',...(edit?['previousGeneration']:[])]);}catch{return {status:'invalid'};}
   if(!id(input.documentId)||typeof input.title!=='string'||!input.title.trim()||Buffer.byteLength(input.title)>200||typeof input.html!=='string'||Buffer.byteLength(input.html)>1024)return {status:'invalid'};
   if(edit&&(!validGeneration(input.previousGeneration)||!validGeneration(input.previousGeneration+1)))return {status:'invalid'};
   const version={kind:'knowledge-version-v1',boardId:scope.boardId,documentId:input.documentId,generation:edit?input.previousGeneration+1:0,creator:edit?'x'.repeat(36):config.actor,editor:config.actor,title:input.title,html:input.html};
   if(size(version)>1024)return {status:'invalid'};
   if(signal?.aborted)return {status:'blocked'};
   const intent={operation:edit?'edit':'create',operationId:randomBytes(16).toString('hex'),documentId:input.documentId,previousGeneration:edit?input.previousGeneration:-1,title:input.title,html:input.html};
   if(journal.begin(intent).status!=='pending')return {status:'blocked'};
   const raw=await send(intent,signal);if(!raw)return {status:'unknown'};
   return journal.confirm(intent,raw).status==='reconciled'?confirmed(intent):{status:'unknown'};
  }catch{return {status:'unknown'};}finally{busy=false;}
 };
}
