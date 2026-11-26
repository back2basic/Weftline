// Test-only fetch router: board fixture in-process; version fixture over loopback.
// It accepts only the reserved synthetic authority and never falls through to it.
if(process.env.VERSIONED_FIXTURE_PORT!==undefined){
const socketFetch = globalThis.fetch;
await import('../../experimental/agent-mcp/test/write-provider.js');
const boardFetch = globalThis.fetch;
const port = Number(process.env.VERSIONED_FIXTURE_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid fixture port');
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url);
  if (u.origin !== 'https://provider.example.test' || !u.pathname.startsWith('/v1/')) throw Error('forbidden synthetic authority');
  if (u.pathname.startsWith('/v1/teams/') || u.pathname.startsWith('/v1/tablesdb/db/tables/versions/')) {
    const headers = new Headers(options.headers);
    if (headers.has('x-appwrite-project')) headers.set('x-appwrite-project', 'project');
    if (headers.has('x-appwrite-key')) headers.set('x-appwrite-key', 'synthetic-key');
    if (headers.has('cookie')) headers.set('cookie', headers.get('cookie').replace('a_session_synthetic-project=', 'a_session_project='));
    return socketFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, {...options, headers});
  }
  return boardFetch(url, options);
};
}
