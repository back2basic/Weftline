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
