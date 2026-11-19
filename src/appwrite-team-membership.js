// Configuration and transport are trusted server inputs, not an isolation
// boundary. Incomplete or ambiguous membership results must deny access.
import {types} from 'node:util';
import {parseGuardedJson} from '../experimental/guarded-strict-json.js';
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(value);
const sessionPattern = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/;

export function createTeamMembershipProvider(options) {
  if (!options || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) throw Error('Invalid configuration');
  const config = Object.create(null);
  for (const key of Reflect.ownKeys(options)) {
    if (!['endpoint','approvedEndpoint','project','boardId','teamId','transport'].includes(key)) throw Error('Invalid configuration');
    const d = Object.getOwnPropertyDescriptor(options,key);
    if (!d || !Object.hasOwn(d,'value')) throw Error('Invalid configuration');
    config[key] = d.value;
  }
  const {endpoint,project,boardId,teamId,transport=globalThis.fetch}=config;
  let url;
  try { url = new URL(endpoint); } catch { throw Error('Invalid configuration'); }
  if (endpoint !== config.approvedEndpoint || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/v1' || url.href !== endpoint ||
      ![project,boardId,teamId].every(id) || typeof transport !== 'function') throw Error('Invalid configuration');
  async function read(path,session,signal,checkDeadline=()=>{}) {
    checkDeadline();
    if (signal?.aborted) throw Error('Membership unavailable');
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
    let timer, reader;
    const timeout = new Promise((_,reject) => { timer=setTimeout(()=>{controller.abort();reject(Error('deadline'));},10000); });
    let onAbort;
    const aborted = new Promise((_,reject) => { onAbort=()=>reject(Error('aborted')); combined.addEventListener('abort',onAbort,{once:true}); });
    try {
      combined.throwIfAborted();
      const response = await Promise.race([Promise.resolve().then(()=>{ checkDeadline();combined.throwIfAborted(); return transport(endpoint+path,{method:'GET',headers:{'X-Appwrite-Project':project,Cookie:`a_session_${project}=${session}`},redirect:'error',signal:combined}); }).then(response=>{
        if (combined.aborted) { try { void Promise.resolve(response.body?.cancel()).catch(()=>{}); } catch {} }
        return response;
      }),timeout,aborted]);
      if (response.status === 401 || response.status === 403 || response.status === 404) { try { void Promise.resolve(response.body?.cancel()).catch(()=>{}); } catch {} return null; }
      if (response.status !== 200 || !response.body) { try { void Promise.resolve(response.body?.cancel()).catch(()=>{}); } catch {} throw Error('unavailable'); }
      reader=response.body.getReader(); const chunks=[]; let size=0;
      for (;;) { const {done,value}=await Promise.race([reader.read(),timeout,aborted]); if(done) break; size+=value.byteLength; if(size>65536) throw Error('large'); chunks.push(value); }
      combined.throwIfAborted();
      return parseGuardedJson(Buffer.concat(chunks));
    } catch { try { if(reader) void reader.cancel().catch(()=>{}); } catch {} throw Error('Membership unavailable'); }
    finally { clearTimeout(timer); combined.removeEventListener('abort',onAbort); controller.abort(); }
  }
  return async (request={}) => {
    if (types.isProxy(request)) return null;
    const expected = Object.getOwnPropertyDescriptor(request,'expectedActor');
    if (expected && (!Object.hasOwn(expected,'value') || !id(expected.value))) return null;
    const {session,boardId: requestedBoard,signal}=request;
    const d=Object.getOwnPropertyDescriptor(request,'deadline');
    if(d && (!Object.hasOwn(d,'value') || !Number.isFinite(d.value))) return null;
    const check=()=>{signal?.throwIfAborted();if(d && performance.now()>=d.value)throw Error('Membership unavailable');};
    if (requestedBoard !== boardId || typeof session !== 'string' || !sessionPattern.test(session)) return null;
    check();const account=await read('/account',session,signal,check);check();
    if (!account || account.status !== true || !id(account.$id)) return null;
    if (expected && expected.value !== account.$id) return null;
    check();
    const params=new URLSearchParams();
    params.append('queries[0]',JSON.stringify({method:'equal',attribute:'userId',values:[account.$id]}));
    params.append('queries[1]',JSON.stringify({method:'limit',values:[2]}));
    const result=await read(`/teams/${teamId}/memberships?${params}`,session,signal,check);
    check();
    if (!result || result.total !== 1 || !Array.isArray(result.memberships) || result.memberships.length !== 1) return null;
    const member=result.memberships[0];
    if (!member || typeof member !== 'object' || Array.isArray(member) || member.userId !== account.$id || member.teamId !== teamId || member.confirm !== true) return null;
    return {active:true,boardId,teamId,userId:account.$id};
  };
}
