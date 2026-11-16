// UNWIRED experiment only. A trusted server lookup must authenticate the exact
// session and return active membership and the board's exclusive team. A lookup
// followed by a write does NOT make revocation atomic; do not expose this path.
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(value);

export async function createSharedTask(input, {lookupMembership, createRow}) {
  const fields = ['session','boardId','title'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Reflect.ownKeys(input).some(key => !fields.includes(key)) ||
      fields.some(key => !Object.hasOwn(input, key))) throw new Error('Invalid request');
  const {session, boardId, title: rawTitle} = input;
  if (typeof session !== 'string' || !session || !id(boardId) ||
      typeof rawTitle !== 'string' || !rawTitle.trim() || rawTitle.length > 200) throw new Error('Invalid request');
  const title = rawTitle.trim();
  const membership = await lookupMembership({session, boardId});
  if (!membership) throw new Error('Access denied');
  const {active, boardId: memberBoardId, userId, teamId} = membership;
  if (active !== true || memberBoardId !== boardId ||
      !id(userId) || !id(teamId)) throw new Error('Access denied');
  return createRow({
    data: {boardId, title, status:'ready', createdBy:userId},
    permissions: [`read("team:${teamId}")`],
  });
}
