import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function startServer(t, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 5000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Listening on (?:0\.0\.0\.0|127\.0\.0\.1):(\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited before listening: ${code}`)); });
  });
  return { child, url: `http://127.0.0.1:${port}`, output };
}

test('landing page communicates the private, unavailable board honestly', async t => {
  const { url } = await startServer(t);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Weftline/);
  assert.match(html, /href="\/board\/login"/);
  assert.match(html, /authentication.*not.*available/i);
  assert.match(html, /no task data/i);
  assert.match(html, /login and task data access are currently disabled even when configured/i);
  assert.match(html, /shared boards are not implemented/i);
  assert.doesNotMatch(html, /personal task creation and listing can be configured/i);
  assert.match(html, /agent execution.*not.*available/i);
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
});

test('write requests to public routes are rejected explicitly', async t => {
  const { url } = await startServer(t);
  for (const path of ['/', '/health']) {
    const res = await fetch(`${url}${path}`, { method: 'POST', body: 'private task data' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
  }
});

test('unrecognized private and filesystem routes reveal no content and are not cached', async t => {
  const { url } = await startServer(t);
  for (const path of ['/api/tasks', '/.env', '/src/task.js', '/%2e%2e/package.json']) {
    const res = await fetch(`${url}${path}`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('server exits on SIGTERM', async t => {
  const { child } = await startServer(t);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, 'SIGTERM');
});

test('health endpoint reports service availability', async t => {
  const { url } = await startServer(t);
  const res = await fetch(`${url}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});


test('board is unavailable without explicit Appwrite and HTTPS origin configuration', async t => {
  const {url} = await startServer(t);
  const r = await fetch(`${url}/board`);
  assert.equal(r.status,503);
  assert.doesNotMatch(await r.text(), /secret|api.key/i);
});


test('development server binds loopback by default', async t => {
  const {output} = await startServer(t);
  assert.match(output, /Listening on 127\.0\.0\.1:/);
});


test('configured login page does not expose the server key', async t => {
  const secret = 'server-only-test-key';
  const {url} = await startServer(t, {BOARD_ORIGIN:'https://board.example',APPWRITE_ENDPOINT:'https://appwrite.example/v1',APPWRITE_PROJECT:'6afa1a52001753a01f2a',APPWRITE_API_KEY:secret});
  const r = await fetch(`${url}/board/login`);
  assert.equal(r.status,200);
  assert.doesNotMatch(await r.text(),new RegExp(secret));
});

test('server can bind an explicitly configured proxy-facing address', async t => {
 const {output}=await startServer(t,{HOST:'0.0.0.0'});
 assert.match(output,/Listening on 0\.0\.0\.0:/);
});

test('configured board data remains unavailable while authentication protection is unverified', async t => {
 const {url}=await startServer(t,{BOARD_ORIGIN:'https://board.example',APPWRITE_ENDPOINT:'https://appwrite.example/v1',APPWRITE_PROJECT:'6afa1a52001753a01f2a',APPWRITE_API_KEY:'test-only'});
 const r=await fetch(`${url}/board`,{headers:{cookie:'__Host-weftline=opaque-session'}});
 assert.equal(r.status,503);
});
