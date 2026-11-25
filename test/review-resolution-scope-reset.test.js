import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {reviewBoardPage} from '../experimental/review-v1-ui.js';

for(const changed of ['guard','resolve-task']) test(`changing ${changed} clears the inspected task and checkpoint`,async()=>{
 const html=reviewBoardPage('b').html,script=html.split('<script>')[1].split('</script>')[0],elements=new Map();
 for(const m of html.matchAll(/id="([^"]+)"/g))elements.set(m[1],{value:'',textContent:''});
 const storage=new Map(),calls=[];
 const localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k),key:i=>[...storage.keys()][i]??null,get length(){return storage.size;}};
 const fetch=async(path,options)=>{calls.push(path);const value=path==='/account'?{$id:'alice',status:true}:{status:'partial',state:'unknown',consistency:'advisory-non-snapshot',actor:'alice',board:'b',task:'task',observed:{generation:4,state:'review',claimant:'alice'},continuation:'opaque'};return new Response(JSON.stringify(value),{status:200});};
 vm.runInNewContext(script,{document:{getElementById:id=>elements.get(id)},localStorage,fetch,Response,TextDecoder,TextEncoder,Uint8Array,AbortController,performance,setTimeout,clearTimeout,crypto:globalThis.crypto,navigator:{locks:{request:async(_n,_o,fn)=>fn()}},addEventListener:()=>{}});
 await elements.get('resume').onclick();elements.get('guard').value='0';elements.get('resolve-task').value='task';await elements.get('resolve-start').onclick();assert.match(elements.get('resolve-result').textContent,/generation.?:4/);
 elements.get(changed).value=changed==='guard'?'1':'other';elements.get(changed).oninput?.();assert.equal(elements.get('resolve-result').textContent,'');
 await elements.get('resolve-next').onclick();assert.deepEqual(calls,['/account','/review/resolve']);
});
