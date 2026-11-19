function validHttpDate(value) {
  const obsolete = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (obsolete) {
    const [, weekday, day, month, shortYear, hour, minute, second] = obsolete;
    const cutoff = new Date(Date.now());
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() + 50);
    let year = Math.floor(cutoff.getUTCFullYear() / 100) * 100 + Number(shortYear);
    const monthIndex = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(month);
    let date = new Date(Date.UTC(year, monthIndex, Number(day), Number(hour), Number(minute), Number(second)));
    if (date > cutoff) {
      year -= 100;
      date = new Date(Date.UTC(year, monthIndex, Number(day), Number(hour), Number(minute), Number(second)));
    }
    const canonical = date.toUTCString();
    const [shortDay, number, parsedMonth, parsedYear, time] = canonical.replace(',', '').split(' ');
    const fullDay = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getUTCDay()];
    return weekday === fullDay && day === number && month === parsedMonth && String(year) === parsedYear && `${hour}:${minute}:${second}` === time;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const date = new Date(timestamp);
  const canonical = date.toUTCString();
  if (value === canonical) return true;
  const [day, number, month, year, time] = canonical.replace(',', '').split(' ');
  const fullDay = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getUTCDay()];
  return value === `${fullDay}, ${number}-${month}-${year.slice(-2)} ${time} GMT` ||
    value === `${day} ${month} ${number.startsWith('0') ? ' ' + number[1] : number} ${time} ${year}`;
}

async function readBounded(stream, limit, timeoutMs, signal) {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const deadline = performance.now() + timeoutMs;
  let timer, abortWait;
  try {
    if (signal.aborted) throw new Error('aborted');
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), timeoutMs); });
    const aborted = new Promise((_, reject) => {
      abortWait = () => reject(new Error('aborted'));
      signal.addEventListener('abort', abortWait, {once:true});
      if (signal.aborted) abortWait();
    });
    const chunks = []; let size = 0;
    for (;;) {
      const {value, done} = await Promise.race([reader.read(), timeout, aborted]);
      if (signal.aborted) throw new Error('aborted');
      if (performance.now() >= deadline) throw new Error('deadline');
      if (done) return Buffer.concat(chunks);
      size += value.byteLength;
      if (size > limit) throw new Error('too large');
      chunks.push(value);
    }
  } catch (error) {
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    throw error;
  } finally {
    clearTimeout(timer);
    if (abortWait) signal.removeEventListener('abort', abortWait);
  }
}

