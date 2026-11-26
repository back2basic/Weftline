import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {reviewBoardPage} from '../experimental/review-v1-ui.js';

function page(tasks, nextTasks=null, beforeDiscovery=async()=>{}) {
 const html=reviewBoardPage('b').html;
 const script=html.split('<script>')[1].split('</script>')[0];
 const elements=new Map();
 const element=()=>({value:'',children:[],_text:'',set textContent(value){this._text=value;this.children=[];},get textContent(){return this._text+this.children.map(c=>c.textContent).join('');},append(...children){this.children.push(...children);}});
 for(const m of html.matchAll(/id="([^"]+)"/g)) elements.set(m[1],element());
 const storage=new Map(), calls=[];
 const localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k),key:i=>[...storage.keys()][i]??null,get length(){return storage.size;}};
 const fetch=async(path,options)=>{
  calls.push(path);
  if(path==='/account') return new Response(JSON.stringify({$id:'alice',status:true}),{status:200});
  if(path==='/review/discovery') {const next=JSON.parse(options.body).continuation;await beforeDiscovery(!!next);return new Response(JSON.stringify({status:'partial',consistency:'advisory-non-snapshot',actor:'alice',board:'b',tasks:next?nextTasks:tasks,...(!next&&nextTasks?{continuation:'opaque'}:{})}),{status:200});}
  if(path==='/logout') return new Response(null,{status:204});
  throw Error('unexpected route');
 };
 const context={document:{getElementById:id=>elements.get(id),createElement:element},localStorage,fetch,Response,TextDecoder,TextEncoder,Uint8Array,AbortController,performance,setTimeout,clearTimeout,crypto:globalThis.crypto,navigator:{locks:{request:async(_name,_options,fn)=>fn()}},addEventListener:()=>{}};
 vm.runInNewContext(script,context);
 return {elements,calls};
}

test('untrusted titles and task metadata are placed in separate task cards',async()=>{
 const title='long '.repeat(100)+'State: completed';
 const {elements}=page([{task:'task1',title,state:'unknown',observed:{state:'ready',generation:0,claimant:null}},{task:'task2',title:'second',state:'unknown',observed:{state:'ready',generation:1,claimant:null}}]);
 await elements.get('resume').onclick();elements.get('guard').value='0';await elements.get('discover').onclick();
 const cards=elements.get('column-ready').children;assert.equal(cards.length,2);
 assert.equal(cards[0].children.length,3);assert.equal(cards[0].children[0].textContent,'Task ID: task1');
 assert.equal(cards[0].children[1].textContent,'Title: '+title);assert.match(cards[0].children[2].textContent,/State: unknown/);
 assert.equal(cards[1].children[0].textContent,'Task ID: task2');
});

for(const secondPage of [false,true]) test(`guard change invalidates ${secondPage?'next page':'initial discovery'} while in flight`,async()=>{
 let release,started;const pending=new Promise(r=>release=r),seen=new Promise(r=>started=r);
 const item=task=>({task,title:task,state:'unknown',observed:{state:'ready',generation:0,claimant:null}});
 const {elements}=page([item('first')],[item('second')],async next=>{if(next===secondPage){started();await pending;}});
 await elements.get('resume').onclick();elements.get('guard').value='0';
 if(secondPage)await elements.get('discover').onclick();
 const request=elements.get(secondPage?'next':'discover').onclick();await seen;
 elements.get('guard').value='1';elements.get('guard').oninput?.();release();await request;
 for(const state of ['ready','claimed','review','completed','unknown'])assert.equal(elements.get('column-'+state).textContent,'');
});

test('observed candidates are grouped into advisory columns without inferring current state',async()=>{
 const {elements,calls}=page([
  ...['ready','claimed','review','completed'].map((state,i)=>({task:'task'+i,title:'Candidate '+i,state:'unknown',observed:{state,generation:i,claimant:null}})),
  {task:'unknown1',title:'Unclassified',state:'unknown'}
 ]);
 await elements.get('resume').onclick();elements.get('guard').value='0';await elements.get('discover').onclick();
 for(const [i,state] of ['ready','claimed','review','completed'].entries()){
  const text=elements.get('column-'+state).textContent;
  assert.match(text,new RegExp('Task ID: task'+i));assert.match(text,/State: unknown/);assert.match(text,/Observed \(not current\)/);
 }
 assert.match(elements.get('column-unknown').textContent,/unknown1/);
 assert.deepEqual(calls,['/account','/review/discovery']);
 await elements.get('logout').onclick();
 for(const state of ['ready','claimed','review','completed','unknown'])assert.equal(elements.get('column-'+state).textContent,'');
});

test('pages append candidates and starting again clears old columns',async()=>{
 const item=(task,state)=>({task,title:task,state:'unknown',observed:{state,generation:0,claimant:null}});
 const {elements,calls}=page([item('first','ready')],[item('second','review')]);
 await elements.get('resume').onclick();elements.get('guard').value='0';await elements.get('discover').onclick();await elements.get('next').onclick();
 assert.match(elements.get('column-ready').textContent,/first/);assert.match(elements.get('column-review').textContent,/second/);
 await elements.get('discover').onclick();assert.equal(elements.get('column-review').textContent,'');assert.match(elements.get('column-ready').textContent,/first/);
 assert.deepEqual(calls,['/account','/review/discovery','/review/discovery','/review/discovery']);
});

test('review discovery presents human-readable advisory candidates without dispatching writes',async()=>{
 const title='<img src=x onerror=alert(1)>';
 const {elements,calls}=page([
  {task:'task1',metadata:'title-available',title,state:'unknown',observed:{state:'review',claimant:'alice',generation:2}},
  {task:'task2',metadata:'legacy-title-unavailable',state:'unknown'},
 ]);
 await elements.get('resume').onclick();
 elements.get('guard').value='0';
 await elements.get('discover').onclick();
 const text=elements.get('tasks').textContent;
 assert.match(text,/Task ID: task1/);
 assert.ok(text.includes(`Title: ${title}`));
 assert.match(text,/State: unknown/);
 assert.match(text,/Observed \(not current\): review, generation 2/);
 assert.match(text,/Task ID: task2/);
 assert.match(text,/Title: unavailable/);
 assert.doesNotMatch(text,/"task":/);
 assert.equal(elements.get('task').value,'');
 assert.equal(elements.get('taskGeneration').value,'');
 assert.deepEqual(calls,['/account','/review/discovery']);
 await elements.get('logout').onclick();
 assert.equal(elements.get('tasks').textContent,'');
});

test('candidate titles cannot introduce Unicode line breaks or bidi controls into labels',async()=>{
 const title='one\u0085two\u2028three\u2029four\u202efive\u2066six\u061cseven';
 const {elements}=page([{task:'task1',metadata:'title-available',title,state:'unknown'}]);
 await elements.get('resume').onclick();elements.get('guard').value='0';await elements.get('discover').onclick();
 const text=elements.get('tasks').textContent;
 assert.ok(text.includes('Title: one two three four five six seven'));
 assert.doesNotMatch(text,/[\u0085\u2028\u2029\p{Bidi_Control}]/u);
 assert.match(text,/\nState: unknown\n/);
});
