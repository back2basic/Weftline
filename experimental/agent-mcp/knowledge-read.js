// Experimental exact read; configuration, CA, listener and runtime are trusted.
import https from 'node:https';
import {parseGuardedJson} from '../guarded-strict-json.js';
import {id,snap,validGeneration,version} from '../knowledge-versioned-schema.js';
import {parseInput,validateConfig,validatedConnection} from '../review-agent-connector.js';

export function createKnowledgeRead({args,session,scope}) {
 const config=validatedConnection(validateConfig(args));
 if(typeof session!=='string')throw Error('configuration');
 parseInput(Buffer.from(JSON.stringify({session,operation:'discover'})));
 scope=snap(scope,['endpoint','project','database','table','boardId','teamId']);
 const endpoint=new URL(scope.endpoint);
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/v1'||endpoint.href!==scope.endpoint||![scope.project,scope.database,scope.table,scope.boardId,scope.teamId].every(id)||scope.boardId!==config.board)throw Error('configuration');
 const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
 return async function read(input,signal){
  try{input=snap(input,['documentId','generation']);}catch{return {status:'invalid'};}
  if(!exact(input,['documentId','generation'])||!id(input.documentId)||!validGeneration(input.generation))return {status:'invalid'};
  const body=JSON.stringify({scope,intent:{expectedActor:config.actor,documentId:input.documentId,generation:input.generation}});
  return new Promise(resolve=>{
   let done=false,req,timer;const finish=value=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(!value)req?.destroy();resolve(value??{status:'unknown'});};
   const abort=()=>finish();if(signal?.aborted)return finish();signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,10000);
   try{req=https.request({hostname:config.hostname,port:config.port,path:'/knowledge/versioned/scoped-read',method:'POST',agent:false,ca:config.ca,rejectUnauthorized:true,headers:{host:config.host,origin:config.endpoint,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json','content-length':Buffer.byteLength(body),cookie:`__Host-weftline=${session}`}},res=>{
    if(![200,202,403].includes(res.statusCode)||res.headers['content-type']?.split(';')[0]!=='application/json'){res.destroy();return finish();}
    const chunks=[];let size=0;res.on('data',c=>{size+=c.length;if(size>4096){res.destroy();finish();}else chunks.push(c);});res.on('error',abort);res.on('aborted',abort);res.on('end',()=>{try{const x=parseGuardedJson(Buffer.concat(chunks));if(res.statusCode===403&&exact(x,['status'])&&x.status==='denied')return finish({status:'denied'});if(res.statusCode===202&&exact(x,['status'])&&x.status==='unknown')return finish({status:'unknown'});if(res.statusCode!==200||!exact(x,['status','version'])||x.status!=='advisory'||!version(x.version,scope.boardId,input.documentId,input.generation,1024))return finish();return finish({status:'advisory',version:x.version});}catch{return finish();}});
   });req.on('error',abort);req.end(body);}catch{finish();}
  });
 };
}
