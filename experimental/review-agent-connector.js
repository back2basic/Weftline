// Opt-in review-v1 advisory reads only. Runtime, authority, CA and response path are trusted.
import https from 'node:https';
import {readFileSync,statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {types} from 'node:util';
import {parseGuardedJson} from './guarded-strict-json.js';
import {bridgeSignal} from '../src/abort-signal.js';

const configs=new WeakMap();
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
const exact=(x,required,optional=[])=>x&&typeof x==='object'&&!Array.isArray(x)&&required.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>required.includes(k)||optional.includes(k));
const token=(x,op)=>typeof x==='string'&&x.length===(op==='discover'?379:720)&&/^[A-Za-z0-9_-]+$/.test(x)&&Buffer.from(x,'base64url').toString('base64url')===x;
function snapshot(x,required,optional=[]) {
 if(!x||typeof x!=='object'||types.isProxy(x)||![null,Object.prototype].includes(Object.getPrototypeOf(x)))throw Error('input');
 const d=Object.getOwnPropertyDescriptors(x), keys=Reflect.ownKeys(d);
 if(!required.every(k=>keys.includes(k))||keys.some(k=>typeof k!=='string'||!required.includes(k)&&!optional.includes(k)||!Object.hasOwn(d[k],'value')||!d[k].enumerable))throw Error('input');
 return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
export function validateConfig(args) {
 if(types.isProxy(args)||!Array.isArray(args))throw Error('configuration');
 const descriptors=Object.getOwnPropertyDescriptors(args),keys=Reflect.ownKeys(descriptors);
 const length=descriptors.length?.value;
 if(![11,12].includes(length)||keys.length!==length+1||Array.from({length},(_,i)=>String(i)).some(k=>!Object.hasOwn(descriptors,k)||!Object.hasOwn(descriptors[k],'value')||!descriptors[k].enumerable))throw Error('configuration');
 args=Array.from({length},(_,i)=>descriptors[i].value);if(args[0]!=='--enable')throw Error('configuration');
 const remote=length===12;if(remote){if(args[1]!=='--remote-https')throw Error('configuration');args.splice(1,1);}
 const o=Object.create(null);for(let i=1;i<11;i+=2){let k=args[i];if(!['--endpoint','--ca','--actor','--board','--guard'].includes(k)||Object.hasOwn(o,k)||typeof args[i+1]!=='string')throw Error('configuration');o[k]=args[i+1];}
 let url;try{url=new URL(o['--endpoint']);}catch{throw Error('configuration');}
 if(remote){if(url.protocol!=='https:'||url.origin!==o['--endpoint']||url.username||url.password||url.hostname.includes(':'))throw Error('configuration');}
 else if(!/^https:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(o['--endpoint']))throw Error('configuration');
 const port=Number(url.port||443);
 if(port<1||port>65535||!id(o['--actor'])||!id(o['--board'])||!/^(0|[1-9][0-9]{0,5})$/.test(o['--guard'])||Number(o['--guard'])>999998||!isAbsolute(o['--ca'])||o['--ca'].includes('\0'))throw Error('configuration');
 const stat=statSync(o['--ca']);if(!stat.isFile()||stat.size<1||stat.size>65536)throw Error('configuration');const ca=readFileSync(o['--ca']),text=ca.toString('ascii');
 if(!/^\s*-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(text)||(text.match(/-----BEGIN CERTIFICATE-----/g)||[]).length!==1)throw Error('configuration');
 const cert=new X509Certificate(ca);if(!cert.ca||Date.now()<Date.parse(cert.validFrom)||Date.now()>Date.parse(cert.validTo))throw Error('configuration');
 const handle=Object.freeze({});configs.set(handle,{port,ca,hostname:url.hostname,host:remote?url.host:`127.0.0.1:${port}`,endpoint:o['--endpoint'],actor:o['--actor'],board:o['--board'],guardGeneration:Number(o['--guard'])});return handle;
}
function inputSnapshot(value){
 const x=snapshot(value,['session','operation'],['task','continuation','guardGeneration']);
 if(typeof x.session!=='string'||!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(x.session)||!['discover','resolve'].includes(x.operation)|| (x.operation==='resolve'?!id(x.task):Object.hasOwn(x,'task')) || (Object.hasOwn(x,'continuation')&&!token(x.continuation,x.operation)) || (Object.hasOwn(x,'guardGeneration')&&(!Number.isSafeInteger(x.guardGeneration)||x.guardGeneration<0||x.guardGeneration>999998)))throw Error('input');
 return x;
}
export function parseInput(bytes){
 const proto=types.isTypedArray(bytes)?Object.getPrototypeOf(Uint8Array.prototype):types.isDataView(bytes)?DataView.prototype:types.isSharedArrayBuffer(bytes)?SharedArrayBuffer.prototype:types.isArrayBuffer(bytes)?ArrayBuffer.prototype:null;
 if(!proto||Object.getOwnPropertyDescriptor(proto,'byteLength').get.call(bytes)>8192)throw Error('input');
 return inputSnapshot(parseGuardedJson(bytes));
}
function observed(x){return exact(x,['generation','state','claimant'])&&Number.isSafeInteger(x.generation)&&x.generation>=0&&x.generation<=999999&&(x.generation===0?x.state==='ready'&&x.claimant===null:['claimed','review','completed'].includes(x.state)&&id(x.claimant));}
function validResult(x,c,input,status){
 const op=input.operation;
 if(status===202)return exact(x,['status'],['consistency','continuation'])&&x.status==='unknown'&&(!Object.hasOwn(x,'consistency')||x.consistency==='advisory-non-snapshot')&&(!Object.hasOwn(x,'continuation')||x.consistency==='advisory-non-snapshot'&&token(x.continuation,op));
 if(status!==200||x?.status!=='partial'||x.consistency!=='advisory-non-snapshot')return false;
 if(op==='resolve')return exact(x,['status','state','consistency','actor','board','task','continuation'],['observed'])&&x.state==='unknown'&&x.actor===c.actor&&x.board===c.board&&x.task===input.task&&token(x.continuation,op)&&(!Object.hasOwn(x,'observed')||observed(x.observed));
 return exact(x,['status','consistency','tasks','actor','board'],['continuation'])&&x.actor===c.actor&&x.board===c.board&&Array.isArray(x.tasks)&&x.tasks.length<=25&&(!Object.hasOwn(x,'continuation')||token(x.continuation,op))&&x.tasks.every(t=>exact(t,['task','metadata','state'],['title','observed'])&&id(t.task)&&t.state==='unknown'&&(['title-available','legacy-title-unavailable'].includes(t.metadata))&&(t.metadata==='title-available'?typeof t.title==='string'&&t.title.trim().length>0&&Buffer.byteLength(t.title)<=1024:!Object.hasOwn(t,'title'))&&(!Object.hasOwn(t,'observed')||observed(t.observed)));
}
export function requestReview(handle,input,options={}) {
 const c=configs.get(handle);if(!c)return Promise.reject(Error('Invalid configuration'));
 let x,opts,bridge;try{x=inputSnapshot(input);opts=snapshot(options,[],['timeoutMs','signal']);if(Object.hasOwn(opts,'timeoutMs')&&(!Number.isSafeInteger(opts.timeoutMs)||opts.timeoutMs<1||opts.timeoutMs>10000))throw Error();bridge=bridgeSignal(opts.signal);}catch{return Promise.reject(Error('Invalid input'));}
 return new Promise((resolve,reject)=>{
  let done=false,req,timer;const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);bridge.signal?.removeEventListener('abort',abort);bridge.dispose();if(error){req?.destroy();reject(Error('Review unavailable'));}else resolve(result);};
  const abort=()=>finish(true);if(bridge.signal?.aborted){finish(true);return;}bridge.signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>finish(true),opts.timeoutMs??10000);
  const body=JSON.stringify({board:c.board,expectedActor:c.actor,guardGeneration:Object.hasOwn(x,'guardGeneration')?x.guardGeneration:c.guardGeneration,...(x.operation==='resolve'?{task:x.task}:{}),...(Object.hasOwn(x,'continuation')?{continuation:x.continuation}:{})});
  try{req=https.request({hostname:c.hostname,port:c.port,path:x.operation==='discover'?'/review/discovery':'/review/resolve',method:'POST',agent:false,ca:c.ca,rejectUnauthorized:true,headers:{host:c.host,origin:c.endpoint,'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty','content-type':'application/json','content-length':Buffer.byteLength(body),cookie:`__Host-weftline=${x.session}`}},res=>{
   if(![200,202].includes(res.statusCode)||res.headers['content-type']?.split(';')[0]!=='application/json'){res.destroy();finish(true);return;}
   const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>65536){res.destroy();finish(true);}else chunks.push(chunk);});res.on('error',()=>finish(true));res.on('aborted',()=>finish(true));res.on('end',()=>{try{const value=parseGuardedJson(Buffer.concat(chunks));if(!validResult(value,c,x,res.statusCode))return finish(true);finish(false,value);}catch{finish(true);}});
  });req.on('error',()=>finish(true));req.end(body);}catch{finish(true);}
 });
}
