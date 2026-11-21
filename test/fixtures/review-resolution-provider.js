// Synthetic transport for progressive read tests; no external provider access.
import './review-v1-provider.js';
import {createHash} from 'node:crypto';
const upstream=globalThis.fetch;
const hash=(...x)=>createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,32);
const versions=Array.from({length:9},(_,generation)=>({kind:'review-task-v1',board:'b',task:'task',generation,state:generation===0?'ready':generation%2?'claimed':'review',claimant:generation===0?null:'alice'}));
const rows=new Map(versions.map(v=>[hash('task','b','task',v.generation),v]));
globalThis.fetch=async(url,opt)=>{
 const u=new URL(url);
 if(opt.method==='GET'&&u.pathname.startsWith('/v1/tablesdb/db/tables/review/rows/')){
  const id=u.pathname.split('/').at(-1),row=rows.get(id);
  if(row)return new Response(JSON.stringify({$id:id,payload:JSON.stringify(row)}),{status:200});
 }
 return upstream(url,opt);
};
