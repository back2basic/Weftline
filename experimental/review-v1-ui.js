import {createHash} from 'node:crypto';
import {guardedBoardPage} from './guarded-board-ui.js';

// Review UI helpers shared by the mounted, CSP-hashed browser script.
export function matchesReviewReceipt(intent, httpStatus, response) {
 const keys=['board','expectedActor','guardGeneration','operation','task','taskGeneration','action'];
 const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 const exactKeys=(x,ks)=>object(x)&&Object.keys(x).length===ks.length&&ks.every(k=>own(x,k));
 const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
 if(!object(intent))return false;
 const genesis=intent.action==='genesis';
 const intendedKeys=genesis?[...keys,'title']:keys;
 if(!exactKeys(intent,intendedKeys)||![intent.board,intent.expectedActor,intent.operation,intent.task].every(id)||!Number.isSafeInteger(intent.guardGeneration)||intent.guardGeneration<0||intent.guardGeneration>=999998||!Number.isSafeInteger(intent.taskGeneration)||intent.taskGeneration<0||intent.taskGeneration>=999999||!['genesis','claim','submit','reject','approve'].includes(intent.action))return false;
 if(genesis&&(intent.taskGeneration!==0||typeof intent.title!=='string'||!intent.title.trim()))return false;
 const expected={kind:'review-receipt-v1',...intent,user:intent.expectedActor};
 if(new TextEncoder().encode(JSON.stringify(expected)).length>1024)return false;
 if(![200,201].includes(httpStatus)||!exactKeys(response,['status','receipt'])||response.status!=='recorded'||!exactKeys(response.receipt,Object.keys(expected)))return false;
 return Object.keys(expected).every(k=>response.receipt[k]===expected[k]);
}


