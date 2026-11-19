// UNWIRED experiment only. A trusted server lookup must authenticate the exact
// session and return active membership and the board's exclusive team. A lookup
// followed by a write does NOT make revocation atomic; do not expose this path.
import {checkSignal} from './abort-signal.js';
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(value);

export async function createSharedTask(input, dependencies) {
  const result = await createSharedTaskOutcome(input, dependencies);
  if (!result.allowed) throw new Error('Access denied');
  return result.value;
}

// A false result is produced only by this local pre-writer branch. Exceptions
// are never classified: once the writer starts its outcome may be unknown.
export async function createSharedTaskOutcome(input, {lookupMembership, createRow}) {
  const fields = ['session','boardId','title'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Reflect.ownKeys(input).some(key => !fields.includes(key) && key !== 'signal') ||
      fields.some(key => !Object.hasOwn(input, key))) throw new Error('Invalid request');
  const {session, boardId, title: rawTitle} = input;
  const signal = Object.hasOwn(input, 'signal') ? input.signal : undefined;
  if (typeof session !== 'string' || !session || !id(boardId) ||
      typeof rawTitle !== 'string' || !rawTitle.trim() || rawTitle.length > 200) throw new Error('Invalid request');
  checkSignal(signal);
  const title = rawTitle.trim();
  const membership = await lookupMembership({session, boardId, ...(signal ? {signal} : {})});
  checkSignal(signal);
  if (!membership) return {allowed:false};
  const {active, boardId: memberBoardId, userId, teamId} = membership;
  if (active !== true || memberBoardId !== boardId ||
      !id(userId) || !id(teamId)) return {allowed:false};
  checkSignal(signal);
  const value = createRow({
    data: {boardId, title, status:'ready', createdBy:userId},
    permissions: [`read("team:${teamId}")`],
    ...(signal ? {signal} : {}),
  });
  return {allowed:true,value};
}
