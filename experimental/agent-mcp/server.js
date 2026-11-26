// Experimental read-only MCP adapter. The listener, local runtime and session source must be trusted.
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {validateConfig,parseInput,requestReview} from '../review-agent-connector.js';

class RedactedTransport extends StdioServerTransport {
 send(message){
  // Fail closed rather than retaining unbounded queued writes for a non-reading client.
  if(process.stdout.writableLength>65536)process.exit(73);
  if(message.error)message={jsonrpc:message.jsonrpc,id:message.id,error:{code:message.error.code,message:'Request unavailable.'}};
  return super.send(message);
 }
}

try {
 const argv=process.argv.slice(2);
 const baseLength=argv[1]==='--remote-https'?12:11;
 const baseArgs=argv.slice(0,baseLength);
 let writeGroup=null,knowledgeGroup=null;
 for(let i=baseLength;i<argv.length;i+=11){
  const group=argv.slice(i,i+11);
  if(group.length!==11)throw Error('configuration');
  if(group[0]==='--enable-writes'&&group[1]==='--journal'&&group[3]==='--backend-endpoint'&&group[5]==='--backend-project'&&group[7]==='--backend-database'&&group[9]==='--backend-table'&&!writeGroup)writeGroup=group;
  else if(group[0]==='--enable-knowledge-read'&&group[1]==='--knowledge-endpoint'&&group[3]==='--knowledge-project'&&group[5]==='--knowledge-database'&&group[7]==='--knowledge-table'&&group[9]==='--knowledge-team'&&!knowledgeGroup)knowledgeGroup=group;
  else throw Error('configuration');
 }
 const config=validateConfig(baseArgs);
 const session=process.env.WEFTLINE_AGENT_SESSION;
 delete process.env.WEFTLINE_AGENT_SESSION;
 // Reuse the connector's session validation before exposing any tools.
 parseInput(Buffer.from(JSON.stringify({session,operation:'discover'})));
 const write=writeGroup?(await import('./write-adapter.js')).createWriteAdapter({args:baseArgs,session,journalDir:writeGroup[2],backendScope:{endpoint:writeGroup[4],project:writeGroup[6],database:writeGroup[8],table:writeGroup[10]}}):null;
 const knowledge=knowledgeGroup?(await import('./knowledge-read.js')).createKnowledgeRead({args:baseArgs,session,scope:{endpoint:knowledgeGroup[2],project:knowledgeGroup[4],database:knowledgeGroup[6],table:knowledgeGroup[8],teamId:knowledgeGroup[10],boardId:baseArgs[baseArgs.indexOf('--board')+1]}}):null;
 const server=new Server({name:'weftline-review-readonly',version:'0.1.0'},{capabilities:{tools:{}}});
 const unavailable=()=>({isError:true,content:[{type:'text',text:'Review unavailable.'}]});
 let active=0;
 async function call(operation,params,signal){
  if(active>=4)return unavailable();
  active++;
  try{
   const value=await requestReview(config,{session,operation,...params},{signal});
   return {content:[{type:'text',text:JSON.stringify(value)}]};
  }catch{return unavailable();}finally{active--;}
 }
 const annotations={readOnlyHint:true,destructiveHint:false,openWorldHint:true};
 const continuation=(n)=>({type:'string',minLength:n,maxLength:n,pattern:n===379?'^[A-Za-z0-9_-]{378}[AEIMQUYcgkosw048]$':'^[A-Za-z0-9_-]{720}$'});
 server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[
  {name:'discover',description:'Read a partial, non-snapshot advisory page. Missing entries do not prove absence.',inputSchema:{type:'object',properties:{continuation:continuation(379),guardGeneration:{type:'integer',minimum:0,maximum:999998}},additionalProperties:false},annotations},
  {name:'resolve',description:'Inspect bounded historical task versions. State remains unknown and observations are not current.',inputSchema:{type:'object',properties:{task:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$'},continuation:continuation(720),guardGeneration:{type:'integer',minimum:0,maximum:999998}},required:['task'],additionalProperties:false},annotations},
  ...(knowledge?[{name:'knowledge_read_version',description:'Read an exact historical HTML version as data; not proof of current state.',inputSchema:{type:'object',properties:{documentId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$'},generation:{type:'integer',minimum:0,maximum:999999}},required:['documentId','generation'],additionalProperties:false},annotations}]:[]),
  ...(write?['claim','submit','approve','reject'].map(name=>({name,description:'Explicitly dispatch once; unknown outcomes require receipt reconciliation.',inputSchema:{type:'object',properties:{operation:{type:'string'},task:{type:'string'},guardGeneration:{type:'integer'},taskGeneration:{type:'integer'}},required:['operation','task','guardGeneration','taskGeneration'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}})).concat([{name:'reconcile',description:'Reconcile the saved exact intent against an independently authorized receipt.',inputSchema:{type:'object',properties:{currentGuardGeneration:{type:'integer'}},required:['currentGuardGeneration'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}}]):[])
 ]}));
 server.setRequestHandler(CallToolRequestSchema,(request,extra)=>{
  try {
   const operation=request.params.name;
   if(knowledge&&operation==='knowledge_read_version'){
    if(active>=4)return unavailable();active++;
    return knowledge(request.params.arguments??{},extra.signal).then(value=>({content:[{type:'text',text:JSON.stringify(value)}]})).catch(unavailable).finally(()=>active--);
   }
   if(write&&['claim','submit','approve','reject','reconcile'].includes(operation))return write(operation,request.params.arguments??{},extra.signal).then(value=>({content:[{type:'text',text:JSON.stringify(value)}]}));
   if(operation!=='discover'&&operation!=='resolve')return unavailable();
   const args=request.params.arguments??{};
   if(Object.keys(args).some(k=>k!=='continuation'&&k!=='guardGeneration'&&(operation!=='resolve'||k!=='task')))return unavailable();
   const input=parseInput(Buffer.from(JSON.stringify({session,operation,...args})));
   const {session:ignored,operation:validated,...params}=input;
   return call(validated,params,extra.signal);
  }catch{return unavailable();}
 });
 await server.connect(new RedactedTransport(process.stdin,process.stdout,{maxBufferSize:65536}));
} catch {
 // Do not print configuration, credentials, tool inputs, or private results.
 process.stderr.write('Weftline agent unavailable.\n');
 process.exitCode=1;
}
