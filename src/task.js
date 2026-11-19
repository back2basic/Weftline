const transitions = {
  ready: ['in_progress', 'blocked'],
  in_progress: ['review', 'blocked'],
  review: ['done', 'in_progress', 'blocked'],
  blocked: ['ready'],
  done: [],
};

export function transitionTask(task, status) {
  if (task.held && status === 'in_progress') {
    throw new Error('Cannot start a held task');
  }
  if (!Object.hasOwn(transitions, task.status) || !transitions[task.status].includes(status)) {
    throw new Error('Invalid task transition');
  }
  return { ...task, status };
}
