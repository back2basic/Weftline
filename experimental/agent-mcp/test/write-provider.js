// Synthetic in-process Appwrite transport. All requests are intercepted.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const hash=(...x)=>createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,32);
const rows=new Map();
for(const [user,role] of [['alice','worker'],['bob','reviewer'],['charlie','worker']]) {
 rows.set(hash('guard','b',user,0),{kind:'review-guard-v1',board:'b',user,generation:0,state:'active',role});
}
let transactions=new Map(),next=0;
const json=(x,status=200)=>new Response(JSON.stringify(x),{status});
globalThis.fetch=async (url,opt)=>{
 const u=new URL(url), root='/v1/tablesdb/db/tables/review/rows';
 if(u.origin!=='https://provider.example.test')throw Error('unexpected authority');
 if(u.pathname==='/v1/account'&&opt.method==='GET') {const actor=opt.headers.Cookie?.split('=').at(-1);return ['alice','bob','charlie','outsider'].includes(actor)?json({$id:actor,status:true}):json({},401);}
 if(opt.headers['X-Appwrite-Key']!=='synthetic')throw Error('unexpected key');
 if(opt.method==='GET'&&process.env.REVIEW_TEST_READS_FILE)appendFileSync(process.env.REVIEW_TEST_READS_FILE,'read\n');
 if(u.pathname.startsWith(root+'/')&&opt.method==='GET'){if(process.env.REVIEW_TEST_GUARD_FILE){let changes;try{changes=JSON.parse(readFileSync(process.env.REVIEW_TEST_GUARD_FILE,'utf8'));}catch{}if(changes)for(const row of changes)rows.set(hash('guard',row.board,row.user,row.generation),row);}const id=u.pathname.slice(root.length+1);if(process.env.REVIEW_TEST_ROWS_FILE){let override;try{override=JSON.parse(readFileSync(process.env.REVIEW_TEST_ROWS_FILE,'utf8'));}catch{}if(override?.id===id){if(override.hang)await new Promise((resolve,reject)=>{if(opt.signal?.aborted)return reject(Error('aborted'));opt.signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});return json({$id:id,payload:JSON.stringify(override.data)});}}return rows.has(id)?json({$id:id,payload:JSON.stringify(rows.get(id))}):json({type:'row_not_found'},404);}
 if(u.pathname===root&&opt.method==='GET'){
  const q=u.searchParams.getAll('queries[]').map(JSON.parse),limit=q.find(x=>x.method==='limit')?.values[0],cursor=q.find(x=>x.method==='cursorAfter')?.values[0];
  if(limit!==25||!q.some(x=>x.method==='orderAsc'&&x.attribute==='$id'))throw Error('bad query');
  let injected;try{injected=JSON.parse(readFileSync(process.env.REVIEW_TEST_LIST_FILE,'utf8'));}catch{}
  if(injected?.hangAfter&&cursor!==undefined)await new Promise(()=>{});
  if(injected?.failAfter&&cursor!==undefined)throw Error('synthetic page failure');
  const extra=(injected?.extras??[]).map(x=>[x.id,x.data]);
  const base=[...rows].map(([id,data])=>[id,injected?.replace?.id===id?injected.replace.data:data]);
  const all=[...base,...extra].sort(([a],[b])=>a<b?-1:a>b?1:0),page=all.filter(([k])=>cursor===undefined||k>cursor).slice(0,limit);
  return json({total:all.length,rows:page.map(([id,data])=>({$id:id,payload:JSON.stringify(data)}))});
 }
 if(u.pathname==='/v1/tablesdb/transactions'&&opt.method==='POST'){if(process.env.REVIEW_TEST_WRITES_FILE)appendFileSync(process.env.REVIEW_TEST_WRITES_FILE,'start\n');const id=`t${++next}`;transactions.set(id,[]);return json({$id:id},201);}
 if(u.pathname===root&&opt.method==='POST'){const b=JSON.parse(opt.body);transactions.get(b.transactionId).push([b.rowId,JSON.parse(b.data.payload)]);return json({$id:b.rowId},201);}
 if(u.pathname.startsWith('/v1/tablesdb/transactions/')&&opt.method==='PATCH'){const id=u.pathname.split('/').at(-1),staged=transactions.get(id);if(staged.some(([k])=>rows.has(k)))return json({},409);for(const [k,v] of staged)rows.set(k,v);if(process.env.REVIEW_TEST_SNAPSHOT_FILE)writeFileSync(process.env.REVIEW_TEST_SNAPSHOT_FILE,JSON.stringify(Object.fromEntries(rows)));if(id==='t1'||(id==='t2'&&process.env.REVIEW_TEST_LOSE_SECOND==='1'))throw Error('synthetic lost commit response');return json({$id:id,status:'committed'});}
 throw Error('unexpected request');
};
