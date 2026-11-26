// Synthetic transport only; reject every non-fixture authority.
import './review-v1-provider.js';
const reviewFetch=globalThis.fetch;
globalThis.fetch=async (url,opt)=>{
 const u=new URL(url);
 if(u.origin!=='https://provider.example.test')throw Error('unexpected authority');
 if(u.pathname==='/v1/account/sessions/email'&&opt.method==='POST'){
  const b=JSON.parse(opt.body),actor=b.email==='alice@example.test'?'alice':b.email==='bob@example.test'?'bob':null;
  if(!actor||b.password!=='synthetic')return new Response('{}',{status:401});
  return new Response('{}',{status:201,headers:{'set-cookie':`a_session_synthetic-project=${actor}; Path=/; Secure; HttpOnly`}});
 }
 if(u.pathname==='/v1/account'&&opt.headers?.cookie){const actor=opt.headers.cookie.split('=').at(-1);return new Response(JSON.stringify({$id:actor,status:true}),{status:200});}
 if(u.pathname==='/v1/account/sessions/current'&&opt.method==='DELETE')return new Response(null,{status:204});
 return reviewFetch(url,opt);
};
