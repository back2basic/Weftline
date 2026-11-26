import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import https from 'node:https';
import dns from 'node:dns';
import {ephemeralTls} from '../../../test/fixtures/local-tls.js';
import {createKnowledgeWrite} from '../knowledge-write.js';

test('only strict HTTP 200 exact raw confirmation clears the private pending intent', {timeout:20000},async t=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'knowledge-confirm-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const tls=ephemeralTls(),cert=join(dir,'ca');writeFileSync(cert,tls.cert);
 const prior=dns.getDefaultResultOrder();dns.setDefaultResultOrder('ipv4first');t.after(()=>dns.setDefaultResultOrder(prior));
 let code=200,raw='',requests=[];
 const server=https.createServer(tls,(req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests.push(JSON.parse(body));res.writeHead(code,{'content-type':'application/json'});res.end(raw);});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const args=['--enable','--remote-https','--endpoint',`https://localhost:${server.address().port}`,'--ca',cert,'--actor','alice','--board','board','--guard','0'];
 const scope={endpoint:'https://provider.example.test/v1',project:'project',database:'db',table:'versions',boardId:'board',teamId:'team'};
 const variants=[[201,'{"status":"confirmed"}'],[200,'{"status":"confirmed","extra":1}'],[200,'{"status":"unknown","status":"confirmed"}'],[200,'garbage'],[200,'{"status":"confirmed"}']];
 for(let i=0;i<variants.length;i++){
  [code,raw]=variants[i];const journal=join(dir,String(i));mkdirSync(journal,{mode:0o700});
  const write=createKnowledgeWrite({args,session:'synthetic-session',journalDir:journal,scope});
  const result=await write('knowledge_create',{documentId:'doc',title:'Private title',html:'<p>Private</p>'});
  if(i===4){assert.deepEqual(result,{status:'confirmed',operationId:result.operationId,operation:'create',documentId:'doc',generation:0});assert.match(result.operationId,/^[a-f0-9]{32}$/);}else assert.deepEqual(result,{status:'unknown'});
  const saved=readFileSync(join(journal,'state.json'),'utf8');assert(!saved.includes('synthetic-session'));assert(!JSON.stringify(result).includes('Private'));
  if(i!==4){assert.deepEqual(await write('knowledge_create',{documentId:'another',title:'x',html:'x'}),{status:'blocked'});}
 }
 assert.equal(requests.length,5);assert.equal(new Set(requests.map(x=>x.intent.operationId)).size,5);for(const r of requests)assert.match(r.intent.operationId,/^[a-f0-9]{32}$/);
});
