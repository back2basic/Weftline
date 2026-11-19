// Experimental local composition; runtime, global fetch, independently supplied
// authority approvals and Appwrite data are trusted.
import {types} from 'node:util';
import {appwriteStore} from './appwrite-store.js';
import {createGuardedReceiver} from './guarded-transition-receiver.js';

const fields=new Set(['enabled','endpoint','project','approvedEndpoint','approvedProject','key','database','table','timeoutMs']);
export function validateGuardedAuthority(actualEndpoint,actualProject,approvedEndpoint,approvedProject) {
  if (typeof actualEndpoint!=='string' || actualEndpoint!==approvedEndpoint || actualProject!==approvedProject || typeof actualProject!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(actualProject)) throw Error('Invalid authority');
  let url;
  try {url=new URL(actualEndpoint);} catch {throw Error('Invalid authority');}
  if (url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/v1' || url.href!==actualEndpoint) throw Error('Invalid authority');
}
export function createGuardedAppwriteStore(options={}) {
  if (!options || typeof options!=='object' || types.isProxy(options) || Object.getPrototypeOf(options)!==Object.prototype) throw Error('Invalid configuration');
  const c=Object.create(null);
  for (const name of Reflect.ownKeys(options)) {
    if (typeof name!=='string' || !fields.has(name)) throw Error('Invalid configuration');
    const descriptor=Object.getOwnPropertyDescriptor(options,name);
    if (!descriptor || !Object.hasOwn(descriptor,'value')) throw Error('Invalid configuration');
    c[name]=descriptor.value;
  }
  if(c.enabled!==true) return null;
  validateGuardedAuthority(c.endpoint,c.project,c.approvedEndpoint,c.approvedProject);
  return appwriteStore({endpoint:c.endpoint,project:c.project,key:c.key,database:c.database,table:c.table,fetchImpl:globalThis.fetch,timeoutMs:c.timeoutMs});
}
export function createGuardedAppwriteReceiver(options={}) {
  const store=createGuardedAppwriteStore(options);
  const timeoutMs=Object.getOwnPropertyDescriptor(options,'timeoutMs')?.value;
  return store ? createGuardedReceiver({enabled:true,store,timeoutMs}) : createGuardedReceiver();
}
