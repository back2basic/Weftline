import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ephemeralTls} from '../../../test/fixtures/local-tls.js';

test('configured handoff namespaces isolate identical task coordinates over MCP', {timeout:15000}, async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'handoff-ns-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const cert=join(dir,'cert');writeFileSync(cert,ephemeralTls().cert);
 const base=[resolve('experimental/agent-mcp/server.js'),'--enable','--remote-https','--endpoint','https://127.0.0.1:12345','--ca',cert,'--actor','alice','--board','b','--guard','0'];
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'};
 async function candidate(ns){const transport=new StdioClientTransport({command:process.execPath,args:[...base,'--enable-handoff','--handoff-namespace',ns],env,stderr:'pipe'});const c=new Client({name:'test',version:'1'});t.after(()=>c.close());await c.connect(transport);const r=await c.callTool({name:'handoff_candidates',arguments:{task:'task',claimGeneration:1}});assert.notEqual(r.isError,true);return JSON.parse(r.content[0].text);}
 const a=await candidate('backend-a'),same=await candidate('backend-a'),b=await candidate('backend-b');
 assert.deepEqual(a,same);assert.notEqual(a.instructions,b.instructions);assert.notEqual(a.deliverable,b.deliverable);
 assert.equal(b.instructions,'icf742d3bd219221fa48a85c4e9ab881b');assert.equal(b.deliverable,'d84e03f2c2de35951e09b3fa20b74aa64');
 for(const flags of [['--enable-handoff'],['--handoff-namespace','backend-a'],['--enable-handoff','--handoff-namespace',''],['--enable-handoff','--handoff-namespace','bad/'],['--enable-handoff','--handoff-namespace','a'.repeat(37)],['--enable-handoff','--handoff-namespace','a','--handoff-namespace','b'],['--enable-handoff','--handoff-namespace','a','--enable-handoff','--handoff-namespace','b']]){
  const p=spawnSync(process.execPath,[...base,...flags],{env,input:'',encoding:'utf8',timeout:4000});assert.equal(p.status,1,JSON.stringify(flags));assert.equal(p.stdout,'');
 }
});
