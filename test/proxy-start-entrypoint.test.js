import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

test('npm start rejects invalid proxy receiver configuration instead of starting the default server', async () => {
  const child = spawn('npm', ['start'], {
    cwd: new URL('..', import.meta.url), detached: true,
    env: {...process.env, HOST:'127.0.0.1', PORT:'0', WEFTLINE_REVIEW_PROXY:'1', WEFTLINE_PROXY_SECRET:''},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => output += data);
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} resolve({timeout:true}); }, 2500);
    child.once('exit', code => { clearTimeout(timer); try { process.kill(-child.pid, 'SIGKILL'); } catch {} resolve({code}); });
  });
  assert.equal(result.timeout, undefined, `invalid proxy config started a listener: ${output}`);
  assert.notEqual(result.code, 0);
  assert.match(output, /invalid configuration/i);
});
