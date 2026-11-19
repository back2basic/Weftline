import {createHash} from 'node:crypto';
import {types} from 'node:util';
export const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
export const rowId=(b,d,g)=>'v'+createHash('sha256').update(JSON.stringify(['knowledge-version-v1',b,d,g])).digest('base64url').slice(0,32);
export const receiptId=(b,a,o)=>'r'+createHash('sha256').update(JSON.stringify(['knowledge-version-receipt-v1',b,a,o])).digest('base64url').slice(0,32);
export function snap(x,keys,exact=true){
 if(!x||typeof x!=='object'||types.isProxy(x)||Object.getPrototypeOf(x)!==Object.prototype)throw Error('invalid');
 const names=Reflect.ownKeys(x);if((exact&&names.length!==keys.length)||names.some(k=>typeof k!=='string'||!keys.includes(k)))throw Error('invalid');
 const out=Object.create(null);for(const k of names){const d=Object.getOwnPropertyDescriptor(x,k);if(!d||!Object.hasOwn(d,'value'))throw Error('invalid');out[k]=d.value;}return out;
}
const versionKeys=['kind','boardId','documentId','generation','creator','editor','title','html'];
const receiptKeys=['kind','boardId','documentId','actor','operationId','previousGeneration','generation','fingerprint'];
export const size=x=>Buffer.byteLength(JSON.stringify(x),'utf8');
export const validGeneration=x=>Number.isSafeInteger(x)&&x>=0&&x<1000000;
export function version(x,b,d,g,max){try{const r=snap(x,versionKeys);return r.kind==='knowledge-version-v1'&&r.boardId===b&&r.documentId===d&&r.generation===g&&id(r.creator)&&id(r.editor)&&typeof r.title==='string'&&r.title.trim().length>0&&Buffer.byteLength(r.title)<=200&&typeof r.html==='string'&&size(r)<=max?r:null;}catch{return null;}}
export function matchReceipt(x,receipt,max){try{const t=snap(x,receiptKeys);return size(t)<=max&&receiptKeys.every(k=>t[k]===receipt[k]);}catch{return false;}}
