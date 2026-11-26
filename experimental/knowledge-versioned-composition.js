// Local composition only. This is deliberately not mounted by the server.
// Table separation does not establish ACLs, exclusive writers, or provider isolation.
import {snap,id} from './knowledge-versioned-schema.js';
import {createSharedKnowledgeTransport} from './knowledge-transport.js';
import {createAppwriteVersionedKnowledge,createAppwriteScopedVersionedKnowledge} from './knowledge-versioned-edit.js';
import {createAppwriteVersionedRead} from './knowledge-versioned-read.js';
import {createAppwriteVersionedDiscovery} from './knowledge-versioned-discovery.js';
import {createAppwriteVersionedResolution} from './knowledge-versioned-resolution.js';

export function createVersionedKnowledgeComposition(options={}) {
 const c=snap(options,['enabled','scopedWrite','endpoint','approvedEndpoint','project','database','table','legacyDatabase','legacyTable','boardDatabase','boardTable','boardId','teamId','key','maxPayloadBytes','transport','deadlineMs'],false);
 if(c.enabled===undefined || c.enabled===false) return null;
 if(c.enabled!==true || (c.scopedWrite!==undefined && typeof c.scopedWrite!=='boolean') || ![c.database,c.table,c.legacyDatabase,c.legacyTable,c.boardDatabase,c.boardTable,c.project,c.boardId,c.teamId].every(id) ||
    (c.database===c.legacyDatabase && c.table===c.legacyTable) ||
    (c.database===c.boardDatabase && c.table===c.boardTable) ||
    !Number.isSafeInteger(c.maxPayloadBytes) || c.maxPayloadBytes<1 || c.maxPayloadBytes>1024 ||
    (c.deadlineMs!==undefined && (!Number.isSafeInteger(c.deadlineMs)||c.deadlineMs<1||c.deadlineMs>30000)) ||
    typeof c.transport!=='function') throw Error('invalid configuration');
 let endpoint;try{endpoint=new URL(c.endpoint);}catch{throw Error('invalid configuration');}
 if(c.endpoint!==c.approvedEndpoint||endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/v1'||endpoint.href!==c.endpoint)throw Error('invalid configuration');
 if(typeof c.key!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(c.key))throw Error('invalid configuration');
 const config={enabled:true,endpoint:c.endpoint,approvedEndpoint:c.approvedEndpoint,project:c.project,database:c.database,table:c.table,legacyTable:c.legacyTable,legacyDatabase:c.legacyDatabase,boardId:c.boardId,teamId:c.teamId,key:c.key,maxPayloadBytes:c.maxPayloadBytes,transport:c.transport,...(c.deadlineMs===undefined?{}:{deadlineMs:c.deadlineMs})};
 const gate=createSharedKnowledgeTransport(c.transport);
 const write=createAppwriteVersionedKnowledge(config,gate), read=createAppwriteVersionedRead(config,gate), discovery=createAppwriteVersionedDiscovery(config,gate), resolution=createAppwriteVersionedResolution(config,gate);
 const scoped=c.scopedWrite?createAppwriteScopedVersionedKnowledge(config,gate):null;
 return Object.freeze({create:write.create,edit:write.edit,reconcile:write.reconcile,...(scoped?{createScoped:scoped.create,editScoped:scoped.edit,reconcileScoped:scoped.reconcile}:{}),read:read.read,readScoped:read.readScoped,list:discovery.list,resolve:resolution.resolve});
}