// Reuse the hardened authentication, discovery, storage and logout implementation.
// Fail startup if its template changes rather than silently mounting a partial page.
export function reviewBoardPage(board) {
 const page=guardedBoardPage(board,{reviewReadOnly:true});
 let html=page.html;
 const replace=(from,to)=>{if(!html.includes(from))throw Error('Review UI template changed');html=html.replace(from,to);};
 replace('<p>Read-only review candidate: writes and receipt reconciliation are not implemented here. Preserve all legacy pending references.</p><form hidden id="create">','<p>Discovery shows observed candidates, not current state. Enter the observed task and generation yourself; preserve all pending references. No direct completion is offered.</p><form id="create">');
 replace('<form hidden id="claim"><h2>Claim existing task</h2>','<form id="claim"><h2>Transition observed task candidate</h2>');
 replace('<button>Claim</button></form>','<button id="action-claim" name="action" value="claim">Claim</button><button id="action-submit" name="action" value="submit">Submit for review</button><button id="action-reject" name="action" value="reject">Reject</button><button id="action-approve" name="action" value="approve">Approve</button></form>');
 replace('<button hidden id="reconcile"','<button id="reconcile"');
 replace('<pre id="tasks"></pre>','<pre id="tasks"></pre><h2>Inspect task versions</h2><label>Task ID <input id="resolve-task" maxlength="36"></label><button type="button" id="resolve-start">Inspect from generation 0</button><button type="button" id="resolve-next">Continue inspection</button><p>Observed candidate is not current and does not authorize a write.</p><pre id="resolve-result"></pre>');
 const start=html.indexOf('<script>')+8,end=html.indexOf('</script>',start);
 if(start<8||end<start)throw Error('Review UI template changed');
 let script=html.slice(start,end);
 const change=(from,to)=>{if(!script.includes(from))throw Error('Review UI template changed');script=script.replace(from,to);};
 change("prefix='weftline-guarded-intent-v2:'", "prefix='weftline-review-intent-v1:', legacyPrefix='weftline-guarded-intent-v2:'");
 change("if(!k.startsWith(prefix))continue;", "if(!k.startsWith(prefix)&&!k.startsWith(legacyPrefix))continue;");
 change("k!==prefix+d.intent.operation", "k!==(k.startsWith(prefix)?prefix:legacyPrefix)+d.intent.operation");
 change("event.key.startsWith(prefix)","(event.key.startsWith(prefix)||event.key.startsWith(legacyPrefix))");
 change("el('pending').textContent='';for(const name", "el('pending').textContent='';el('resolve-result').textContent='';el('resolve-task').value='';resolutionToken=null;resolutionScope=null;resolutionSequence++;for(const name");
 change("const status=s=>", "let resolutionToken=null,resolutionScope=null,resolutionSequence=0;const status=s=>");
 const replaceFunction=(begin,endMarker,body)=>{const a=script.indexOf(begin),b=script.indexOf(endMarker,a);if(a<0||b<a)throw Error('Review UI template changed');script=script.slice(0,a)+body+'\n '+script.slice(b);};
 replaceFunction('async function confirm(ref,result)',"function clearAuthMarker",`const matchesReviewReceipt=${matchesReviewReceipt.toString()};
 async function confirm(ref,result){return performance.now()<result.deadline&&matchesReviewReceipt(ref.d.intent,result.status,result.value);}`);
 replaceFunction('async function mutate(kind)',"el('create').onsubmit",`async function mutate(action){if(!['genesis','claim','submit','reject','approve'].includes(action)||active)return;active=true;let ref,g=epoch;try{ready();await locked(async()=>{ready();if(g!==epoch||refs().length)throw Error();let intent;const base={board,expectedActor:actor,guardGeneration:guard(),operation:random()};if(action==='genesis'){const title=el('title').value;if(!title||title.trim()!==title||new TextEncoder().encode(title).length>256)throw Error();intent={...base,task:random(),taskGeneration:0,action,title};}else{const task=el('task').value,n=el('taskGeneration').value;if(!id(task)||!/^(0|[1-9][0-9]*)$/.test(n)||Number(n)>999998)throw Error();intent={...base,task,taskGeneration:Number(n),action};}if(intent.guardGeneration>=999998)throw Error();const kind=action==='genesis'?'genesis':'transition',key=prefix+intent.operation,raw=JSON.stringify({kind,intent});if(localStorage.getItem(key)!==null)throw Error();localStorage.setItem(key,raw);ref={key,raw,d:{kind,intent}};const all=refs();if(localStorage.getItem(key)!==raw||all.length!==1||all[0].key!==key||all[0].raw!==raw||g!==epoch||!storage())throw Error();showRefs();if(blocked||g!==epoch||localStorage.getItem(key)!==raw)throw Error();const result=await request(kind==='genesis'?'/review/genesis':'/review/transition',intent);if(g!==epoch||!await confirm(ref,result)||g!==epoch||performance.now()>=result.deadline)throw Error();remove(ref);showRefs();status('Matching historical receipt confirmed; current task existence is not proven. Update your guard candidate.');});}catch{if(g===epoch){status(ref?'Outcome unknown. Keep the saved intent and check its receipt; never retry blindly.':'Operation blocked before dispatch; verify identity, guard, and storage.');showRefs();}}finally{active=false;}}`);
 change("el('claim').onsubmit=e=>{e.preventDefault();mutate('transition');};", "el('claim').onsubmit=e=>{e.preventDefault();mutate(e.submitter?.value);};");
 replaceFunction("el('reconcile').onclick=", "addEventListener('storage'",`el('reconcile').onclick=async()=>{if(active)return;active=true;const g=epoch;try{ready();await locked(async()=>{ready();const all=refs();if(all.length!==1||!all[0].key.startsWith(prefix)||all[0].d.intent.expectedActor!==actor||all[0].d.intent.board!==board)throw Error();const ref=all[0],body={...ref.d.intent,currentGuardGeneration:guard()};const r=await request('/review/receipt',body);if(g!==epoch||!await confirm(ref,r)||g!==epoch||performance.now()>=r.deadline)throw Error();remove(ref);showRefs();status('Matching historical receipt confirmed; current task existence is not proven.');});}catch{if(g===epoch)status('Receipt unknown or denied. Preserve the intent; do not retry the write.');}finally{active=false;}};`);
 change("addEventListener('storage'",`async function resolveTask(next){const g=epoch,seq=++resolutionSequence;try{ready();const task=el('resolve-task').value,guardGeneration=guard(),expectedActor=actor,scope=JSON.stringify([expectedActor,guardGeneration,task]);if(!id(task)||(next&&(!resolutionToken||scope!==resolutionScope)))throw Error();if(!next){resolutionToken=null;resolutionScope=null;el('resolve-result').textContent='';}const r=await request('/review/resolve',{board,expectedActor,guardGeneration,task,...(next?{continuation:resolutionToken}:{})});if(g!==epoch||seq!==resolutionSequence||actor!==expectedActor||el('resolve-task').value!==task||guard()!==guardGeneration)return;if(performance.now()>=r.deadline||!r.value||r.value.consistency!=='advisory-non-snapshot'||typeof r.value.continuation!=='string'||r.value.continuation.length>1024)throw Error();if(r.status===202&&r.value.status==='unknown'){resolutionToken=r.value.continuation;resolutionScope=scope;status('Inspection unknown; retry the checkpoint.');return;}const v=r.value;if(r.status!==200||v.status!=='partial'||v.state!=='unknown'||v.actor!==expectedActor||v.board!==board||v.task!==task||!Object.keys(v).every(k=>['status','state','consistency','actor','board','task','observed','continuation'].includes(k)))throw Error();if(v.observed&&(!Number.isSafeInteger(v.observed.generation)||v.observed.generation<0||v.observed.generation>999999||!['ready','claimed','review','completed'].includes(v.observed.state)||(v.observed.claimant!==null&&!id(v.observed.claimant))))throw Error();resolutionToken=v.continuation;resolutionScope=scope;el('resolve-result').textContent=v.observed?'State unknown. Observed candidate, not current: '+JSON.stringify(v.observed):'No candidate observed; state unknown.';status('Inspection is advisory, not a snapshot. Continue or retry explicitly.');}catch{if(g===epoch&&seq===resolutionSequence)status('Inspection unavailable or unknown; do not infer absence.');}}el('resolve-start').onclick=()=>resolveTask(false);el('resolve-next').onclick=()=>resolveTask(true);
 addEventListener('storage'`);
 html=html.slice(0,start)+script+html.slice(end);
 const hash=createHash('sha256').update(script).digest('base64');
 return {html,csp:`default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`};
}
