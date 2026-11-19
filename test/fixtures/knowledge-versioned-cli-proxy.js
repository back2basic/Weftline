// Test-only: pin the CLI's configured authority to an ephemeral synthetic provider.
const realFetch=globalThis.fetch;
if(process.env.VERSIONED_FIXTURE_PORT!==undefined){
const port=Number(process.env.VERSIONED_FIXTURE_PORT);
if(!Number.isInteger(port)||port<1||port>65535) throw Error('invalid fixture port');
globalThis.fetch=async(url,options={})=>{
 const u=new URL(url);
 if(u.origin!=='https://provider.example.test'||!u.pathname.startsWith('/v1/'))throw Error('external network forbidden');
 if(process.env.VERSIONED_HANG_ACCOUNT==='1'&&u.pathname==='/v1/account'){
  process.send?.('account-hung');await new Promise(resolve=>process.on('message',function release(m){if(m==='release-account'){process.removeListener('message',release);resolve();}}));
 }
 const headers=new Headers(options.headers);
 if(headers.has('x-appwrite-project'))headers.set('x-appwrite-project','project');
 if(headers.has('x-appwrite-key'))headers.set('x-appwrite-key','synthetic-key');
 if(headers.has('cookie'))headers.set('cookie',headers.get('cookie').replace('a_session_synthetic-project=','a_session_project='));
 if(process.env.VERSIONED_IGNORE_ROW_ABORT==='1'&&u.pathname==='/v1/tablesdb/db/tables/versions/rows'&&options.method==='POST'){
  const response=await realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`,{...options,headers,signal:undefined});process.send?.('late-row-delivered');return response;
 }
 return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`,{...options,headers});
};
}
