// Development verification using installed Chrome, with an isolated profile.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const url = process.env.FOX_BROWSER_URL || 'http://127.0.0.1:5173';
const profile = await mkdtemp(join(tmpdir(), 'foxwq-web-chrome-'));
const chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, url
], { stdio: 'ignore' });
let startupError; chrome.on('error', error => { startupError = error; });
let ws, serial = 0;
const pending = new Map(), browserErrors = [];
try {
  let port;
  for (let i = 0; i < 100; i++) {
    if (startupError) throw startupError;
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await pause(100); }
  }
  if (!port) throw Error('Chrome debugging port unavailable');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.method === 'Runtime.exceptionThrown') browserErrors.push(m.params.exceptionDetails.text);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP ${method} timed out`)); }, 20000);
    pending.set(id, m => { clearTimeout(timer); m.error ? reject(Error(m.error.message)) : resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const js = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 200; i++) { if (await js(expression)) return; await pause(100); }
    throw Error(`Browser condition timed out: ${expression}`);
  };
  await call('Runtime.enable');
  await wait("document.getElementById('local')?.onclick != null");
  await js("document.getElementById('local').click()");
  await js("(()=>{const b=document.getElementById('board'),r=b.getBoundingClientRect();b.dispatchEvent(new MouseEvent('click',{clientX:r.left+172*r.width/840,clientY:r.top+172*r.height/840,bubbles:true}));})()");
  await wait("document.getElementById('turn').textContent.includes('Move 2')");
  await js("document.getElementById('pass').click();document.getElementById('pass').click()");
  await wait("!document.getElementById('score').hidden");
  await js("document.getElementById('score').click()");
  await wait("document.getElementById('turn').textContent==='B+353.5'");
  const sgf = await js(`(async()=>{
    let saved='';const create=URL.createObjectURL;URL.createObjectURL=blob=>{saved=blob;return create(blob);};
    document.getElementById('save-sgf').click();URL.createObjectURL=create;return saved.text();
  })()`);
  assert.match(sgf, /RE\[B\+353.5\]/); assert.match(sgf, /;B\[dd\];W\[\];B\[\]/);
  console.log('Browser checks passed: board click, passing, scoring, local SGF download');
  if (process.argv.includes('--live')) {
    const [username, password] = (await readFile('creds','utf8')).trimEnd().split(/\r?\n/);
    const token = (await readFile('proxy/.dev.vars','utf8')).match(/PROXY_TOKEN="?([A-Za-z0-9_-]+)/)[1];
    await js(`document.getElementById('username').value=${JSON.stringify(username)};document.getElementById('password').value=${JSON.stringify(password)};document.getElementById('proxy-token').value=${JSON.stringify(token)};document.getElementById('login-form').requestSubmit()`);
    await wait("['ready','error'].includes(document.getElementById('mode').textContent)");
    assert.equal(await js("document.getElementById('mode').textContent"), 'ready', await js("document.getElementById('status').textContent"));
    assert.equal(await js("document.getElementById('password').value"), '');
    assert.equal(await js("document.getElementById('match').disabled"), false);
    await js("document.getElementById('disconnect').click();document.getElementById('proxy-token').value='';document.getElementById('username').value=''");
    console.log('Browser live login through Cloudflare proxy and normal-match availability verified');
  }
  assert.deepEqual(browserErrors, []);
} finally {
  ws?.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => { if (chrome.exitCode !== null) resolve(); else { chrome.once('exit', resolve); setTimeout(() => { chrome.kill('SIGKILL'); resolve(); }, 3000).unref(); } });
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
