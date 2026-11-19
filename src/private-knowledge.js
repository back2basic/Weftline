import { validateGuardedAuthority } from '../experimental/guarded-appwrite-composition.js';
// Unwired, server-only experiment. Membership and storage are separate reads:
// an operation authorized before removal may finish afterwards. The Appwrite
// Before exposure, validate actual table/row ACLs and direct client bypass on
// the intended provider: row security and no client table grants are assumed,
// not established by synthetic tests. No query snapshot guarantee is made.
// Credentials, configuration, transport and the calling process are trusted.
import {types} from 'node:util';
import {createHash} from 'node:crypto';
import {bridgeSignal,checkSignal} from './abort-signal.js';
import {createTeamMembershipProvider} from './appwrite-team-membership.js';
import {appwriteStore} from '../experimental/appwrite-store.js';

const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
// 192 bits, encoded as 32 URL-safe characters with a fixed leading letter.
const rowId = (board, document) => 'k' + createHash('sha256').update(JSON.stringify([board,document])).digest('base64url').slice(0,32);
// v2 namespace deliberately does not claim legacy board-scoped receipts.
const receiptId = (board, actor, operationId) => 'r' + createHash('sha256').update(JSON.stringify(['knowledge-receipt-actor-v2',board,actor,operationId])).digest('base64url').slice(0,32);
const operationValid = x => typeof x==='string' && /^[a-f0-9]{32}$/.test(x);
const fingerprintValid = x => typeof x==='string' && /^[a-f0-9]{64}$/.test(x);
// Correlation only: low-entropy contents can be guessed from a digest.
export function knowledgeIntentFingerprint(input) {
  const r=snapshot(input,['boardId','id','title','html','actor','operationId']);
  const row={kind:'knowledge-document-v1',boardId:r.boardId,id:r.id,title:r.title,html:r.html};
  if (!id(r.boardId)||!id(r.id)||!id(r.actor)||!operationValid(r.operationId)||!validDocument(row,r.boardId,r.id)) throw Error('Invalid input');
  return createHash('sha256').update(JSON.stringify(['knowledge-create-v1',r.boardId,r.id,r.title,r.html,r.actor,r.operationId])).digest('hex');
}
function validReceipt(row, board, operationId) {
  let r; try {r=snapshot(row,['kind','boardId','operationId','actor','fingerprint']);} catch {return null;}
  return Reflect.ownKeys(r).length===5 && r.kind==='knowledge-create-receipt-v1' && r.boardId===board && r.operationId===operationId && id(r.actor) && fingerprintValid(r.fingerprint) ? r : null;
}
const sessionValid = x => typeof x === 'string' && /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(x);
const escape = x => x.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const headers = {'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow','content-security-policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; sandbox"};
// Only services constructed here have a trusted pre-dispatch outcome path.
const creators=new WeakMap();
const receiptCreators=new WeakMap();
const receiptReaders=new WeakMap();
export async function lookupKnowledgeReceiptOutcome(service,input) {
  const lookup=receiptReaders.get(service);
  if(!lookup) return {status:'unknown'};
  try { return await lookup(input); } catch { return {status:'unknown'}; }
}
export async function createKnowledgeReceiptOutcome(service,input) {
  const trusted=receiptCreators.get(service);
  if(trusted) return trusted(input);
  await service.createWithReceipt(input);
  return {status:'unknown'};
}
export async function createKnowledgeOutcome(service,input) {
  const create=creators.get(service);
  if(create) return create(input);
  await service.create(input);
  return true;
}
function snapshot(value, allowed) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value)!==Object.prototype) throw Error('Invalid input');
  const out=Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const d=Object.getOwnPropertyDescriptor(value,key);
    if (!allowed.includes(key) || !d || !Object.hasOwn(d,'value')) throw Error('Invalid input');
    out[key]=d.value;
  }
  return out;
}
function validDocument(row, boardId, documentId) {
  // Store.get parses JSON; nevertheless validate only own data properties and
  // use the same snapshot for validation and rendering, without invoking getters.
  let doc;
  try { doc=snapshot(row,['kind','boardId','id','title','html']); } catch { return null; }
  if (Reflect.ownKeys(doc).length!==5 || doc.kind!=='knowledge-document-v1' || doc.boardId!==boardId || doc.id!==documentId || typeof doc.title!=='string' || !doc.title.trim() || Buffer.byteLength(doc.title)>200 || typeof doc.html!=='string' || Buffer.byteLength(doc.html)>16384 || Buffer.byteLength(JSON.stringify(doc))>30000) return null;
  return doc;
}
// Separate authority from caller configuration, as in the closed board adapter.
// This is unwired; runtime intrinsics and global fetch are trusted, not sandboxed.
export function createClosedPrivateKnowledge(options={}) {
  const c=snapshot(options,['enabled','endpoint','approvedEndpoint','project','approvedProject','boardId','teamId','database','table','key','knowledgePayloadMaxBytes']);
  if(c.enabled!==true) return createPrivateKnowledge();
  validateGuardedAuthority(c.endpoint,c.project,c.approvedEndpoint,c.approvedProject);
  return createPrivateKnowledge({enabled:true,endpoint:c.endpoint,approvedEndpoint:c.approvedEndpoint,project:c.project,boardId:c.boardId,teamId:c.teamId,database:c.database,table:c.table,key:c.key,knowledgePayloadMaxBytes:c.knowledgePayloadMaxBytes,transport:globalThis.fetch});
}
// Injectable composition is a test seam, not an independent authority gate.
export function createPrivateKnowledge(options={}) {
  return privateKnowledge(options,false);
}
// Every v2 operation binds its own actor, not a separate preflight.
export function createActorBoundPrivateKnowledge(options={}) {
  return privateKnowledge(options,true);
}
function privateKnowledge(options,actorBound) {
  const c=snapshot(options,['enabled','endpoint','approvedEndpoint','project','boardId','teamId','database','table','key','transport','knowledgePayloadMaxBytes']);
  if(actorBound && c.enabled!==true) throw Error('Knowledge unavailable');
  if(c.enabled!==true) return Object.freeze({create:async()=>{throw Error('Knowledge unavailable');},read:async()=>new Response('Knowledge unavailable',{status:503,headers})});
  // The operator must independently verify the configured table's limit. The
  // cap is no greater than the 1024-byte bound established in the DEV probe.
  if(!Number.isSafeInteger(c.knowledgePayloadMaxBytes)||c.knowledgePayloadMaxBytes<1||c.knowledgePayloadMaxBytes>1024||!id(c.database)||!id(c.table)||typeof c.key!=='string'||! /^[\x21-\x7e]{1,4096}$/.test(c.key)||typeof c.transport!=='function') throw Error('Invalid configuration');
  const membership=createTeamMembershipProvider({endpoint:c.endpoint,approvedEndpoint:c.approvedEndpoint,project:c.project,boardId:c.boardId,teamId:c.teamId,transport:c.transport});
  const store=appwriteStore({endpoint:c.endpoint,project:c.project,key:c.key,database:c.database,table:c.table,fetchImpl:c.transport});
  function operation(input,allowed) {
    const r=snapshot(input,actorBound?[...allowed,'expectedActor']:allowed);
    if(actorBound && !id(r.expectedActor)) throw Error('Invalid input');
    return r;
  }
  async function authorize(session,signal,expectedActor) {
    if(!sessionValid(session)) return false;
    const request={session,boardId:c.boardId,signal};
    if(actorBound) request.expectedActor=expectedActor;
    const member=await membership(request);
    checkSignal(signal);
    return member?.active===true && member.boardId===c.boardId && member.teamId===c.teamId && id(member.userId) ? member.userId : false;
  }
  async function createOutcome(input) {
      const r=operation(input,['session','id','title','html','signal']);
      const row={kind:'knowledge-document-v1',boardId:c.boardId,id:r.id,title:r.title,html:r.html};
      if(!id(r.id)||!validDocument(row,c.boardId,r.id)||Buffer.byteLength(JSON.stringify(row),'utf8')>c.knowledgePayloadMaxBytes) throw Error('Invalid input');
      const bridge=bridgeSignal(r.signal), signal=bridge.signal;
      try {
      if(!await authorize(r.session,signal,r.expectedActor)) return false;
      checkSignal(signal);
      // Create-only transaction. Any error after dispatch is indeterminate;
      // the caller must reconcile, not blindly retry.
      try {await store.transaction([{id:rowId(c.boardId,r.id),data:row}],{signal}); checkSignal(signal);} catch {throw Error('Write outcome unknown; do not blindly retry');}
      return {id:r.id};
      } finally {bridge.dispose();}
  }
  const service=Object.freeze({
    async preflightCreate(input) {
      const r=operation(input,['session','id','title','html','operationId','signal']);
      const row={kind:'knowledge-document-v1',boardId:c.boardId,id:r.id,title:r.title,html:r.html};
      if(!id(r.id)||!operationValid(r.operationId)||!validDocument(row,c.boardId,r.id)||Buffer.byteLength(JSON.stringify(row))>c.knowledgePayloadMaxBytes) throw Error('Invalid input');
      const bridge=bridgeSignal(r.signal), signal=bridge.signal;
      try {
        const actor=await authorize(r.session,signal,r.expectedActor);
        if(!actor) throw Error('Access denied');
        const fingerprint=knowledgeIntentFingerprint({boardId:c.boardId,id:r.id,title:r.title,html:r.html,actor,operationId:r.operationId});
        const receipt={kind:'knowledge-create-receipt-v1',boardId:c.boardId,operationId:r.operationId,actor,fingerprint};
        if(Buffer.byteLength(JSON.stringify(receipt))>c.knowledgePayloadMaxBytes) throw Error('Invalid input');
        checkSignal(signal);
        return {fingerprint};
      } finally {bridge.dispose();}
    },
    async createWithReceipt(input) {
      const r=operation(input,['session','id','title','html','operationId','expectedFingerprint','signal']);
      if(Object.hasOwn(r,'expectedFingerprint')&&!fingerprintValid(r.expectedFingerprint)) throw Error('Invalid input');
      const row={kind:'knowledge-document-v1',boardId:c.boardId,id:r.id,title:r.title,html:r.html};
      if(!id(r.id)||!operationValid(r.operationId)||!validDocument(row,c.boardId,r.id)||Buffer.byteLength(JSON.stringify(row))>c.knowledgePayloadMaxBytes) throw Error('Invalid input');
      const bridge=bridgeSignal(r.signal), signal=bridge.signal;
      try {
        const actor=await authorize(r.session,signal,r.expectedActor);
        if(!actor) throw Error('Access denied');
        const fingerprint=knowledgeIntentFingerprint({boardId:c.boardId,id:r.id,title:r.title,html:r.html,actor,operationId:r.operationId});
        if(Object.hasOwn(r,'expectedFingerprint') && (!fingerprintValid(r.expectedFingerprint)||r.expectedFingerprint!==fingerprint)) throw Error('Intent mismatch');
        const receipt={kind:'knowledge-create-receipt-v1',boardId:c.boardId,operationId:r.operationId,actor,fingerprint};
        if(Buffer.byteLength(JSON.stringify(receipt))>c.knowledgePayloadMaxBytes) throw Error('Invalid input');
        checkSignal(signal);
        try {
          await store.transaction([{id:rowId(c.boardId,r.id),data:row},{id:receiptId(c.boardId,actor,r.operationId),data:receipt}],{signal});
          checkSignal(signal);
          const storedReceipt=validReceipt(await store.get(receiptId(c.boardId,actor,r.operationId),{signal}),c.boardId,r.operationId);
          const storedDoc=validDocument(await store.get(rowId(c.boardId,r.id),{signal}),c.boardId,r.id);
          checkSignal(signal);
          if(!storedReceipt || storedReceipt.actor!==actor || storedReceipt.fingerprint!==fingerprint || !storedDoc || storedDoc.title!==r.title || storedDoc.html!==r.html) return {status:'unknown'};
          return {status:'confirmed',fingerprint};
        } catch {return {status:'unknown'};}
      } finally {bridge.dispose();}
    },
    async lookupReceipt(input) {
      const r=operation(input,['session','operationId','fingerprint','signal']);
      if(!operationValid(r.operationId)||!fingerprintValid(r.fingerprint)) throw Error('Invalid input');
      const bridge=bridgeSignal(r.signal), signal=bridge.signal;
      try {
        const actor=await authorize(r.session,signal,r.expectedActor);
        if(!actor) throw Error('Access denied');
        try {
          const receipt=validReceipt(await store.get(receiptId(c.boardId,actor,r.operationId),{signal}),c.boardId,r.operationId);
          checkSignal(signal);
          if(!receipt) return {status:'unknown'};
          return {status:receipt.actor===actor && receipt.fingerprint===r.fingerprint?'confirmed':'conflict'};
        } catch {return {status:'unknown'};}
      } finally {bridge.dispose();}
    },
    async create(input) {
      const result=await createOutcome(input);
      if(!result) throw Error('Access denied');
      return result;
    },
    async read(input) {
      const r=operation(input,['session','id','signal']);
      if(!id(r.id)) throw Error('Invalid input');
      const bridge=bridgeSignal(r.signal), signal=bridge.signal;
      try {
      if(!await authorize(r.session,signal,r.expectedActor)) return new Response('Knowledge unavailable',{status:403,headers});
      checkSignal(signal);
      const row=await store.get(rowId(c.boardId,r.id),{signal});
      checkSignal(signal);
      if(row===null) return new Response('Knowledge unavailable',{status:404,headers});
      const doc=validDocument(row,c.boardId,r.id);
      if(!doc) throw Error('Knowledge schema mismatch');
      return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(doc.title)}</title><main><h1>${escape(doc.title)}</h1><p>HTML source (not executed)</p><pre>${escape(doc.html)}</pre></main></html>`,{status:200,headers});
      } finally {bridge.dispose();}
    }
  });
  creators.set(service,createOutcome);
  receiptCreators.set(service,service.createWithReceipt);
  receiptReaders.set(service,service.lookupReceipt);
  return service;
}
