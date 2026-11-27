import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReviewDiscovery} from '../experimental/review-v1-discovery.js';
import {guardId} from '../experimental/guarded-transition-receiver.js';

const hash=(...x)=>createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,32);
const guard=(board,user,generation=0,role='worker',state='active')=>({kind:'review-guard-v1',board,user,generation,state,role});
const adminReceipt=(board,admin,operation,role,newRole)=>({kind:'review-admin-receipt-v1',board,actor:'operator',operation,action:'change',generation:1,role,admin,newRole});
const adminId=(board,admin,operation)=>hash('review-admin-receipt-v1',board,admin,operation);

function setup({callerRole='worker',callerState='active',accountId='alice',accountActive=true,successor=null,rows=[]}={}) {
 const own=guard('b','alice',0,callerRole,callerState);
 let listed=0;
 const store={
  account:async()=>({$id:accountId,status:accountActive}),
  get:async id=>id===guardId('b','alice',0)?own:id===guardId('b','alice',1)?successor:null,
  listPage:async()=>{listed++;return rows;}
 };
 return {discover:createReviewDiscovery({store,board:'b'}),get listed(){return listed;}};
}
const call=(discover,actor='alice',generation=0)=>discover({board:'b',expectedActor:actor,guardGeneration:generation},'alice');

test('authorized worker and reviewer scans tolerate structurally valid reader rows across boards',async()=>{
 const rows=[
  {id:guardId('b','reader1',0),data:guard('b','reader1',0,'reader')},
  {id:adminId('b','admin','reader-change'),data:adminReceipt('b','admin','reader-change','worker','reader')},
  {id:guardId('other','reader2',0),data:guard('other','reader2',0,'reader')},
  {id:adminId('other','admin','reader-change'),data:adminReceipt('other','admin','reader-change','reader','worker')},
  {id:adminId('b','admin','reader-bootstrap'),data:{kind:'review-admin-receipt-v1',board:'b',actor:'operator',operation:'reader-bootstrap',action:'bootstrap',generation:0,role:'reader',admin:'admin'}},
  {id:adminId('b','admin','reader-revoke'),data:{kind:'review-admin-receipt-v1',board:'b',actor:'operator',operation:'reader-revoke',action:'revoke',generation:1,role:'reader',admin:'admin'}},
  {id:hash('review-receipt-v1','other','otheruser','foreignop'),data:{kind:'review-receipt-v1',board:'other',expectedActor:'otheruser',guardGeneration:0,operation:'foreignop',task:'foreign',taskGeneration:0,action:'genesis',user:'otheruser',title:'Foreign private title'}}
 ].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 for(const role of ['worker','reviewer']) {
  const {discover}=setup({callerRole:role,rows});
  const result=await call(discover);
  assert.equal(result.code,200);
  assert.equal(result.status,'partial');
  assert.deepEqual(result.tasks,[]);
  assert.equal(JSON.stringify(result).includes('Foreign private title'),false);
 }
});

test('reader can scan with a valid active guard',async()=>{
 const ctx=setup({callerRole:'reader'});
 const result=await call(ctx.discover);
 assert.equal(result.code,200);
 assert.equal(result.status,'partial');
 assert.equal(ctx.listed,1);
});

test('mismatched, inactive, revoked and superseded callers cannot scan',async()=>{
 for(const options of [{accountId:'mallory'},{accountActive:false},{callerState:'revoked'},{successor:guard('b','alice',1,'worker','revoked')}]) {
  const ctx=setup(options);
  assert.deepEqual(await call(ctx.discover),{code:403,status:'denied'});
  assert.equal(ctx.listed,0);
 }
});

test('malformed role-bearing guard and admin receipt rows still fail closed',async()=>{
 const malformed=[
  {id:guardId('b','reader1',0),data:{...guard('b','reader1',0,'reader'),role:'administrator'}},
  {id:adminId('b','admin','reader-change'),data:{...adminReceipt('b','admin','reader-change','worker','reader'),newRole:'administrator'}},
  {id:'wrong-id',data:guard('b','reader1',0,'reader')},
  {id:guardId('b','reader1',0),data:guard('other','reader1',0,'reader')},
  {id:guardId('b','reader1',0),data:{...guard('b','reader1',0,'reader'),extra:true}},
  {id:guardId('b','reader1',0),data:{kind:'review-guard-v1',board:'b',user:'reader1',generation:0,state:'active'}},
  {id:guardId('b','reader1',0),data:guard('b','reader1',-1,'reader')},
  {id:guardId('b','reader1',0),data:guard('b','reader1',0,'reader','invalid')}
 ];
 for(const row of malformed) {
  const {discover}=setup({rows:[row]});
  const result=await call(discover);
  assert.equal(result.code,202);
  assert.equal(result.status,'unknown');
 }
});
