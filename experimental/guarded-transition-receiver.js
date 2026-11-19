// OFFLINE EXPERIMENT ONLY. Not installed on any route or suitable for real sessions.
// This injectable receiver has no trusted ingress/TLS boundary. See experimental/README.md.
import {createHash,randomBytes} from 'node:crypto';
import {parseGuardedJson} from './guarded-strict-json.js';

const valid = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
const generation = x => Number.isSafeInteger(x) && x >= 0 && x < 1000000;
const id = (...x) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,32);
export const guardId = (board,user,n) => id('guard',board,user,n);
export const taskVersionId = (board,task,n) => id('task',board,task,n);
export const receiptId = (_board,user,op) => id('receipt-v2',user,op);
export const revocationReceiptId = (administrator,op) => id('revocation-receipt-v1',administrator,op);
// Generate and retain this identifier before dispatch; never generate it inside a retry.
export const newRevocationOperation = () => randomBytes(16).toString('hex');
const exactly = (v,keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const fingerprint = (board,user,task,operation,guardGeneration,taskGeneration,action) => createHash('sha256').update(JSON.stringify(['weftline-transition-v1',board,user,task,operation,guardGeneration,taskGeneration,action])).digest('hex');
const receiptFor = (input,user) => ({kind:'receipt',board:input.board,user,task:input.task,operation:input.operation,guardGeneration:input.guardGeneration,taskGeneration:input.taskGeneration,action:input.action,fingerprint:fingerprint(input.board,user,input.task,input.operation,input.guardGeneration,input.taskGeneration,input.action)});
function validReceipt(r,user,operation) {
  return exactly(r,['kind','board','user','task','operation','guardGeneration','taskGeneration','action','fingerprint']) && r.kind==='receipt' && valid(r.board) && r.user===user && r.operation===operation && valid(r.task) && generation(r.guardGeneration) && r.guardGeneration<999998 && generation(r.taskGeneration) && r.taskGeneration<999999 && ['claim','complete','hold','unhold'].includes(r.action) && r.fingerprint===fingerprint(r.board,r.user,r.task,r.operation,r.guardGeneration,r.taskGeneration,r.action);
}
const reply = (res,status,body) => {if (res.destroyed || res.writableEnded) return;res.writeHead(status,{'content-type':'text/plain','cache-control':'no-store'});res.end(body);};

const revocationReceipt = ({board,user,administrator,guardGeneration,operation}) => ({kind:'revocation-receipt',board,user,administrator,operation,guardGeneration,action:'revoke'});
const validRevocation = ({board,user,administrator,guardGeneration,operation}) => [board,user,administrator,operation].every(valid) && generation(guardGeneration) && guardGeneration < 999999;

// Races settlement against a request-wide deadline; work that ignores abort can
// continue, but must check the supplied signal before every further side effect.
function bounded(work, timeoutMs, signal, onSettled=()=>{}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>10000) throw Error('Invalid timeout');
  const controller=new AbortController(), deadline=performance.now()+timeoutMs;
  const cancel=()=>controller.abort();
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort',cancel,{once:true});
  let timer, abortListener;
  const expired=new Promise(resolve=>{
    abortListener=()=>resolve({expired:true});
    controller.signal.addEventListener('abort',abortListener,{once:true});
    timer=setTimeout(cancel,timeoutMs);
    if (controller.signal.aborted) abortListener();
  });
  const check=()=>{if (performance.now()>=deadline) cancel();controller.signal.throwIfAborted();};
  const task=Promise.resolve().then(()=>{check();return work(controller.signal,check)});
  task.then(onSettled,onSettled);
  return Promise.race([task.then(value=>({value})),expired]).then(result=>{
    check();return result.value;
  }).finally(()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',abortListener);signal?.removeEventListener('abort',cancel);});
}

// Read-only hint, never proof of a current head or of failed prior commits.
// Scan the complete bounded window so a visible gap cannot be skipped.
function validateDiscovery({store,board,user,guardGeneration,maxReads}) {
  if (!store || typeof store.get !== 'function' || ![board,user].every(valid) || !generation(guardGeneration) || !Number.isSafeInteger(maxReads) || maxReads<2 || maxReads>256) throw Error('Invalid discovery');
}
async function scanManagedGuard({store,board,user,guardGeneration,maxReads,signal},check) {
  validateDiscovery({store,board,user,guardGeneration,maxReads});
  let last=null, missing=false;
  for (let i=0;i<maxReads && guardGeneration+i<1000000;i++) {
    check();
    const n=guardGeneration+i;
    const guard=await store.get(guardId(board,user,n),{signal});
    check();
    if (guard===null) {missing=true;continue;}
    if (missing || !exactly(guard,['kind','board','user','generation','state']) || guard.kind!=='guard' || guard.board!==board || guard.user!==user || guard.generation!==n || guard.state!=='active' || n===999999) return {status:'unknown'};
    last=n;
  }
  if (last===null || !missing) return {status:'unknown'};
  return {status:'candidate',guardGeneration:last};
}
// Shared by all standalone calls in this module instance, regardless of store.
let activeStandaloneDiscoveries=0;
export async function discoverManagedGuard(input) {
  validateDiscovery(input);
  const timeoutMs=input.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>10000) throw Error('Invalid timeout');
  if (activeStandaloneDiscoveries>=8) return {status:'unknown'};
  activeStandaloneDiscoveries++;
  let released=false;
  const release=()=>{if (!released) {released=true;activeStandaloneDiscoveries--;}};
  let pending;
  try {pending=bounded((signal,check)=>scanManagedGuard({...input,signal},check),timeoutMs,input.signal,release);}
  catch {release();return {status:'unknown'};}
  try {return await pending;}
  catch {return {status:'unknown'};}
}

