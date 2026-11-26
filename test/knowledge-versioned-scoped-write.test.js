import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as write from '../experimental/knowledge-versioned-edit.js';
import {startVersionedProvider} from './fixtures/knowledge-versioned-http-provider.js';

const scope={endpoint:'https://synthetic.test/v1',project:'project',database:'db',table:'versions',boardId:'board',teamId:'team'};
const config=transport=>({enabled:true,...scope,approvedEndpoint:scope.endpoint,legacyTable:'legacy',key:'synthetic-key',maxPayloadBytes:1024,transport});
const create={session:'alice',expectedActor:'alice',documentId:'doc',operationId:'a'.repeat(32),title:'Title',html:'<p>First</p>'};
const edit={...create,operationId:'b'.repeat(32),previousGeneration:0,html:'<p>Second</p>'};

test('separate scoped Appwrite receiver authenticates before scope and private operations', {timeout:10000}, async t=>{
 assert.equal(typeof write.createAppwriteScopedVersionedKnowledge,'function');
 const provider=await startVersionedProvider();t.after(()=>provider.close());
 const service=write.createAppwriteScopedVersionedKnowledge(config(provider.transport));
 for(const [mode,input] of [['create',create],['edit',edit],['reconcile',{...create,previousGeneration:-1}]]) {
  for(const key of Object.keys(scope)) {
   const before=(await provider.control('metrics')).requests.length;
   assert.deepEqual(await service[mode]({...input,scope:{...scope,[key]:'wrong'}}),{status:'unknown'});
   const requests=(await provider.control('metrics')).requests.slice(before);
   assert.deepEqual(requests.map(x=>x.path),['/v1/account','/v1/teams/team/memberships']);
  }
  for(const supplied of [scope,{...scope,table:'wrong'},null]) {
   const before=(await provider.control('metrics')).requests.length;
   assert.deepEqual(await service[mode]({...input,session:'outsider',expectedActor:'outsider',scope:supplied}),{status:'denied'});
   const requests=(await provider.control('metrics')).requests.slice(before);
   assert.deepEqual(requests.map(x=>x.path),['/v1/account','/v1/teams/team/memberships']);
  }
  for(const altered of [{},{scope:null},{scope:{...scope,extra:'x'}},{scope:{...scope,table:undefined}}]) {
   const before=(await provider.control('metrics')).requests.length;
   assert.deepEqual(await service[mode]({...input,...altered}),{status:'unknown'});
   assert.deepEqual((await provider.control('metrics')).requests.slice(before).map(x=>x.path),['/v1/account','/v1/teams/team/memberships']);
  }
  for(const auth of [{session:'bad',expectedActor:'alice'},{session:'alice',expectedActor:'bob'}]) {
   const results=[];
   for(const supplied of [scope,{...scope,table:'wrong'},null]) {
    const before=(await provider.control('metrics')).requests.length;
    results.push(await service[mode]({...input,...auth,scope:supplied}));
    assert.ok(!(await provider.control('metrics')).requests.slice(before).some(x=>x.path.includes('/tablesdb/')));
   }
   assert.deepEqual(results,[results[0],results[0],results[0]]);
   assert.notEqual(results[0].status,'confirmed');
  }
 }
 assert.deepEqual(await service.create({...create,scope}),{status:'confirmed'});
 assert.deepEqual(await service.reconcile({...create,previousGeneration:-1,scope}),{status:'confirmed'});
 assert.deepEqual(await service.edit({...edit,scope}),{status:'confirmed'});
 assert.deepEqual(await service.reconcile({...edit,scope}),{status:'confirmed'});
 assert.deepEqual(await service.reconcile({...edit,html:'different',scope}),{status:'unknown'});
 const metrics=await provider.control('metrics');assert.equal(metrics.commits,2);
});

