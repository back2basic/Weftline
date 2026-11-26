// Local single-host journal. A trusted, private directory and filesystem are required.
// A stale lock is never removed automatically; reconcile it manually offline.
// The caller must bind scope to the actual receiver's backend, not merely the local listener.
// Loss of both marker and record (including full directory loss) is indistinguishable
// from a fresh journal; independent durable inventory is needed to detect it.
import {constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, fstatSync, lstatSync, mkdirSync, rmdirSync, renameSync, existsSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {types} from 'node:util';
import {parseGuardedJson} from '../guarded-strict-json.js';

const fields=['board','expectedActor','guardGeneration','operation','task','taskGeneration','action'];
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
export function snapshot(value, keys) {
 if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('invalid');
 const d=Object.getOwnPropertyDescriptors(value),all=Reflect.ownKeys(d);
 if(all.length!==keys.length||keys.some(k=>!Object.hasOwn(d,k)||!Object.hasOwn(d[k],'value')||!d[k].enumerable))throw Error('invalid');
 return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
function intentSnapshot(value) {
 const x=snapshot(value,fields);
 if(![x.board,x.expectedActor,x.operation,x.task].every(id)||!['claim','submit','approve','reject'].includes(x.action)||!Number.isSafeInteger(x.guardGeneration)||x.guardGeneration<0||x.guardGeneration>=999998||!Number.isSafeInteger(x.taskGeneration)||x.taskGeneration<0||x.taskGeneration>=999999)throw Error('invalid');
 return x;
}
function exactReceipt(result,intent) {
 try {
  const x=snapshot(result,['code','status','receipt']);
  if(![200,201].includes(x.code)||x.status!=='recorded')return false;
  const r=snapshot(x.receipt,['kind',...fields,'user']);
  return r.kind==='review-receipt-v1'&&r.user===intent.expectedActor&&fields.every(k=>r[k]===intent[k]);
 } catch {return false;}
}
function checkDir(path) {
 const s=lstatSync(path);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)throw Error('unsafe journal directory');
}
function syncDir(path) {const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function load(path) {
 let fd;
 try {fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 try {
  const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.nlink!==1||s.size>4096)throw Error('unsafe record');
  const record=snapshot(parseGuardedJson(readFileSync(fd)),['version','status','intent']);
  if(record.version!==1||!['empty','pending','reconciled'].includes(record.status))throw Error('invalid record');
  if(record.status==='empty'){if(record.intent!==null)throw Error('invalid record');}else record.intent=intentSnapshot(record.intent);return record;
 } finally {closeSync(fd);}
}
function store(dir,record) {
 const tmp=join(dir,'intent.next'),target=join(dir,'intent.json');
 const fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try {writeFileSync(fd,JSON.stringify(record));fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(tmp,target);syncDir(dir);
}
export function createJournal(dir, backendScope) {
 if(typeof dir!=='string'||!isAbsolute(dir))throw Error('invalid journal directory');
 const scope=snapshot(backendScope,['endpoint','project','database','table']);
 if(typeof scope.endpoint!=='string'||scope.endpoint.length>1024||/[\u0000-\u0020\u007f]/.test(scope.endpoint)||![scope.project,scope.database,scope.table].every(id))throw Error('invalid backend scope');
 let endpoint;try {endpoint=new URL(scope.endpoint);}catch {throw Error('invalid backend scope');}
 if(!['https:','http:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw Error('invalid backend scope');
 checkDir(dir);
 const file=join(dir,'intent.json'),lock=join(dir,'intent.lock'),marker=join(dir,'journal.marker');
 function locked(fn) {
  checkDir(dir);
  try {mkdirSync(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')return {status:'blocked'};throw e;}
  // Any error while holding the lock leaves it behind: recovery is manual.
  syncDir(dir);
  if(!existsSync(marker)) {
   if(existsSync(file)||existsSync(join(dir,'intent.next')))throw Error('uninitialized journal contains records');
   const fd=openSync(marker,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try {writeFileSync(fd,JSON.stringify({version:1,scope}));fsyncSync(fd);}finally{closeSync(fd);}
   syncDir(dir);
   store(dir,{version:1,status:'empty',intent:null});
  } else {
   const fd=openSync(marker,constants.O_RDONLY|constants.O_NOFOLLOW);
   try {
    const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.nlink!==1||s.size>4096)throw Error('invalid marker');
    const saved=snapshot(parseGuardedJson(readFileSync(fd)),['version','scope']);
    const savedScope=snapshot(saved.scope,['endpoint','project','database','table']);
    if(saved.version!==1||Object.keys(scope).some(k=>scope[k]!==savedScope[k]))throw Error('journal scope mismatch');
   }finally{closeSync(fd);}
  }
  const result=fn();
  rmdirSync(lock);syncDir(dir);
  return result;
 }
 return Object.freeze({
  inspect() {
   return locked(()=>{const record=load(file);return !record?{status:'unknown'}:record.status==='empty'?{status:'empty'}:{status:record.status,intent:record.intent};});
  },
  begin(value) {
   const intent=intentSnapshot(value);
   return locked(()=>{const old=load(file);if(!old)return {status:'unknown'};if(old.status==='pending')return {status:'blocked'};store(dir,{version:1,status:'pending',intent});return {status:'pending'};});
  },
  reconcile(result) {
   return locked(()=>{const old=load(file);if(!old||old.status!=='pending')return {status:'blocked'};if(!exactReceipt(result,old.intent))return {status:'unknown'};store(dir,{...old,status:'reconciled'});return {status:'reconciled'};});
  }
 });
}
