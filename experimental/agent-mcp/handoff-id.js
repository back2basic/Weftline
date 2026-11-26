import {createHash} from 'node:crypto';

// Convention only: neither attachment nor authorization is established here.
export function deriveHandoffIds(namespace, board, task, claimGeneration) {
 const id=x=>typeof x==='string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(x);
 if(!id(namespace)||!id(board)||!id(task)||!Number.isSafeInteger(claimGeneration)||claimGeneration<0||claimGeneration>999999)throw Error('invalid handoff input');
 const digest=tuple=>createHash('sha256').update(JSON.stringify(tuple),'utf8').digest('hex').slice(0,32);
 return {instructions:'i'+digest(['weftline-handoff-v1','instructions',namespace,board,task]),deliverable:'d'+digest(['weftline-handoff-v1','deliverable',namespace,board,task,claimGeneration])};
}
