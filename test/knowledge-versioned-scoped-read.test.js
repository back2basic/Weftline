import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAppwriteVersionedRead,createVersionedRead} from '../experimental/knowledge-versioned-read.js';
import {rowId} from '../experimental/knowledge-versioned-schema.js';
import {startVersionedProvider} from './fixtures/knowledge-versioned-http-provider.js';

const scope={endpoint:'https://provider.example.test/v1',project:'project',database:'database',table:'knowledge',boardId:'board',teamId:'team'};
const version={kind:'knowledge-version-v1',boardId:'board',documentId:'doc',generation:0,creator:'alice',editor:'alice',title:'Title',html:'<p>Shared</p>'};

test('scoped read authenticates membership before checking scope and private data',{timeout:5000},async()=>{
 const events=[];
 const service=createVersionedRead({enabled:true,boardId:'board',teamId:'team',backendScope:scope,maxPayloadBytes:1024,
  membership:async({session,expectedActor})=>{events.push('membership');return session==='good'&&expectedActor==='alice'?{active:true,boardId:'board',teamId:'team',userId:'alice'}:null;},
  store:{get:async()=>{events.push('private-read');return version;}}});
 const input={session:'good',expectedActor:'alice',documentId:'doc',generation:0};
 for(const key of Object.keys(scope)){
  events.length=0;const result=await service.readScoped({...input,scope:{...scope,[key]:'wrong'}});
  assert.deepEqual(result,{status:'unknown'});assert.deepEqual(events,['membership']);
 }
 events.length=0;const denied=await service.readScoped({...input,session:'bad',scope});assert.deepEqual(denied,{status:'denied'});assert.deepEqual(events,['membership']);
 events.length=0;const allowed=await service.readScoped({...input,scope});assert.equal(allowed.status,'advisory');assert.equal(allowed.version.html,'<p>Shared</p>');assert.deepEqual(events,['membership','private-read']);
});

test('Appwrite composition binds scoped reads to its own configured store',{timeout:10000},async t=>{
 const provider=await startVersionedProvider();t.after(()=>provider.close());
 await provider.control('seed',[{$id:rowId('board','doc',0),payload:JSON.stringify(version),$permissions:[]}]);
 const actual={endpoint:'https://synthetic.test/v1',project:'project',database:'db',table:'versions',boardId:'board',teamId:'team'};
 const service=createAppwriteVersionedRead({enabled:true,...actual,approvedEndpoint:actual.endpoint,legacyTable:'legacy',key:'synthetic-key',maxPayloadBytes:1024,transport:provider.transport});
 const input={session:'alice',expectedActor:'alice',documentId:'doc',generation:0};
 assert.equal((await service.readScoped({...input,scope:actual})).version?.html,'<p>Shared</p>');
 const before=(await provider.control('metrics')).requests.filter(r=>r.path.includes('/tablesdb/')).length;
 assert.deepEqual(await service.readScoped({...input,scope:{...actual,table:'other'}}),{status:'unknown'});
 assert.equal((await provider.control('metrics')).requests.filter(r=>r.path.includes('/tablesdb/')).length,before);
});

for(const [initial,changed,expected,reads] of [['wrong','knowledge','unknown',0],['knowledge','wrong','advisory',1]]){
 test(`scoped read retains ${initial} scope while membership is pending`,{timeout:5000},async()=>{
  let entered,release;const held=new Promise(r=>{entered=r});const gate=new Promise(r=>{release=r});let lookups=0;
  const service=createVersionedRead({enabled:true,boardId:'board',teamId:'team',backendScope:scope,maxPayloadBytes:1024,
   membership:async()=>{entered();await gate;return {active:true,boardId:'board',teamId:'team',userId:'alice'};},
   store:{get:async()=>{lookups++;return version;}}});
  const supplied={...scope,table:initial};
  const pending=service.readScoped({session:'good',expectedActor:'alice',documentId:'doc',generation:0,scope:supplied});
  await held;supplied.table=changed;release();const result=await pending;
  assert.equal(result.status,expected);assert.equal(lookups,reads);
 });
}

test('outsider sees equal denial for valid malformed and mismatched scope',async()=>{
 let lookups=0,memberships=0;
 const service=createVersionedRead({enabled:true,boardId:'board',teamId:'team',backendScope:scope,maxPayloadBytes:1024,
  membership:async()=>{memberships++;return null;},store:{get:async()=>{lookups++;return version;}}});
 const getter={...scope};Object.defineProperty(getter,'table',{get(){throw Error('must not run');},enumerable:true});
 for(const supplied of [scope,{...scope,table:'wrong'},null,{...scope,extra:1},getter,new Proxy({}, {ownKeys(){throw Error('must not run');}})]){
  assert.deepEqual(await service.readScoped({session:'bad',expectedActor:'outsider',documentId:'doc',generation:0,scope:supplied}),{status:'denied'});
 }
 assert.equal(memberships,6);assert.equal(lookups,0);
});

test('legacy non-scoped read remains available with a bound scope',async()=>{
 let lookups=0;
 const service=createVersionedRead({enabled:true,boardId:'board',teamId:'team',backendScope:scope,maxPayloadBytes:1024,
  membership:async()=>({active:true,boardId:'board',teamId:'team',userId:'alice'}),
  store:{get:async()=>{lookups++;return version;}}});
 const result=await service.read({session:'good',expectedActor:'alice',documentId:'doc',generation:0});
 assert.equal(result.status,'advisory');assert.equal(result.version.html,version.html);assert.equal(lookups,1);
});
