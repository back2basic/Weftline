import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createReviewService} from '../experimental/review-v1-service.js';
import {guardId} from '../experimental/guarded-transition-receiver.js';

const intent={board:'b',expectedActor:'alice',guardGeneration:0,operation:'create',task:'t',taskGeneration:0,action:'genesis'};
const guard=(generation,state='active',role='worker',user='alice')=>({kind:'review-guard-v1',board:'b',user,generation,state,role});

test('historical receipts require the exact current active role-bearing guard on both routes',async()=>{
 const rows=new Map([[guardId('b','alice',0),guard(0)]]);let receiptReads=0;
 const store={account:async session=>({$id:session,status:true}),get:async id=>{if(![0,1,2,3].some(n=>id===guardId('b','alice',n)))receiptReads++;return rows.get(id)??null;},transaction:async entries=>{for(const e of entries)rows.set(e.id,e.data);}};
 const service=createReviewService({store,board:'b'});
 assert.equal((await service('genesis',intent,'alice')).status,'recorded');
 for(const route of ['receipt','genesis']) {
  assert.notEqual((await service(route,intent,'alice')).status,'recorded', 'old candidate cannot reveal receipt');
  assert.equal((await service(route,{...intent,currentGuardGeneration:1},'alice')).status,'recorded');
  rows.set(guardId('b','alice',2),guard(2));
  const before=receiptReads;
  assert.notEqual((await service(route,{...intent,currentGuardGeneration:1},'alice')).status,'recorded');
  assert.equal(receiptReads,before,'stale candidate must not lookup receipt');
  assert.equal((await service(route,{...intent,currentGuardGeneration:2},'alice')).status,'recorded');
  rows.set(guardId('b','alice',2),guard(2,'revoked'));
  assert.notEqual((await service(route,{...intent,currentGuardGeneration:2},'alice')).status,'recorded');
  rows.set(guardId('b','alice',2),guard(2,'active','reviewer'));
  assert.notEqual((await service(route,{...intent,currentGuardGeneration:2},'alice')).status,'recorded');
  rows.set(guardId('b','alice',2),guard(2));
  assert.notEqual((await service(route,{...intent,currentGuardGeneration:2},'bob')).status,'recorded');
  assert.equal((await service('receipt',{...intent,currentGuardGeneration:2,operation:'absent'},'alice')).status,'unknown');
  assert.equal((await service('genesis',{...intent,currentGuardGeneration:2,operation:'absent'},'alice')).status,'unknown');
  assert.notEqual((await service(route,{...intent,currentGuardGeneration:2,task:'other'},'alice')).status,'recorded');
  assert.notEqual((await service(route,{...intent,currentGuardGeneration:2,guardGeneration:1},'alice')).status,'recorded');
  assert.notEqual((await service('receipt',{...intent,currentGuardGeneration:2,action:'claim',taskGeneration:1},'alice')).status,'recorded');
  rows.delete(guardId('b','alice',2));
 }
});
