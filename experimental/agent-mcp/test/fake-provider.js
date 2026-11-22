// Synthetic provider for local MCP tests; every request is intercepted.
import {createHash} from 'node:crypto';
import {appendFileSync} from 'node:fs';
const hash=(...x)=>createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,32);
const rows=new Map();
for(const [user,role] of [['alice','worker'],['bob','reviewer']])rows.set(hash('guard','b',user,0),{kind:'review-guard-v1',board:'b',user,generation:0,state:'active',role});
for(let generation=0;generation<9;generation++)rows.set(hash('task','b','task',generation),{kind:'review-task-v1',board:'b',task:'task',generation,state:generation===0?'ready':generation%2?'claimed':'review',claimant:generation===0?null:'alice'});
rows.set(hash('review-receipt-v1','b','alice','op'),{kind:'review-receipt-v1',board:'b',expectedActor:'alice',guardGeneration:0,operation:'op',task:'task',taskGeneration:0,action:'genesis',user:'alice',title:'Synthetic task'});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status});
globalThis.fetch=async(url,opt)=>{
 const u=new URL(url),root='/v1/tablesdb/db/tables/review/rows';
 if(u.origin!=='https://provider.example.test')throw Error('unexpected authority');
 if(u.pathname==='/v1/account'&&opt.method==='GET'){const session=opt.headers.Cookie?.split('=').at(-1),actor=session==='synthetic-private-session'?'alice':session;return ['alice','bob'].includes(actor)?json({$id:actor,status:true}):json({},401);}
 if(opt.headers['X-Appwrite-Key']!=='synthetic')throw Error('unexpected credential');
 if(opt.method!=='GET'){if(process.env.REVIEW_TEST_WRITES_FILE)appendFileSync(process.env.REVIEW_TEST_WRITES_FILE,'write\n');throw Error('write forbidden');}
 if(u.pathname.startsWith(root+'/')){const id=u.pathname.slice(root.length+1),row=rows.get(id);return row?json({$id:id,payload:JSON.stringify(row)}):json({type:'row_not_found'},404);}
 if(u.pathname===root){const q=u.searchParams.getAll('queries[]').map(JSON.parse),limit=q.find(x=>x.method==='limit')?.values[0],cursor=q.find(x=>x.method==='cursorAfter')?.values[0];if(limit!==25||!q.some(x=>x.method==='orderAsc'&&x.attribute==='$id'))throw Error('bad query');const all=[...rows].sort(([a],[b])=>a<b?-1:a>b?1:0),page=all.filter(([key])=>cursor===undefined||key>cursor).slice(0,limit);return json({total:all.length,rows:page.map(([id,data])=>({$id:id,payload:JSON.stringify(data)}))});}
 throw Error('unexpected route');
};
