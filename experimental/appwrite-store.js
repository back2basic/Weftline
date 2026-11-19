// Server-side only. Never log headers or secrets.
import {parseGuardedJson} from './guarded-strict-json.js';
const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
export function appwriteStore({endpoint,project,key,database,table,fetchImpl=fetch,onTransaction=()=>{},timeoutMs=10000}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('Invalid timeout');
  if (![project,database,table].every(id) || typeof key !== 'string' || !key || typeof endpoint !== 'string') throw new Error('Invalid configuration');
  const root = `${endpoint.replace(/\/$/,'')}/tablesdb/${database}/tables/${table}/rows`;
  let active=0;
  async function request(method,url,body,session,signal,strict=false,checkDeadline=()=>{}) {
    checkDeadline();signal?.throwIfAborted();
    const headers={'X-Appwrite-Project':project, 'Content-Type':'application/json'};
    if (session !== undefined) {
      if (typeof session !== 'string' || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(session)) throw new Error('Invalid session');
      headers.Cookie=`a_session_${project}=${session}`;
    } else headers['X-Appwrite-Key']=key;
    if(active>=4) throw Error('Appwrite transport busy');
    active++;
    let pending=0,finished=false,released=false;
    const release=()=>{if(finished && pending===0 && !released){released=true;active--;}};
    const tracked=p=>{pending++;const promise=Promise.resolve(p);promise.then(()=>{pending--;release();},()=>{pending--;release();});return promise;};
    try {
    const controller=new AbortController();
    let timer, reader, interrupted=false, onAbort;
    const interruption=new Promise((_,reject)=>{
      onAbort=()=>{interrupted=true;controller.abort();reject(Error('interrupted'));};
      signal?.addEventListener('abort',onAbort,{once:true});
      if(signal?.aborted) onAbort();
      timer=setTimeout(onAbort,timeoutMs);
    });
    try {
      signal?.throwIfAborted();
      const upstream=tracked(Promise.resolve().then(()=>{
        checkDeadline();signal?.throwIfAborted();
        return fetchImpl(url,{method,headers,...(body === undefined ? {} : {body:JSON.stringify(body)}),redirect:'error',signal:controller.signal});
      }).then(response=>{
        if(interrupted) { try { tracked(response.body?.cancel()).catch(()=>{}); } catch {} throw Error('interrupted'); }
        return response;
      }));
      const r=await Promise.race([upstream,interruption]);
      signal?.throwIfAborted();
      const chunks=[]; let size=0;
      if(r.body) {
        reader=r.body.getReader();
        for (;;) {
          const {value:chunk,done}=await Promise.race([tracked(reader.read()),interruption]);
          signal?.throwIfAborted();
          if(done) break;
          size+=chunk.byteLength;
          if(size>65536) throw Error('too large');
          chunks.push(chunk);
        }
      }
      const bytes=Buffer.concat(chunks);
      return {status:r.status,value:bytes.length ? (strict?parseGuardedJson(bytes):JSON.parse(bytes.toString('utf8'))) : {}};
    } catch {
      controller.abort();
      try { if(reader) tracked(reader.cancel()).catch(()=>{}); } catch {}
      throw new Error('Appwrite request or response indeterminate');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort',onAbort);
    }
    } finally {finished=true;release();}
  }
  async function account(session, {signal}={}) {
    const r=await request('GET',`${endpoint.replace(/\/$/,'')}/account`,undefined,session,signal);
    signal?.throwIfAborted();
    if (r.status === 401 || r.status === 403) return null;
    if (r.status !== 200 || !r.value || typeof r.value !== 'object') throw new Error('Appwrite account indeterminate');
    return r.value;
  }
  async function get(row, options={}) {
    const {signal}=options;
    const d=Object.getOwnPropertyDescriptor(options,'deadline');
    if(d&&(!Object.hasOwn(d,'value')||!Number.isFinite(d.value)))throw Error('Invalid deadline');
    const check=()=>{signal?.throwIfAborted();if(d&&performance.now()>=d.value)throw Error('deadline');};
    if (!id(row)) throw new Error('Invalid row');
    const r=await request('GET',`${root}/${row}`,undefined,undefined,signal,true,check);
    check();
    if (r.status === 404 && r.value?.type === 'row_not_found') return null;
    if (r.status !== 200 || r.value?.$id !== row || typeof r.value.payload !== 'string') throw new Error('Appwrite row indeterminate');
    let value;
    try { value=parseGuardedJson(Buffer.from(r.value.payload,'utf8')); } catch { throw new Error('Appwrite invalid row'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Appwrite invalid row');
    return value;
  }
  async function listPage({limit,cursor,signal}={}) {
    if (!Number.isSafeInteger(limit) || limit<1 || limit>25 || (cursor!==undefined && !id(cursor))) throw Error('Invalid page');
    const params=new URLSearchParams();
    for(const query of [{method:'limit',values:[limit]},{method:'orderAsc',attribute:'$id',values:[]},...(cursor===undefined?[]:[{method:'cursorAfter',values:[cursor]}])]) params.append('queries[]',JSON.stringify(query));
    const r=await request('GET',`${root}?${params}`,undefined,undefined,signal,true);
    signal?.throwIfAborted();
    if(r.status!==200 || !r.value || !Number.isSafeInteger(r.value.total) || r.value.total<0 || !Array.isArray(r.value.rows) || r.value.rows.length>limit || r.value.total<r.value.rows.length) throw Error('Appwrite list indeterminate');
    let previous=cursor;
    return r.value.rows.map(row=>{
      if(!row || typeof row!=='object' || !id(row.$id) || (previous!==undefined && row.$id<=previous) || typeof row.payload!=='string') throw Error('Appwrite invalid page');
      previous=row.$id;
      const data=parseGuardedJson(Buffer.from(row.payload,'utf8'));
      if(!data || typeof data!=='object' || Array.isArray(data)) throw Error('Appwrite invalid page');
      return {id:row.$id,data};
    });
  }
  async function transaction(entries, options={}) {
    const {signal}=options;
    const d=Object.getOwnPropertyDescriptor(options,'deadline');
    if(d&&(!Object.hasOwn(d,'value')||!Number.isFinite(d.value)))throw Error('Invalid deadline');
    const check=()=>{signal?.throwIfAborted();if(d&&performance.now()>=d.value)throw Error('deadline');};
    check();
    if (!Array.isArray(entries) || !entries.length || entries.length > 3) throw new Error('Invalid transaction');
    const base=endpoint.replace(/\/$/,'');
    const t=await request('POST',`${base}/tablesdb/transactions`,{ttl:60},undefined,signal,false,check);
    check();
    if (t.status !== 201 || !id(t.value.$id)) throw new Error('Appwrite transaction indeterminate');
    const tid=t.value.$id; onTransaction(tid);
    for (const entry of entries) {
      check();
      if (!id(entry.id) || !entry.data) throw new Error('Invalid entry');
      const r=await request('POST',root,{rowId:entry.id,data:{payload:JSON.stringify(entry.data)},permissions:[],transactionId:tid},undefined,signal,false,check);
      check();
      if (r.status !== 201 || r.value.$id !== entry.id) throw new Error('Appwrite staging failed or indeterminate');
    }
    check();
    let r;
    try {
      r=await request('PATCH',`${base}/tablesdb/transactions/${tid}`,{commit:true},undefined,signal,false,check);
      check();
    } catch { throw new Error('Appwrite commit outcome indeterminate; do not blindly retry'); }
    if (r.status !== 200 || r.value.$id !== tid || r.value.status !== 'committed') throw new Error('Appwrite commit failed or indeterminate');
  }
  return {account,get,listPage,transaction};
}
