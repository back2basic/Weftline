// Internal knowledge-only seam: status and a single reader/cancel, not a Fetch Response.
// The two consumers each bound their JSON bodies to 65536 bytes.
import {types} from 'node:util';
// Opaque capabilities are passed only by trusted composition code, never by a
// request. Bind each capability to the exact configured fetch implementation.
const sharedGates=new WeakMap();
export function createSharedKnowledgeTransport(fetchImpl) {
 if(typeof fetchImpl!=='function') throw Error('Invalid transport');
 const gate=Object.freeze(Object.create(null));
 sharedGates.set(gate,{fetchImpl,transport:boundedKnowledgeTransport(fetchImpl,4).transport});
 return gate;
}
export function knowledgeTransportFor(fetchImpl,gate) {
 if(gate===undefined) return boundedKnowledgeTransport(fetchImpl,4).transport;
 const entry=sharedGates.get(gate);
 if(!entry||entry.fetchImpl!==fetchImpl) throw Error('Invalid shared transport');
 return entry.transport;
}
const nativeBody=Object.getOwnPropertyDescriptor(Response.prototype,'body').get;
const nativeStatus=Object.getOwnPropertyDescriptor(Response.prototype,'status').get;
// Avoid calling arbitrary accessors: they could start unobservable work before throwing.
function responseField(response,key,nativeGetter) {
 for(let object=response;object!==null;object=Object.getPrototypeOf(object)) {
  if(types.isProxy(object)) throw Error('Invalid response');
  const descriptor=Object.getOwnPropertyDescriptor(object,key);
  if(descriptor) {
   if('value' in descriptor) return descriptor.value;
   if(descriptor.get===nativeGetter) return nativeGetter.call(response);
   throw Error('Invalid response accessor');
  }
 }
 return undefined;
}
export function boundedKnowledgeTransport(fetchImpl, limit=4) {
 let active=0;
 function transport(...args) {
  if(active>=limit) return Promise.reject(Error('Knowledge transport unavailable'));
  active++;
  let pending=0, terminal=false, released=false, bytes=0, source, reader, claimed=false, cancellation;
  const release=()=>{if(terminal && pending===0 && !released){released=true;active--;}};
  const track=(call,onSuccess,onFailure)=>{
   pending++;
   let p;
   try { p=Promise.resolve(call()); } catch(error) { p=Promise.reject(error); }
   return p.then(value=>{try { const result=onSuccess?.(value); return result === undefined ? value : result; } finally {pending--;release();}},error=>{try { onFailure?.(error); throw error; } finally {pending--;release();}});
  };
  const cancel=target=>{
   if(cancellation) return cancellation;
   if(terminal && pending===0) return Promise.resolve();
   cancellation=track(()=>target.cancel(),()=>{terminal=true;});
   return cancellation;
  };
  const abortBody=target=>{try { void cancel(target).catch(()=>{}); } catch {}};
  const wrap=response=>{
   let bodyKnown=false;
   try {
    if(!response || (typeof response!=='object' && typeof response!=='function')) {bodyKnown=true;throw Error('Invalid response');}
    source=responseField(response,'body',nativeBody);
    bodyKnown=true;
    const status=responseField(response,'status',nativeStatus);
    if(!source){terminal=true;release();return {status,body:null};}
    const body={
    cancel(){return cancel(source);},
    getReader(){
     if(claimed || terminal || cancellation) throw Error('Body already consumed');
     claimed=true;
     try { reader=source.getReader(); } catch(error) {abortBody(source);throw error;}
     return {
      read(){if(terminal) return Promise.resolve({done:true,value:undefined});let synchronous=false;return track(()=>{try{return reader.read();}catch(error){synchronous=true;abortBody(reader);throw error;}},part=>{
       try {
        if(part.done){terminal=true;return;}
        if(!(part.value instanceof Uint8Array)||part.value.byteLength>65536-bytes) throw Error('Invalid or oversized body');
        bytes+=part.value.byteLength;
       } catch(error) {abortBody(reader);throw error;}
      },()=>{if(!synchronous) abortBody(reader);});},
      cancel(){return cancel(reader);}
     };
    }
   };
    return {status,body};
   } catch(error) {
    // An unreadable body may conceal a live stream; do not free its slot.
    if(source) abortBody(source); else if(bodyKnown) terminal=true;
    throw error;
   }
  };
  return track(()=>fetchImpl(...args),wrap,()=>{terminal=true;}).then(wrapResult=>wrapResult);
 }
 return {transport,get active(){return active;}};
}
