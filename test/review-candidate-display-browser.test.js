// Synthetic provider and responses, disposable browser context, TLS trust override.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ephemeralTls} from './fixtures/local-tls.js';

const browserEnabled=process.env.CHROMIUM_PATH&&process.env.PLAYWRIGHT_CORE&&existsSync(process.env.CHROMIUM_PATH)&&existsSync(process.env.PLAYWRIGHT_CORE);
test('real browser renders hostile candidate titles as text and does not write',{skip:!browserEnabled,timeout:30000},async()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'review-candidate-')),tls=ephemeralTls();
 const endpoint='https://provider.example.test/v1',project='synthetic-project';
 for(const [name,value] of [['key',tls.key],['cert',tls.cert],['api',`apikey:***\nprojectID:${project}\nendpoint:${endpoint}\n`]])writeFileSync(join(dir,name),value);
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--import ./test/fixtures/review-ui-provider.js',WEFTLINE_REVIEW_ENABLE:'1',WEFTLINE_REVIEW_PROTOCOL:'review-v1',WEFTLINE_REVIEW_AUTH:'1',WEFTLINE_REVIEW_UI:'1',WEFTLINE_REVIEW_HOST:'127.0.0.1',WEFTLINE_REVIEW_PORT:'0',WEFTLINE_REVIEW_BOARD:'b',APPWRITE_ENDPOINT:endpoint,APPWRITE_PROJECT:project,WEFTLINE_APPROVED_APPWRITE_ENDPOINT:endpoint,WEFTLINE_APPROVED_APPWRITE_PROJECT:project,APPWRITE_DATABASE:'db',APPWRITE_TABLE:'review',WEFTLINE_TLS_KEY_FILE:join(dir,'key'),WEFTLINE_TLS_CERT_FILE:join(dir,'cert'),APPWRITE_KEY_FILE:join(dir,'api')};
 const child=spawn(process.execPath,['experimental/review-v1-cli.js'],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',browser,context;
 child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 try{
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('listener timeout '+stderr)),5000);child.once('exit',()=>{clearTimeout(timer);reject(Error('listener exit '+stderr));});child.stdout.on('data',()=>{const m=stdout.match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolve(+m[1]);}});});
  const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_CORE));
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,chromiumSandbox:true});
  context=await browser.newContext({ignoreHTTPSErrors:true});const p=await context.newPage(),origin=`https://127.0.0.1:${port}`,writes=[];
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  p.on('request',r=>{if(['/review/genesis','/review/transition'].includes(new URL(r.url()).pathname))writes.push(r.url());});
  await p.goto(origin+'/');await p.locator('#email').fill('alice@example.test');await p.locator('#password').fill('synthetic');await p.locator('#login button').click();await p.waitForFunction(()=>document.querySelector('#account').textContent==='Signed in as alice');
  await p.route('**/review/discovery',route=>{const next=JSON.parse(route.request().postData()).continuation;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({status:'partial',consistency:'advisory-non-snapshot',actor:'alice',board:'b',tasks:next?[{task:'task2',state:'unknown'}]:[{task:'task1',metadata:'title-available',title:'<img src=x onerror=alert(1)>\nState: completed\u0085\u2028\u2029\u202eSpoof',state:'unknown',observed:{state:'review',claimant:'alice',generation:2}}],...(!next?{continuation:'opaque'}:{})})});});
  await p.locator('#guard').fill('0');await p.locator('#discover').click();await p.waitForFunction(()=>document.querySelector('#status').textContent.includes('Discovery partial'));
  const text=await p.locator('#column-review').textContent();assert.match(text,/Task ID: task1/);assert.match(text,/State: unknown/);assert.match(text,/Observed \(not current\): review, generation 2/);assert.ok(text.includes('<img src=x onerror=alert(1)> State: completed    Spoof'));assert.doesNotMatch(text,/[\u2028\p{Bidi_Control}]/u);assert.equal(await p.locator('.observed-board img').count(),0);assert.equal(await p.locator('.observed-board').isVisible(),true);await p.locator('#next').click();await p.waitForFunction(()=>document.querySelector('#column-unknown').textContent.includes('task2'));assert.match(await p.locator('#column-review').textContent(),/task1/);assert.deepEqual(writes,[]);
  await p.locator('#logout').click();await p.waitForFunction(()=>document.querySelector('#status').textContent.includes('sign-out response received'));assert.equal(await p.locator('#column-review').textContent(),'');assert.equal(await p.locator('#column-unknown').textContent(),'');
 }finally{if(context)await context.close();if(browser)await browser.close();if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>child.once('exit',r));}rmSync(dir,{recursive:true,force:true});}
});