test('scoped cancellation after a staged row prevents later transaction steps', {timeout:10000},async t=>{
 const provider=await startVersionedProvider();t.after(()=>provider.close());
 const service=write.createAppwriteScopedVersionedKnowledge({...config(provider.transport),deadlineMs:1000});
 await provider.control('hold-next-row-response');
 const controller=new AbortController();
 const pending=service.create({...create,scope,signal:controller.signal});
 let staged=false;
 for(let i=0;i<100;i++){
  if((await provider.control('metrics')).transactions.some(tx=>tx.staged===1)){staged=true;break;}
  await new Promise(r=>setTimeout(r,5));
 }
 assert.ok(staged);
 controller.abort();assert.deepEqual(await pending,{status:'unknown'});
 await provider.control('release-row-response');
 await new Promise(r=>setTimeout(r,50));
 const metrics=await provider.control('metrics');
 assert.equal(metrics.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/rows')).length,1);
 assert.equal(metrics.commits,0);
});

test('scoped reconciliation confirms an exact committed receipt after a lost response', {timeout:10000},async t=>{
 const provider=await startVersionedProvider();t.after(()=>provider.close());
 const service=write.createAppwriteScopedVersionedKnowledge(config(provider.transport));
 await provider.control('lose-next-commit');
 assert.deepEqual(await service.create({...create,scope}),{status:'unknown'});
 assert.deepEqual(await service.reconcile({...create,previousGeneration:-1,scope}),{status:'confirmed'});
 assert.deepEqual(await service.reconcile({...create,previousGeneration:-1,title:'Other',scope}),{status:'unknown'});
 assert.equal((await provider.control('metrics')).commits,1);
});

test('scoped deadline does not dispatch subsequent rows after a stalled stage', {timeout:10000},async t=>{
 const provider=await startVersionedProvider();t.after(()=>provider.close());
 const service=write.createAppwriteScopedVersionedKnowledge({...config(provider.transport),deadlineMs:200});
 await provider.control('hold-next-row-response');
 const pending=service.create({...create,scope});
 let staged=false;
 for(let i=0;i<100;i++){
  if((await provider.control('metrics')).transactions.some(tx=>tx.staged===1)){staged=true;break;}
  await new Promise(r=>setTimeout(r,5));
 }
 assert.ok(staged);
 assert.deepEqual(await pending,{status:'unknown'});
 await provider.control('release-row-response');
 await new Promise(r=>setTimeout(r,50));
 const metrics=await provider.control('metrics');
 assert.equal(metrics.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/rows')).length,1);
 assert.equal(metrics.commits,0);
});

test('legacy API remains callable and scoped receiver is disabled by default',async()=>{
 assert.equal(typeof write.createAppwriteScopedVersionedKnowledge,'function');
 const disabled=write.createAppwriteScopedVersionedKnowledge();
 assert.deepEqual(await disabled.create({}),{status:'disabled'});
 assert.deepEqual(await disabled.edit({}),{status:'disabled'});
 assert.deepEqual(await disabled.reconcile({}),{status:'disabled'});
 const provider=await startVersionedProvider();try {
  const legacy=write.createAppwriteVersionedKnowledge(config(provider.transport));
  assert.deepEqual(Object.keys(legacy),['create','edit','reconcile']);
  assert.deepEqual(await legacy.create(create),{status:'confirmed'});
  assert.deepEqual(await legacy.edit(edit),{status:'confirmed'});
  assert.deepEqual(await legacy.reconcile(edit),{status:'confirmed'});
 } finally {await provider.close();}
});


test('direct scoped calls snapshot scope before pending membership without disclosing denial', {timeout:10000}, async t=>{
 const provider=await startVersionedProvider();t.after(()=>provider.close());
 let release, reached;
 let held=new Promise(r=>{reached=r});let gate=new Promise(r=>{release=r});
 const transport=async(url,options)=>{
  const response=await provider.transport(url,options);
  if(new URL(url).pathname==='/v1/teams/team/memberships'){reached();await gate;}
  return response;
 };
 const service=write.createAppwriteScopedVersionedKnowledge(config(transport));
 async function attempt(initial, changed, actor, documentId){
  held=new Promise(r=>{reached=r});gate=new Promise(r=>{release=r});
  const supplied={...scope,table:initial};
  const before=(await provider.control('metrics')).requests.length;
  const pending=service.create({...create,session:actor,expectedActor:actor,documentId,scope:supplied});
  await held;supplied.table=changed;release();
  const result=await pending;
  const requests=(await provider.control('metrics')).requests.slice(before);
  return {result,privateRequests:requests.filter(x=>x.path.includes('/tablesdb/'))};
 }
 const wrong=await attempt('wrong','versions','alice','wrong-doc');
 assert.deepEqual(wrong.result,{status:'unknown'});assert.equal(wrong.privateRequests.length,0);
 const right=await attempt('versions','wrong','alice','right-doc');
 assert.deepEqual(right.result,{status:'confirmed'});assert.ok(right.privateRequests.length>0);
 for(const table of ['wrong','versions']){
  const outsider=await attempt(table,table==='wrong'?'versions':'wrong','outsider','outsider-doc');
  assert.deepEqual(outsider.result,{status:'denied'});assert.equal(outsider.privateRequests.length,0);
 }
});