// Trusted internal primitives only: an authenticated, authorized administrative
// boundary must independently authorize discovery, mutation and reconciliation.
export async function reconcileManagedRevocation(input) {
  const {store,administrator,operation,signal}=input;
  if (!validRevocation(input) || !store || typeof store.get !== 'function') throw Error('Invalid revocation');
  try {
    signal?.throwIfAborted();
    const receipt=await store.get(revocationReceiptId(administrator,operation),{signal});
    signal?.throwIfAborted();
    const expected=revocationReceipt(input);
    if (!exactly(receipt,Object.keys(expected)) || !Object.keys(expected).every(k=>receipt[k]===expected[k])) return 'unknown';
    return 'revoked';
  } catch {return 'unknown';}
}

export async function revokeManagedGuard({store,board,user,administrator,guardGeneration,operation,signal,check=()=>signal?.throwIfAborted()}) {
  if (!store || typeof store.get !== 'function' || typeof store.transaction !== 'function' || !validRevocation({board,user,administrator,operation,guardGeneration})) throw Error('Invalid revocation');
  check();
  let previous;
  try {previous=await store.get(revocationReceiptId(administrator,operation),{signal});}
  catch {throw Error('Outcome unknown; do not retry blindly');}
  check();
  if (previous!==null) {
    const expected=revocationReceipt({board,user,administrator,guardGeneration,operation});
    if (exactly(previous,Object.keys(expected)) && Object.keys(expected).every(k=>previous[k]===expected[k])) return 'revoked';
    throw Error('Outcome unknown; do not retry blindly');
  }
  let guard;
  try {guard=await store.get(guardId(board,user,guardGeneration),{signal});}
  catch {throw Error('Outcome unknown; do not retry blindly');}
  check();
  if (!exactly(guard,['kind','board','user','generation','state']) || guard.kind!=='guard' || guard.board!==board || guard.user!==user || guard.generation!==guardGeneration || guard.state!=='active') {
    if (await reconcileManagedRevocation({store,board,user,administrator,guardGeneration,operation,signal})==='revoked') return 'revoked';
    throw Error('Outcome unknown; do not retry blindly');
  }
  const entries=[
    {id:guardId(board,user,guardGeneration+1),data:{kind:'guard',board,user,generation:guardGeneration+1,state:'revoked'}},
    {id:revocationReceiptId(administrator,operation),data:revocationReceipt({board,user,administrator,operation,guardGeneration})}
  ];
  check();
  try {
    await store.transaction(entries,{signal});
    if (await reconcileManagedRevocation({store,board,user,administrator,guardGeneration,operation,signal}) !== 'revoked') throw Error('unconfirmed');
    return 'revoked';
  } catch {throw Error('Outcome unknown; do not retry blindly');}
}

