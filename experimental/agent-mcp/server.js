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
 const writeEnabled=argv.length>=11&&argv.at(-11)==='--enable-writes'&&argv.at(-10)==='--journal'&&argv.at(-8)==='--backend-endpoint'&&argv.at(-6)==='--backend-project'&&argv.at(-4)==='--backend-database'&&argv.at(-2)==='--backend-table';
 const baseArgs=writeEnabled?argv.slice(0,-11):argv;
 const config=validateConfig(baseArgs);
 const session=process.env.WEFTLINE_AGENT_SESSION;
 delete process.env.WEFTLINE_AGENT_SESSION;
 // Reuse the connector's session validation before exposing any tools.
 parseInput(Buffer.from(JSON.stringify({session,operation:'discover'})));
 const write=writeEnabled?(await import('./write-adapter.js')).createWriteAdapter({args:baseArgs,session,journalDir:argv.at(-9),backendScope:{endpoint:argv.at(-7),project:argv.at(-5),database:argv.at(-3),table:argv.at(-1)}}):null;
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
  {name:'discover',description:'Read a partial, non-snapshot advisory page. Missing entries do not prove absence.',inputSchema:{type:'object',properties:{continuation:continuation(379)},additionalProperties:false},annotations},
  {name:'resolve',description:'Inspect bounded historical task versions. State remains unknown and observations are not current.',inputSchema:{type:'object',properties:{task:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$'},continuation:continuation(720)},required:['task'],additionalProperties:false},annotations},
  ...(write?['claim','submit'].map(name=>({name,description:'Explicitly dispatch once; unknown outcomes require receipt reconciliation.',inputSchema:{type:'object',properties:{operation:{type:'string'},task:{type:'string'},guardGeneration:{type:'integer'},taskGeneration:{type:'integer'}},required:['operation','task','guardGeneration','taskGeneration'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}})).concat([{name:'reconcile',description:'Reconcile the saved exact intent against an independently authorized receipt.',inputSchema:{type:'object',properties:{currentGuardGeneration:{type:'integer'}},required:['currentGuardGeneration'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}}]):[])
 ]}));
 server.setRequestHandler(CallToolRequestSchema,(request,extra)=>{
  try {
   const operation=request.params.name;
   if(write&&['claim','submit','reconcile'].includes(operation))return write(operation,request.params.arguments??{},extra.signal).then(value=>({content:[{type:'text',text:JSON.stringify(value)}]}));
   if(operation!=='discover'&&operation!=='resolve')return unavailable();
   const args=request.params.arguments??{};
   if(Object.keys(args).some(k=>k!=='continuation'&&(operation!=='resolve'||k!=='task')))return unavailable();
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
