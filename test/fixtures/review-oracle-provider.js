import './review-resolution-provider.js';
import {readFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const guard1=createHash('sha256').update(JSON.stringify(['guard','b','alice',1])).digest('hex').slice(0,32);
const fetcher=globalThis.fetch, now=Date.now;
Date.now=()=>{try{return now()+Number(readFileSync(process.env.REVIEW_TEST_CLOCK_FILE,'utf8'));}catch{return now();}};
globalThis.fetch=async(url,opts)=>{const u=new URL(url);if(u.pathname.includes('/rows')){appendFileSync(process.env.REVIEW_TEST_TRACE_FILE,u.pathname+'\n');let override;try{override=JSON.parse(readFileSync(process.env.REVIEW_TEST_ROWS_FILE,'utf8'));}catch{}if(u.pathname.endsWith('/'+guard1)){let rows=[];try{rows=JSON.parse(readFileSync(process.env.REVIEW_TEST_GUARD_FILE,'utf8'));}catch{}if(!rows.some(x=>x.user==='alice'&&x.generation===1))return new Response(JSON.stringify({type:'row_not_found'}),{status:404});}if(override?.missing&&u.pathname.endsWith('/'+override.id))return new Response(JSON.stringify({type:'row_not_found'}),{status:404});}return fetcher(url,opts);};
