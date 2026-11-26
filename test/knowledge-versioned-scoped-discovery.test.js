import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVersionedDiscovery,createAppwriteVersionedDiscovery} from '../experimental/knowledge-versioned-discovery.js';
import {startVersionedProvider} from './fixtures/knowledge-versioned-http-provider.js';
import {rowId} from '../experimental/knowledge-versioned-schema.js';

const scope={endpoint:'https://provider.example.test/v1',project:'project',database:'database',table:'knowledge',boardId:'board',teamId:'team'};
test('scoped discovery authenticates before scope and snapshots scope before authorization',async()=>{
 let release, entered;const wait=new Promise(r=>release=r), started=new Promise(r=>entered=r);let scans=0;
 const service=createVersionedDiscovery({enabled:true,boardId:'board',teamId:'team',backendScope:scope,maxPayloadBytes:1024,
  membership:async({session})=>{entered();await wait;return session==='good'?{active:true,boardId:'board',teamId:'team',userId:'alice'}:null;},
  store:{listPage:async()=>{scans++;return [];}}});
 const supplied={...scope};const request=service.listScoped({session:'good',expectedActor:'alice',scope:supplied});await started;supplied.table='wrong';release();
 assert.equal((await request).status,'partial');assert.equal(scans,1);
 for(const key of Object.keys(scope)){assert.deepEqual(await service.listScoped({session:'good',expectedActor:'alice',scope:{...scope,[key]:'wrong'}}),{status:'unknown'});}
 assert.deepEqual(await service.listScoped({session:'bad',expectedActor:'alice',scope:null,continuation:'bad'}),{status:'denied'});assert.equal(scans,1);
 assert.deepEqual(await service.listScoped({session:'good',expectedActor:'alice',scope,continuation:'bad'}),{status:'invalid'});assert.equal(scans,1);
});

test('Appwrite discovery binds to the real configured backend before scanning',async t=>{
 const provider=await startVersionedProvider();t.after(()=>provider.close());
 const actual={endpoint:'https://synthetic.test/v1',project:'project',database:'db',table:'versions',boardId:'board',teamId:'team'};
 const version={kind:'knowledge-version-v1',boardId:'board',documentId:'doc',generation:0,creator:'alice',editor:'alice',title:'Title',html:'body'};
 await provider.control('seed',[{$id:rowId('board','doc',0),payload:JSON.stringify(version),$permissions:[]}]);
 const service=createAppwriteVersionedDiscovery({enabled:true,...actual,approvedEndpoint:actual.endpoint,legacyTable:'legacy',key:'synthetic-key',maxPayloadBytes:1024,transport:provider.transport});
 const input={session:'alice',expectedActor:'alice',scope:actual};
 assert.deepEqual((await service.listScoped(input)).documents,[{id:'doc',title:'Title',generation:0}]);
 const before=(await provider.control('metrics')).requests.filter(r=>r.path.includes('/tablesdb/')).length;
 assert.deepEqual(await service.listScoped({...input,scope:{...actual,table:'wrong'}}),{status:'unknown'});
 assert.equal((await provider.control('metrics')).requests.filter(r=>r.path.includes('/tablesdb/')).length,before);
});

test('scoped continuations expire and do not survive receiver restart',async()=>{
 const rows=Array.from({length:25},(_,i)=>{const documentId='doc'+i;return {id:rowId('board',documentId,0),data:{kind:'knowledge-version-v1',boardId:'board',documentId,generation:0,creator:'alice',editor:'alice',title:'Title',html:'body'}};}).sort((a,b)=>a.id<b.id?-1:1);
 const options={enabled:true,boardId:'board',teamId:'team',backendScope:scope,maxPayloadBytes:1024,membership:async({expectedActor})=>({active:true,boardId:'board',teamId:'team',userId:expectedActor}),store:{listPage:async()=>rows}};
 const service=createVersionedDiscovery(options),input={session:'good',expectedActor:'alice',scope};
 const page=await service.listScoped(input);assert.equal(page.status,'partial');assert.equal(page.continuation.length,720);
 assert.deepEqual(await createVersionedDiscovery(options).listScoped({...input,continuation:page.continuation}),{status:'invalid'});
 const now=Date.now;try{Date.now=()=>now()+300001;assert.deepEqual(await service.listScoped({...input,continuation:page.continuation}),{status:'invalid'});}finally{Date.now=now;}
});
