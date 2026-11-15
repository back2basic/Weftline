import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transitionTask } from '../src/task.js';

test('a ready task can move into progress without modifying the original', () => {
  const task = { id: 'task-1', status: 'ready', held: false };
  assert.deepEqual(transitionTask(task, 'in_progress'), { ...task, status: 'in_progress' });
  assert.equal(task.status, 'ready');
});

test('a held task cannot move into progress', () => {
  assert.throws(() => transitionTask({ id: 'task-1', status: 'ready', held: true }, 'in_progress'), /held/);
});

test('a task cannot skip directly from ready to done', () => {
  assert.throws(() => transitionTask({ id: 'task-1', status: 'ready', held: false }, 'done'), /transition/);
});
