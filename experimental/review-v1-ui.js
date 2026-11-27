import {createHash} from 'node:crypto';
import {guardedBoardPage} from './guarded-board-ui.js';

// Theme preference is cosmetic and never changes authorization or saved intents.
export function installReviewTheme(document, storage, media) {
 const button=document.getElementById('theme-toggle');
 let saved=null;
 try{const value=storage.getItem('weftline-theme');if(value==='light'||value==='dark')saved=value;}catch{}
 let theme=saved||(media?.matches?'dark':'light');
 const render=()=>{document.documentElement.dataset.theme=theme;button.setAttribute('aria-pressed',String(theme==='dark'));};
 render();
 button.onclick=()=>{theme=theme==='dark'?'light':'dark';saved=theme;try{storage.setItem('weftline-theme',theme);}catch{}render();};
 media?.addEventListener?.('change',()=>{if(saved===null){theme=media.matches?'dark':'light';render();}});
}

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
 replace('<meta charset="utf-8">','<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">');
 replace('<p id="account"></p>','<p id="auth-status" aria-hidden="true"></p><p id="account"></p>');
 replace('<title>Review local board</title><h1>Review local board</h1>','<title>Weftline — work board</title><button id="theme-toggle" type="button" aria-pressed="false">Dark mode</button><h1>Weftline</h1>');
 replace('<p>Read-only review candidate: writes and receipt reconciliation are not implemented here. Preserve all legacy pending references.</p><form hidden id="create">','<p>Discovery shows observed candidates, not current state. Enter the observed task and generation yourself; preserve all pending references. No direct completion is offered.</p><form id="create">');
 replace('<form hidden id="claim"><h2>Claim existing task</h2>','<form id="claim"><h2>Transition observed task candidate</h2>');
 replace('<button>Claim</button></form>','<button id="action-claim" name="action" value="claim">Claim</button><button id="action-submit" name="action" value="submit">Submit for review</button><button id="action-reject" name="action" value="reject">Reject</button><button id="action-approve" name="action" value="approve">Approve</button></form>');
 replace('<button hidden id="reconcile"','<button id="reconcile"');
 const boardStyle=`
 :root{color-scheme:light;--ink:#18252a;--muted:#52666c;--line:#ccd9d7;--surface:#fff;--accent:#14685f}
 *{box-sizing:border-box}body{max-width:1440px;margin:0 auto;padding:32px clamp(18px,4vw,56px) 72px;background:#f3f7f5;color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
 h1{font-size:clamp(28px,4vw,38px);letter-spacing:-.04em;margin:0 0 8px;color:#143e3b}h2{font-size:19px;letter-spacing:-.015em;margin:32px 0 8px}h3{font-size:14px}p{max-width:88ch;color:var(--muted);margin:8px 0 14px}
 form{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px;margin:22px 0;box-shadow:0 3px 12px #173e3510}form h2{margin:0 0 12px}label{display:inline-flex;flex-direction:column;gap:5px;margin:4px 12px 8px 0;font-weight:600;font-size:13px;color:#344c4c;vertical-align:bottom}
 input{min-height:40px;max-width:100%;padding:8px 10px;border:1px solid #aabebb;border-radius:7px;background:#fff;color:var(--ink);font:inherit}button{min-height:40px;margin:4px 8px 4px 0;padding:8px 14px;border:1px solid #aabebb;border-radius:7px;background:#fff;color:#173f3c;font:600 14px system-ui,sans-serif;cursor:pointer}button:hover{background:#eaf4f1}button:focus-visible,input:focus-visible{outline:3px solid #31a093;outline-offset:2px}button:disabled{opacity:.55;cursor:not-allowed}#discover,#login button{background:var(--accent);border-color:var(--accent);color:#fff}#discover:hover,#login button:hover{background:#0b514a}
 #account:not(:empty),#status:not(:empty),#auth-status:not(:empty){padding:10px 13px;border:1px solid #c8d5d2;border-radius:8px;background:#edf2f0;color:#243d3a;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace}
 .observed-board{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr));gap:12px;margin:16px 0 28px}.observed-column{border:1px solid var(--line);border-radius:10px;padding:12px;min-width:0;background:#eaf1ee}.observed-column h3{margin:0;color:#3b5654}.observed-card{border:1px solid #d3e0dc;border-radius:8px;margin-top:10px;padding:12px;min-width:0;background:#fff;box-shadow:0 2px 6px #173e350d}.observed-card>*{display:block;white-space:pre-wrap;overflow-wrap:anywhere;unicode-bidi:plaintext}.observed-card-title{font-weight:700;color:#173e3b;margin:5px 0}.observed-card span{font-size:12px;color:#455e5c}
 #theme-toggle{float:right;margin-top:0}
 html[data-theme="dark"]{color-scheme:dark;--ink:#e4efed;--muted:#b6c8c4;--line:#405954;--surface:#1d2b29;--accent:#367f72}
 html[data-theme="dark"] body{background:#111b1a;color:var(--ink)}html[data-theme="dark"] h1{color:#d7f0e9}html[data-theme="dark"] label{color:#ccded9}
 html[data-theme="dark"] input,html[data-theme="dark"] button{background:#223430;color:#e4efed;border-color:#526d66}html[data-theme="dark"] button:hover{background:#304b44}
 html[data-theme="dark"] #discover,html[data-theme="dark"] #login button{background:#367f72;border-color:#367f72;color:#fff}html[data-theme="dark"] #discover:hover,html[data-theme="dark"] #login button:hover{background:#286b5e}
 html[data-theme="dark"] #account:not(:empty),html[data-theme="dark"] #status:not(:empty),html[data-theme="dark"] #auth-status:not(:empty){background:#273b36;color:#e2efeb;border-color:#526d66}
 html[data-theme="dark"] .observed-column{background:#192724}html[data-theme="dark"] .observed-column h3{color:#c2d9d3}html[data-theme="dark"] .observed-card{background:#243632;border-color:#405954}html[data-theme="dark"] .observed-card-title{color:#e2f5ef}html[data-theme="dark"] .observed-card span{color:#c2d9d3}
 @media (max-width: 600px){body{padding:20px 16px 48px}form label{display:flex;margin-right:0}form input{width:100%}.observed-board{grid-template-columns:1fr}button{max-width:100%}}
 `;
 replace('<pre id="tasks"></pre>',`<style>${boardStyle}</style><h2>Observed candidates — advisory and possibly stale</h2><p>Every column is a partial, non-snapshot observation, not current state or authorization. An empty column does not mean no tasks exist.</p><section class="observed-board" aria-label="Advisory observed task candidates">${['ready','claimed','review','completed','unknown'].map(s=>`<section class="observed-column"><h3>${s==='unknown'?'Unknown observation':'Observed '+s}</h3><div id="column-${s}"></div></section>`).join('')}</section><pre hidden id="tasks"></pre><h2>Inspect task versions</h2><label>Task ID <input id="resolve-task" maxlength="36"></label><button type="button" id="resolve-start">Inspect from generation 0</button><button type="button" id="resolve-next">Continue inspection</button><p>Observed candidate is not current and does not authorize a write.</p><pre id="resolve-result"></pre>`);
 const start=html.indexOf('<script>')+8,end=html.indexOf('</script>',start);
 if(start<8||end<start)throw Error('Review UI template changed');
 let script=html.slice(start,end);
 const change=(from,to)=>{if(!script.includes(from))throw Error('Review UI template changed');script=script.replace(from,to);};
 change("prefix='weftline-guarded-intent-v2:'", "prefix='weftline-review-intent-v1:', legacyPrefix='weftline-guarded-intent-v2:'");
 change("if(!k.startsWith(prefix))continue;", "if(!k.startsWith(prefix)&&!k.startsWith(legacyPrefix))continue;");
 change("k!==prefix+d.intent.operation", "k!==(k.startsWith(prefix)?prefix:legacyPrefix)+d.intent.operation");
 change("event.key.startsWith(prefix)","(event.key.startsWith(prefix)||event.key.startsWith(legacyPrefix))");
 change("for(const t of r.value.tasks)el('tasks').textContent+=(reviewReadOnly?'Candidate (state unknown): ':'')+JSON.stringify(t)+'\\n';",`for(const t of r.value.tasks){const title=typeof t.title==='string'?t.title.replace(/[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029\\p{Bidi_Control}]/gu,' '):'unavailable',o=t.observed,valid=o&&typeof o==='object'&&!Array.isArray(o)&&Number.isSafeInteger(o.generation)&&o.generation>=0&&o.generation<=999999&&['ready','claimed','review','completed'].includes(o.state);const observation=valid?'Observed (not current): '+o.state+', generation '+o.generation:'No valid observation; state remains unknown',text='Task ID: '+t.task+'\\nTitle: '+title+'\\nState: unknown\\n'+observation+'\\n\\n';el('tasks').textContent+=text;const card=document.createElement('article'),identity=document.createElement('span'),label=document.createElement('strong'),details=document.createElement('span');card.className='observed-card';label.className='observed-card-title';identity.textContent='Task ID: '+t.task;label.textContent='Title: '+title;details.textContent='State: unknown\\n'+observation;card.append(identity,label,details);el('column-'+(valid?o.state:'unknown')).append(card);}`);
 change("el('tasks').textContent='';", "el('tasks').textContent='';for(const s of ['ready','claimed','review','completed','unknown'])el('column-'+s).textContent='';");
 change("if(!next)el('tasks').textContent='';", "if(!next){el('tasks').textContent='';for(const s of ['ready','claimed','review','completed','unknown'])el('column-'+s).textContent='';}");
 change("el('discover').onclick=()=>discover(false);", "function clearScan(){discoverySequence++;continuation=null;scanGuard=null;el('tasks').textContent='';for(const s of ['ready','claimed','review','completed','unknown'])el('column-'+s).textContent='';}function clearResolution(){resolutionToken=null;resolutionScope=null;resolutionSequence++;el('resolve-result').textContent='';}el('guard').oninput=()=>{clearScan();clearResolution();status('Guard changed; previous discovery and inspection cleared. Start again.');};el('resolve-task').oninput=()=>{clearResolution();status('Task changed; previous inspection cleared. Start inspection again.');};el('discover').onclick=()=>discover(false);");
 change("if(sequence!==discoverySequence)return;", "if(sequence!==discoverySequence)return;try{if(guard()!==candidate){clearScan();status('Guard changed; previous discovery cleared. Start discovery again.');return;}}catch{clearScan();status('Guard changed; previous discovery cleared. Start discovery again.');return;}");
 change("el('pending').textContent='';for(const name", "el('pending').textContent='';el('resolve-result').textContent='';el('resolve-task').value='';resolutionToken=null;resolutionScope=null;resolutionSequence++;for(const name");
 change("const status=s=>{el('status').textContent=s;};", "let resolutionToken=null,resolutionScope=null,resolutionSequence=0;const status=s=>{el('status').textContent=s;el('auth-status').textContent=s;};");
 const replaceFunction=(begin,endMarker,body)=>{const a=script.indexOf(begin),b=script.indexOf(endMarker,a);if(a<0||b<a)throw Error('Review UI template changed');script=script.slice(0,a)+body+'\n '+script.slice(b);};
 replaceFunction('async function confirm(ref,result)',"function clearAuthMarker",`const matchesReviewReceipt=${matchesReviewReceipt.toString()};
 async function confirm(ref,result){return performance.now()<result.deadline&&matchesReviewReceipt(ref.d.intent,result.status,result.value);}`);
 replaceFunction('async function mutate(kind)',"el('create').onsubmit",`async function mutate(action){if(!['genesis','claim','submit','reject','approve'].includes(action)||active)return;active=true;let ref,g=epoch;try{ready();await locked(async()=>{ready();if(g!==epoch||refs().length)throw Error();let intent;const base={board,expectedActor:actor,guardGeneration:guard(),operation:random()};if(action==='genesis'){const title=el('title').value;if(!title||title.trim()!==title||new TextEncoder().encode(title).length>256)throw Error();intent={...base,task:random(),taskGeneration:0,action,title};}else{const task=el('task').value,n=el('taskGeneration').value;if(!id(task)||!/^(0|[1-9][0-9]*)$/.test(n)||Number(n)>999998)throw Error();intent={...base,task,taskGeneration:Number(n),action};}if(intent.guardGeneration>=999998)throw Error();const kind=action==='genesis'?'genesis':'transition',key=prefix+intent.operation,raw=JSON.stringify({kind,intent});if(localStorage.getItem(key)!==null)throw Error();localStorage.setItem(key,raw);ref={key,raw,d:{kind,intent}};const all=refs();if(localStorage.getItem(key)!==raw||all.length!==1||all[0].key!==key||all[0].raw!==raw||g!==epoch||!storage())throw Error();showRefs();if(blocked||g!==epoch||localStorage.getItem(key)!==raw)throw Error();const result=await request(kind==='genesis'?'/review/genesis':'/review/transition',intent);if(g!==epoch||!await confirm(ref,result)||g!==epoch||performance.now()>=result.deadline)throw Error();remove(ref);showRefs();status('Matching historical receipt confirmed; current task existence is not proven. Update your guard candidate.');});}catch{if(g===epoch){status(ref?'Outcome unknown. Keep the saved intent and check its receipt; never retry blindly.':'Operation blocked before dispatch; verify identity, guard, and storage.');showRefs();}}finally{active=false;}}`);
 change("el('claim').onsubmit=e=>{e.preventDefault();mutate('transition');};", "el('claim').onsubmit=e=>{e.preventDefault();mutate(e.submitter?.value);};");
 replaceFunction("el('reconcile').onclick=", "addEventListener('storage'",`el('reconcile').onclick=async()=>{if(active)return;active=true;const g=epoch;try{ready();await locked(async()=>{ready();const all=refs();if(all.length!==1||!all[0].key.startsWith(prefix)||all[0].d.intent.expectedActor!==actor||all[0].d.intent.board!==board)throw Error();const ref=all[0],body={...ref.d.intent,currentGuardGeneration:guard()};const r=await request('/review/receipt',body);if(g!==epoch||!await confirm(ref,r)||g!==epoch||performance.now()>=r.deadline)throw Error();remove(ref);showRefs();status('Matching historical receipt confirmed; current task existence is not proven.');});}catch{if(g===epoch)status('Receipt unknown or denied. Preserve the intent; do not retry the write.');}finally{active=false;}};`);
 change("addEventListener('storage'",`async function resolveTask(next){const g=epoch,seq=++resolutionSequence;try{ready();const task=el('resolve-task').value,guardGeneration=guard(),expectedActor=actor,scope=JSON.stringify([expectedActor,guardGeneration,task]);if(!id(task)||(next&&(!resolutionToken||scope!==resolutionScope)))throw Error();if(!next){resolutionToken=null;resolutionScope=null;el('resolve-result').textContent='';}const r=await request('/review/resolve',{board,expectedActor,guardGeneration,task,...(next?{continuation:resolutionToken}:{})});if(g!==epoch||seq!==resolutionSequence||actor!==expectedActor||el('resolve-task').value!==task||guard()!==guardGeneration)return;if(performance.now()>=r.deadline||!r.value||r.value.consistency!=='advisory-non-snapshot'||typeof r.value.continuation!=='string'||r.value.continuation.length>1024)throw Error();if(r.status===202&&r.value.status==='unknown'){resolutionToken=r.value.continuation;resolutionScope=scope;status('Inspection unknown; retry the checkpoint.');return;}const v=r.value;if(r.status!==200||v.status!=='partial'||v.state!=='unknown'||v.actor!==expectedActor||v.board!==board||v.task!==task||!Object.keys(v).every(k=>['status','state','consistency','actor','board','task','observed','continuation'].includes(k)))throw Error();if(v.observed&&(!Number.isSafeInteger(v.observed.generation)||v.observed.generation<0||v.observed.generation>999999||!['ready','claimed','review','completed'].includes(v.observed.state)||(v.observed.claimant!==null&&!id(v.observed.claimant))))throw Error();resolutionToken=v.continuation;resolutionScope=scope;el('resolve-result').textContent=v.observed?'State unknown. Observed candidate, not current: '+JSON.stringify(v.observed):'No candidate observed; state unknown.';status('Inspection is advisory, not a snapshot. Continue or retry explicitly.');}catch{if(g===epoch&&seq===resolutionSequence)status('Inspection unavailable or unknown; do not infer absence.');}}el('resolve-start').onclick=()=>resolveTask(false);el('resolve-next').onclick=()=>resolveTask(true);
 addEventListener('storage'`);
 script+=`\ntry{let themeStorage;try{themeStorage=localStorage;}catch{}(${installReviewTheme.toString()})(document,themeStorage,typeof matchMedia==='function'?matchMedia('(prefers-color-scheme: dark)'):null);}catch{}`;
 html=html.slice(0,start)+script+html.slice(end);
 const hash=createHash('sha256').update(script).digest('base64');
 const styleHash=createHash('sha256').update(boardStyle).digest('base64');
 return {html,csp:`default-src 'none'; script-src 'sha256-${hash}'; style-src 'sha256-${styleHash}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`};
}