export function createClientAuth({origin, endpoint, project, approvedEndpoint, approvedProject, transport = fetch, parseLogin, parseLogout}) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid authority'); }
  if (typeof endpoint !== 'string' || endpoint !== approvedEndpoint || project !== approvedProject ||
      typeof project !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(project) || url.protocol !== 'https:' ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/v1' || url.href !== endpoint) throw new Error('Invalid authority');
  const originUrl = new URL(origin);
  if (originUrl.protocol !== 'https:' || originUrl.origin !== origin || originUrl.username || originUrl.password) throw new Error('Invalid origin');
  const sessionName = `a_session_${project}`;
  const unknownLogin = () => new Response('Sign-in outcome unknown; a provider session may exist. Do not retry blindly.', {status:502,headers:{'cache-control':'no-store'}});
  async function handle(request, state) {
    const requestOrigin = request.headers.get('origin');
    // Adapter must preserve the actual Host header, including duplicate values;
    // never synthesize it from the configured origin or forwarded headers.
    if (request.headers.get('host') !== originUrl.host) return new Response('Forbidden', {status:403});
    const isAccountGet = request.method === 'GET' && new URL(request.url).pathname === '/account';
    const fetchSite = request.headers.get('sec-fetch-site');
    if (new URL(request.url).origin !== origin || (isAccountGet ? (requestOrigin !== null && requestOrigin !== origin) || (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') : requestOrigin !== origin)) return new Response('Forbidden', {status:403});
    const path = new URL(request.url).pathname;
    let target, method, body, session;
    if (path === '/login' && request.method === 'POST') {
      // Do not overwrite an existing session reference, even if the cookie is
      // ambiguous or malformed. Other malformed Cookie headers also fail closed.
      const cookie = request.headers.get('cookie');
      if (cookie !== null) {
        const parts = cookie.split(';');
        const validPair = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*|"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*")$/;
        if (parts.some(part => {
          const pair = part.trim();
          return !validPair.test(pair) || pair.slice(0, pair.indexOf('=')) === '__Host-weftline';
        })) return new Response('Sign-in blocked; existing session state is not confirmed. Do not retry blindly.', {status:409});
      }
      target = '/account/sessions/email'; method = 'POST';
      let data;
      try {
        const bytes = await readBounded(request.body, 8192, 1000, request.signal);
        data = parseLogin ? parseLogin(bytes) : JSON.parse(bytes.toString('utf8'));
      } catch (error) {
        if (error.message === 'deadline') return new Response('Request timeout', {status:408});
        if (error.message === 'too large') return new Response('Too large', {status:413});
        return new Response('Invalid login', {status:400});
      }
      if (!data || typeof data.email !== 'string' || !data.email || typeof data.password !== 'string' || !data.password) return new Response('Invalid login', {status:400});
      body = JSON.stringify({email:data.email, password:data.password});
    } else if ((path === '/account' && request.method === 'GET') || (path === '/logout' && request.method === 'POST')) {
      const matches = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith('__Host-weftline='));
      const value = matches.length === 1 ? matches[0].slice('__Host-weftline='.length) : '';
      if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(value)) return new Response('Authentication required', {status:401});
      session = value;
      target = path === '/account' ? '/account' : '/account/sessions/current';
      method = path === '/account' ? 'GET' : 'DELETE';
      if (path === '/logout') {
        if (parseLogout) {
          try { parseLogout(await readBounded(request.body, 4096, 1000, request.signal)); }
          catch { return new Response('Invalid logout', {status:400}); }
        } else {
          try { if (request.body && !request.body.locked) Promise.resolve(request.body.cancel()).catch(() => {}); } catch {}
        }
      }
    } else return new Response('Not found', {status:404});
    const headers = {'x-appwrite-project':project};
    if (body) headers['content-type'] = 'application/json';
    if (session) headers.cookie = `${sessionName}=${session}`;
    let upstream;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, request.signal]);
    if (signal.aborted) return new Response('Authentication unavailable', {status:502});
    let headerTimer, abortWait, expired = false;
    const deadline = performance.now() + 10000;
    try {
      const request = Promise.resolve().then(() => { signal.throwIfAborted(); state.dispatched = true; return transport(endpoint + target, {method,headers,body,redirect:'error',signal}); }).then(response => {
        if (expired || signal.aborted || performance.now() >= deadline) {
          try { if (response.body && !response.body.locked) Promise.resolve(response.body.cancel()).catch(() => {}); } catch {}
          throw new Error('deadline');
        }
        return response;
      });
      const timeout = new Promise((_, reject) => { headerTimer = setTimeout(() => { expired = true; controller.abort(); reject(new Error('deadline')); }, 10000); });
      const aborted = new Promise((_, reject) => {
        abortWait = () => reject(new Error('aborted'));
        signal.addEventListener('abort', abortWait, {once:true});
        if (signal.aborted) abortWait();
      });
      upstream = await Promise.race([request, timeout, aborted]);
    } catch { controller.abort(); return path === '/login' && state.dispatched ? unknownLogin() : new Response('Authentication unavailable', {status:502,headers:{'cache-control':'no-store'}}); }
    finally { clearTimeout(headerTimer); signal.removeEventListener('abort', abortWait); }
    try {
    if (path === '/login' && !upstream.ok) {
      const result = unknownLogin();
      // A response does not prove that the provider did not create a session.
      // Forward only validated guidance; retain the indeterminate outcome.
      for (const name of ['retry-after','x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset']) {
        const value = upstream.headers.get(name);
        if (value && (/^[0-9]{1,16}$/.test(value) || (name === 'retry-after' && validHttpDate(value)))) result.headers.set(name, value);
      }
      return result;
    }
    if (upstream.status >= 300 && upstream.status < 400) return new Response('Authentication unavailable', {status:502,headers:{'cache-control':'no-store'}});
    if (path === '/login' && upstream.ok) {
      const cookies = upstream.headers.getSetCookie().filter(value => value.startsWith(sessionName + '='));
      if (cookies.length !== 1) return unknownLogin();
      const value = cookies[0].slice(sessionName.length + 1).split(';')[0];
      if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(value)) return unknownLogin();
      return new Response(null, {status:upstream.status,headers:{'set-cookie':`__Host-weftline=${value}; Path=/; Secure; HttpOnly; SameSite=Strict`}});
    }
    if (path === '/logout' && upstream.ok) return new Response(null, {status:204,headers:{'set-cookie':'__Host-weftline=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict'}});
    if (path === '/account' && upstream.ok) {
      if (upstream.status === 204 || upstream.status === 205) return new Response(null, {status:upstream.status});
      return new Response(await readBounded(upstream.body, 65536, 1000, signal), {status:upstream.status,headers:{'content-type':'application/json'}});
    }
    const errorHeaders = {'cache-control':'no-store'};
    for (const name of ['retry-after','x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset']) {
      const value = upstream.headers.get(name);
      if (value && (/^[0-9]{1,16}$/.test(value) || (name === 'retry-after' && validHttpDate(value)))) errorHeaders[name] = value;
    }
    return new Response('Authentication failed', {status:upstream.status,headers:errorHeaders});
    } finally {
      try { if (upstream.body && !upstream.body.locked) Promise.resolve(upstream.body.cancel()).catch(() => {}); } catch {}
      controller.abort();
    }
  }
  return async request => {
    let response;
    const state = {dispatched:false};
    try { response = await handle(request, state); }
    catch { response = state.dispatched && new URL(request.url).pathname === '/login' ? unknownLogin() : new Response('Authentication unavailable', {status:502}); }
    finally {
      try { if (request.body && !request.body.locked) Promise.resolve(request.body.cancel()).catch(() => {}); } catch {}
    }
    response.headers.set('cache-control','no-store');
    return response;
  };
}
