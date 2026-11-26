// Experimental scoped discovery; configuration, CA, listener and runtime are trusted.
import https from 'node:https';
import {parseGuardedJson} from '../guarded-strict-json.js';
import {id,snap} from '../knowledge-versioned-schema.js';
import {parseInput,validateConfig,validatedConnection} from '../review-agent-connector.js';

export function createKnowledgeList({args,session,scope}) {
 const config=validatedConnection(validateConfig(args));
 if(typeof session!=='string')throw Error('configuration');
 parseInput(Buffer.from(JSON.stringify({session,operation:'discover'})));
 scope=snap(scope,['endpoint','project','database','table','boardId','teamId']);
 const endpoint=new URL(scope.endpoint);
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/v1'||endpoint.href!==scope.endpoint||![scope.project,scope.database,scope.table,scope.boardId,scope.teamId].every(id)||scope.boardId!==config.board)throw Error('configuration');
 const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
 return async function list(input,signal){
  try{input=snap(input,Object.hasOwn(input,'continuation')?['continuation']:[]);}catch{return {status:'invalid'};}
  // Preserve the authentication ordering even for malformed, oversized tokens.
  if(Object.hasOwn(input,'continuation')&&(typeof input.continuation!=='string'||input.continuation.length>720))input.continuation='';
  const body=JSON.stringify({scope,intent:{expectedActor:config.actor,...input}});
  return new Promise(resolve=>{
   let done=false,req,timer;const finish=value=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(!value)req?.destroy();resolve(value??{status:'unknown'});};
   const abort=()=>finish();if(signal?.aborted)return finish();signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,10000);
   try{req=https.request({hostname:config.hostname,port:config.port,path:'/knowledge/versioned/scoped-list',method:'POST',agent:false,ca:config.ca,rejectUnauthorized:true,headers:{host:config.host,origin:config.endpoint,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json','content-length':Buffer.byteLength(body),cookie:`__Host-weftline=${session}`}},res=>{
    if(![200,202,400,403].includes(res.statusCode)||res.headers['content-type']?.split(';')[0]!=='application/json'){res.destroy();return finish();}
    const chunks=[];let size=0;res.on('data',c=>{size+=c.length;if(size>32768){res.destroy();finish();}else chunks.push(c);});res.on('error',abort);res.on('aborted',abort);res.on('end',()=>{try{const x=parseGuardedJson(Buffer.concat(chunks));if(res.statusCode===403&&exact(x,['status'])&&x.status==='denied')return finish({status:'denied'});if(res.statusCode===202&&exact(x,['status'])&&x.status==='unknown')return finish({status:'unknown'});if(res.statusCode===400&&exact(x,['status'])&&x.status==='invalid')return finish({status:'invalid'});
    const keys=['status','consistency','documents',...(Object.hasOwn(x,'continuation')?['continuation']:[])];
    if(res.statusCode!==200||!exact(x,keys)||x.status!=='partial'||x.consistency!=='advisory-non-snapshot'||!Array.isArray(x.documents)||x.documents.length>25||!x.documents.every(d=>exact(d,['id','title','generation'])&&id(d.id)&&typeof d.title==='string'&&Buffer.byteLength(d.title)<=200&&d.generation===0)||Object.hasOwn(x,'continuation')&&(typeof x.continuation!=='string'||!/^[A-Za-z0-9_-]{720}$/.test(x.continuation)))return finish();return finish(x);}catch{return finish();}});
   });req.on('error',abort);req.end(body);}catch{finish();}
  });
 };
}
