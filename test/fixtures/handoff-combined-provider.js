// Test-only composite synthetic transport. No request may leave the reserved authority.
// Virtual transaction IDs are routed to exactly one of the two synthetic stores
// on first row staging. This models no cross-table transaction or production guarantee.
if(process.env.VERSIONED_FIXTURE_PORT!==undefined){
 const realFetch=globalThis.fetch;
 await import('../../experimental/agent-mcp/test/write-provider.js');
 const boardFetch=globalThis.fetch;
 const port=Number(process.env.VERSIONED_FIXTURE_PORT);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('invalid fixture port');
 let next=0;const transactions=new Map();
 const root='/v1/tablesdb/transactions';
 const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json'}});
 const remote=async(u,opt)=>{const headers=new Headers(opt.headers);if(headers.has('x-appwrite-project'))headers.set('x-appwrite-project','project');if(headers.has('x-appwrite-key'))headers.set('x-appwrite-key','synthetic-key');if(headers.has('cookie'))headers.set('cookie',headers.get('cookie').replace('a_session_synthetic-project=','a_session_project='));return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`,{...opt,headers});};
 globalThis.fetch=async(url,opt={})=>{
  const u=new URL(url);if(u.origin!=='https://provider.example.test'||!u.pathname.startsWith('/v1/'))throw Error('forbidden synthetic authority');
  if(u.pathname===root&&opt.method==='POST'){const id=`virtual${++next}`;transactions.set(id,{});return json({$id:id},201);}
  const table=u.pathname==='/v1/tablesdb/db/tables/versions/rows'?'versions':u.pathname==='/v1/tablesdb/db/tables/review/rows'?'review':null;
  if(table&&opt.method==='POST'){
   const body=JSON.parse(opt.body),tx=transactions.get(body.transactionId);if(!tx)throw Error('missing virtual transaction');
   if(!tx.table){tx.table=table;const start=table==='versions'?await remote(new URL('https://provider.example.test'+root),{...opt,body:JSON.stringify({ttl:60})}):await boardFetch('https://provider.example.test'+root,{...opt,body:JSON.stringify({ttl:60})});const data=await start.json();if(start.status!==201||typeof data.$id!=='string')throw Error('transaction start failed');tx.id=data.$id;}
   if(tx.table!==table)throw Error('cross-table transaction not supported');
   body.transactionId=tx.id;return table==='versions'?remote(u,{...opt,body:JSON.stringify(body)}):boardFetch(url,{...opt,body:JSON.stringify(body)});
  }
  if(u.pathname.startsWith(root+'/')&&opt.method==='PATCH'){
   const virtual=u.pathname.slice(root.length+1),tx=transactions.get(virtual);if(!tx?.id)throw Error('missing transaction');
   const actual=new URL('https://provider.example.test'+root+'/'+tx.id);const response=tx.table==='versions'?await remote(actual,opt):await boardFetch(actual.href,opt);const data=await response.json();return json({...data,$id:virtual},response.status);
  }
  if(u.pathname.startsWith('/v1/teams/')||u.pathname.startsWith('/v1/tablesdb/db/tables/versions/'))return remote(u,opt);
  return boardFetch(url,opt);
 };
}
