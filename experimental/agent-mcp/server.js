// Experimental read-only MCP adapter. The listener, local runtime and session source must be trusted.
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {validateConfig,parseInput,requestReview} from '../review-agent-connector.js';
import {statSync} from 'node:fs';

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
 let writeGroup=null,knowledgeGroup=null,knowledgeWriteGroup=null,knowledgeListGroup=null;
 for(let i=baseLength;i<argv.length;){
  const length=argv[i]==='--enable-knowledge-write'?13:11;
  const group=argv.slice(i,i+length);i+=length;
  if(group.length!==length)throw Error('configuration');
  if(group[0]==='--enable-writes'&&group[1]==='--journal'&&group[3]==='--backend-endpoint'&&group[5]==='--backend-project'&&group[7]==='--backend-database'&&group[9]==='--backend-table'&&!writeGroup)writeGroup=group;
  else if(group[0]==='--enable-knowledge-read'&&group[1]==='--knowledge-endpoint'&&group[3]==='--knowledge-project'&&group[5]==='--knowledge-database'&&group[7]==='--knowledge-table'&&group[9]==='--knowledge-team'&&!knowledgeGroup)knowledgeGroup=group;
  else if(group[0]==='--enable-knowledge-list'&&group[1]==='--knowledge-list-endpoint'&&group[3]==='--knowledge-list-project'&&group[5]==='--knowledge-list-database'&&group[7]==='--knowledge-list-table'&&group[9]==='--knowledge-list-team'&&!knowledgeListGroup)knowledgeListGroup=group;
  else if(group[0]==='--enable-knowledge-write'&&group[1]==='--knowledge-journal'&&group[3]==='--knowledge-write-endpoint'&&group[5]==='--knowledge-write-project'&&group[7]==='--knowledge-write-database'&&group[9]==='--knowledge-write-table'&&group[11]==='--knowledge-write-team'&&!knowledgeWriteGroup)knowledgeWriteGroup=group;
  else throw Error('configuration');
 }
 const config=validateConfig(baseArgs);
 const session=process.env.WEFTLINE_AGENT_SESSION;
 delete process.env.WEFTLINE_AGENT_SESSION;
 // Reuse the connector's session validation before exposing any tools.
 parseInput(Buffer.from(JSON.stringify({session,operation:'discover'})));
 if(writeGroup&&knowledgeWriteGroup){const a=statSync(writeGroup[2]),b=statSync(knowledgeWriteGroup[2]);if(a.dev===b.dev&&a.ino===b.ino)throw Error('configuration');}
 const write=writeGroup?(await import('./write-adapter.js')).createWriteAdapter({args:baseArgs,session,journalDir:writeGroup[2],backendScope:{endpoint:writeGroup[4],project:writeGroup[6],database:writeGroup[8],table:writeGroup[10]}}):null;
 const knowledge=knowledgeGroup?(await import('./knowledge-read.js')).createKnowledgeRead({args:baseArgs,session,scope:{endpoint:knowledgeGroup[2],project:knowledgeGroup[4],database:knowledgeGroup[6],table:knowledgeGroup[8],teamId:knowledgeGroup[10],boardId:baseArgs[baseArgs.indexOf('--board')+1]}}):null;
 const knowledgeList=knowledgeListGroup?(await import('./knowledge-list.js')).createKnowledgeList({args:baseArgs,session,scope:{endpoint:knowledgeListGroup[2],project:knowledgeListGroup[4],database:knowledgeListGroup[6],table:knowledgeListGroup[8],teamId:knowledgeListGroup[10],boardId:baseArgs[baseArgs.indexOf('--board')+1]}}):null;
 const knowledgeWrite=knowledgeWriteGroup?(await import('./knowledge-write.js')).createKnowledgeWrite({args:baseArgs,session,journalDir:knowledgeWriteGroup[2],scope:{endpoint:knowledgeWriteGroup[4],project:knowledgeWriteGroup[6],database:knowledgeWriteGroup[8],table:knowledgeWriteGroup[10],teamId:knowledgeWriteGroup[12],boardId:baseArgs[baseArgs.indexOf('--board')+1]}}):null;
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
 const knowledgeDescriptions={
  knowledge_create:'Create a knowledge version once. An unknown outcome blocks future knowledge writes; reconcile the saved exact intent instead of retrying. A confirmed result includes operationId, operation, documentId and generation and must be acknowledged with the exact original intent using knowledge_ack before another write. A confirmed receipt does not prove the current head. Title: at most 200 UTF-8 bytes; HTML: at most 1024 UTF-8 bytes; serialized version: at most 1024 UTF-8 bytes (the receiver may impose a lower limit).',
  knowledge_edit:'Edit a knowledge version from the supplied previous generation once. An unknown outcome blocks future knowledge writes; reconcile the saved exact intent instead of retrying. A confirmed result includes operationId, operation, documentId and generation and must be acknowledged with the exact original intent using knowledge_ack before another write. A confirmed receipt does not prove the current head. Title: at most 200 UTF-8 bytes; HTML: at most 1024 UTF-8 bytes; serialized version: at most 1024 UTF-8 bytes (the receiver may impose a lower limit).',
  knowledge_reconcile:'Recover a locally confirmed operation or reconcile a pending exact intent against the receiver; never retries a write. Confirmation includes operationId, operation, documentId and generation and requires the exact original intent for knowledge_ack before another write. A receipt does not prove the current head.',
  knowledge_ack:'Acknowledge only with the complete exact original intent, including operationId, operation, documentId, previousGeneration (-1 for create), title and html. Do not call if original content is lost; require offline recovery.'
 };
 const continuation=(n)=>({type:'string',minLength:n,maxLength:n,pattern:n===379?'^[A-Za-z0-9_-]{378}[AEIMQUYcgkosw048]$':'^[A-Za-z0-9_-]{720}$'});
 server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[
  {name:'discover',description:'Read a partial, non-snapshot advisory page. Missing entries do not prove absence.',inputSchema:{type:'object',properties:{continuation:continuation(379),guardGeneration:{type:'integer',minimum:0,maximum:999998}},additionalProperties:false},annotations},
  {name:'resolve',description:'Inspect bounded historical task versions. State remains unknown and observations are not current.',inputSchema:{type:'object',properties:{task:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$'},continuation:continuation(720),guardGeneration:{type:'integer',minimum:0,maximum:999998}},required:['task'],additionalProperties:false},annotations},
  ...(knowledge?[{name:'knowledge_read_version',description:'Read an exact historical HTML version as data; not proof of current state.',inputSchema:{type:'object',properties:{documentId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$'},generation:{type:'integer',minimum:0,maximum:999999}},required:['documentId','generation'],additionalProperties:false},annotations}]:[]),
  ...(knowledgeList?[{name:'knowledge_list',description:'List partial advisory, non-snapshot genesis candidates. Absence proves nothing.',inputSchema:{type:'object',properties:{continuation:continuation(720)},additionalProperties:false},annotations}]:[]),
  ...(knowledgeWrite?['knowledge_create','knowledge_edit','knowledge_reconcile','knowledge_ack'].map(name=>({name,description:knowledgeDescriptions[name],inputSchema:name==='knowledge_ack'?{type:'object',properties:{operationId:{type:'string',pattern:'^[a-f0-9]{32}$'},operation:{type:'string',enum:['create','edit']},documentId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$'},previousGeneration:{type:'integer',minimum:-1,maximum:999998},title:{type:'string',minLength:1,maxLength:200},html:{type:'string',maxLength:1024}},required:['operationId','operation','documentId','previousGeneration','title','html'],additionalProperties:false}:name==='knowledge_reconcile'?{type:'object',properties:{},additionalProperties:false}:{type:'object',properties:{documentId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$'},...(name==='knowledge_edit'?{previousGeneration:{type:'integer',minimum:0,maximum:999998}}:{}),title:{type:'string',minLength:1,maxLength:200},html:{type:'string',maxLength:1024}},required:name==='knowledge_edit'?['documentId','previousGeneration','title','html']:['documentId','title','html'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}})):[]),
  ...(write?['claim','submit','approve','reject'].map(name=>({name,description:'Explicitly dispatch once; unknown outcomes require receipt reconciliation.',inputSchema:{type:'object',properties:{operation:{type:'string'},task:{type:'string'},guardGeneration:{type:'integer'},taskGeneration:{type:'integer'}},required:['operation','task','guardGeneration','taskGeneration'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}})).concat([{name:'reconcile',description:'Reconcile the saved exact intent against an independently authorized receipt.',inputSchema:{type:'object',properties:{currentGuardGeneration:{type:'integer'}},required:['currentGuardGeneration'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}}]):[])
 ]}));
 server.setRequestHandler(CallToolRequestSchema,(request,extra)=>{
  try {
   const operation=request.params.name;
   if(knowledgeList&&operation==='knowledge_list'){
    if(active>=4)return unavailable();active++;
    return knowledgeList(request.params.arguments??{},extra.signal).then(value=>({content:[{type:'text',text:JSON.stringify(value)}]})).catch(unavailable).finally(()=>active--);
   }
   if(knowledgeWrite&&['knowledge_create','knowledge_edit','knowledge_reconcile','knowledge_ack'].includes(operation))return knowledgeWrite(operation,request.params.arguments??{},extra.signal).then(value=>({content:[{type:'text',text:JSON.stringify(value)}]})).catch(unavailable);
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
