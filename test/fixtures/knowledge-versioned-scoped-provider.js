// Local-only synthetic Appwrite subset. Never use with real credentials or data.
import http from 'node:http';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const origin='https://synthetic.test';
export async function startVersionedProvider() {
 const child=fork(fileURLToPath(import.meta.url),['--provider'],{stdio:['ignore','ignore','inherit','ipc']});
 let seq=0;const pending=new Map();
 const ready=new Promise((resolve,reject)=>{child.once('error',reject);child.on('message',m=>{if(m.ready)resolve(m.port);else if(m.reply){const p=pending.get(m.reply);if(p){pending.delete(m.reply);m.error?p.reject(Error(m.error)):p.resolve(m.value);}}});child.once('exit',()=>{for(const p of pending.values())p.reject(Error('provider exited'));pending.clear();reject(Error('provider exited'));});});
 const port=await ready;
 const control=(action,value)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('provider control timed out'));},3000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});child.send({id,action,value});});
 return {port,control,transport:(url,options)=>{const u=new URL(url);if(u.origin!==origin)throw Error('fixture forbids external network');return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`,options);},close:async()=>{if(child.exitCode!==null||child.signalCode!==null)return;const closed=new Promise(r=>child.once('close',r));child.send({action:'close'});const kill=setTimeout(()=>child.kill('SIGKILL'),2000);let timer;try{await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('provider cleanup timed out')),4000);})]);}finally{clearTimeout(kill);clearTimeout(timer);}}};
}

if(process.argv[2]==='--provider') {
 const rows=new Map(),transactions=new Map(),metrics={requests:[],commits:0,collisions:0,rollbacks:0,lostCommits:0};let next=0,lose=false,holdCommit=false,heldCommit=null,holdRow=false,heldRow=null,holdAccount=false,heldAccount=null,failAccount=false;
 const root='/v1/tablesdb/db/tables/versions/rows',txroot='/v1/tablesdb/transactions';
 const members=new Set(['creatorSentinel83','bob']),sessions=new Set(['creatorSentinel83','bob','outsider']),memberRoles=new Map();
 const send=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 const server=http.createServer(async(req,res)=>{try{
  const u=new URL(req.url,'http://127.0.0.1'),method=req.method;metrics.requests.push({method,path:u.pathname,query:u.search});
  const actor=(req.headers.cookie||'').match(/(?:^|;\s*)a_session_project=([^;]+)/)?.[1];
  const authenticated=sessions.has(actor),admin=req.headers['x-appwrite-key']==='synthetic-key'&&req.headers['x-appwrite-project']==='project';
  if(u.pathname==='/v1/account/sessions/current'&&method==='DELETE'){if(!authenticated)return send(res,401,{});sessions.delete(actor);res.writeHead(204);return res.end();}
  let body={};if(method==='POST'||method==='PATCH'){let raw='';for await(const chunk of req)raw+=chunk;body=JSON.parse(raw||'{}');}
  if(u.pathname==='/v1/account'&&method==='GET'){if(failAccount){failAccount=false;return send(res,500,{message:'synthetic-provider-secret-marker'});}const respond=()=>authenticated?send(res,200,{$id:actor,status:true}):send(res,401,{type:'user_unauthorized'});if(holdAccount){holdAccount=false;heldAccount=respond;return;}return respond();}
  if(u.pathname==='/v1/teams/team/memberships'&&method==='GET'){
   if(!authenticated)return send(res,401,{});const q=JSON.parse(u.searchParams.get('queries[0]')||'null'),l=JSON.parse(u.searchParams.get('queries[1]')||'null');
   if(q?.method!=='equal'||q.attribute!=='userId'||q.values?.length!==1||q.values[0]!==actor||l?.method!=='limit'||l.values?.[0]!==2)return send(res,400,{});
   const allowed=members.has(actor),membership={userId:actor,teamId:'team',confirm:true};if(memberRoles.has(actor)){if(memberRoles.get(actor)!==undefined)membership.roles=memberRoles.get(actor);}else membership.roles=['member'];return send(res,200,{total:allowed?1:0,memberships:allowed?[membership]:[]});
  }
  if(u.pathname===txroot&&method==='POST'){if(!admin)return send(res,401,{});const id=`tx${++next}`;transactions.set(id,{status:'pending',rows:new Map()});return send(res,201,{$id:id,status:'pending'});}
  if(u.pathname.startsWith(txroot+'/')&&method==='PATCH'){
   if(!admin)return send(res,401,{});const id=u.pathname.slice(txroot.length+1),tx=transactions.get(id);if(!tx||tx.status!=='pending')return send(res,404,{});
   if(body.rollback===true){tx.status='rolledBack';tx.rows.clear();metrics.rollbacks++;return send(res,200,{$id:id,status:tx.status});}
   if(body.commit!==true)return send(res,400,{});
   if([...tx.rows.keys()].some(id=>rows.has(id))){tx.status='failed';tx.rows.clear();metrics.collisions++;return send(res,409,{type:'transaction_conflict'});}
   for(const [key,value] of tx.rows)rows.set(key,value);tx.status='committed';metrics.commits++;
   if(lose){lose=false;metrics.lostCommits++;return req.socket.destroy();}if(holdCommit){holdCommit=false;heldCommit=()=>send(res,200,{$id:id,status:'committed'});return;}return send(res,200,{$id:id,status:'committed'});
  }
  if(u.pathname===root&&method==='POST'){
   if(!admin)return send(res,401,{});const tx=transactions.get(body.transactionId);if(!tx||tx.status!=='pending')return send(res,404,{});
   if(typeof body.rowId!=='string'||typeof body.data?.payload!=='string'||!Array.isArray(body.permissions))return send(res,400,{});
   if(tx.rows.has(body.rowId))return send(res,409,{type:'row_already_exists'});
   const row={$id:body.rowId,payload:body.data.payload,$permissions:body.permissions};tx.rows.set(body.rowId,row);if(holdRow){holdRow=false;heldRow=()=>send(res,201,row);return;}return send(res,201,row);
  }
  const canRead=row=>admin||(authenticated&&row.$permissions.some(p=>p==='read("any")'||p===`read("user:${actor}")`||(members.has(actor)&&p==='read("team:team")')));
  const transactionId=u.searchParams.get('transactionId');let view=rows;
  if(transactionId){const tx=transactions.get(transactionId);if(!admin||!tx||tx.status!=='pending')return send(res,404,{type:'transaction_not_found'});view=new Map([...rows,...tx.rows]);}
  if(u.pathname===root&&method==='GET'){
   if(!admin&&!authenticated)return send(res,401,{});const qs=u.searchParams.getAll('queries[]').map(JSON.parse),limit=qs.find(q=>q.method==='limit')?.values?.[0]??25,cursor=qs.find(q=>q.method==='cursorAfter')?.values?.[0];
   if(!Number.isInteger(limit)||limit<1||limit>100||!qs.some(q=>q.method==='orderAsc'&&q.attribute==='$id'))return send(res,400,{});
   const visible=[...view.values()].filter(canRead).sort((a,b)=>a.$id<b.$id?-1:a.$id>b.$id?1:0);if(cursor&&!visible.some(r=>r.$id===cursor))return send(res,404,{type:'cursor_not_found'});
   return send(res,200,{total:visible.length,rows:visible.filter(r=>!cursor||r.$id>cursor).slice(0,limit)});
  }
  if(u.pathname.startsWith(root+'/')&&method==='GET'){
   const row=view.get(u.pathname.slice(root.length+1));return row&&canRead(row)?send(res,200,row):send(res,404,{type:'row_not_found'});
  }
  return send(res,404,{type:'not_found'});
 }catch{if(!res.headersSent)send(res,400,{type:'fixture_invalid_request'});else res.destroy();}});
 process.on('message',m=>{if(m.action==='close'){server.close(()=>process.exit(0));server.closeAllConnections();return;}try{let value;
  if(m.action==='metrics')value=structuredClone({...metrics,rowCount:rows.size,transactions:[...transactions].map(([id,t])=>({id,status:t.status,staged:t.rows.size}))});
  else if(m.action==='rows')value=structuredClone([...rows.values()]);
  else if(m.action==='lose-next-commit')lose=true;
  else if(m.action==='hold-next-row-response')holdRow=true;
  else if(m.action==='release-row-response'){if(!heldRow)throw Error('no held row');heldRow();heldRow=null;}
  else if(m.action==='hold-next-commit-response')holdCommit=true;
  else if(m.action==='release-commit-response'){if(!heldCommit)throw Error('no held commit');heldCommit();heldCommit=null;}
  else if(m.action==='fail-next-account')failAccount=true;
  else if(m.action==='hold-next-account')holdAccount=true;
  else if(m.action==='account-held')value=!!heldAccount;
  else if(m.action==='release-account'){if(!heldAccount)throw Error('no held account');heldAccount();heldAccount=null;}
  else if(m.action==='membership'){m.value.active?members.add(m.value.actor):members.delete(m.value.actor);}
  else if(m.action==='roles'){memberRoles.set(m.value.actor,structuredClone(m.value.roles));}
  else if(m.action==='seed'){for(const row of m.value){if(rows.has(row.$id))throw Error('duplicate seed');rows.set(row.$id,structuredClone(row));}}
  else throw Error('unknown control');process.send({reply:m.id,value});
 }catch(e){process.send({reply:m.id,error:e.message});}});
 server.listen(0,'127.0.0.1',()=>process.send({ready:true,port:server.address().port}));
}
