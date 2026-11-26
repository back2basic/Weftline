import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ephemeralTls} from '../../../test/fixtures/local-tls.js';

test('handoff candidates require explicit flag and validate inputs over stdio', {timeout:10000}, async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'handoff-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const cert=join(dir,'cert');writeFileSync(cert,ephemeralTls().cert);
 const base=[resolve('experimental/agent-mcp/server.js'),'--enable','--remote-https','--endpoint','https://127.0.0.1:12345','--ca',cert,'--actor','alice','--board','b','--guard','0'];
 async function connect(flags=[]){const transport=new StdioClientTransport({command:process.execPath,args:[...base,...flags],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},stderr:'pipe'});const c=new Client({name:'test',version:'1'});t.after(()=>c.close());await c.connect(transport);return c;}
 const old=await connect();assert.deepEqual((await old.listTools()).tools.map(t=>t.name),['discover','resolve']);assert.equal((await old.callTool({name:'handoff_candidates',arguments:{task:'task',claimGeneration:1}})).isError,true);
 const c=await connect(['--enable-handoff','--handoff-namespace','backend-a']);const tools=(await c.listTools()).tools;assert.deepEqual(tools.map(t=>t.name),['discover','resolve','handoff_candidates']);assert.equal(tools[2].annotations.readOnlyHint,true);
 const call=args=>c.callTool({name:'handoff_candidates',arguments:args});
 const result=await call({task:'task',claimGeneration:1});assert.deepEqual(JSON.parse(result.content[0].text),{status:'candidate',board:'b',task:'task',claimGeneration:1,instructions:'ib97943927bc4abdd6ce617cb990c44eb',deliverable:'d609284545c507211e0b2e1cf36cd922e'});
 for(const args of [{task:'task',claimGeneration:-1},{task:'task',claimGeneration:'1'},{task:'task',claimGeneration:1,board:'other'},{task:'bad/',claimGeneration:1},{task:'task',claimGeneration:1,namespace:'backend-b'},{}])assert.equal((await call(args)).isError,true);
 const dup=spawnSync(process.execPath,[...base,'--enable-handoff','--enable-handoff'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,WEFTLINE_AGENT_SESSION:'alice'},input:'',encoding:'utf8',timeout:4000});assert.equal(dup.status,1);assert.equal(dup.stdout,'');
});
