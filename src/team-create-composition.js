// Unwired experiment. Trusted process/transport only. Membership check and write
// are not atomic: an already-authorized request can finish after removal.
// Table-level permissions must not grant broader read/create/update/delete.
import {types} from 'node:util';
import {checkSignal, bridgeSignal} from './abort-signal.js';
import {createTeamMembershipProvider} from './appwrite-team-membership.js';
import {createSharedTaskOutcome} from './shared-board-mutation.js';

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(value);
function snapshot(value, keys, optional=[]) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw Error('Invalid request');
  const result=Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (!keys.includes(key) && !optional.includes(key)) throw Error('Invalid request');
    const d=Object.getOwnPropertyDescriptor(value,key);
    if (!d || !Object.hasOwn(d,'value')) throw Error('Invalid request');
    result[key]=d.value;
  }
  if (keys.some(key=>!Object.hasOwn(result,key))) throw Error('Invalid request');
  return result;
}

export function createTeamTaskCreator(options) {
  const create = createTeamTaskCreatorOutcome(options);
  return async request => {
    const result = await create(request);
    if (!result.allowed) throw Error('Access denied');
    return {requestId:result.requestId};
  };
}

// Only this local composition can return a pre-writer denial. It never
// interprets exceptions or writer/provider responses as a denial.
export function createTeamTaskCreatorOutcome(options) {
  const c=snapshot(options,['endpoint','approvedEndpoint','project','boardId','teamId','databaseId','tableId','key','transport']);
  if (![c.databaseId,c.tableId].every(id) || typeof c.key !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(c.key) || typeof c.transport !== 'function') throw Error('Invalid configuration');
  // The membership constructor validates and pins this same endpoint and project.
  const lookupMembership=createTeamMembershipProvider({endpoint:c.endpoint,approvedEndpoint:c.approvedEndpoint,project:c.project,boardId:c.boardId,teamId:c.teamId,transport:c.transport});
  const path=`/tablesdb/${c.databaseId}/tables/${c.tableId}/rows`;
  return async request => {
    const {session,title,requestId,signal:source}=snapshot(request,['session','title','requestId'],['signal']);
    if (!id(requestId)) throw Error('Invalid request');
    const bridge=bridgeSignal(source), signal=bridge.signal;
    try {
    checkSignal(signal);
    const outcome=await createSharedTaskOutcome({session,boardId:c.boardId,title,...(signal ? {signal} : {})},{lookupMembership,createRow:async ({data,permissions})=>{
      checkSignal(source);
      checkSignal(signal);
      const controller=new AbortController();
      const combined=signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
      let timer;
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('deadline'));},10000);});
      let onAbort;
      const aborted=new Promise((_,reject)=>{onAbort=()=>reject(Error('aborted'));combined.addEventListener('abort',onAbort,{once:true});});
      try {
        const response=await Promise.race([Promise.resolve().then(()=>{combined.throwIfAborted(); return c.transport(c.endpoint+path,{method:'POST',headers:{'X-Appwrite-Project':c.project,'X-Appwrite-Key':c.key,'Content-Type':'application/json'},body:JSON.stringify({rowId:requestId,data,permissions}),redirect:'error',signal:combined});}).then(response=>{if(combined.aborted) {try {void Promise.resolve(response.body?.cancel()).catch(()=>{});} catch {}} return response;}),deadline,aborted]);
        combined.throwIfAborted();
        try { void Promise.resolve(response.body?.cancel()).catch(()=>{}); } catch {}
        if (response.status !== 201) throw Error('write failed');
        combined.throwIfAborted();
      } catch { throw Error('Write outcome unknown'); }
      finally {clearTimeout(timer);combined.removeEventListener('abort',onAbort);controller.abort();}
    }});
    if (!outcome.allowed) return {allowed:false};
    await outcome.value;
    try { checkSignal(source); checkSignal(signal); } catch { throw Error('Write outcome unknown'); }
    return {allowed:true,requestId};
    } finally { bridge.dispose(); }
  };
}
