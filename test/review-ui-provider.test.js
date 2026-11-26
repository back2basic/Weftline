import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('browser-test provider preload is available and restricts the synthetic authority',()=>{
 const code=`const base='https://provider.example.test/v1';
const r=await fetch(base+'/account/sessions/email',{method:'POST',body:JSON.stringify({email:'alice@example.test',password:'synthetic'})});
if(r.status!==201||!r.headers.get('set-cookie')?.includes('synthetic-project'))process.exit(2);
let rejected=false;try{await fetch('https://wrong.example.test/v1/account',{method:'GET',headers:{}})}catch{rejected=true}if(!rejected)process.exit(3);`;
 const child=spawnSync(process.execPath,['--import','./test/fixtures/review-ui-provider.js','--input-type=module','-e',code],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR}});
 assert.equal(child.status,0,child.stderr);
});
