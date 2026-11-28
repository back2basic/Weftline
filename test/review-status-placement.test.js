import {test} from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {reviewBoardPage} from '../experimental/review-v1-ui.js';

test('auth mirror preserves the original sole live status and CSP',()=>{
 const {html,csp}=reviewBoardPage('b');
 assert.equal((html.match(/role="status"/g)||[]).length,1);
 const resume=html.indexOf('<button id="resume"'), mirror=html.indexOf('<p id="auth-status" aria-hidden="true">'), account=html.indexOf('<p id="account">'), reconcile=html.indexOf('<button id="reconcile"'), status=html.indexOf('<p id="status" role="status">');
 assert.ok(resume<mirror&&mirror<account,'visual mirror must follow auth controls');
 assert.ok(reconcile<status,'original live region must remain after reconciliation');
 assert.match(html,/el\('status'\)\.textContent=s;el\('auth-status'\)\.textContent=s;/);
 assert.doesNotMatch(html,/position\s*:\s*(?:sticky|fixed)/);
 for(const tag of ['script','style']){const body=html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))[1];const hash=createHash('sha256').update(body).digest('base64');assert.ok(csp.includes(`${tag}-src 'sha256-${hash}'`));}
});

const enabled=process.env.CHROMIUM_PATH&&process.env.PLAYWRIGHT_CORE&&existsSync(process.env.CHROMIUM_PATH)&&existsSync(process.env.PLAYWRIGHT_CORE);
test('synthetic cross-actions mirror text without an overlay at short and mobile sizes',{skip:!enabled,timeout:60000},async()=>{
 const {html,csp}=reviewBoardPage('b');
  const server=createServer((req,res)=>{if(req.url==='/'){res.writeHead(200,{'content-type':'text/html','content-security-policy':csp});res.end(html);}else if(req.url==='/account'){res.writeHead(401,{'content-type':'application/json','x-weftline-session-state':'absent'});res.end('{"status":"absent"}');}else if(req.url==='/login'){res.writeHead(502,{'content-type':'text/plain'});res.end('Sign-in outcome unknown');}else{res.writeHead(401,{'content-type':'application/json'});res.end('{}');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser,context;
 try{
  const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_CORE));
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,chromiumSandbox:true});
  context=await browser.newContext();const page=await context.newPage(),origin=`http://127.0.0.1:${server.address().port}`;
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:320,height:240}]){
   await page.setViewportSize(viewport);await page.goto(origin);await page.evaluate(()=>localStorage.clear());await page.reload();
   await page.locator('#email').fill('synthetic@example.test');await page.locator('#password').fill('synthetic-value');await page.locator('#login button').click();
   await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Sign-in outcome unknown'));
   const mirror=page.locator('#auth-status'), bottom=page.locator('#status');
   assert.equal(await mirror.textContent(),await bottom.textContent());
   await mirror.scrollIntoViewIfNeeded();assert.equal(await mirror.isVisible(),true);
   assert.doesNotMatch(await mirror.textContent(),/synthetic-value|synthetic@example/);
   await page.locator('#reconcile').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Receipt unknown or denied'));
   assert.equal(await mirror.textContent(),await bottom.textContent());
   await bottom.scrollIntoViewIfNeeded();const b=await bottom.boundingBox();assert.ok(b.y>=0&&b.y+b.height<=viewport.height);
   assert.equal(await page.locator('[role="status"]').count(),1);
   assert.equal(await page.locator('#auth-status').getAttribute('aria-hidden'),'true');
   assert.equal(await mirror.evaluate(e=>getComputedStyle(e).position),'static');
   assert.equal(await bottom.evaluate(e=>getComputedStyle(e).position),'static');
   assert.equal(await mirror.locator('*').count(),0);assert.equal(await bottom.locator('*').count(),0);
  }
 }finally{if(context)await context.close();if(browser)await browser.close();await new Promise(r=>server.close(r));}
});

test('real handlers mirror changing auth and reconciliation warnings in text-only DOM',async()=>{
 const html=reviewBoardPage('b').html,script=html.split('<script>')[1].split('</script>')[0],elements=new Map();
 for(const m of html.matchAll(/id="([^"]+)"/g))elements.set(m[1],{value:'',textContent:'',children:[],append(...x){this.children.push(...x);}});
 const storage=new Map(),localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k),key:i=>[...storage.keys()][i]??null,get length(){return storage.size;}};
 const calls=[],fetch=async path=>{calls.push(path);if(path==='/account')return new Response('{"status":"absent"}',{status:401,headers:{'x-weftline-session-state':'absent'}});if(path==='/login')return new Response('Sign-in outcome unknown',{status:502});return new Response('{}',{status:401});};
 const context={document:{getElementById:id=>elements.get(id),createElement:()=>({textContent:''})},localStorage,fetch,Response,TextDecoder,TextEncoder,Uint8Array,AbortController,performance,setTimeout,clearTimeout,crypto:globalThis.crypto,navigator:{locks:{request:async(_n,_o,fn)=>fn()}},addEventListener:()=>{}};
 vm.runInNewContext(script,context);
 const mirror=elements.get('auth-status'),bottom=elements.get('status');
 elements.get('email').value='synthetic@example.test';elements.get('password').value='synthetic-value';await elements.get('login').onsubmit({preventDefault(){}});
 assert.match(bottom.textContent,/Sign-in outcome unknown/);assert.equal(mirror.textContent,bottom.textContent);assert.deepEqual(calls,['/account','/login']);
 await elements.get('reconcile').onclick();assert.match(bottom.textContent,/Receipt unknown or denied/);assert.equal(mirror.textContent,bottom.textContent);assert.deepEqual(calls,['/account','/login']);
 assert.equal(mirror.children.length,0);assert.equal(bottom.children.length,0);
});

test('unmarked preflight denial stays denied and never dispatches login',async()=>{
 const html=reviewBoardPage('b').html,script=html.split('<script>')[1].split('</script>')[0],elements=new Map();
 for(const m of html.matchAll(/id="([^"]+)"/g))elements.set(m[1],{value:'',textContent:'',children:[],append(...x){this.children.push(...x);}});
 const storage=new Map(),localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k),key:i=>[...storage.keys()][i]??null,get length(){return storage.size;}};
 const calls=[],fetch=async path=>{calls.push(path);return new Response('{}',{status:401});};
 const context={document:{getElementById:id=>elements.get(id),createElement:()=>({textContent:''})},localStorage,fetch,Response,TextDecoder,TextEncoder,Uint8Array,AbortController,performance,setTimeout,clearTimeout,crypto:globalThis.crypto,navigator:{locks:{request:async(_n,_o,fn)=>fn()}},addEventListener:()=>{}};
 vm.runInNewContext(script,context);
 elements.get('email').value='synthetic@example.test';elements.get('password').value='synthetic-value';await elements.get('login').onsubmit({preventDefault(){}});
 const bottom=elements.get('status'),mirror=elements.get('auth-status');
 assert.match(bottom.textContent,/Access denied; display cleared/);assert.doesNotMatch(bottom.textContent,/Sign-in outcome unknown/);assert.equal(mirror.textContent,bottom.textContent);assert.deepEqual(calls,['/account']);assert.equal(storage.has('weftline-guarded-auth-uncertain-v1'),false);
});