const recoveryReceiptId = (administrator,operation) => id('recovery-receipt-v1',administrator,operation);
const recoveryReceipt = ({board,user,task,administrator,guardGeneration,taskGeneration,operation}) => ({kind:'recovery-receipt',board,user,task,administrator,guardGeneration,taskGeneration,operation,action:'recover-held'});
const validRecovery = x => [x.board,x.user,x.task,x.administrator,x.operation].every(valid) && generation(x.guardGeneration) && generation(x.taskGeneration) && x.taskGeneration<999999;
async function reconcileRecovery(input) {
  if (!validRecovery(input)) throw Error('Invalid recovery');
  try {
    input.check();
    const receipt=await input.store.get(recoveryReceiptId(input.administrator,input.operation),{signal:input.signal});
    input.check();
    const expected=recoveryReceipt(input);
    return exactly(receipt,Object.keys(expected)) && Object.keys(expected).every(k=>receipt[k]===expected[k]) ? 'recovered' : 'unknown';
  } catch {return 'unknown';}
}
async function recoverHeld(input) {
  if (!validRecovery(input) || typeof input.store.get!=='function' || typeof input.store.transaction!=='function') throw Error('Invalid recovery');
  const {store,board,user,task,administrator,guardGeneration,taskGeneration,operation,signal,check}=input;
  const unknown=()=>Error('Outcome unknown; do not retry blindly');
  check();
  let previous,guard,held;
  try {
    previous=await store.get(recoveryReceiptId(administrator,operation),{signal});check();
    if (previous!==null) {
      if (await reconcileRecovery(input)==='recovered') return 'recovered';
      throw unknown();
    }
    guard=await store.get(guardId(board,user,guardGeneration),{signal});check();
    held=await store.get(taskVersionId(board,task,taskGeneration),{signal});check();
  } catch {throw unknown();}
  if (!exactly(guard,['kind','board','user','generation','state']) || guard.kind!=='guard' || guard.board!==board || guard.user!==user || guard.generation!==guardGeneration || guard.state!=='revoked' ||
      !exactly(held,['kind','board','task','generation','state','claimant']) || held.kind!=='task' || held.board!==board || held.task!==task || held.generation!==taskGeneration || held.state!=='held' || held.claimant!==user) {
    if (await reconcileRecovery(input)==='recovered') return 'recovered';
    throw unknown();
  }
  const entries=[{id:taskVersionId(board,task,taskGeneration+1),data:{kind:'task',board,task,generation:taskGeneration+1,state:'ready',claimant:null}},
    {id:recoveryReceiptId(administrator,operation),data:recoveryReceipt(input)}];
  check();
  try {
    await store.transaction(entries,{signal});check();
    if (await reconcileRecovery(input)!=='recovered') throw unknown();
    return 'recovered';
  } catch {throw unknown();}
}

