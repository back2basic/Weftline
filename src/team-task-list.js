// Unwired, read-only experiment. Transport and process configuration are trusted.
// Membership and rows are separate reads; revocation and pagination are not atomic.
import {types} from 'node:util';
import {createTeamMembershipProvider} from './appwrite-team-membership.js';

const id = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(s);
const sessionPattern = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/;
const escape = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const headers = {'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow','content-security-policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'"};
const fail = status => new Response('Board unavailable', {status,headers});

export function createTeamTaskListRoute(options={}) {
  if (!options || types.isProxy(options) || Object.getPrototypeOf(options)!==Object.prototype) throw Error('Invalid configuration');
  const c=Object.create(null), allowed=['enabled','endpoint','approvedEndpoint','project','boardId','teamId','databaseId','tableId','transport','pageSize','maxPages','timeoutMs','trustedOrigin'];
  for (const key of Reflect.ownKeys(options)) {
    if (!allowed.includes(key)) throw Error('Invalid configuration');
    const d=Object.getOwnPropertyDescriptor(options,key);
    if (!d || !Object.hasOwn(d,'value')) throw Error('Invalid configuration');
    c[key]=d.value;
  }
  if (c.enabled!==true) return async ()=>fail(503);
  const {endpoint,approvedEndpoint,project,boardId,teamId,databaseId,tableId,transport=globalThis.fetch,pageSize=25,maxPages=4,timeoutMs=10000}=c;
  if (![databaseId,tableId].every(id) || typeof transport!=='function' || !Number.isSafeInteger(pageSize) || pageSize<1 || pageSize>100 || !Number.isSafeInteger(maxPages) || maxPages<1 || maxPages>20 || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>10000) throw Error('Invalid configuration');
  let origin;
  try { origin=new URL(c.trustedOrigin); } catch { throw Error('Invalid configuration'); }
  if (typeof c.trustedOrigin!=='string' || origin.protocol!=='https:' || origin.origin!==c.trustedOrigin || origin.username || origin.password) throw Error('Invalid configuration');
  const membership=createTeamMembershipProvider({endpoint,approvedEndpoint,project,boardId,teamId,transport});
  const path=`${endpoint}/tablesdb/${databaseId}/tables/${tableId}/rows`;
  return async request => {
    if (request.method!=='GET' || new URL(request.url).pathname!=='/board') return fail(404);
    const requestUrl=new URL(request.url);
    const fetchSite=request.headers.get('sec-fetch-site');
    const suppliedOrigin=request.headers.get('origin');
    if (requestUrl.origin!==origin.origin || request.headers.get('host')!==origin.host ||
        (suppliedOrigin!==null && suppliedOrigin!==origin.origin) ||
        (fetchSite!==null && fetchSite!=='same-origin' && fetchSite!=='none')) return fail(403);
    const cookies=(request.headers.get('cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('__Host-weftline='));
    const session=cookies.length===1?cookies[0].slice('__Host-weftline='.length):'';
    if (!sessionPattern.test(session)) return fail(401);
    const controller=new AbortController();
    const signal=AbortSignal.any([controller.signal,request.signal]);
    let timer, reader, stop;
    const interrupted=new Promise((_,reject)=>{
      stop=()=>reject(Error('interrupted'));
      signal.addEventListener('abort',stop,{once:true});
      if(signal.aborted) stop();
      timer=setTimeout(()=>controller.abort(),timeoutMs);
    });
    try {
      const member=await Promise.race([membership({session,boardId,signal}),interrupted]);
      if (!member) return fail(403);
      const rows=[], seen=new Set(); let cursor;
      for(let page=0;page<maxPages;page++) {
        signal.throwIfAborted();
        const queries=[{method:'equal',attribute:'boardId',values:[boardId]},{method:'orderAsc',attribute:'$id'},{method:'limit',values:[pageSize]}];
        if(cursor) queries.push({method:'cursorAfter',values:[cursor]});
        const url=new URL(path);
        queries.forEach((q,i)=>url.searchParams.append(`queries[${i}]`,JSON.stringify(q)));
        const response=await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted(); return transport(url.href,{method:'GET',headers:{'X-Appwrite-Project':project,Cookie:`a_session_${project}=${session}`},redirect:'error',signal}); }).then(r=>{if(signal.aborted) {try {void Promise.resolve(r.body?.cancel()).catch(()=>{});} catch {}} return r;}),interrupted]);
        if(response.status!==200 || !response.body) {try {void Promise.resolve(response.body?.cancel()).catch(()=>{});} catch {} throw Error('provider');}
        reader=response.body.getReader(); const chunks=[]; let size=0;
        for(;;) {const {value,done}=await Promise.race([reader.read(),interrupted]); if(done) break; size+=value.byteLength; if(size>262144) throw Error('large'); chunks.push(value);}
        reader=undefined;
        const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!data || !Number.isSafeInteger(data.total) || data.total<0 || !Array.isArray(data.rows) || data.rows.length>pageSize) throw Error('invalid');
        for(const row of data.rows) {
          if(!row || !id(row.$id) || row.boardId!==boardId || typeof row.title!=='string' || row.title.length>200 || typeof row.status!=='string' || row.status.length>100 || seen.has(row.$id)) throw Error('invalid');
          seen.add(row.$id); rows.push(row);
        }
        if(data.rows.length<pageSize) break;
        cursor=data.rows.at(-1).$id;
      }
      signal.throwIfAborted();
      const columns=[['ready','Ready'],['in_progress','In progress'],['review','Review'],['blocked','Blocked'],['done','Done']];
      let body=columns.map(([status,label])=>`<section><h2>${label}</h2><ul>${rows.filter(r=>r.status===status).map(r=>`<li>${escape(r.title)} — ID: ${escape(r.$id)}</li>`).join('')}</ul></section>`).join('');
      const other=rows.filter(r=>!columns.some(([status])=>status===r.status));
      if(other.length) body+=`<section><h2>Unexpected status</h2><ul>${other.map(r=>`<li>${escape(r.title)} — ${escape(r.status)} — ID: ${escape(r.$id)}</li>`).join('')}</ul></section>`;
      return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Private tasks</title><main><h1>Private tasks</h1><p>Results may be partial and are not a snapshot; concurrent changes may be missed or repeated.</p>${body}</main></html>`,{headers});
    } catch {if(reader) {try {void reader.cancel().catch(()=>{});} catch {}} return fail(signal.aborted?504:502);}
    finally {clearTimeout(timer);signal.removeEventListener('abort',stop);controller.abort();}
  };
}
