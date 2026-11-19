import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedTask } from '../src/shared-board-mutation.js';

test('a verified member creates a ready task with server-derived team read only', async () => {
  const writes = [];
  const result = await createSharedTask({session:'session-secret', boardId:'board-1', title:'  First task  '}, {
    lookupMembership: async ({session, boardId}) => {
      assert.equal(session, 'session-secret');
      assert.equal(boardId, 'board-1');
      return {userId:'user-1', boardId, teamId:'team-1', active:true};
    },
    createRow: async row => { writes.push(row); return {id:'row-1'}; },
  });
  assert.deepEqual(result, {id:'row-1'});
  assert.deepEqual(writes, [{data:{boardId:'board-1', title:'First task', status:'ready', createdBy:'user-1'}, permissions:['read("team:team-1")']}]);
});

test('denies untrusted inputs and absent, revoked, nonmember or mismatched membership before writing', async () => {
  const valid = {session:'session-secret', boardId:'board-1', title:'Task'};
  const member = {userId:'user-1', boardId:'board-1', teamId:'team-1', active:true};
  const cases = [
    [{...valid, session:''}, member],
    [{...valid, userId:'forged-user'}, member],
    [{...valid, permissions:['read("any")']}, member],
    [{...valid, title:' '}, member],
    [{...valid, boardId:'board/other'}, member],
    [valid, null],
    [valid, {...member, active:false}],
    [valid, {...member, active:undefined}],
    [valid, {...member, boardId:'other-board'}],
    [valid, {...member, userId:''}],
    [valid, {...member, teamId:'team-1")'}],
  ];
  for (const [request, lookupResult] of cases) {
    let writes = 0;
    await assert.rejects(createSharedTask(request, {
      lookupMembership: async () => lookupResult,
      createRow: async () => { writes++; },
    }));
    assert.equal(writes, 0);
  }
  let active = true;
  let writes = 0;
  const deps = {
    lookupMembership: async ({session, boardId}) => session === 'session-secret' && boardId === 'board-1' && active ? member : null,
    createRow: async () => { writes++; },
  };
  await assert.rejects(createSharedTask({...valid, session:'forged-session'}, deps));
  active = false;
  await assert.rejects(createSharedTask(valid, deps));
  assert.equal(writes, 0);
  await assert.rejects(createSharedTask(valid, {...deps, lookupMembership:async () => { throw new Error('lookup failed'); }}));
  assert.equal(writes, 0);
});

test('validates and snapshots title before waiting for the membership lookup', async () => {
  const request = {session:'session-secret', boardId:'board-1', title:'Allowed'};
  let row;
  await createSharedTask(request, {
    lookupMembership: async () => {
      request.title = '';
      return {userId:'user-1', boardId:'board-1', teamId:'team-1', active:true};
    },
    createRow: async value => { row = value; },
  });
  assert.equal(row.data.title, 'Allowed');
});

test('accessor-backed request and membership fields are read once and used consistently', async t => {
  for (const [source, field, first, later] of [
    ['request', 'session', 'session-secret', 'other-session'],
    ['request', 'boardId', 'board-1', 'bad/board'],
    ['request', 'title', '  Allowed  ', ''],
    ['membership', 'active', true, false],
    ['membership', 'boardId', 'board-1', 'other-board'],
    ['membership', 'userId', 'user-1', 'bad/user'],
    ['membership', 'teamId', 'team-1', 'bad/team'],
  ]) {
    await t.test(`${source}.${field}`, async () => {
      const request = {session:'session-secret', boardId:'board-1', title:'  Allowed  '};
      const member = {active:true, boardId:'board-1', userId:'user-1', teamId:'team-1'};
      let reads = 0;
      Object.defineProperty(source === 'request' ? request : member, field, {
        enumerable:true, get() { return ++reads === 1 ? first : later; },
      });
      let lookup;
      let row;
      await createSharedTask(request, {
        lookupMembership: async args => { lookup = args; return member; },
        createRow: async value => { row = value; },
      });
      assert.deepEqual(lookup, {session:'session-secret', boardId:'board-1'});
      assert.deepEqual(row, {data:{boardId:'board-1', title:'Allowed', status:'ready', createdBy:'user-1'}, permissions:['read("team:team-1")']});
      assert.equal(reads, 1);
    });
  }
});

test('writer result is assimilated once after dispatch',async()=>{
  let writes=0,reads=0;const value={get then(){if(++reads>1)throw Error('second then probe');return undefined}};
  const result=await createSharedTask({session:'session',boardId:'board',title:'Task'}, {
    lookupMembership:async()=>({active:true,boardId:'board',userId:'user',teamId:'team'}),
    createRow:()=>{writes++;return value},
  });
  assert.equal(result,value);assert.equal(writes,1);assert.equal(reads,1);
});

test('does not retry a rejected or ambiguous writer result', async () => {
  const request = {session:'session-secret', boardId:'board-1', title:'Task'};
  for (const reject of [true, false]) {
    let writes = 0;
    const deps = {
      lookupMembership: async () => ({active:true, boardId:'board-1', userId:'user-1', teamId:'team-1'}),
      createRow: async () => { writes++; if (reject) throw new Error('uncertain write'); return undefined; },
    };
    if (reject) await assert.rejects(createSharedTask(request, deps), /uncertain write/);
    else assert.equal(await createSharedTask(request, deps), undefined);
    assert.equal(writes, 1);
  }
});