// The injected authorizer is trusted to authenticate the credential and authorize
// this action and target, returning the authenticated administrator's ID.
// No authorizer or administrative ingress is provided by this experiment.
export function createManagedRevocationService({store,authorize,timeoutMs=10000,maxConcurrent=8,recoveryEnabled=false}) {
  if (typeof recoveryEnabled !== 'boolean') throw Error('Invalid configuration');
  if (!store || typeof authorize !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>10000 || !Number.isSafeInteger(maxConcurrent) || maxConcurrent<1 || maxConcurrent>256) throw Error('Invalid configuration');
  let active=0;
  async function run(action,{credential,board,user,task,administrator:expectedAdministrator,guardGeneration,taskGeneration,operation,maxReads,signal}) {
    const recovery=action==='recover' || action==='reconcileRecovery';
    if (recovery && !recoveryEnabled) throw Error('Recovery disabled');
    if (active>=maxConcurrent) {
      if (action==='discover') return {status:'unknown'};
      if (action==='reconcile' || action==='reconcileRecovery') return 'unknown';
      throw Error('Service busy; outcome of any prior intent unknown');
    }
    active++;
    let released=false;
    const release=()=>{if (!released) {released=true;active--;}};
    let pending;
    try {
      try {pending=bounded(async (signal,check)=>{
        const administrator=await authorize({credential,action,board,user,task,administrator:expectedAdministrator,guardGeneration,taskGeneration,operation,signal});
        check();
        if (!valid(administrator) || (recovery && administrator!==expectedAdministrator)) throw Error('Denied; outcome of any prior intent unknown');
        const input={store,board,user,task,administrator,guardGeneration,taskGeneration,operation,maxReads,signal,check};
        if (action==='discover') return scanManagedGuard(input,check);
        if (action==='recover') return recoverHeld(input);
        if (action==='reconcileRecovery') return reconcileRecovery(input);
        return action==='revoke' ? revokeManagedGuard(input) : reconcileManagedRevocation(input);
      },timeoutMs,signal,release);} catch (error) {release();throw error;}
      return await pending;
    } catch (error) {
      // An aborted request, including one that timed out before authorization,
      // cannot establish the outcome of an earlier intent.
      if (!(signal?.aborted || error?.name==='AbortError')) throw error;
      if (action==='discover') return {status:'unknown'};
      if (action==='reconcile' || action==='reconcileRecovery') return 'unknown';
      throw Error('Outcome unknown; do not retry blindly');
    }
  }
  return {discover:input=>run('discover',input),revoke:input=>run('revoke',input),reconcile:input=>run('reconcile',input),recover:input=>run('recover',input),reconcileRecovery:input=>run('reconcileRecovery',input)};
}

