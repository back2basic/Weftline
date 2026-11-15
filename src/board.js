export function createBoardHandler({ origin, appwrite }) {
  return async request => {
    if (request.method !== 'GET' && request.headers.get('origin') !== origin) {
      return new Response('Forbidden', { status: 403 });
    }
    const path = new URL(request.url).pathname;
    if (path === '/board/login' && request.method === 'GET') {
      return new Response('<!doctype html><title>Sign in unavailable</title><h1>Sign in unavailable</h1>', {headers:{'Content-Type':'text/html; charset=utf-8'}});
    }
    if (path === '/board/login' && request.method === 'POST') {
      return new Response('Login unavailable', {status:503});
    }
    const match = request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-weftline=([A-Za-z0-9._~-]+)/);
    if (!match) return new Response('Authentication required', { status: 401 });
    if (path === '/board/logout' && request.method === 'POST') {
      let result;
      try { result = await appwrite('/account/sessions/current', {session:match[1],method:'DELETE'}); }
      catch { return new Response('Logout could not be confirmed', {status:503}); }
      if (!result.ok) return new Response('Logout could not be confirmed', {status:503});
      return new Response(null, {status:303,headers:{Location:'/board/login','Set-Cookie':'__Host-weftline=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict'}});
    }
    if (path === '/board' && request.method === 'GET') {
      const result = await appwrite('/tablesdb/weftline-dev-v1/tables/human-tasks-v1/rows', {session:match[1]});
      if (!result.ok) return new Response('Authentication required', {status:401});
      const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const columns = [['ready','Ready'], ['in_progress','In progress'], ['review','Review'], ['blocked','Blocked'], ['done','Done']];
      let sections = columns.map(([status, label]) => {
        const rows = result.data.rows.filter(row => row.status === status);
        return `<section aria-labelledby="${status}"><h2 id="${status}">${label}</h2>${rows.length ? `<ul>${rows.map(row => `<li>${escape(row.title)}</li>`).join('')}</ul>` : '<p>No tasks</p>'}</section>`;
      }).join('');
      const unexpected = result.data.rows.filter(row => !columns.some(([status]) => status === row.status));
      if (unexpected.length) {
        sections += `<section aria-labelledby="unexpected"><h2 id="unexpected">Unexpected status</h2><ul>${unexpected.map(row => `<li>${escape(row.title)} — ${escape(row.status ?? 'Missing status')}</li>`).join('')}</ul></section>`;
      }
      return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Private tasks</title><style>body{font-family:system-ui,sans-serif;margin:2rem}.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:1rem}section{background:#f2f2f2;padding:1rem}ul{list-style:none;padding:0}li{background:white;padding:.75rem;margin:.5rem 0;overflow-wrap:anywhere}form{margin:1rem 0}</style></head><body><main><h1>Private tasks</h1><p>Only the first page is shown; additional tasks may not be displayed.</p><div class="board">${sections}</div><form action="/board/logout" method="post"><button>Sign out</button></form><form action="/board/tasks" method="post"><label>New task <input name="title" maxlength="200" required></label><button>Add task</button></form></main></body></html>`, {headers:{'Content-Type':'text/html; charset=utf-8'}});
    }
    if (path === '/board/tasks' && request.method === 'POST') {
      const form = await request.formData();
      const title = form.get('title');
      if (typeof title !== 'string' || !title.trim() || title.length > 200) return new Response('Invalid title', {status:400});
      const result = await appwrite('/tablesdb/weftline-dev-v1/tables/human-tasks-v1/rows', {session:match[1],method:'POST',body:{rowId:'unique()',data:{title:title.trim(),status:'ready'}}});
      if (!result.ok) return new Response('Could not create task', {status:403});
      return new Response(null, {status:303,headers:{Location:'/board'}});
    }
    return new Response('Not found', {status:404});
  };
}