test('ignores inherited optional signal without reading its getter', async () => {
  let reads = 0;
  const prototype = {get signal() { reads++; throw new Error('inherited signal read'); }};
  const request = Object.assign(Object.create(prototype), {session:'session', boardId:'board', title:'Task'});
  let lookup, row;
  await createSharedTask(request, {
    lookupMembership: async args => { lookup = args; return {active:true, boardId:'board', userId:'user', teamId:'team'}; },
    createRow: async args => { row = args; },
  });
  assert.equal(reads, 0);
  assert.equal(Object.hasOwn(lookup, 'signal'), false);
  assert.equal(Object.hasOwn(row, 'signal'), false);
});

test('ignores an inherited aborted signal', async () => {
  const controller = new AbortController(); controller.abort();
  const request = Object.assign(Object.create({signal:controller.signal}), {session:'session', boardId:'board', title:'Task'});
  let writes = 0;
  await createSharedTask(request, {
    lookupMembership: async () => ({active:true, boardId:'board', userId:'user', teamId:'team'}),
    createRow: async () => { writes++; },
  });
  assert.equal(writes, 1);
});

test('own signal accessor is snapshotted once and propagated', async () => {
  const controller = new AbortController();
  const request = {session:'session', boardId:'board', title:'Task'};
  let reads = 0, lookupSignal, writeSignal;
  Object.defineProperty(request, 'signal', {get() { return ++reads === 1 ? controller.signal : undefined; }});
  await createSharedTask(request, {
    lookupMembership: async args => { lookupSignal = args.signal; return {active:true, boardId:'board', userId:'user', teamId:'team'}; },
    createRow: async args => { writeSignal = args.signal; },
  });
  assert.equal(reads, 1);
  assert.equal(lookupSignal, controller.signal);
  assert.equal(writeSignal, controller.signal);
});

test('own cancellation prevents write after membership lookup', async () => {
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(createSharedTask({session:'session', boardId:'board', title:'Task', signal:controller.signal}, {
    lookupMembership: async args => {
      assert.equal(args.signal, controller.signal);
      controller.abort();
      return {active:true, boardId:'board', userId:'user', teamId:'team'};
    },
    createRow: async () => { writes++; },
  }), {name:'AbortError'});
  assert.equal(writes, 0);
});

test('own throwing signal accessor propagates error without dispatch', async () => {
  const failure = new Error('hostile getter'); let calls = 0;
  const request = {session:'session', boardId:'board', title:'Task'};
  Object.defineProperty(request, 'signal', {get() { throw failure; }});
  await assert.rejects(createSharedTask(request, {lookupMembership: async () => { calls++; }}), error => error === failure);
  assert.equal(calls, 0);
});

test('proxy without own signal does not receive a signal get', async () => {
  let signalGets = 0, writes = 0;
  const request = new Proxy({session:'session', boardId:'board', title:'Task'}, {
    get(target, key, receiver) {
      if (key === 'signal') { signalGets++; throw new Error('unexpected signal get'); }
      return Reflect.get(target, key, receiver);
    },
  });
  await createSharedTask(request, {
    lookupMembership: async () => ({active:true, boardId:'board', userId:'user', teamId:'team'}),
    createRow: async () => { writes++; },
  });
  assert.equal(signalGets, 0);
  assert.equal(writes, 1);
});

test('throwing proxy validation trap propagates without dispatch', async () => {
  const failure = new Error('hostile proxy'); let calls = 0;
  const request = new Proxy({session:'session', boardId:'board', title:'Task'}, {ownKeys() { throw failure; }});
  await assert.rejects(createSharedTask(request, {lookupMembership: async () => { calls++; }}), error => error === failure);
  assert.equal(calls, 0);
});

test('creator request boundary rejects accessors and proxies without reading them', async () => {
  const {createTeamTaskCreator} = await import('../src/team-create-composition.js');
  let calls = 0, reads = 0;
  const create = createTeamTaskCreator({endpoint:'https://example.test/v1', approvedEndpoint:'https://example.test/v1', project:'project', boardId:'board', teamId:'team', databaseId:'db', tableId:'tasks', key:'secret', transport:async () => { calls++; }});
  const accessor = {session:'session', title:'Task', requestId:'request'};
  Object.defineProperty(accessor, 'signal', {get() { reads++; throw Error('getter read'); }});
  const proxy = new Proxy({session:'session', title:'Task', requestId:'request'}, {get() { reads++; throw Error('proxy read'); }});
  for (const request of [accessor, proxy]) await assert.rejects(create(request), /Invalid request/);
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('rejects inherited request fields and unexpected own keys', async () => {
  const requests = [
    Object.assign(Object.create({session:'session-secret'}), {boardId:'board-1', title:'Task'}),
    Object.defineProperty({session:'session-secret', boardId:'board-1', title:'Task'}, 'extra', {value:true}),
    Object.assign({session:'session-secret', boardId:'board-1', title:'Task'}, {[Symbol('extra')]:true}),
  ];
  for (const request of requests) {
    let calls = 0;
    await assert.rejects(createSharedTask(request, {lookupMembership: async () => { calls++; }}), /Invalid request/);
    assert.equal(calls, 0);
  }
});