export function createGuardedReceiver({enabled=false,store,timeoutMs=10000,board}={}) {
  if (board !== undefined && !valid(board)) throw Error('Invalid board');
  if (enabled !== true) return (_req,res)=>reply(res,503,'Unavailable');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw Error('Invalid timeout');
  if (!store || typeof store.account !== 'function' || typeof store.get !== 'function' || typeof store.transaction !== 'function') throw Error('Invalid store');
  return async (req,res) => {
    const controller=new AbortController();
    let dispatched=false;
    const deadline=performance.now()+timeoutMs;
    const check=()=>{if (performance.now()>=deadline) controller.abort();controller.signal.throwIfAborted();};
    const timer=setTimeout(()=>{controller.abort();reply(res,dispatched?502:408,dispatched?'Outcome unknown; do not retry blindly':'Request timed out');if (!req.complete) req.destroy();},timeoutMs);
    const disconnect=()=>{if (!res.writableFinished) controller.abort();};
    res.once('close',disconnect);
    try {
    if (req.method !== 'POST' || !['/transition','/receipt','/v2/transition','/v2/receipt'].includes(req.url)) return reply(res,404,'Not found');
    const v2=req.url.startsWith('/v2/');
    const recorded=(status,user)=>{
      if (!v2) return reply(res,status,'Transition recorded');
      const body=JSON.stringify({status:'recorded',receipt:{kind:'transition',actor:user,board:input.board,task:input.task,operation:input.operation,guardGeneration:input.guardGeneration,taskGeneration:input.taskGeneration,action:input.action}});
      if (!res.destroyed && !res.writableEnded) {res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(body);}
    };
    const parts=(req.headers.cookie ?? '').split(';').map(x=>x.trim()).filter(x=>x.startsWith('__Host-weftline='));
    const session=parts.length===1 ? parts[0].slice('__Host-weftline='.length) : '';
    if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(session)) return reply(res,401,'Unauthorized');
    let input;
    try {
      const chunks=[]; let size=0;
      for await (const chunk of req) {size+=chunk.length;if(size>4096) throw Error();chunks.push(chunk);}
      check();
      input=parseGuardedJson(Buffer.concat(chunks));
    } catch {return reply(res,400,'Invalid request');}
    if (!exactly(input,['board','task','operation','guardGeneration','taskGeneration','action',...(v2?['expectedActor']:[])]) || ![input.board,input.task,input.operation,...(v2?[input.expectedActor]:[])].every(valid) || (!generation(input.guardGeneration) || input.guardGeneration >= 999998) || (!generation(input.taskGeneration) || input.taskGeneration >= 999999) || !['claim','complete','hold','unhold'].includes(input.action)) return reply(res,400,'Invalid request');
    if (board !== undefined && input.board !== board) return reply(res,400,'Invalid request');
    let user, guard, task;
    try {
      const account=await store.account(session,{signal:controller.signal});
      check();
      if (!account || account.status!==true || !valid(account.$id)) return reply(res,403,'Denied');
      user=account.$id;
      if (v2 && input.expectedActor!==user) return reply(res,403,'Denied; outcome of any prior intent unknown');
      const receipt=await store.get(receiptId(input.board,user,input.operation),{signal:controller.signal});
      check();
      if (receipt !== null) {
        if (!validReceipt(receipt,user,input.operation)) return reply(res,503,'Unavailable');
        if (receipt.fingerprint!==receiptFor(input,user).fingerprint) return reply(res,409,'Operation mismatch');
        return recorded(200,user);
      }
      if (req.url==='/receipt' || req.url==='/v2/receipt') return reply(res,202,'Outcome unknown; do not retry blindly');
      guard=await store.get(guardId(input.board,user,input.guardGeneration),{signal:controller.signal});
      check();
      task=await store.get(taskVersionId(input.board,input.task,input.taskGeneration),{signal:controller.signal});
      check();
    } catch {return reply(res,503,'Unavailable');}
    if (!exactly(guard,['kind','board','user','generation','state']) || guard.kind!=='guard' || guard.board!==input.board || guard.user!==user || guard.generation!==input.guardGeneration || guard.state!=='active' ||
        !exactly(task,['kind','board','task','generation','state','claimant']) || task.kind!=='task' || task.board!==input.board || task.task!==input.task || task.generation!==input.taskGeneration || !(input.action==='claim' || input.action==='hold' ? task.state==='ready' && task.claimant===null : task.state===(input.action==='unhold'?'held':'claimed') && task.claimant===user)) return reply(res,403,'Denied');
    const entries=[
      {id:guardId(input.board,user,input.guardGeneration+1),data:{kind:'guard',board:input.board,user,generation:input.guardGeneration+1,state:'active'}},
      {id:taskVersionId(input.board,input.task,input.taskGeneration+1),data:{kind:'task',board:input.board,task:input.task,generation:input.taskGeneration+1,state:({claim:'claimed',complete:'completed',hold:'held',unhold:'ready'})[input.action],claimant:input.action==='unhold'?null:user}},
      {id:receiptId(input.board,user,input.operation),data:receiptFor(input,user)}
    ];
    try {
      check(); dispatched=true; await store.transaction(entries,{signal:controller.signal}); check();
      const receipt=await store.get(receiptId(input.board,user,input.operation),{signal:controller.signal});
      check();
      if (!validReceipt(receipt,user,input.operation) || receipt.fingerprint!==receiptFor(input,user).fingerprint) throw Error('unconfirmed receipt');
    } catch {if (!res.destroyed) return reply(res,502,'Outcome unknown; do not retry blindly'); return;}
    return recorded(201,user);
    } finally {clearTimeout(timer);res.removeListener('close',disconnect);}
  };
}
