import {createHash} from 'node:crypto';

// Local-only UI: browser storage and its lock manager are trusted, not durable.
export function knowledgePage(boardId, limit) {
 const board=JSON.stringify(boardId).replace(/</g,'\\u003c');
 const cap=Number.isSafeInteger(limit)&&limit>0?String(limit):'not supplied';
 const script=`'use strict';
const boardId=${board};
const el=id=>document.getElementById(id);
let generation=0,logoutBlocked=false;
const loginKey='weftline-pending-login',logoutMessage='Sign-out detected or authentication state unavailable. Display cleared; session revocation is not confirmed. Reload only after independent reconciliation.';
function clear(){generation++;el('document').textContent='';el('status').textContent=logoutBlocked?logoutMessage:'Display cleared. Open by ID again if needed.';}
function authAllowed(){try{const state=localStorage.getItem(loginKey);if(state!==null&&!/^complete:[0-9]+$/.test(state))logoutBlocked=true;}catch{logoutBlocked=true;}if(logoutBlocked){clear();return false;}return true;}
el('clear').onclick=clear;addEventListener('pagehide',clear);addEventListener('storage',event=>{if((event.key===loginKey&&event.newValue!==null&&!/^complete:[0-9]+$/.test(event.newValue))||event.key===null)logoutBlocked=true;clear();});
document.addEventListener('visibilitychange',clear);
el('title').oninput=el('html').oninput=()=>{generation++;};
const entities={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"};
function decode(s){return s.replace(/&(?:amp|lt|gt|quot|#39);/g,x=>entities[x]);}
el('open').onsubmit=async event=>{event.preventDefault();clear();const g=generation;el('status').textContent='Opening…';try{const r=await bounded('/knowledge/read',{boardId,id:el('id').value},false);if(r.status!==200||performance.now()>=r.deadline)throw Error();const text=r.value;if(g!==generation)return;const title=/<h1>([\\s\\S]*?)<\\/h1>/.exec(text),source=/<pre>([\\s\\S]*?)<\\/pre>/.exec(text);if(!title||!source)throw Error();el('document').textContent=decode(title[1])+'\\n\\nHTML source (not executed):\\n'+decode(source[1]);el('status').textContent='Opened. Authorization can change; clear this display when finished.';}catch{if(g===generation)el('status').textContent='Unavailable or access denied. Sign in on the local board and try again.';}};
const prefix='weftline-knowledge-pending-v1:';let storageFault=false;
function entries(){
 const result=[];const n=localStorage.length;if(n>1024)throw Error('storage scan limit');
 for(let i=0;i<n;i++){const key=localStorage.key(i);if(typeof key!=='string')throw Error('incomplete scan');if(!key.startsWith(prefix))continue;
  const raw=localStorage.getItem(key);if(typeof raw!=='string'||raw.length>512)throw Error('invalid reference');const d=JSON.parse(raw);
  if(!d||Object.keys(d).sort().join(',')!=='boardId,fingerprint,id,operationId'||typeof d.boardId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(d.boardId)||typeof d.id!=='string'||!/^[a-f0-9]{32}$/.test(d.id)||!/^[a-f0-9]{32}$/.test(d.operationId)||!/^[a-f0-9]{64}$/.test(d.fingerprint)||key!==prefix+d.operationId)throw Error('invalid reference');
  result.push({key,raw,d});if(result.length>32)throw Error('too many references');
 }return result;
}
function showPending(){try{el('pending').textContent=entries().map(x=>'Board '+x.d.boardId+' | Unverified saved document ID '+x.d.id+' | Operation '+x.d.operationId+' | Fingerprint '+x.d.fingerprint).join('\\n')||'No stored pending references.';}catch{storageFault=true;el('pending').textContent='Storage unavailable or invalid; creation is blocked.';}}
function removeExact(key,raw){if(localStorage.getItem(key)!==raw)throw Error('reference changed');try{localStorage.removeItem(key);if(localStorage.getItem(key)!==null)throw Error('remove failed');}catch(e){storageFault=true;try{if(localStorage.getItem(key)===null)localStorage.setItem(key,raw);}catch{}throw e;}}
function randomId(){const a=new Uint8Array(16);crypto.getRandomValues(a);return Array.from(a,x=>x.toString(16).padStart(2,'0')).join('');}
async function locked(fn){
 if(storageFault||!navigator.locks||typeof navigator.locks.request!=='function')throw Error('coordination unavailable');
 const controller=new AbortController(),deadline=performance.now()+10000;let timer,expired=false;
 const stop=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;controller.abort();reject(Error('lock deadline'));},10000);});
 try{return await Promise.race([navigator.locks.request('weftline-knowledge-pending-v1',{mode:'exclusive',signal:controller.signal},async()=>{if(expired||performance.now()>=deadline)throw Error('lock deadline');clearTimeout(timer);return fn();}),stop]);}finally{clearTimeout(timer);}
}
function exact(value,keys){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys;}
async function bounded(path,data,json=true){
 if(!authAllowed())throw Error('authentication blocked');
 const controller=new AbortController(),deadline=performance.now()+10000;let timer,reader,response,expired=false;
 const cancel=target=>{try{if(target&&typeof target.cancel==='function')Promise.resolve(target.cancel()).catch(()=>{});}catch{}};
 const stop=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;controller.abort();cancel(reader||response?.body);reject(Error('deadline'));},10000);});
 try{return await Promise.race([(async()=>{response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),redirect:'error',cache:'no-store',signal:controller.signal});if(expired||performance.now()>=deadline){cancel(response.body);throw Error('deadline');}
  if(!response.ok){cancel(response.body);throw Error('status');}
  reader=response.body.getReader();const chunks=[];let size=0;try{for(;;){const part=await reader.read();if(expired||performance.now()>=deadline)throw Error('deadline');if(part.done)break;size+=part.value.length;if(size>(json?4096:${cap === 'not supplied' ? '4096' : `(${cap}*6+4096)`}))throw Error('large');chunks.push(part.value);}}catch(e){cancel(reader);throw e;}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}if(!authAllowed())throw Error('authentication blocked');const text=new TextDecoder().decode(bytes);return {status:response.status,value:json?JSON.parse(text):text,deadline};})(),stop]);}finally{clearTimeout(timer);}
}
el('create').onsubmit=async event=>{event.preventDefault();const g=generation,title=el('title').value,html=el('html').value;const current=()=>g===generation&&el('title').value===title&&el('html').value===html;el('status').textContent='Preparing…';try{await locked(async()=>{
 const id=randomId(),operationId=randomId();
 const documentRow={kind:'knowledge-document-v1',boardId,id,title,html};
 if(!title.trim()||new TextEncoder().encode(title).length>200||new TextEncoder().encode(JSON.stringify(documentRow)).length>${cap === 'not supplied' ? '0' : cap})throw Error('Invalid document or capacity');
 if(entries().length!==0)throw Error('Resolve pending references first');
 const intent={boardId,id,title,html,operationId};const pre=await bounded('/knowledge/preflight',intent);
 if(pre.status!==200||performance.now()>=pre.deadline||!exact(pre.value,'fingerprint')||typeof pre.value.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(pre.value.fingerprint))throw Error('Preflight unavailable');
 const descriptor={operationId,boardId,fingerprint:pre.value.fingerprint,id},key=prefix+operationId,raw=JSON.stringify(descriptor);
 if(localStorage.getItem(key)!==null)throw Error('Reference collision');localStorage.setItem(key,raw);
 if(localStorage.getItem(key)!==raw||!entries().some(x=>x.key===key&&x.raw===raw))throw Error('Reference not stored');showPending();if(storageFault||localStorage.getItem(key)!==raw)throw Error('Storage unavailable');
 try{const result=await bounded('/knowledge/create-with-receipt',{...intent,expectedFingerprint:descriptor.fingerprint});
  if(result.status!==201||performance.now()>=result.deadline||!exact(result.value,'fingerprint,operationId,status')||result.value.status!=='confirmed'||result.value.operationId!==operationId||result.value.fingerprint!==descriptor.fingerprint)throw Error('unknown');
  removeExact(key,raw);if(current()){el('id').value=id;el('title').value='';el('html').value='';el('status').textContent='Matching historical receipt confirmed; document ID is ready to open. This does not prove it still exists.';}
 }catch{if(current())el('status').textContent='Save outcome unknown. Keep the reference and check its receipt; do not retry blindly.';}finally{showPending();}
 });}catch{if(current())el('status').textContent='Create blocked before dispatch: validation, storage, lock or preflight unavailable. If a reference remains, check its receipt; do not retry blindly.';showPending();}};
showPending();
el('receipt').onsubmit=async event=>{event.preventDefault();clear();const g=generation;el('status').textContent='Checking…';try{await locked(async()=>{const operationId=el('operation').value,fingerprint=el('fingerprint').value;const refs=entries(),match=refs.find(x=>x.d.boardId===boardId&&x.d.operationId===operationId&&x.d.fingerprint===fingerprint);const r=await bounded('/knowledge/receipt',{boardId,operationId,fingerprint});if(g!==generation||performance.now()>=r.deadline)throw Error();const result=r.value;if(r.status!==200||!exact(result,'fingerprint,operationId,status')||result.status!=='confirmed'||result.operationId!==operationId||result.fingerprint!==fingerprint)throw Error();if(match){removeExact(match.key,match.raw);}el('status').textContent='Matching historical receipt confirmed. This does not prove the document still exists.';showPending();});}catch{if(g===generation)el('status').textContent='Unknown. Do not retry blindly.';showPending();}};`;
 const hash=createHash('sha256').update(script).digest('base64');
 const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Local private knowledge</title><h1>Local private knowledge</h1><p>Trusted local development only; not production. Sign in using the local board first. On the same origin, a storage event may clear this page on board sign-out, but storage failure or a suspended page can prevent it. On a different origin this page cannot observe board sign-out. Close or clear this page when signing out. This is not proof of session revocation; authorization changes do not erase displayed text automatically.</p><p>No listing, indexing, or editing. Configured serialized document payload cap: ${cap} bytes; it includes JSON structure and UTF-8 encoding.</p><form id="create"><h2>Create document</h2><label>Title <input id="title" required maxlength="200"></label><label>HTML source <textarea id="html" maxlength="1024"></textarea></label><button>Create</button></form><p>Pending references persist only in this browser storage and may be lost. Fingerprints can expose guessable content. Missing receipts remain unknown; do not retry blindly. A receipt is historical, not proof a document still exists.</p><pre id="pending"></pre><form id="open"><label>Document ID <input id="id" required maxlength="36"></label><button>Open by ID</button></form><form id="receipt"><h2>Check save status</h2><p>Enter a pending operation reference; confirmation depends on the trusted response path.</p><label>Operation ID <input id="operation" required pattern="[a-f0-9]{32}"></label><label>Fingerprint <input id="fingerprint" required pattern="[a-f0-9]{64}"></label><button>Check save status</button></form><button type="button" id="clear">Clear display</button><p id="status" role="status"></p><pre id="document"></pre><script>${script}</script></html>`;
 return {html,csp:`default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`};
}
