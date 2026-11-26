import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ephemeralTls} from '../../../test/fixtures/local-tls.js';

test('knowledge write tools are separately opt-in through actual stdio server', {timeout:10000}, async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'knowledge-write-mcp-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const cert=join(dir,'cert'),journal=join(dir,'knowledge-journal');writeFileSync(cert,ephemeralTls().cert);mkdirSync(journal,{mode:0o700});
 const base=[resolve('experimental/agent-mcp/server.js'),'--enable','--remote-https','--endpoint','https://127.0.0.1:12345','--ca',cert,'--actor','alice','--board','board','--guard','0'];
 const flags=['--enable-knowledge-write','--knowledge-journal',journal,'--knowledge-write-endpoint','https://provider.example.test/v1','--knowledge-write-project','project','--knowledge-write-database','db','--knowledge-write-table','versions','--knowledge-write-team','team'];
 async function tools(args){const transport=new StdioClientTransport({command:process.execPath,args,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},stderr:'pipe'});const client=new Client({name:'test',version:'1'});t.after(()=>client.close());await client.connect(transport);return (await client.listTools()).tools;}
 assert.deepEqual((await tools(base)).map(x=>x.name),['discover','resolve']);
 const enabled=await tools([...base,...flags]);assert.deepEqual(enabled.map(x=>x.name),['discover','resolve','knowledge_create','knowledge_edit','knowledge_reconcile','knowledge_ack']);
 for(const tool of enabled.slice(2))assert.equal(tool.inputSchema.additionalProperties,false);
 assert.deepEqual(enabled[2].inputSchema.required,['documentId','title','html']);
 assert.deepEqual(enabled[3].inputSchema.required,['documentId','previousGeneration','title','html']);
 assert.deepEqual(enabled[4].inputSchema.properties,{});
 assert.equal(new Set(enabled.slice(2).map(x=>x.description)).size,4);
 for(const tool of enabled.slice(2,4)){
  assert.match(tool.description,/unknown/i);
  assert.match(tool.description,/reconcile/i);
  assert.match(tool.description,/current head/i);
 }
 for(const tool of enabled.slice(2,4)){
  assert.match(tool.description,/blocks? (future|further)/i);
  assert.match(tool.description,/200 UTF-8 bytes/i);
  assert.match(tool.description,/1024 UTF-8 bytes/i);
  assert.match(tool.description,/serialized/i);
  assert.match(tool.description,/instead of retry/i);
 }
 assert.match(enabled[4].description,/pending exact intent/i);
 assert.deepEqual(enabled[5].inputSchema.required,['operationId','operation','documentId','previousGeneration','title','html']);assert.equal(enabled[5].annotations.readOnlyHint,false);assert.match(enabled[5].description,/exact original intent/i);
 assert.equal(enabled[4].annotations.readOnlyHint,false);
 const taskJournal=join(dir,'task-journal');mkdirSync(taskJournal,{mode:0o700});
 const task=['--enable-writes','--journal',taskJournal,'--backend-endpoint','https://provider.example.test/v1','--backend-project','project','--backend-database','db','--backend-table','tasks'];
 const read=['--enable-knowledge-read','--knowledge-endpoint','https://provider.example.test/v1','--knowledge-project','project','--knowledge-database','db','--knowledge-table','versions','--knowledge-team','team'];
 for(const groups of [[...flags,...read,...task],[...task,...read,...flags],[...read,...flags,...task]]){
  const names=(await tools([...base,...groups])).map(x=>x.name);
  assert.deepEqual(names,['discover','resolve','knowledge_read_version','knowledge_create','knowledge_edit','knowledge_reconcile','knowledge_ack','claim','submit','approve','reject','reconcile']);
 }
 const shared=[...task];shared[2]=journal;
 const result=spawnSync(process.execPath,[...base,...flags,...shared],{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},input:'',encoding:'utf8',timeout:4000});
 assert.equal(result.status,1);assert.equal(result.stdout,'');
});
