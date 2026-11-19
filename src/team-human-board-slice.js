// Unwired, local-only experiment. Never install on the public application server.
// Process configuration and transport are trusted; membership and writes are not atomic.
import {types} from 'node:util';
import {randomUUID} from 'node:crypto';
import {createNodeAuthAdapter} from './node-auth-adapter.js';
import {createClientAuth} from './client-auth.js';
import {createTeamTaskListRoute} from './team-task-list.js';
import {createTeamTaskCreatorOutcome} from './team-create-composition.js';

const page=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Private board</title><h1>Private board</h1><p>Local experiment; results may be incomplete and are not a snapshot. References are stored only in this browser storage; clearing it, using another device, or storage failure may lose access to them. Creation is not serialized across tabs or devices.</p>
<p>Sign-in requires secure-context Web Locks and shared origin localStorage. This coordinates cooperating tabs in the same browser storage partition only; other devices, cleared storage, browser crashes and suspended pages are not covered. Storage that changes a completion marker and then throws, followed by failed restoration, can lose the durable warning on reload. A lost sign-in response can leave a provider session; sign-out cannot revoke a session whose cookie was lost. Do not retry blindly.</p>
<p>Uncertain sign-in cannot be cleared in this interface; an aborted request may still create a session or install a cookie later. Seek independent reconciliation before further sign-in.</p>
<p>Sign-in is currently unavailable pending abuse protection.</p>
<form id="login"><label>Email <input name="email" type="email" required></label><label>Password <input name="password" type="password" required></label><button>Sign in</button></form>
<button id="logout">Sign out</button><button id="refresh">Refresh board</button><form id="create"><label>Task title <input name="title" maxlength="200" required></label><button>Create</button></form><label><input type="checkbox" id="reconciled"> I independently reconciled the operation; I understand this board is incomplete and not a snapshot.</label><button id="resolve" type="button">Clear reconciled operation</button><p id="message" role="status"></p><div id="board"></div>
<script>
const msg=document.querySelector('#message'), board=document.querySelector('#board');
const createForm=document.querySelector('#create'),createButton=createForm.querySelector('button'),pendingKey='weftline-pending-create',prefix=pendingKey+':';
// These states serialize cookie-changing requests in this tab only. In-flight writes cannot be cancelled.
let auth={phase:'active'}, loginDone=null,boardGeneration=0,displayed=null,storageError=false,storageWarning='',revokeWarning='',loginWarning='',stateWarning='',status='';
const loginKey='weftline-pending-login',loginLock='weftline-session-cookie',loginText='Sign-in outcome unknown; a provider session may exist. Do not retry blindly; independently verify pending work stopped and revoke sessions.';
const logoutText='Sign-out unconfirmed; session may not be revoked. Reconcile independently.';
function loginState(){try{const state=localStorage.getItem(loginKey);if(state!==null&&!/^complete:[0-9]+$/.test(state)){stateWarning=state.startsWith('logout-pending:')?logoutText:loginText;return false}stateWarning='';return !loginWarning}catch{loginWarning=loginText+' Local storage unavailable.';return false}}
const allowed=()=>auth.phase==='active'&&loginState();
function render(){loginState();document.querySelector('#refresh').disabled=!allowed();createButton.disabled=!allowed()||storageError||!!displayed;msg.textContent=[status,revokeWarning,loginWarning,stateWarning,storageWarning,displayed?'Outcome unknown. Reference: '+displayed.reference+'. Board results may be incomplete and are not a snapshot; listing cannot prove absence. Reconcile independently before clearing. '+displayed.count+' unresolved operation(s).':''].filter(Boolean).join(' ');}
function pendingRecords(){const records=[];const legacy=localStorage.getItem(pendingKey);if(legacy!==null)records.push({key:pendingKey,reference:legacy});for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key&&key.startsWith(prefix)){const value=localStorage.getItem(key);if(value!==null)records.push({key,reference:value});}}return records;}
function storageFailed(text='Local storage unavailable; operation references may be inaccessible. Creation remains blocked; reconcile independently.'){storageError=true;storageWarning=text;render();}
function showPending(){try{const records=pendingRecords();displayed=records[0]?{...records[0],count:records.length}:null;render();return true}catch{storageFailed();return false}}
showPending();
async function refresh(){if(!allowed()){board.replaceChildren();render();return;}const owner=auth,generation=++boardGeneration;board.replaceChildren();try{const r=await fetch('/board');if(owner!==auth||generation!==boardGeneration||!allowed())return;if(!r.ok){status='Board unavailable ('+r.status+')';render();return}const doc=new DOMParser().parseFromString(await r.text(),'text/html');if(owner!==auth||generation!==boardGeneration||!allowed())return;for(const section of doc.querySelectorAll('section')){const s=document.createElement('section'),h=document.createElement('h2'),ul=document.createElement('ul');h.textContent=section.querySelector('h2')?.textContent||'';for(const li of section.querySelectorAll('li')){const n=document.createElement('li');n.textContent=li.textContent;ul.append(n)}s.append(h,ul);board.append(s)}if(status==='Sign-in failed'||status==='Sign-in unavailable'||status==='Board unavailable'||(status.startsWith('Board unavailable (')&&status.endsWith(')'))){status='';render()}}catch{if(owner===auth&&generation===boardGeneration){board.replaceChildren();status='Board unavailable';render()}}}
document.querySelector('#refresh').onclick=refresh;
// Best-effort rollback cannot guarantee durability if storage mutates and then fails again.
function completeState(next,restore){try{localStorage.setItem(loginKey,next);if(localStorage.getItem(loginKey)!==next)throw Error('storage')}catch(e){try{localStorage.setItem(loginKey,restore)}catch{}throw e}}
function loginAvailable(){return typeof isSecureContext!=='undefined'&&isSecureContext&&typeof navigator!=='undefined'&&navigator.locks&&typeof navigator.locks.request==='function'}
// The deadline only bounds acquiring the lock, not a dispatched logout request.
async function withLogoutLock(revoke){const controller=new AbortController(),deadline=performance.now()+10000;let timer;try{const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('lock deadline'))},10000)});return await Promise.race([timeout,navigator.locks.request(loginLock,{signal:controller.signal},async()=>{if(controller.signal.aborted||performance.now()>=deadline)throw Error('lock deadline');clearTimeout(timer);return revoke()})])}finally{clearTimeout(timer)}}
loginState();render();
if(typeof addEventListener==='function')addEventListener('storage',e=>{if(e.key===loginKey||e.key===null){if(!loginState()){++boardGeneration;board.replaceChildren()}render()}});
document.querySelector('#login').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget;if(!loginAvailable()){loginWarning=loginText+' Secure Web Locks unavailable; sign-in blocked.';f.password.value='';render();return}if(loginWarning||!['active','signed-out'].includes(auth.phase)){f.password.value='';render();return}let epoch;try{if(!loginState()){f.password.value='';render();return}epoch=localStorage.getItem(loginKey)}catch{loginWarning=loginText+' Local storage unavailable.';f.password.value='';render();return}const owner=auth={phase:'signing-in'};render();let finish;loginDone=new Promise(resolve=>{finish=resolve});let ok=false,lockTimer;const lockAbort=new AbortController();try{const lockDeadline=new Promise((_,reject)=>{lockTimer=setTimeout(()=>{lockAbort.abort();reject(Error('lock deadline'))},10000)});await Promise.race([lockDeadline,navigator.locks.request(loginLock,{signal:lockAbort.signal},async()=>{clearTimeout(lockTimer);if(lockAbort.signal.aborted||auth!==owner||!loginState())return;if(localStorage.getItem(loginKey)!==epoch)throw Error('login epoch changed');localStorage.setItem(loginKey,'pending');if(localStorage.getItem(loginKey)!=='pending')throw Error('storage');const controller=new AbortController(),until=performance.now()+10000;let timer;try{const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('deadline'))},10000)});const r=await Promise.race([fetch('/login',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({email:f.email.value,password:f.password.value}),signal:controller.signal}),timeout]);if(!r.ok||r.redirected||performance.now()>=until)throw Error('unknown');const n=epoch===null?0:Number(epoch.slice(9));if(!Number.isSafeInteger(n)||n>=Number.MAX_SAFE_INTEGER)throw Error('epoch exhausted');const complete='complete:'+(n+1);if(auth!==owner||localStorage.getItem(loginKey)!=='pending')throw Error('login superseded');completeState(complete,'pending');ok=true;if(auth===owner){auth={phase:'active'};status='Signed in'}}finally{clearTimeout(timer)}})])}catch{loginWarning=loginText}finally{clearTimeout(lockTimer);if(!ok&&auth===owner)auth={phase:'unknown'};f.password.value='';finish();loginDone=null;render()}if(ok&&auth.phase==='active')await refresh()};
document.querySelector('#logout').onclick=async()=>{if(auth.phase==='signing-out'||auth.phase==='logout-wait'||auth.phase==='storage-fault')return;const wait=loginDone;const owner=auth={phase:wait?'logout-wait':'signing-out'};++boardGeneration;board.replaceChildren();status='Signing out';let marker,n,uncertain=false,markerFailure=false;try{const state=localStorage.getItem(loginKey);if(state&&state.startsWith('logout-pending:')){status='Sign-out already pending';revokeWarning=logoutText;auth={phase:'signed-out'};render();return}uncertain=!!wait||(state!==null&&!/^complete:[0-9]+$/.test(state));n=state===null||uncertain?0:Number(state.slice(9));if(!Number.isSafeInteger(n)||n>=Number.MAX_SAFE_INTEGER)throw Error('epoch');marker='logout-pending:'+n;localStorage.setItem(loginKey,marker);if(localStorage.getItem(loginKey)!==marker)throw Error('storage')}catch{markerFailure=true;uncertain=true;loginWarning=loginText+' Local storage unavailable or authentication state unresolved; other tabs may not receive a storage event.';revokeWarning='Session may not be revoked';}render();if(wait)await wait;if(auth!==owner)return;owner.phase='signing-out';try{const revoke=async()=>{if(!markerFailure&&localStorage.getItem(loginKey)!==marker)throw Error('logout epoch changed');const r=await fetch('/logout',{method:'POST'});if(r.ok&&!uncertain&&localStorage.getItem(loginKey)===marker)completeState('complete:'+(n+1),marker);return r};const r=loginAvailable()?await withLogoutLock(revoke):await revoke();status=r.ok&& !uncertain&&loginState()?'Signed out':'Sign-out unconfirmed; a late sign-in may install a session';if(!r.ok)revokeWarning='Session may not be revoked'}catch{status='Sign-out unavailable';revokeWarning='Session may not be revoked'}auth={phase:markerFailure?'storage-fault':'signed-out'};render()};
document.querySelector('#resolve').onclick=()=>{if(!document.querySelector('#reconciled').checked||!displayed||storageError)return;try{if(localStorage.getItem(displayed.key)!==displayed.reference)throw Error('changed');localStorage.removeItem(displayed.key);document.querySelector('#reconciled').checked=false;showPending();if(!displayed){status='Reconciled operation cleared';render()}}catch{storageFailed('Unable to clear operation; creation remains blocked; reconcile independently.')}};
// Trust only the authenticated same-origin TLS application and approved ingress.
// A response-fabricating intermediary is outside this contract and needs ingress review.
function cancelResponse(r){try{if(r.body)void Promise.resolve(r.body.cancel()).catch(()=>{})}catch{}}
async function createResponse(body,until){
 const controller=new AbortController(),expired=Symbol('header deadline');let timer,timedOut=false;
 const deadline=new Promise(resolve=>{timer=setTimeout(()=>{timedOut=true;resolve(expired);controller.abort()},5000)});
 try{
  const request=Promise.resolve(fetch('/create',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body,signal:controller.signal})).then(r=>{
   if(timedOut||performance.now()>=until){cancelResponse(r);controller.abort();return expired}return r;
  });
  const result=await Promise.race([request,deadline]);
  if(result===expired)return null;
  if(performance.now()>=until){cancelResponse(result);controller.abort();return null}return result;
 }finally{clearTimeout(timer)}
}
async function exactReceipt(r,reference,until){
 const expected=r.status===201?'Created '+reference:r.status===403?'Not authorized '+reference:null;
 if(!expected||r.redirected){cancelResponse(r);return false}if(!r.body)return false;
 const reader=r.body.getReader();let offset=0,timer;
 const expired=Symbol('receipt deadline');
 const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve(expired),5000)});
 const cancel=()=>{try{void Promise.resolve(reader.cancel()).catch(()=>{})}catch{}};
 try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part===expired||performance.now()>=until){cancel();return false}const {done,value}=part;if(done)return offset===expected.length;if(!value||value.length===0){cancel();return false}for(const byte of value){if(offset>=expected.length||byte!==expected.charCodeAt(offset++)){cancel();return false}}}}
 catch{cancel();return false}finally{clearTimeout(timer)}
}
createForm.onsubmit=async e=>{e.preventDefault();if(!allowed()){board.replaceChildren();render();return;}showPending();if(createButton.disabled)return;const f=e.currentTarget,owner=auth;let reference,key;try{reference=crypto.randomUUID();key=prefix+reference;if(localStorage.getItem(key)!==null)throw Error('duplicate');localStorage.setItem(key,reference);if(localStorage.getItem(key)!==reference)throw Error('storage');}catch{storageFailed('Local storage unavailable or ambiguous; creation remains blocked; reconcile independently.');return}showPending();if(storageError||owner!==auth||!allowed())return;try{const headerUntil=performance.now()+5000;const r=await createResponse(JSON.stringify({title:f.title.value,reference}),headerUntil);if(!r){showPending();return}if(performance.now()>=headerUntil){cancelResponse(r);showPending();return}const receiptUntil=performance.now()+5000;const confirmed=await exactReceipt(r,reference,receiptUntil);if(!confirmed||performance.now()>=receiptUntil||owner!==auth||storageError){showPending();return}let removing=false;try{if(!showPending()||localStorage.getItem(key)!==reference)throw Error('changed');removing=true;localStorage.removeItem(key);if(!showPending())throw Error('scan failed')}catch{if(removing){try{if(localStorage.getItem(key)===null)localStorage.setItem(key,reference)}catch{}}displayed=displayed||{key,reference,count:1};storageFailed();return}if(owner!==auth)return;if(!displayed&&!storageError)status=r.status===201?'Created':'Not authorized to create';render();if(r.status===201){f.reset();await refresh()}}catch{showPending()}};
</script></html>`;
const htmlHeaders={'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
const reply=(text,status)=>new Response(text,{status,headers:{'cache-control':'no-store','content-type':'text/plain; charset=utf-8'}});
const loopback=x=>x==='127.0.0.1'||x==='::1'||x==='::ffff:127.0.0.1';
function snapshot(o) {
  if(!o||types.isProxy(o)||Object.getPrototypeOf(o)!==Object.prototype) throw Error('Invalid configuration');
  const result=Object.create(null), allowed=['enabled','localRealLogin','origin','endpoint','approvedEndpoint','project','approvedProject','boardId','teamId','databaseId','tableId','key','transport'];
  for(const key of Reflect.ownKeys(o)){const d=Object.getOwnPropertyDescriptor(o,key);if(!allowed.includes(key)||!d||!Object.hasOwn(d,'value'))throw Error('Invalid configuration');result[key]=d.value;}
  return result;
}
async function readBody(request) {
  if(!request.body) throw Error('missing');
  const reader=request.body.getReader();let timer,stop;
  try {
    const interrupted=new Promise((_,reject)=>{stop=()=>reject(Error('aborted'));request.signal.addEventListener('abort',stop,{once:true});if(request.signal.aborted)stop();timer=setTimeout(()=>reject(Error('deadline')),1000);});
    let size=0;const chunks=[];
    for(;;){const {value,done}=await Promise.race([reader.read(),interrupted]);if(done)break;size+=value.byteLength;if(size>8192)throw Error('large');chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch(e){try{void reader.cancel().catch(()=>{});}catch{}throw e;} finally {clearTimeout(timer);request.signal.removeEventListener('abort',stop);}
}
export function createHumanBoardAdapter(options={}) {
  const c=snapshot(options);
  if(c.localRealLogin!==undefined && c.localRealLogin!==true)throw Error('Invalid configuration');
  if(c.enabled!==true)return (_req,res)=>{res.writeHead(503,{'cache-control':'no-store'});res.end('Board unavailable');};
  let u;try{u=new URL(c.origin);}catch{throw Error('Invalid origin');}
  if(u.protocol!=='https:'||u.origin!==c.origin||!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw Error('Invalid origin');
  const {endpoint,approvedEndpoint,project,approvedProject,boardId,teamId,databaseId,tableId,key,transport}=c;
  if(endpoint!==approvedEndpoint||project!==approvedProject||typeof approvedProject!=='string')throw Error('Invalid authority');
  const auth=createClientAuth({origin:c.origin,endpoint,project,approvedEndpoint,approvedProject,transport});
  const list=createTeamTaskListRoute({enabled:true,trustedOrigin:c.origin,endpoint,approvedEndpoint,project,boardId,teamId,databaseId,tableId,transport});
  const create=createTeamTaskCreatorOutcome({endpoint,approvedEndpoint,project,boardId,teamId,databaseId,tableId,key,transport});
  const handle=async (request,rawPath)=>{
    // Route only on the original origin-form target, before reading a session.
    if(!['/','/login','/logout','/account','/board','/create','/health'].includes(rawPath))return reply('Not found',404);
    const path=rawPath;
    const site=request.headers.get('sec-fetch-site');
    if(site!==null&&!['same-origin','none'].includes(site))return reply('Forbidden',403);
    // Deployment gate: no provider abuse protection has been verified.
    if(path==='/login' && c.localRealLogin!==true)return reply('Sign-in unavailable: abuse protection not verified',503);
    if(path==='/login')return auth(request);
    if(['/account','/logout'].includes(path))return auth(request);
    if(path==='/board')return list(request);
    const origin=request.headers.get('origin');
    if(request.headers.get('host')!==u.host||new URL(request.url).origin!==c.origin||(origin!==null&&origin!==c.origin)||(site!==null&&!['same-origin','none'].includes(site)))return reply('Forbidden',403);
    if(rawPath==='/health') return request.method==='GET'
      ? new Response(JSON.stringify({status:'ok'}),{headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})
      : new Response(null,{status:405,headers:{allow:'GET','cache-control':'no-store'}});
    if(path==='/'&&request.method==='GET')return new Response(c.localRealLogin===true?page.replace('Sign-in is currently unavailable pending abuse protection.','Local-only sign-in experiment; not production-ready.'):page,{headers:htmlHeaders});
    if(path!=='/create'||request.method!=='POST')return reply('Not found',404);
    if(origin!==c.origin)return reply('Forbidden',403);
    const cookies=(request.headers.get('cookie')??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('__Host-weftline='));
    const session=cookies.length===1?cookies[0].slice('__Host-weftline='.length):'';
    if(!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(session))return reply('Authentication required',401);
    let data;try{data=await readBody(request);}catch{return reply('Invalid request',400);}
    if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!['title','reference'].includes(k))||typeof data.title!=='string'||!data.title.trim()||data.title.length>200||(data.reference!==undefined&&(typeof data.reference!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.reference))))return reply('Invalid request',400);
    const requestId=data.reference??randomUUID();
    try {const result=await create({session,title:data.title,requestId,signal:request.signal});return result.allowed ? reply(`Created ${requestId}`,201) : reply(`Not authorized ${requestId}`,403);}
    catch{return reply(`Outcome unknown. Check the board; do not blindly retry. Reference: ${requestId}`,502);}
  };
  const adapter=createNodeAuthAdapter({origin:c.origin,endpoint,project,transport},handle);
  return (req,res)=>{const forwarded=Object.keys(req.headers).some(h=>h==='forwarded'||h.startsWith('x-forwarded-')||h==='x-real-ip');if(req.socket.encrypted!==true||forwarded||!loopback(req.socket.server?.address()?.address)||!loopback(req.socket.remoteAddress)||!loopback(req.socket.localAddress)){res.writeHead(403,{'connection':'close','cache-control':'no-store'});res.end('Forbidden');return;}return adapter(req,res);};
}
