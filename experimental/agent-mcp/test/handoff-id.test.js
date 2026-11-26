import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deriveHandoffIds} from '../handoff-id.js';

test('canonical handoff vectors and strict bounds',()=>{
 assert.deepEqual(deriveHandoffIds('backend-a','b','task',1),{instructions:'ib97943927bc4abdd6ce617cb990c44eb',deliverable:'d609284545c507211e0b2e1cf36cd922e'});
 assert.notEqual(deriveHandoffIds('backend-a','b','task',0).deliverable,deriveHandoffIds('backend-a','b','task',1).deliverable);
 assert.notEqual(deriveHandoffIds('backend-a','b','task',1).deliverable,deriveHandoffIds('backend-a','b','task2',1).deliverable);
 for(const args of [['','task',1],['b','a/b',1],['b','task\n',1],['b\n','task',1],['b','a'.repeat(37),1],['b','task',-1],['b','task',1000000],['b','task','1'],['b','task',1.1]])assert.throws(()=>deriveHandoffIds('backend-a',...args));
 for(const ns of ['', 'bad/', 'a'.repeat(37), null])assert.throws(()=>deriveHandoffIds(ns,'b','task',1));
 assert.doesNotThrow(()=>deriveHandoffIds('backend-a','b','a'.repeat(36),999999));
});
