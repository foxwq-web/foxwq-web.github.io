import type { ChildProcess } from 'node:child_process';
import type { ViteDevServer, PreviewServer } from 'vite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer as createPortServer } from 'node:net';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, build, preview } from 'vite';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { CDPSession } from 'playwright';
import assert from 'node:assert/strict';
import { DEV_SCREENS } from '../src/dev-screens.ts';

if (!process.env.FOX_BROWSER_URL) {
  const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
  const args = process.argv.slice(2);
  const production = args.includes('--score-production') || args.includes('--production-shortcuts') || args.includes('--history');
  async function availablePort() {
    const socket = createPortServer();
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.listen(0, '127.0.0.1', () => resolve());
    });
    const address = socket.address();
    assert.ok(address && typeof address !== 'string');
    const { port } = address;
    await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    return port;
  }

  let server: ViteDevServer | PreviewServer | undefined;
  let child: ChildProcess | undefined;
  let cache: string | undefined;
  const interrupt = () => child?.kill('SIGINT');
  const terminate = () => child?.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const port = await availablePort();
    if (production) {
      await build({ configFile });
      server = await preview({ configFile, preview: { host: '127.0.0.1', port, strictPort: true } });
    } else {
      cache = await mkdtemp(join(tmpdir(), 'foxwq-web-vite-'));
      server = await createServer({ configFile, cacheDir: cache,
        server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null } });
      await server.listen();
    }
    assert.ok(server.httpServer);
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), ...args], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, FOX_BROWSER_URL: url }, stdio: 'inherit'
    });
    const runningChild = child;
    process.exitCode = await new Promise<number>((resolve, reject) => {
      runningChild.once('error', reject);
      runningChild.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    if (server) await server.close();
    if (cache) await rm(cache, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
}

if (process.argv.includes('--history')) {
  await import('./history-browser-check.ts');
  process.exit(0);
}

if (process.argv.includes('--network-log')) {
  await import('./network-log-browser-check.ts');
  process.exit(0);
}

if (process.argv.includes('--player-info')) {
  await import('./player-info-browser-check.ts');
  process.exit(0);
}

if (process.argv.includes('--replay-captures')) {
  await import('./replay-captures-browser-check.ts');
  process.exit(0);
}

if (process.argv.includes('--score-engines') || process.argv.includes('--score-production')) {
  await import('../../score-estimator/scripts/score-engine-browser-check.ts');
  process.exit(0);
}
await import('./network-log-browser-check.ts');
await import('./history-browser-check.ts');
if (!process.argv.includes('--production-shortcuts')) await import('./replay-captures-browser-check.ts');
if (!process.argv.includes('--production-shortcuts')) await import('./clock-sizing-browser-check.ts');

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const url = process.env.FOX_BROWSER_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const browserErrors: string[] = [];
let websocketCount = 0;
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  const cdp = await context.newCDPSession(page);
  cdp.on('Network.webSocketCreated', ({ url: socketURL }) => {
    const socket = new URL(socketURL);

    if (!(socket.host === new URL(url).host && socket.searchParams.has('token'))) websocketCount++;
  });
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    browserErrors.push(exceptionDetails.exception?.description || exceptionDetails.text);
  });
  const call: CDPSession['send'] = async (method, params) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        cdp.send(method, params),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`CDP ${method} timed out`)), 20000); })
      ]);
    } finally { clearTimeout(timer); }
  };
  const js = async <T = any>(expression: string): Promise<T> => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async (expression: string) => {
    // Playwright retries in the new execution context when navigation replaces the page.
    const result = await page.waitForFunction(expression, undefined, { polling: 100, timeout: 20000 });
    await result.dispose();
  };
  const clickControl = async (selector: string) => {
    const { x, y } = await js(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    await call('Input.dispatchMouseEvent', {type:'mousePressed',x,y,button:'left',clickCount:1});
    await call('Input.dispatchMouseEvent', {type:'mouseReleased',x,y,button:'left',clickCount:1});
  };
  const assertEscapeIgnored = async () => {
    const focusBefore = await js('document.activeElement.id');
    await js(`window.menuOpenChanges=0;window.menuObserver=new MutationObserver(records=>window.menuOpenChanges+=records.length);window.menuObserver.observe(document.getElementById('connection-layer'),{attributes:true,attributeFilter:['hidden']})`);
    for (let i=0;i<3;i++) {
      await call('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await call('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    }
    await pause(300);
    assert.equal(await js("!document.getElementById('connection-layer').hidden"), true);
    assert.equal(await js('window.menuOpenChanges'), 0);
    assert.equal(await js('document.activeElement.id'), focusBefore);
    await js('window.menuObserver.disconnect()');
  };
  await call('Runtime.enable');
  await call('Network.enable');
  const audioLifecycle = await page.evaluate(async () => {
    const { FoxSounds } = await import(`${'/src'}/sound.ts`) as typeof import('../src/sound.ts');
    const sounds = new FoxSounds();
    sounds.preload(); sounds.unlock(); sounds.play('stone');
    const beforeGame = sounds.context === null;
    sounds.setActive(true);
    await sounds.loading;
    const first = sounds.context!;
    const decoded = sounds.buffers.size === sounds.names.length;
    sounds.play('start-play');
    sounds.setActive(false);
    // close() releases the device asynchronously, after stopping playback.
    await new Promise<void>(resolve => first.addEventListener('statechange', () => {
      if (first.state === 'closed') resolve();
    }));
    sounds.unlock(); sounds.play('stone');
    const afterGame = sounds.context === null && first.state === 'closed';
    sounds.setActive(true);
    await sounds.loading;
    const nextGame = sounds.context !== first && sounds.buffers.size === sounds.names.length;
    const second = sounds.context!;
    sounds.setActive(false);
    await new Promise<void>(resolve => second.addEventListener('statechange', () => {
      if (second.state === 'closed') resolve();
    }));
    return { beforeGame, decoded, afterGame, nextGame };
  });
  assert.deepEqual(audioLifecycle, { beforeGame: true, decoded: true, afterGame: true, nextGame: true });
  console.log('Browser audio lifecycle passed: no pregame context, decoded game sounds, closed postgame context, and a fresh next game');
  await wait("typeof window.downloadNetworkLog === 'function'");
  await js('document.activeElement?.blur()');
  await page.keyboard.press('f');
  await wait('document.fullscreenElement === document.documentElement');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'f', repeat:true, bubbles:true}))`);
  assert.equal(await js('document.fullscreenElement === document.documentElement'), true);
  await page.keyboard.press('Shift+F');
  await wait('document.fullscreenElement === null');
  for (const attributes of ['type="text"', 'contenteditable="true"']) {
    await js(`(() => {
      const field = document.createElement(${JSON.stringify(attributes.startsWith('type') ? 'input' : 'div')});
      field.id = 'fullscreen-typing-check';
      field.setAttribute(...${JSON.stringify(attributes.startsWith('type') ? ['type', 'text'] : ['contenteditable', 'true'])});
      document.body.append(field); field.focus();
    })()`);
    await page.keyboard.press('f');
    assert.equal(await js('document.fullscreenElement'), null);
    await js("document.getElementById('fullscreen-typing-check').remove()");
  }
  await page.keyboard.press('Control+f');
  assert.equal(await js('document.fullscreenElement'), null);
  console.log('Browser fullscreen passed: F toggles, typing, repeat, and modifier guards');
  await js(`(async()=>{
    const {IndexedDBNetworkLogStore}=await import('/src/network-log-store.ts');
    const store=new IndexedDBNetworkLogStore(indexedDB);
    store.put({key:'2020-01-01T00:00:00.000Z:fixture:0000000000000000',entry:{
      timestamp:'2020-01-01T00:00:00.000Z',source:'client:fixture:1',destination:'fox.example:10000',payload:'AQ=='
    }});
    await store.flush();
  })()`);
  await js('window.networkReloadMarker=true');
  await call('Page.reload');
  await wait("!window.networkReloadMarker && typeof window.downloadNetworkLog === 'function'");
  const consoleLog = await js(`(async()=>{
    let saved; const create = URL.createObjectURL;
    URL.createObjectURL = blob => {saved = blob; return create(blob);};
    try { await downloadNetworkLog(); } finally { URL.createObjectURL = create; }
    return saved.text();
  })()`);
  assert.deepEqual(JSON.parse(consoleLog), [{
    timestamp:'2020-01-01T00:00:00.000Z', source:'client:fixture:1', destination:'fox.example:10000', payload:'AQ=='
  }]);
  await js('window.networkReloadMarker=true');
  await call('Page.reload');
  await wait("!window.networkReloadMarker && typeof window.downloadNetworkLog === 'function'");
  assert.equal(await js(`(async()=>{
    const {IndexedDBNetworkLogStore}=await import('/src/network-log-store.ts');
    return (await new IndexedDBNetworkLogStore(indexedDB).read()).length;
  })()`), 1);
  await js(`new Promise((resolve,reject)=>{
    const request=indexedDB.open('fox-network-log',1);
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result,tx=db.transaction(['entries','metadata'],'readwrite');
      tx.objectStore('entries').clear();tx.objectStore('metadata').clear();
      tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);
    };
  })`);
  console.log('Browser network log passed: async console download, retention across reloads');

  for (const screen of ['matchmaking', 'board-black', 'unknown']) {
    const shortcut = new URL(url); shortcut.searchParams.set('dev-screen', screen);
    await js('window.shortcutPageMarker=true');
    await call('Page.navigate', { url: shortcut.href });
    await wait("!window.shortcutPageMarker && document.getElementById('pass') != null");
    assert.deepEqual(browserErrors, []);
    if (process.argv.includes('--production-shortcuts') || screen === 'unknown') {
      assert.equal(await js("document.getElementById('menu-title').textContent"), 'Foxwq-web');
      assert.equal(await js("document.getElementById('login-form').hidden"), false);
      assert.equal(await js("document.querySelector('main').inert"), true);
      const remembered = await js("document.getElementById('remember').checked");
      await clickControl('#remember');
      assert.equal(await js("document.getElementById('remember').checked"), !remembered);
      await clickControl('.remember');
      assert.equal(await js("document.getElementById('remember').checked"), remembered);
    } else if (screen === 'matchmaking') {
      assert.equal(await js("document.getElementById('matchmaking').hidden"), false);
      assert.equal(await js("document.getElementById('login-form')"), null);
      assert.equal(await js("document.querySelectorAll('.time-option').length"), 4);
      assert.equal(await js("document.getElementById('match').disabled"), false);
      assert.equal(await js("document.querySelector('.field-population').textContent"), '(128 players)');
      await clickControl('#time-controls input[value="2"]');
      assert.equal(await js("document.querySelector('#time-controls input:checked').value"), '2');
      await clickControl('.time-option:nth-child(3) > span');
      assert.equal(await js("document.querySelector('#time-controls input:checked').value"), '3');
      assert.equal(await js("document.getElementById('match-summary')"), null);
      assert.equal(await js("document.getElementById('disconnect')"), null);
      assert.equal(await js("document.getElementById('menu-title').textContent"), 'Matchmaking');
      assert.equal(await js("document.getElementById('match').textContent"), 'Play');
    } else {
      assert.equal(await js("document.getElementById('connection-layer').hidden"), true);
      assert.equal(await js("document.querySelector('main').inert"), false);
      assert.equal(await js("document.querySelector('#black-time time').dateTime"), 'PT425S');
      await js("document.getElementById('pass').click()");
      assert.equal(await js("document.getElementById('pass').disabled"), true);
    }
    await js('window.shortcutPageMarker=true');
    await call('Page.reload');
    await wait("!window.shortcutPageMarker && document.getElementById('pass') != null");
    assert.equal(await js("document.getElementById('connection-layer').hidden"), !process.argv.includes('--production-shortcuts') && screen === 'board-black');
  }


  const production = process.argv.includes('--production-shortcuts');
  for (const fixture of DEV_SCREENS) {
    const target = new URL(url); target.searchParams.set('dev-screen', fixture.id);
    await js('window.previewPageMarker=true');
    await call('Page.navigate', { url: target.href });
    await wait("!window.previewPageMarker && document.getElementById('pass') != null");
    if (production) {
      assert.equal(await js("document.getElementById('menu-title').textContent"), 'Foxwq-web');
      assert.equal(await js("document.getElementById('dev-screens')"), null);
      assert.equal(await js("document.getElementById('dev-menu')"), null);
      assert.equal(await js("document.getElementById('replay-file')"), null);
      continue;
    }
    await wait("document.getElementById('dev-menu-toggle') != null");
    const before = await js("['black','white'].map(name=>{const el=document.getElementById(name+'-time');return el.querySelector('input')?.value ?? el.textContent})");
    const connectionStatus = {
      connecting: 'Connecting...',
      authenticating: 'Waiting for login response...',
      bootstrap: 'Fetching server list...',
      gateway: 'Connecting to gateway...',
      joining: 'Joining the game...',
    }[fixture.id];
    if (connectionStatus) {
      assert.equal(await js("document.getElementById('status').textContent"), connectionStatus, fixture.id);
    }
    assert.equal(await js("document.getElementById('dev-menu-toggle').textContent"), 'Dev menu');
    if (fixture.id === 'login') {
      await js("document.getElementById('dev-menu').open=true");
      assert.equal(await js("document.querySelectorAll('#dev-screen-tools li a').length"), DEV_SCREENS.length);
      assert.equal(await js("document.getElementById('save-network-log').checkVisibility() && typeof window.downloadNetworkLog === 'function'"), true);
      await js("document.getElementById('dev-menu').open=false");
    }
    assert.equal(await js("document.getElementById('dev-screens')"), null, fixture.id);
    assert.equal(await js("document.querySelector('fieldset')"), null, fixture.id);
    if (fixture.playerName) {
      await wait(`document.querySelector(${JSON.stringify(fixture.playerName)})?.getAttribute('aria-expanded') === 'true' && document.querySelectorAll('.player-info-games tbody tr').length === 10`);
      const expectedName = fixture.id === 'board-white-player-info' ? 'White' : 'Black';
      assert.equal(await js("document.querySelector('.player-info').getAttribute('aria-label')"), `${expectedName} player information`, fixture.id);
      assert.equal(await js("document.querySelectorAll('.player-info').length"), 1, fixture.id);
      await page.keyboard.press('Escape');
      await wait("document.querySelector('.player-info') === null");
    }
    if (fixture.id === 'matchmaking') {
      assert.equal(await js("document.getElementById('time-controls').getAttribute('role')"), 'radiogroup');
      assert.equal(await js("document.getElementById('time-controls').getAttribute('aria-label')"), 'Time control');
      for (const width of [1280, 390, 320]) {
        await call('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:false});
        assert.equal(await js(`[...document.querySelectorAll('.time-option')].every(label=>{
          const title=label.querySelector('span > span'), population=label.querySelector('.field-population');
          const a=title.getBoundingClientRect(), b=population.getBoundingClientRect();
          return Math.abs(a.top-b.top)<1 && Math.abs(b.left-a.right-4)<1 && label.scrollWidth<=label.clientWidth;
        })`), true, `Inline time controls at ${width}px`);
      }
      await call('Emulation.clearDeviceMetricsOverride');
    }
    assert.equal(await js("[...document.querySelectorAll('a')].some(a => a.textContent.includes('All offline previews'))"), false, fixture.id);
    if (['board-black','board-white','byoyomi'].includes(fixture.id)) {
      assert.equal(await js("document.querySelectorAll('time.clock-display').length"), 2);
      assert.equal(await js("document.querySelectorAll('#hours').length"), 1);
      const color = fixture.id === 'board-white' ? 'white' : 'black';
      assert.equal(await js(`document.getElementById('hours').closest('dd').id`), `${color}-time`);
      assert.equal(await js("document.querySelector('input[type=time], #popularHours')"), null);
      if (fixture.id === 'byoyomi') assert.equal(await js("document.getElementById('hours').dateTime"), 'PT9S');
    }
    const inBoard = ['playing','finished'].includes(fixture.phase);
    if (inBoard) {
      assert.equal(await js(`[...document.querySelectorAll('.player-panel, .quest-panel')].every(panel=>{
        const style=getComputedStyle(panel);
        return ['Top','Right','Bottom','Left'].every(side=>style['border'+side+'Width']==='1px' && style['border'+side+'Style']==='solid');
      })`), true, fixture.id);
    }
    const countingDialog = ['counting-request','counting-result'].includes(fixture.id);
    assert.equal(await js("document.getElementById('connection-layer').hidden"), inBoard, fixture.id);
    if (!inBoard) {
      await call('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      await call('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      await js("document.getElementById('connection-menu').focus()");
      assert.equal(await js("document.activeElement.id"), 'connection-menu', fixture.id);
      assert.equal(await js("getComputedStyle(document.activeElement).outlineStyle"), 'none', fixture.id);
    }
    if (fixture.id === 'joining') {
      assert.equal(await js("document.getElementById('status').parentElement.id"), 'match');
      assert.equal(await js("document.getElementById('match').textContent"), await js("document.getElementById('status').textContent"));
      await call('Emulation.setDeviceMetricsOverride', {width:1280,height:900,deviceScaleFactor:1,mobile:false});
      const before = await js("document.getElementById('connection-menu').getBoundingClientRect().toJSON()");
      await js("window.joiningStatus=document.getElementById('status').textContent;document.getElementById('status').textContent='Joining a room and waiting for the game environment to finish loading... Additional information about the connection appears here.'");
      const after = await js("document.getElementById('connection-menu').getBoundingClientRect().toJSON()");
      assert.deepEqual([after.x,after.y,after.width], [before.x,before.y,before.width]);
      assert.ok(after.height > before.height);
      await js("document.getElementById('status').textContent=window.joiningStatus");
    }
    assert.equal(await js("document.getElementById('counting-dialog').open"), countingDialog, fixture.id);
    assert.equal(await js("document.getElementById('game-downloads').hidden"), fixture.phase !== 'finished', fixture.id);
    assert.equal(await page.locator('#game-review').isVisible(), fixture.phase === 'finished', fixture.id);
    if (fixture.id === 'room-left') {
      assert.equal(await page.locator('#primary-actions').isVisible(), true);
      assert.equal(await page.locator('#board .stone').count(), 0);
      assert.equal(await page.locator('#board polygon').count(), 0);
      assert.equal(await page.locator('#game-state-panel').isVisible(), false);
      assert.equal(await page.locator('.clock-display').count(), 0);
    }
    if (fixture.phase === 'finished') {
      const result = {finished:'B+2.5', 'finished-resign':'W+R', 'finished-void':'Void', 'room-left':'W+R', 'replay-variation':'W+R'}[fixture.id];
      assert.equal(await js("document.getElementById('game-state-title').textContent"), 'Game over', fixture.id);
      assert.equal(await js("[...document.querySelectorAll('#game-state-panel > p:not(#game-state-title)')].filter(p=>p.getClientRects().length).map(p=>p.textContent).join('|')"), `Result: ${result}`, fixture.id);
      assert.equal(await js("document.getElementById('counting-dialog').open"), false, fixture.id);
      assert.equal(await page.locator('#estimate-score').isEnabled(), true, fixture.id);
      assert.equal(await js("['pass','request-score','resign'].every(id=>{const button=document.getElementById(id);return button.checkVisibility() && button.disabled;})"), true, fixture.id);
    }
    if (fixture.phase === 'finished' && fixture.id !== 'room-left') {
      assert.equal(await page.locator('.player-panel.to-play').count(), 0, fixture.id);
      assert.equal(await js("[...document.querySelectorAll('.clock-display')].every(clock=>getComputedStyle(clock).color === 'rgb(153, 153, 153)')"), true, fixture.id);
    }
    if (fixture.id === 'finished') {
      const finalStones = await page.locator('#board .board-stones').innerHTML();
      assert.equal(await page.locator('#game-state-panel #game-review').count(), 0);
      assert.equal(await page.locator('.review-position').count(), 0);
      assert.equal(await page.locator('#game-review button svg').count(), 4);
      await page.getByRole('button', { name: 'First move', exact: true }).click();
      assert.equal(await page.locator('#board .stone').count(), 0);
      assert.equal(await page.locator('#review-previous').isDisabled(), true);
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#board .stone').count(), 1);
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator('#board .stone').count(), 0);
      await page.locator('#review-next').click();
      assert.equal(await page.locator('#board .stone').count(), 1);
      await page.locator('#estimate-score').click();
      await wait("!document.getElementById('estimation-lead').hidden");
      assert.equal(await page.locator('#board .stone').count(), 1);
      assert.ok(await page.locator('.estimated-territory rect').count() > 0);
      await page.locator('#estimate-score').click();
      assert.equal(await page.locator('.estimated-territory rect').count(), 0);
      assert.equal(await page.locator('#board .stone').count(), 1);
      await page.locator('#estimate-score').click();
      await wait("!document.getElementById('estimation-lead').hidden");
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator('#board .stone').count(), 1);
      assert.equal(await page.locator('#review-previous').isDisabled(), true);
      assert.ok(await page.locator('.estimated-territory rect').count() > 0);
      await page.locator('#estimate-score').click();
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator('#board .stone').count(), 0);
      assert.equal(await page.locator('.estimated-territory rect').count(), 0);
      assert.equal(await page.locator('#estimation-panel').isVisible(), false);
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator('#board .stone').count(), 0);
      await page.locator('#review-last').click();
      assert.equal(await page.locator('#board .board-stones').innerHTML(), finalStones);
      assert.equal(await page.locator('#review-next').isDisabled(), true);
      const record = await js(`(async()=>{
        let saved,filename;const create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;
        URL.createObjectURL=blob=>{saved=blob;return create(blob);};
        HTMLAnchorElement.prototype.click=function(){filename=this.download;};
        document.getElementById('save-sgf').click();URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;
        return {contents:await saved.text(),filename};
      })()`);
      assert.match(record.contents, /PB\[Black\]PW\[White\]/);
      assert.match(record.filename, /^Black-White-\d{8}T\d{4}\.sgf$/);
    }
    if (inBoard) assert.deepEqual(await js("['black','white'].map(name=>document.getElementById(name+'-player-name').textContent)"),
      ['Black (9p)','White (9p)'], fixture.id);
    if (['playing', 'finished'].includes(fixture.phase)) {
      const geometry = await js<{ id: string; x: number; y: number; width: number; height: number; sidebarWidth: number; boxed: boolean; visible: boolean }[]>(`(() => {
        const bar = document.querySelector('aside').getBoundingClientRect();
        return [...document.querySelectorAll('#primary-actions > button, #resign')].map(button => {
          const r = button.getBoundingClientRect();
          return {id:button.id, x:r.x-bar.x, y:r.y, width:r.width, height:r.height,
            sidebarWidth:bar.width, boxed:!!button.closest('fieldset,.quest-panel'), visible:!!button.getClientRects().length};
        });
      })()`);
      assert.deepEqual(geometry.map(b => b.id), ['pass','request-score','resign','estimate-score'], fixture.id);
      for (const [i, button] of geometry.entries()) {
        assert.equal(button.visible, true, fixture.id);
        assert.equal(button.boxed, false, fixture.id);
        assert.equal(button.x, 0, fixture.id);
        assert.equal(button.width, button.sidebarWidth - (button.id === 'resign' && fixture.id === 'resign-confirm' ? 40 : 0), fixture.id);
        assert.equal(button.height, geometry[0].height, fixture.id);
        if (i) assert.equal(button.y, geometry[i-1].y + button.height + 8, fixture.id);
      }
      assert.equal(await js("document.querySelector('#counting-dialog:modal')"), null, fixture.id);
      assert.equal(await js("document.getElementById('menu')"), null, fixture.id);
      assert.equal(await js("[...document.querySelectorAll('#sidebar-quests > *')].filter(p=>p.getClientRects().length).every(p=>p.getBoundingClientRect().top >= document.getElementById('primary-actions').getBoundingClientRect().bottom)"), true, fixture.id);
    }
    assert.equal(await js("document.getElementById('action-panel').hidden"), true, fixture.id);
    if (fixture.id === 'opponent-turn') {
      for (const id of ['pass', 'request-score']) {
        assert.equal(await js(`document.getElementById('${id}').disabled`), true);
        await js(`document.getElementById('${id}').click()`);
        assert.equal(await js("document.getElementById('action-panel').hidden"), true);
      }
      console.log('Browser opponent-turn checks passed: Pass and Request counting disabled without prompts');
    }
    if (fixture.id === 'resign-confirm') {
      assert.equal(await js("document.getElementById('resign').textContent"), 'Confirm Resignation');
      assert.equal(await js("['pass','request-score','estimate-score'].every(id=>document.getElementById(id).disabled)"), true);
      assert.equal(await js("document.getElementById('resign').disabled"), false);
      assert.equal(await js("document.getElementById('resign-cancel').hidden"), false);
      assert.equal(await js("(()=>{const r=document.getElementById('resign-cancel').getBoundingClientRect();return r.width===r.height})()"), true);
      await js("document.getElementById('resign-cancel').click()");
      assert.equal(await js("document.getElementById('resign').textContent"), 'Resign');
      assert.equal(await js("document.getElementById('resign-cancel').hidden"), true);
      await js("document.getElementById('resign').click()");
    }
    if (fixture.id === 'counting-waiting') {
      assert.equal(await js("document.getElementById('request-score').textContent"), 'Request Counting');
      assert.equal(await js("document.getElementById('request-score').disabled"), true);
      assert.equal(await js("document.getElementById('board-status').checkVisibility()"), true);
      assert.equal(await js("document.getElementById('board-status').textContent"), 'Waiting for opponent...');
    }
    if (fixture.id === 'counting-accepted') {
      assert.equal(await js("document.getElementById('board-status').checkVisibility()"), true);
      assert.equal(await js("document.getElementById('board-status').textContent"), 'Waiting for counting result...');
    }
    if (process.env.FOX_BROWSER_SCREENSHOTS && ['matchmaking','board-black','counting-request','counting-result','score-estimation','finished','resign-confirm'].includes(fixture.id)) {
      await mkdir(process.env.FOX_BROWSER_SCREENSHOTS, {recursive:true});
      await call('Emulation.setDeviceMetricsOverride', {width:1280,height:900,deviceScaleFactor:1,mobile:false});
      const { data } = await call('Page.captureScreenshot', {captureBeyondViewport:true});
      await writeFile(join(process.env.FOX_BROWSER_SCREENSHOTS, `${fixture.id}.png`), Buffer.from(data, 'base64'));
      await call('Emulation.clearDeviceMetricsOverride');
    }

    assert.equal(await js("document.getElementById('estimation-panel').hidden"), !fixture.id.startsWith('score-estimation') || fixture.id === 'score-estimation-loading', fixture.id);
    if (fixture.id === 'score-estimation') {
      const spacing = await js(`(() => {
        const panel = document.getElementById('estimation-panel');
        const text = document.getElementById('estimation-lead');
        const box = panel.getBoundingClientRect(), content = text.getBoundingClientRect();
        const style = getComputedStyle(text);
        return {marginTop:style.marginTop, marginBottom:style.marginBottom,
          alignment:style.textAlign, top:content.top-box.top-parseFloat(getComputedStyle(panel).borderTopWidth), bottom:box.bottom-content.bottom-parseFloat(getComputedStyle(panel).borderBottomWidth)};
      })()`);
      assert.equal(spacing.marginTop, '0px', fixture.id);
      assert.equal(spacing.marginBottom, '0px', fixture.id);
      assert.equal(spacing.alignment, 'left', fixture.id);
      assert.equal(spacing.top, spacing.bottom, fixture.id);
    }
    if (fixture.id === 'counting-request') {
      assert.equal(await js("document.getElementById('estimate-score').disabled"), false);
      assert.equal(await js("document.getElementById('resign').disabled"), false);
      await js("document.getElementById('estimate-score').click()");
      await wait("!document.getElementById('estimation-lead').hidden");
      assert.equal(await js("document.getElementById('counting-dialog').open"), true);
      await js("document.getElementById('estimate-score').click()");
      await wait("document.getElementById('estimation-panel').hidden");
      assert.equal(await js("document.getElementById('counting-dialog').open"), true);
      await js("document.getElementById('resign').click()");
      await wait("!document.getElementById('resign-cancel').hidden");
      assert.equal(await js("document.getElementById('counting-accept').disabled"), true);
      await js("document.getElementById('resign-cancel').click()");
      assert.equal(await js("document.getElementById('counting-accept').disabled"), false);
    }
    if (fixture.id === 'login') {
      const cookies = await js('document.cookie');
      await js("document.getElementById('username').value='offline';document.getElementById('password').value='offline';document.getElementById('remember').checked=true;document.getElementById('login-form').requestSubmit()");
      assert.match(await js("document.getElementById('status').textContent"), /Offline preview/);
      assert.equal(await js('document.cookie'), cookies);
    }
    await js('window.previewPageMarker=true');
    await call('Page.reload');
    await wait("!window.previewPageMarker && document.getElementById('pass') != null");
    assert.deepEqual(await js("['black','white'].map(name=>{const el=document.getElementById(name+'-time');return el.querySelector('input')?.value ?? el.textContent})"), before, fixture.id);
  }
  const index = new URL(url); index.searchParams.set('dev-screen', 'all');
  await js('window.previewPageMarker=true');
  await call('Page.navigate', { url: index.href });
  await wait("!window.previewPageMarker && document.getElementById('pass') != null");
  if (!production) {
    await wait("document.querySelector('#dev-screens li') != null");
    assert.equal(await js("document.querySelectorAll('#dev-screens li').length"), DEV_SCREENS.length);
  }
  if (!production) {
    const target = new URL(url); target.searchParams.set('dev-screen', 'score-estimation');
    await js('window.previewPageMarker=true');
    await call('Page.navigate', { url: target.href });
    await wait("!window.previewPageMarker && document.getElementById('pass') != null");
    assert.ok(await js("document.querySelectorAll('.territory-black').length") > 0);
    assert.ok(await js("document.querySelectorAll('.territory-white').length") > 0);
    assert.equal(await js("[...document.querySelectorAll('.board-stones .stone')].every(stone=>getComputedStyle(stone).opacity==='1')"), true);
    assert.match(await js("document.getElementById('estimation-lead').textContent"), /(?:Black|White) leads|Even/);
    assert.equal(await js("['pass','request-score','resign'].every(id=>document.getElementById(id).disabled)"), true);
    assert.equal(await js("document.getElementById('estimate-score').disabled"), false);
    assert.equal(await js("document.getElementById('estimate-score').textContent"), 'Return to Game');
    assert.equal(await js("[...document.getElementById('estimation-panel').children].filter(el=>el.getClientRects().length).map(el=>el.id).join(',')"), 'estimation-lead');
    assert.ok(await js("document.querySelector('#board polygon') != null"));
    const position = await js("document.querySelector('#board').innerHTML");
    await js("document.getElementById('estimate-score').click()");
    await wait("document.getElementById('estimation-panel').hidden");
    assert.equal(await js("document.querySelectorAll('.estimated-territory rect').length"), 0);
    assert.equal(await js("document.getElementById('pass').disabled"), false);
    assert.ok(await js("document.querySelector('#board polygon') != null"));
    await js("document.getElementById('estimate-score').click()");
    await wait("!document.getElementById('estimation-lead').hidden");
    assert.equal(await js("document.querySelector('#board').innerHTML"), position, 'Estimate round trip must restore identical markers and stones');

    await js("document.getElementById('estimate-score').click()");
    await js(`(async()=>{
      const source=await (await fetch('/src/controller.ts')).text();
      const sessionPath=source.match(/from ["']([^"']*session[.]ts[^"']*)["']/)[1];
      const {Session}=await import(sessionPath);
      const estimate=Session.prototype.estimateScore;
      Session.prototype.estimateScore=function(){
        Session.prototype.estimateScore=estimate;
        const fetch=this.estimationFetcher;
        this.estimationFetcher=async()=>({ret:109045});
        const done=estimate.call(this);this.estimationFetcher=fetch;return done;
      };
    })()`);
    await js("document.getElementById('estimate-score').click()");
    await wait("document.getElementById('estimation-status').textContent.includes('109045')");
    await js("document.getElementById('estimation-retry').click()");
    await wait("!document.getElementById('estimation-lead').hidden");
    assert.ok(await js("document.querySelectorAll('.estimated-territory rect').length") > 0);
  }
  assert.equal(websocketCount, 0, 'Offline previews must never open an application WebSocket');
  console.log(`Browser offline previews passed: ${DEV_SCREENS.length} states, reloads, index, production gating`);
  assert.deepEqual(browserErrors, []);
  await js("document.cookie='foxwq_time_control=; Max-Age=0; Path=/'");
  console.log(process.argv.includes('--production-shortcuts')
    ? 'Browser production checks passed: development URL shortcuts are ignored'
    : 'Browser URL shortcuts passed: matchmaking preview, Fox game, reload, unknown values');
  if (!process.argv.includes('--production-shortcuts') && !process.argv.includes('--previews-only')) {
  await js('window.shortcutPageMarker=true');
  await call('Page.navigate', { url });
  await wait("!window.shortcutPageMarker && document.getElementById('pass') != null");
  assert.equal(await js("!document.getElementById('connection-layer').hidden"), true);
  assert.equal(await js("document.getElementById('board').tabIndex"), -1);
  await js("document.getElementById('board').dispatchEvent(new MouseEvent('click', {bubbles:true}))");
  assert.equal(await js("document.getElementById('game-state-panel').hidden"), true);
  assert.equal(await js("document.getElementById('connection-menu').tagName"), 'DIV');
  assert.notEqual(await js("getComputedStyle(document.getElementById('connection-layer')).backdropFilter"), 'none');
  assert.notEqual(await js("getComputedStyle(document.getElementById('connection-menu')).backgroundColor"), 'rgba(0, 0, 0, 0)');
  assert.equal(await js("document.querySelector('main').inert"), true);
  assert.equal(await js("document.getElementById('login').disabled"), true);
  await js("document.getElementById('login-form').requestSubmit()");
  assert.equal(await js("document.getElementById('status').hidden"), true);
  await js(`window.setLoginField = (id, value) => {
    const input = document.getElementById(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles:true}));
  }; setLoginField('username', 'test');`);
  assert.equal(await js("document.getElementById('login').disabled"), true);
  await js("setLoginField('password', 'test')");
  assert.equal(await js("document.getElementById('login').disabled"), false);
  await js("setLoginField('username', '')");
  assert.equal(await js("document.getElementById('login').disabled"), true);
  await js("setLoginField('username', 'test');setLoginField('password', '')");
  assert.equal(await js("document.getElementById('login').disabled"), true);
  await js("setLoginField('username', '');document.getElementById('remember').focus()");
  await page.keyboard.press('Tab');
  assert.equal(await js('document.activeElement.textContent'), 'Sign up');
  await page.keyboard.press('Tab');
  assert.equal(await js('document.activeElement.id'), 'dev-menu-toggle');
  await page.keyboard.press('Tab');
  assert.equal(await js('document.activeElement.id'), 'github-source');
  await page.keyboard.press('Tab');
  assert.equal(await js('document.activeElement.id'), 'fox-server');
  await page.keyboard.press('Tab');
  assert.equal(await js('document.activeElement.id'), 'username');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await js('document.activeElement.id'), 'fox-server');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await js('document.activeElement.id'), 'github-source');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await js('document.activeElement.id'), 'dev-menu-toggle');
  await assertEscapeIgnored();
  await call('Input.dispatchMouseEvent', {type:'mousePressed',x:2,y:2,button:'left',clickCount:1});
  await call('Input.dispatchMouseEvent', {type:'mouseReleased',x:2,y:2,button:'left',clickCount:1});
  await assertEscapeIgnored();
  await js("document.getElementById('username').focus()");
  await js("document.getElementById('connection-menu').dispatchEvent(new Event('cancel',{cancelable:true}))");
  assert.equal(await js("!document.getElementById('connection-layer').hidden"), true);
  await js(`(async()=>{const {rememberCredentials}=await import('/src/credentials.ts');rememberCredentials('test;name','p=ss & word',true)})()`);
  await js('window.checkPageMarker=true');
  await call('Page.reload');
  await wait("!window.checkPageMarker && document.getElementById('pass') != null");
  assert.equal(await js("document.getElementById('username').value"), 'test;name');
  assert.equal(await js("document.getElementById('password').value"), 'p=ss & word');
  assert.equal(await js("document.getElementById('remember').checked"), true);
  await js("document.getElementById('remember').click()");
  assert.equal(await js("document.cookie.includes('foxwq_credentials=')"), false);
  await js(`document.cookie='foxwq_credentials=invalid; Max-Age=2592000; Path=/'`);
  assert.equal(await js(`(async()=>{const {rememberedCredentials}=await import('/src/credentials.ts');return rememberedCredentials()})()`), null);
  assert.equal((await context.cookies()).some(cookie => cookie.name === 'foxwq_credentials'), false, 'Malformed credentials must be deleted from cookie storage');
  await js(`(async()=>{
    const {rememberCredentials}=await import('/src/credentials.ts');
    rememberCredentials('expiring-user','expiring-password',true);
    const cookie=document.cookie.split('; ').find(value=>value.startsWith('foxwq_credentials='));
    document.cookie=cookie+'; Max-Age=1; Path=/';
  })()`);
  assert.equal((await context.cookies()).some(cookie => cookie.name === 'foxwq_credentials'), true);
  await pause(1200);
  assert.equal((await context.cookies()).some(cookie => cookie.name === 'foxwq_credentials'), false, 'Expired credentials must be deleted from cookie storage');
  assert.equal(await js(`(async()=>{const {rememberedCredentials}=await import('/src/credentials.ts');return rememberedCredentials()})()`), null);
  assert.match(await js("document.getElementById('username').placeholder"), /username/i);
  assert.match(await js("document.getElementById('password').placeholder"), /password/i);
  assert.equal(await js("document.getElementById('login').textContent"), 'Log in');
  assert.equal(await js("getComputedStyle(document.getElementById('connection-menu')).borderTopWidth"), '1px');
  assert.equal(await js("document.querySelector('#connection-menu > legend, .player-turn, #events')"), null);
  assert.equal(await js("document.querySelector('label[for=username]').textContent"), '');
  assert.equal(await js("document.querySelector('label[for=password]').textContent"), '');
  assert.ok(await js("document.getElementById('connection-menu').getBoundingClientRect().width") < 400);
  assert.equal(await js("getComputedStyle(document.documentElement).overflowY"), 'hidden');
  assert.equal(await js("document.getElementById('status').hidden"), true);
  assert.equal(await js("document.querySelector('.match-overview')"), null);
  await js(`(() => {
    const menu=document.getElementById('connection-menu');window.loginBounds=menu.getBoundingClientRect().toJSON();
    window.titleMutations=0;window.titleObserver=new MutationObserver(records=>titleMutations+=records.length);
    titleObserver.observe(document.getElementById('menu-title'),{childList:true,subtree:true,characterData:true});
    const selection=getSelection(),range=document.createRange();range.selectNodeContents(document.getElementById('menu-title'));
    selection.removeAllRanges();selection.addRange(range);
  })()`);
  await pause(1100);
  assert.equal(await js('titleMutations'),0);
  assert.equal(await js('getSelection().toString()'),'Foxwq-web');
  await js(`document.getElementById('login-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))`);
  assert.equal(await js("document.getElementById('status').hidden"),false);
  assert.equal(await js(`(() => {const r=document.getElementById('connection-menu').getBoundingClientRect();
    return r.x===loginBounds.x&&r.y===loginBounds.y&&r.width===loginBounds.width&&r.height>=loginBounds.height})()`),true);
  assert.equal(await js(`document.getElementById('status').parentElement.id`), 'login');
  assert.equal(await js(`document.getElementById('login').textContent`), await js(`document.getElementById('status').textContent`));
  assert.equal(await js('titleMutations'),0);
  await js('titleObserver.disconnect();getSelection().removeAllRanges()');
  const scrollBefore = await js('window.scrollY');
  await call('Input.dispatchMouseEvent', {type:'mouseWheel',x:10,y:10,deltaX:0,deltaY:400});
  await pause(100);
  assert.equal(await js('window.scrollY'), scrollBefore);
  await js(`(async()=>{
    const source=await (await fetch('/src/controller.ts')).text();
    const sessionPath=source.match(/from ["']([^"']*session[.]ts[^"']*)["']/)[1];
    const {Session}=await import(sessionPath);window.CheckSession=Session;window.originalLogin=Session.prototype.login;
    const {decode,encode}=await import('/src/wire.ts');
    const {unpack}=await import('/src/game.ts');
    window.setupCheckGame=s=>{
      s.close();s.board=new s.board.constructor();s.phase='playing';s.color=1;s.result='';s.gameOver=false;
      s.roomKey={1:31000,2:63};s.status='';
      s.gateway={close(){},send(command,payload){
        const [header,fields]=unpack(payload),op=header.number(1);
        queueMicrotask(()=>{
          if(op===201)s.gameMessage(203,fields);
          if(op===204)s.gameMessage(206,decode(encode({})));
          if(op===311)s.gameMessage(402,decode(encode({2:3-s.color,4:3})));
        });
      }};s.changed();
    };
    Session.prototype.login=function(){window.checkSession=this;setupCheckGame(this);};
    document.getElementById('username').value='test';document.getElementById('password').value='test';document.getElementById('login-form').requestSubmit();
    Session.prototype.login=window.originalLogin;
  })()`);
  assert.equal(await js("!document.getElementById('connection-layer').hidden"), false);
  assert.equal(await js("document.activeElement.id"), 'board');
  assert.notEqual(await js("getComputedStyle(document.documentElement).overflowY"), 'hidden');
  assert.equal(await js("document.querySelector('main').inert"), false);
  assert.equal(await js("document.getElementById('board').tagName"), 'svg');
  assert.equal(await js("document.querySelectorAll('header:not(.player-panel header),footer,canvas').length"), 0);
  await call('Emulation.setDeviceMetricsOverride', {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false});
  const boardWidth = await js("document.getElementById('board').getBoundingClientRect().width");
  await call('Emulation.setDeviceMetricsOverride', {width: 2560, height: 1600, deviceScaleFactor: 2, mobile: false});
  assert.ok(await js("document.getElementById('board').getBoundingClientRect().width") > boardWidth * 1.5);
  for (const [width, height] of [[3440,1440], [2560,720], [800,1200], [390,844], [800,360]]) {
    await call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
    const bounds = await js(`(() => {
      const r = document.getElementById('board').getBoundingClientRect();
      return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};
    })()`);
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= width, JSON.stringify({width,height,bounds}));
    assert.ok(Math.abs(bounds.width - bounds.height) < 1);
    const gap = await js("parseFloat(getComputedStyle(document.querySelector('.layout')).gap)");
    const padding = await js("parseFloat(getComputedStyle(document.querySelector('main')).paddingTop)");
    assert.equal(bounds.top, padding);
    if (width > 800) assert.ok(bounds.bottom <= height - gap);
    else assert.equal(bounds.width, width);
  }
  await call('Emulation.setDeviceMetricsOverride', {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false});

  await pause(150);
  await js('setupCheckGame(checkSession)');
  assert.equal(await js("document.getElementById('white-captures').textContent"), 'Captures: 0 + 7.5');
  assert.equal(await js("document.getElementById('black-time').textContent"), '—');
  assert.equal(await js("document.getElementById('white-periods')"), null);
  const pointerAt = async (x: number, y: number, type = 'pointermove') => js(`(() => {
    const board = document.getElementById('board'), rect = board.getBoundingClientRect(), view = board.viewBox.baseVal;
    board.dispatchEvent(new MouseEvent('${type}', {clientX: rect.left + (48 + ${x} * 744 / 18 - view.x) * rect.width / view.width,
      clientY: rect.top + (48 + ${y} * 744 / 18 - view.y) * rect.height / view.height, bubbles: true}));
  })()`);
  const previewCount = () => js("document.querySelectorAll('#board > g.stone-preview circle').length");
  const surface = await js(`(() => {
    const rect = document.querySelector('#board .board-surface');
    return {x:Number(rect.getAttribute('x')), y:Number(rect.getAttribute('y')), width:Number(rect.getAttribute('width'))};
  })()`);
  const stoneRadius = 744 / 18 / 2;
  const edgePadding = stoneRadius * 2 * 0.025;
  assert.ok(Math.abs(48 - surface.x - stoneRadius - edgePadding) < 1e-9);
  assert.ok(Math.abs(surface.x + surface.width - 792 - stoneRadius - edgePadding) < 1e-9);
  assert.equal(await js("document.querySelectorAll('#board text').length"), 0);
  assert.equal(await js("document.getElementById('board').tabIndex"), -1);
  assert.equal(await js("getComputedStyle(document.getElementById('board')).outlineStyle"), 'none');
  assert.equal(await js(`Array.from(document.querySelectorAll('#board path')).every(line => {
    const style = getComputedStyle(line);
    return style.stroke === 'rgb(0, 0, 0)' && style.strokeWidth === '1px' && style.vectorEffect === 'non-scaling-stroke';
  })`), true);

  for (const [x,y] of [[0,0], [18,0], [0,18], [18,18], [0,9]]) {
    await pointerAt(x, y); assert.equal(await previewCount(), 1);
    const circle = await js(`(() => {
      const c = document.querySelector('#board > g.stone-preview circle');
      return {x:Number(c.getAttribute('cx')),y:Number(c.getAttribute('cy')),r:Number(c.getAttribute('r'))};
    })()`);
    if (x === 0) assert.ok(Math.abs(circle.x - circle.r - surface.x - edgePadding) < 1e-9);
    if (x === 18) assert.ok(Math.abs(circle.x + circle.r - surface.x - surface.width + edgePadding) < 1e-9);
    if (y === 0) assert.ok(Math.abs(circle.y - circle.r - surface.y - edgePadding) < 1e-9);
    if (y === 18) assert.ok(Math.abs(circle.y + circle.r - surface.y - surface.width + edgePadding) < 1e-9);
  }

  for (const [x,y] of [[-.8,9], [18.8,9], [9,-.8], [9,18.8]]) {
    await pointerAt(x, y); assert.equal(await previewCount(), 0);
    await pointerAt(x, y, 'click');
    assert.ok(await js("document.getElementById('black-player').classList.contains('to-play')"));
  }

  for (const [x,y] of [[3.5,3.5], [3.4,3.4], [-.4,-.4]]) {
    await pointerAt(x, y); assert.equal(await previewCount(), 0);
    await pointerAt(x, y, 'click');
    assert.ok(await js("document.getElementById('black-player').classList.contains('to-play')"));
  }

  await pointerAt(3.49, 3);
  assert.equal(await previewCount(), 1);
  assert.equal(await js("Number(document.querySelector('#board > g.stone-preview circle').getAttribute('r'))"), 744 / 18 / 2);

  await pointerAt(3, 3);
  assert.equal(await previewCount(), 1);
  assert.equal(await js("document.querySelector('#board > g.stone-preview circle').getAttribute('fill')"), 'url(#black-stone)');
  assert.equal(await js("document.querySelectorAll('#board image').length"), 0);
  assert.equal(await js("document.querySelector('#board > g.stone-preview .stone').getAttribute('filter')"), 'url(#stone-shadow)');
  assert.equal(await js("document.querySelectorAll('#board > g.stone-preview ellipse').length"), 0);

  await pointerAt(3, 3, 'click');
  await wait("document.getElementById('white-player').classList.contains('to-play')");
  assert.equal(await previewCount(), 0);
  assert.equal(await js("document.querySelector('#board polygon').getAttribute('fill')"), '#fff');
  const triangle = await js("document.querySelector('#board polygon').getAttribute('points').split(/[ ,]/).map(Number)");
  assert.equal(triangle[0], 172); assert.equal(triangle[1], 172);
  assert.equal(triangle[2], 172); assert.ok(triangle[3] > 172);
  assert.ok(triangle[4] > 172); assert.equal(triangle[5], 172);
  await pointerAt(3, 3, 'click');
  assert.ok(await js("document.getElementById('white-player').classList.contains('to-play')"));
  await js('checkSession.color=2;checkSession.changed()');
  await pointerAt(4, 3);
  assert.equal(await js("document.querySelector('#board > g.stone-preview circle').getAttribute('fill')"), 'url(#white-stone)');
  assert.equal(await js("document.querySelector('#board > g.stone-preview ellipse').getAttribute('fill')"), 'url(#white-stone-glow)');
  await js("document.getElementById('board').dispatchEvent(new PointerEvent('pointerout', {bubbles:true}))");
  assert.equal(await previewCount(), 0);

  await js("document.getElementById('pass').click()");
  await wait('checkSession.board.passes===1');
  await js("(async()=>{const {encode,decode}=await import('/src/wire.ts');checkSession.gameMessage(206,decode(encode({})));})()");
  await wait('checkSession.board.passes===2');
  assert.equal(await js('checkSession.phase'), 'playing');
  await pointerAt(4, 3); assert.equal(await previewCount(), 1);
  await js("document.getElementById('resign').click()");
  await wait("!document.getElementById('resign-cancel').hidden");
  await js("document.getElementById('resign').click()");
  await wait("document.getElementById('board-status').textContent==='Result: B+R'");
  assert.equal(await js("document.getElementById('save-sgf').tagName"), 'BUTTON');
  assert.equal(await js("document.getElementById('save-sgf').textContent"), 'Download SGF');
  assert.equal(await js("document.getElementById('save-sgf').type"), 'button');
  assert.equal(await js("document.querySelector('#login-form, #username, #password')"), null);
  assert.deepEqual(await js("[...document.getElementById('game-downloads').children].map(el=>el.id)"), ['save-sgf']);
  await js("window.downloadSubmissions=0;document.addEventListener('submit',()=>downloadSubmissions++,true)");
  const sgf = await js(`(async()=>{
    let saved='';const create=URL.createObjectURL;URL.createObjectURL=blob=>{saved=blob;return create(blob);};
    document.getElementById('save-sgf').click();URL.createObjectURL=create;return saved.text();
  })()`);
  assert.match(sgf, /PB\[Black\]PW\[White\]/);
  assert.match(sgf, /RE\[B\+R\]/); assert.match(sgf, /;B\[dd\];W\[\];B\[\]/);
  assert.equal(await js("downloadSubmissions"), 0);
  const networkLog = await js(`(async()=>{
    let saved;const create=URL.createObjectURL;URL.createObjectURL=blob=>{saved=blob;return create(blob);};
    try {
      document.getElementById('save-network-log').click();
      while (!saved) await new Promise(resolve=>setTimeout(resolve,10));
      return await saved.text();
    } finally { URL.createObjectURL=create; }
  })()`);
  assert.ok(Array.isArray(JSON.parse(networkLog)));
  assert.equal(networkLog.includes('"kind":"ui"'), false);
  assert.equal(networkLog.includes('"event":'), false);
  assert.equal(networkLog.includes('\n'), false);

  console.log('Browser checks passed: SVG, responsive sizing, preview/placement, triangle, komi, passing, resignation, SGF');

  await js(`const Session=window.CheckSession;Session.prototype.login=function(){this.close();this.phase='connecting';this.status='Connecting to Fox...';window.checkSession=this;};checkSession.close()`);
  await assertEscapeIgnored();
  await js("document.getElementById('username').value='test';document.getElementById('password').value='';document.getElementById('password').focus()");
  await call('Input.insertText', {text:'retained-test-password'});
  await call('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13});
  await call('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await wait("window.checkSession.phase==='connecting'");
  assert.equal(await js("document.getElementById('password').value"), 'retained-test-password');
  for (const phase of ['connecting','authenticating','bootstrap','gateway','resuming']) {
    const loginBefore=await js("document.getElementById('connection-menu').getBoundingClientRect().toJSON()");
    await js(`window.checkSession.phase=${JSON.stringify(phase)};window.checkSession.status='Waiting for Fox to finish connecting and checking for a running game...';window.checkSession.changed()`);
    await wait("document.getElementById('status').textContent==='Waiting for Fox to finish connecting and checking for a running game...'");await pause(300);
    assert.equal(await js("document.getElementById('disconnect')"), null);
    assert.equal(await js("document.getElementById('login').disabled"), true);
    assert.equal(await js("document.getElementById('login').textContent"), await js("document.getElementById('status').textContent"));
    assert.equal(await js("document.getElementById('password').value"), 'retained-test-password');
    const loginAfter=await js("document.getElementById('connection-menu').getBoundingClientRect().toJSON()");
    assert.deepEqual([loginAfter.x,loginAfter.y,loginAfter.width],[loginBefore.x,loginBefore.y,loginBefore.width]);
    assert.equal(await js(`(() => {
      const modal=document.getElementById('connection-menu').getBoundingClientRect();
      const login=document.getElementById('login').getBoundingClientRect();
      return modal.width<400 && login.left>=modal.left && login.right<=modal.right && login.bottom<=modal.bottom;
    })()`), true);
  }
  await assertEscapeIgnored();
  await js("window.checkSession.failed(window.checkSession.generation,'Fox login rejected')");
  await wait("document.getElementById('status').textContent==='Error: Fox login rejected'");
  assert.equal(await js("document.getElementById('login').textContent"), 'Log in');
  assert.equal(await js("document.getElementById('status').parentElement.id"), 'login-form');
  assert.equal(await js("document.getElementById('status').getBoundingClientRect().top>=document.getElementById('login').getBoundingClientRect().bottom"), true);
  assert.equal(await js("document.getElementById('password').value"), 'retained-test-password');
  assert.equal(await js("getComputedStyle(document.getElementById('status')).color"), await js("getComputedStyle(document.body).color"));
  assert.equal(await js("document.getElementById('disconnect')"), null);
  assert.ok(await js("document.getElementById('connection-menu').getBoundingClientRect().width") < 400);
  await js("window.CheckSession.prototype.login=function(){throw Error('Invalid test credentials')};document.getElementById('password').value='test';document.getElementById('login-form').requestSubmit()");
  assert.equal(await js("document.getElementById('status').textContent"), 'Error: Invalid test credentials');
  assert.equal(await js("getComputedStyle(document.getElementById('status')).color"), await js("getComputedStyle(document.body).color"));
  const loginPosition = await js("document.getElementById('connection-menu').getBoundingClientRect().toJSON()");
  await js("window.CheckSession.prototype.login=function(){this.close();this.phase='ready';this.status='Connected test account'};document.getElementById('password').value='test';document.getElementById('login-form').requestSubmit()");
  await wait("!document.getElementById('matchmaking').hidden");
  const matchmakingPosition = await js("document.getElementById('connection-menu').getBoundingClientRect().toJSON()");
  assert.deepEqual(
    [matchmakingPosition.x + matchmakingPosition.width / 2, matchmakingPosition.y],
    [loginPosition.x + loginPosition.width / 2, loginPosition.y],
  );
  assert.equal(matchmakingPosition.width, loginPosition.width);
  assert.equal(await js("!document.getElementById('connection-layer').hidden"), true);
  await assertEscapeIgnored();
  assert.equal(await js("document.getElementById('disconnect')"), null);
  assert.equal(await js("document.getElementById('status').classList.contains('is-error')"), false);
  assert.equal(await js("document.querySelector('#login-form, #username, #password')"), null);
  await js("checkSession.close()");
  await wait("document.getElementById('password') != null");
  await js(`(async()=>{
    const Session=window.CheckSession;
    Session.prototype.login=function(){this.close();this.phase='resuming';this.status='Restoring test game';setTimeout(()=>{this.color=1;this.phase='playing';this.status='Game synchronized';this.changed();},600);};
    document.getElementById('password').value='test';document.getElementById('login-form').requestSubmit();
  })()`);
  assert.equal(await js("document.getElementById('menu-title').textContent"), 'Foxwq-web');
  assert.equal(await js("document.getElementById('matchmaking').hidden"), true);
  await wait("document.getElementById('connection-layer').hidden");
  assert.equal(await js("document.activeElement.id"), 'board');
  await js(`(async()=>{const Session=window.CheckSession;Session.prototype.login=window.originalLogin;checkSession.close();})()`);
  console.log('Browser checks passed: Escape ignored, stable pending login, default-colored errors, modal gating, cookies, matchmaking, restoration, Fox play/resignation/SGF');


  await call('Page.navigate', { url });
  await wait("document.getElementById('pass') != null");

  await js(`(async () => {
    const source=await (await fetch('/src/controller.ts')).text();
    const sessionPath=source.match(/from ["']([^"']*session[.]ts[^"']*)["']/)[1];
    const { Session } = await import(sessionPath);
    const game = await import('/src/game.ts');
    const { encode, decode } = await import('/src/wire.ts');
    const snapshot = Session.prototype.snapshot;
    Session.prototype.snapshot = function () { window.countingSession = this; return snapshot.call(this); };
    window.countingSent = [];
    window.countingNotify = (op, fields) => countingSession.gameMessage(op, decode(encode(fields)), new Map());
    window.countingUnpack = payload => game.unpack(payload).map(game.plain);
    const login = Session.prototype.login; Session.prototype.login = function () { this.close();this.phase='playing';this.color=1;this.roomKey={1:31000,2:63};this.changed(); };
    document.getElementById('username').value='test';document.getElementById('password').value='test';
    document.getElementById('login-form').requestSubmit(); Session.prototype.login = login;
  })()`);
  await wait('window.countingSession != null');
  await js(`(() => {
    const s = countingSession; s.close(); s.phase = 'playing'; s.color = s.board.turn;
    s.uid = 42; s.roomKey = { 1: 31000, 2: 63, 3: 23, 4: 202 };
    s.gateway = { send: (command, payload) => countingSent.push([command, ...countingUnpack(payload)]), close() {} };
  })()`);
  await wait("!document.getElementById('request-score').hidden && !document.getElementById('request-score').disabled");
  assert.equal(await js("document.getElementById('request-score').textContent"), 'Request Counting');
  await js("document.getElementById('request-score').click()");
  assert.equal(await js("document.getElementById('action-panel').hidden"), true);
  assert.equal(await js('countingSent.at(-1)[1][1]'), 301);
  await js('countingNotify(301, {1:0})');
  await wait("document.getElementById('request-score').disabled");

  await js(`(() => {
    const board = document.getElementById('board'), rect = board.getBoundingClientRect(), view = board.viewBox.baseVal;
    window.countingPoint = {clientX: rect.left + (172 - view.x) * rect.width / view.width,
      clientY: rect.top + (172 - view.y) * rect.height / view.height};
    board.dispatchEvent(new MouseEvent('pointermove', {...countingPoint, bubbles:true}));
  })()`);
  assert.equal(await previewCount(), 0);
  const sentBeforeCountingClick = await js('countingSent.length');
  await js("document.getElementById('board').dispatchEvent(new MouseEvent('click', {...countingPoint, bubbles:true}))");
  assert.equal(await js('countingSent.length'), sentBeforeCountingClick);
  assert.equal(await js("document.getElementById('error').hidden"), true);

  await js('countingNotify(306, {1:false,2:1}); countingNotify(303, {1:0,2:1})');
  await wait("document.getElementById('counting-dialog').open");
  assert.equal(await js("document.activeElement.id"), 'counting-reject');
  await js("document.getElementById('counting-reject').click()");
  assert.deepEqual(await js('countingSent.at(-1)[2]'), {1:0,2:1});
  await wait("!document.getElementById('counting-dialog').open");
  await js('countingNotify(304, {1:0}); countingNotify(306, {1:false,2:1})');
  await wait("!document.getElementById('pass').disabled");
  await js('countingNotify(303, {1:0,2:1})');
  await wait("document.getElementById('counting-dialog').open");
  await js("document.getElementById('counting-accept').click()");
  assert.deepEqual(await js('countingSent.at(-1)[2]'), {1:1,2:1});
  await js('countingNotify(304, {1:0}); countingNotify(306, {1:true,2:1}); countingNotify(303, {1:0,2:2,6:1127841792,8:1})');
  await wait("document.getElementById('counting-dialog').open && document.getElementById('counting-title').textContent === 'Counting result: B+2.5'");
  assert.equal(await js("document.getElementById('counting-result').textContent"), 'B+2.5');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait("!document.getElementById('counting-dialog').open");
  assert.deepEqual(await js('countingSent.at(-1)[2]'), {1:0,2:2});
  await js('countingNotify(304, {1:0}); countingNotify(306, {1:false,2:2}); countingNotify(303, {1:0,2:2,8:2})');
  await wait("document.getElementById('counting-dialog').open");
  await js("document.getElementById('counting-accept').click()");
  assert.deepEqual(await js('countingSent.at(-1)[2]'), {1:1,2:2});
  await js('countingNotify(304, {1:0}); countingNotify(306, {1:true,2:2})');
  await wait("!document.getElementById('counting-dialog').open");
  assert.equal(await js('countingSession.phase'), 'playing');
  await js('countingNotify(303, {1:0,2:2,8:2})');
  await wait("document.getElementById('counting-dialog').open");
  await js('countingNotify(402, {1:0,2:2,3:125,4:2})');
  await wait("!document.getElementById('counting-dialog').open");
  assert.equal(await js('countingSession.phase'), 'finished');

  await js("countingSession.phase='playing';countingNotify(303, {1:0,2:2,8:2})");
  await wait("document.getElementById('counting-dialog').open");
  await js('countingNotify(501, {1:0,3:[{1:42,6:1}],6:5})');
  await wait("!document.getElementById('counting-dialog').open");
  assert.equal(await js('countingSession.counting'), false);
  await js('countingSession.close()');
  console.log('Browser counting checks passed: button, request/result dialogs, Accept, Reject, Escape, game end');


  await js(`(async()=>{const {rememberTimeControl}=await import('/src/time-preference.ts');
    rememberTimeControl({size:19,main:300,periods:3,byoyomi:30});window.timePreferenceReload=true;})()`);
  await call('Page.reload');
  await wait("!window.timePreferenceReload && document.getElementById('pass') != null");
  await js(`(async()=>{
    const source=await (await fetch('/src/controller.ts')).text();
    const sessionPath=source.match(/from ["']([^"']*session[.]ts[^"']*)["']/)[1];
    window.CheckSession=(await import(sessionPath)).Session;
  })()`);
  await js(`window.originalLogin=window.CheckSession.prototype.login;window.CheckSession.prototype.login=function(){
    window.matchSession=this;this.phase='gateway';this.gameLockChecked=true;
    this.gateway={send:(command,payload)=>window.matchPayload=payload,close(){}};
    import('/src/wire.ts').then(({decode,encode})=>this.roomMessage(100150,decode(encode({1:[
      {1:101,2:19,3:1200,4:3,5:60,7:0,12:1},
      {1:102,2:19,3:300,4:3,5:30,7:0,12:1},
      {1:103,2:19,3:0,4:5,5:30,7:0,12:1}
    ]}))));
  };document.getElementById('username').value='test';
  document.getElementById('password').value='test';document.getElementById('login-form').requestSubmit();`);
  await wait("document.querySelectorAll('#time-controls input').length===3");
  assert.equal(await js("document.querySelector('#time-controls input:checked').value"), '102');
  await js("document.querySelector('#time-controls input[value=\"103\"]').click()");
  assert.deepEqual(await js("import('/src/time-preference.ts').then(m=>m.rememberedTimeControl())"), {size:19,main:0,periods:5,byoyomi:30});
  await js("document.querySelector('#time-controls input[value=\"102\"]').click()");
  assert.deepEqual(await js("import('/src/time-preference.ts').then(m=>m.rememberedTimeControl())"), {size:19,main:300,periods:3,byoyomi:30});
  assert.equal(await js("document.getElementById('match-summary')"), null);
  assert.deepEqual(await js("[...document.querySelectorAll('.field-population')].map(el=>el.textContent)"), ['(— players)','(— players)','(— players)']);
  await js(`(async()=>{const {decode,encode}=await import('/src/wire.ts');
    window.selectedTimeInput=document.querySelector('#time-controls input:checked');selectedTimeInput.focus();
    matchSession.roomMessage(100145,decode(encode({1:0,2:[{1:101,2:250},{1:102,2:1},{1:103,2:0}]})));})();`);
  await wait("document.querySelector('.field-population[data-field-id=\"102\"]').textContent==='(1 player)'");
  assert.deepEqual(await js("[...document.querySelectorAll('.field-population')].map(el=>el.textContent)"), ['(0 players)','(1 player)','(250 players)']);
  assert.equal(await js("document.activeElement===selectedTimeInput && document.querySelector('#time-controls input:checked')===selectedTimeInput"), true);
  for (const [width,height] of [[1280,900],[390,844],[320,568],[800,360]]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
    assert.equal(await js(`(() => {const r=document.getElementById('connection-menu').getBoundingClientRect();return r.left>=0&&r.right<=${width}&&r.top>=0&&r.bottom<=${height}})()`), true);
  }
  await js("document.getElementById('match').click()");
  assert.equal(await js("window.matchSession.fieldId"), 102);
  assert.equal(await js("document.querySelectorAll('#time-controls input:disabled').length"), 3);
  assert.equal(await js("document.getElementById('cancel')"), null);
  await assertEscapeIgnored();
  await js(`(async()=>{const {decode,encode}=await import('/src/wire.ts');
    window.gameNotice=(op,fields)=>matchSession.gameMessage(op,decode(encode(fields)),decode(encode({8:63})));
    matchSession.uid=42;
    gameNotice(107,{6:23,7:202,9:[{1:42,6:1,7:300,8:3,9:30}]});
    matchSession.roomMessage(100130,decode(encode({1:0})));
  })()`);
  await wait("document.getElementById('connection-layer').hidden");
  assert.equal(await js("document.querySelector('main').inert"), false);
  assert.equal(await js("document.activeElement.id"), 'board');
  assert.equal(await js("document.getElementById('menu')"), null);
  await js("document.getElementById('resign').click()");
  assert.equal(await js("document.getElementById('resign-cancel').hidden"), false);
  await js("document.getElementById('resign-cancel').click()");
  assert.equal(await js("matchSession.phase"), 'playing');

  await js("matchSession.quitRoom()");
  assert.equal(await js("document.getElementById('connection-layer').hidden"), true);
  assert.equal(await js("matchSession.quitRequested"), true);
  await js("gameNotice(311,{1:0});gameNotice(402,{1:0,2:2,3:-1,4:3})");
  await wait("!document.getElementById('connection-layer').hidden && !document.getElementById('matchmaking').hidden");
  assert.equal(await js("document.getElementById('login-form')"), null);
  assert.equal(await js("document.getElementById('match').disabled"), false);
  assert.equal(await js("matchSession.gateway != null && matchSession.fieldId===102"), true);
  await js("document.getElementById('match').click();gameNotice(107,{6:24,7:203,9:[{1:42,6:1}]})");
  await wait("document.getElementById('connection-layer').hidden");
  await js("gameNotice(402,{1:0,2:1,4:3})");
  await wait("document.getElementById('board-status').textContent==='Result: B+R' && matchSession.phase==='finished'");
  await js("document.getElementById('quit-room').click()");
  assert.equal(await js("matchSession.phase"), 'ready');
  assert.equal(await js("document.getElementById('matchmaking').hidden"), false);
  await assertEscapeIgnored();
  assert.equal(await js("document.querySelector('main').inert"), true);
  assert.equal(await js("Object.keys(matchSession.roomKey).length"), 0);
  await js("document.getElementById('match').click();gameNotice(107,{6:25,7:204,9:[{1:42,6:1},{1:43,6:2}]})");
  await wait("document.getElementById('connection-layer').hidden");
  await js("matchSession.board.turn=2;matchSession.clocks[2]={main:1200,periods:3,byoyomi:60,at:Date.now()/1000-10}");
  await js("gameNotice(503,{1:43,2:90,3:1})");
  await wait("document.getElementById('opponent-connection-status').checkVisibility() && document.getElementById('opponent-connection-status').textContent==='Opponent disconnected (1:30)'");
  await wait("document.getElementById('opponent-connection-status').textContent==='Opponent disconnected (1:29)'");
  assert.equal(await js("document.getElementById('white-hours').dateTime"), 'PT1190S');
  assert.equal(await js("document.getElementById('resign').disabled"), false);
  await js("matchSession.opponentDisconnectDeadline=Date.now()/1000-1;matchSession.changed()");
  await wait("document.getElementById('opponent-connection-status').textContent==='Opponent disconnected (0:00)'");
  assert.equal(await js("document.getElementById('opponent-connection-status').checkVisibility()"), true);
  await js("gameNotice(109,{1:27,2:{1:0,2:1034,3:3,4:60,5:43,6:45}});gameNotice(504,{1:43})");
  await wait("!document.getElementById('opponent-connection-status').checkVisibility()");
  await wait("document.getElementById('white-hours').dateTime==='PT1034S'");
  await wait("document.getElementById('white-hours').dateTime==='PT1033S'");
  await js("matchSession.board.turn=1;matchSession.changed()");
  assert.equal(await js("document.getElementById('disconnect-board')"), null);
  assert.equal(await js("document.getElementById('disconnect')"), null);
  await js(`(async () => {
    const {loginRequest} = await import('/src/session.ts');
    matchSession.loginPacket = loginRequest('test', 'password');
    matchSession.connectionFactory = () => new Promise(() => {});
    gameNotice(203,{1:3,2:3,3:1});
    window.reconnectStones = [...matchSession.snapshot().stones];
    matchSession.failed(matchSession.generation, 'Proxy connection closed');
  })()`);
  await wait("document.getElementById('board-status').checkVisibility() && document.getElementById('board-status').textContent.includes('Connection lost. Reconnecting... (Attempt 1)')");
  assert.equal(await js("document.getElementById('connection-layer').hidden"), true);
  assert.equal(await js("document.querySelector('main').inert"), false);
  for (const id of ['pass', 'request-score', 'resign', 'estimate-score']) {
    assert.equal(await js(`document.getElementById('${id}').checkVisibility()`), true);
    assert.equal(await js(`document.getElementById('${id}').disabled`), true);
  }
  await clickControl("#board");
  assert.deepEqual(await js("matchSession.snapshot().stones"), await js("reconnectStones"));
  await js("matchSession.failed(matchSession.generation, 'Proxy unreachable')");
  await wait("document.getElementById('board-status').textContent.includes('Reconnection failed: Proxy unreachable')");
  await wait("document.getElementById('board-status').textContent.includes('Attempt 2')");
  await js("gameNotice(501,{1:0,3:[{1:42,6:1}],4:[{1:1,2:3,3:3,4:1}],6:3,7:25,10:204,12:31000,13:63})");
  await wait("!document.getElementById('resign').disabled");
  await js("matchSession.close()");
  assert.equal(await js("document.getElementById('login-form').hidden"), false);
  assert.equal(await js("document.getElementById('matchmaking').hidden"), true);
  assert.equal(await js("matchSession.gateway"), null);
  assert.equal(await js("document.querySelector('main').inert"), true);

  for (const fieldsFirst of [true,false]) {
    await js(`window.CheckSession.prototype.login=function(){
      this.close();this.phase='gateway';this.uid=42;
      this.gateway={send(){},close(){}};
      import('/src/wire.ts').then(({encode,decode})=>{
        const fields=decode(encode({1:[{1:101,2:19,3:1200,4:3,5:60,7:0,12:1}]}));
        const lock=decode(encode({1:0,2:31000,3:63}));
        for(const op of ${fieldsFirst ? '[100150,100115]' : '[100115,100150]'}) this.roomMessage(op,op===100150?fields:lock);
        setTimeout(()=>gameNotice(501,{1:0,3:[{1:42,6:1}],4:[{1:1,2:3,3:3,4:1}],6:3,7:23,10:202,12:31000,13:63}),400);
      });
    };document.getElementById('password').value='test';document.getElementById('login-form').requestSubmit()`);
    await wait("matchSession.phase==='resuming'");
    assert.equal(await js("document.getElementById('menu-title').textContent"), 'Foxwq-web');
    assert.equal(await js("document.getElementById('matchmaking').hidden"), true);
    await wait("document.getElementById('connection-layer').hidden");
    assert.equal(await js("matchSession.board.moves.length"), 1);
    await js("matchSession.close()");
  }
  console.log('Browser transitions passed: login, search to game, quit/cancel, finished quit, disconnect, active-game restoration in either order');
  await js("window.CheckSession.prototype.login=window.originalLogin;window.matchSession.close()");
  console.log('Browser matchmaking checks passed: advertised controls, selection, search lock, responsive modal');
  await call('Emulation.setDeviceMetricsOverride', {width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await pause(150);
  for (const [name,sequence] of [
    ['ko',[[0,1],[1,1],[1,0],[0,2],[2,1],[2,2],[10,10],[1,3],[1,2]]],
    ['suicide',[[1,0],[10,10],[0,1],[11,10],[2,1],[12,10],[1,2]]]
  ]) {
    await js(`(async()=>{const {Board}=await import('/src/board.ts');
      const s=matchSession;s.board=new Board();for(const [x,y] of ${JSON.stringify(sequence)})s.board.play(x,y);
      s.phase='playing';s.color=s.board.turn;s.pending=false;s.counting=false;s.pendingConfirmation=null;
      s.roomKey={1:31000,2:63,3:23,4:202};s.clocks={};s.status=${JSON.stringify(name + ' check')};
      window.illegalPackets=0;window.illegalSounds=0;
      s.gateway={send(){illegalPackets++},close(){}};s.onSound=()=>illegalSounds++;
      window.boardBeforeIllegal=JSON.stringify(s.board);s.changed();
    })()`);
    await wait(`document.getElementById('board-status').textContent===${JSON.stringify(name + ' check')} && document.getElementById('connection-layer').hidden`);
    await pointerAt(1,1);assert.equal(await previewCount(),0);
    assert.equal(await js("document.getElementById('board').style.cursor"),'default');
    await pointerAt(1,1,'click');
    assert.equal(await js('JSON.stringify(matchSession.board)===boardBeforeIllegal'),true);
    assert.equal(await js('illegalPackets'),0);assert.equal(await js('illegalSounds'),0);
  }
  await js('matchSession.close()');
  console.log('Browser legality checks passed: online ko and suicide have no preview, placement, packet, or sound');

  await js(`(() => {
    const s=matchSession;s.phase='finished';s.color=1;s.status='player panel check';
    s.board.captures={1:4,2:6};s.komi=7.5;
    s.clocks={1:{main:90,periods:3,byoyomi:30,periodLength:30,at:Date.now()/1000-31},
              2:{main:0,periods:2,byoyomi:30,periodLength:30,at:Date.now()/1000-31}};s.changed();
  })()`);
  await wait("document.getElementById('board-status').textContent==='player panel check'");
  assert.equal(await js("document.querySelector('.game-settings, #game-time')"), null);
  const playerStats = () => js(`['black','white'].map(name => ({
    captures:document.getElementById(name+'-captures').textContent,
    time:document.querySelector('#'+name+'-time time').dateTime,
    label:document.getElementById(name+'-time-label').textContent,
    periods:document.getElementById(name+'-periods')?.textContent ?? null,
    active:document.getElementById(name+'-player').classList.contains('to-play')
  }))`);
  assert.deepEqual(await playerStats(),[
    {captures:'Captures: 4',time:'PT90S',label:'Main time',periods:null,active:false},
    {captures:'Captures: 6 + 7.5',time:'PT30S',label:'Byoyomi: 2/3',periods:'2/3',active:false}
  ]);
  const clockText = () => js("[...document.querySelectorAll('.clock-text')].map(node=>node.textContent)");
  assert.deepEqual(await clockText(), ['00:30', '01:30']);
  assert.equal(await js("document.getElementById('hours').tagName"), 'TIME');
  await js("document.activeElement.blur();document.getElementById('hours').scrollIntoView({block:'center'})");
  const clockPoint = await js(`(() => {const r=document.getElementById('hours').getBoundingClientRect();
    return {x:r.right-12,y:r.y+r.height/2};})()`);
  await call('Input.dispatchMouseEvent', {type:'mousePressed',...clockPoint,button:'left',clickCount:1});
  await call('Input.dispatchMouseEvent', {type:'mouseReleased',...clockPoint,button:'left',clickCount:1});
  assert.equal(await js("document.activeElement.id==='hours'"), false);
  assert.equal(await js("document.querySelector('input[type=time]')"), null);
  await js("document.getElementById('hours').focus()");
  await call('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
  await call('Input.dispatchKeyEvent', {type:'keyUp',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
  assert.equal((await playerStats())[0].time, 'PT90S');
  await js('matchSession.clocks[1].main=3600;matchSession.changed()');
  await wait("document.querySelector('#black-time .clock-text').textContent==='01:00:00'");
  await js('matchSession.clocks[1].main=3599;matchSession.changed()');
  await wait("document.querySelector('#black-time .clock-text').textContent==='59:59'");
  await js('matchSession.clocks[1].main=90;matchSession.changed()');
  await js('matchSession.komi=0;matchSession.changed()');
  await wait("document.getElementById('white-captures').textContent==='Captures: 6'");
  await js('matchSession.komi=-5.5;matchSession.changed()');
  await wait("document.getElementById('black-captures').textContent==='Captures: 4 + 5.5'");
  assert.equal((await playerStats())[1].captures,'Captures: 6');
  await js(`matchSession.phase='playing';matchSession.board.turn=2;
    matchSession.clocks[2].at=Date.now()/1000-31;matchSession.changed()`);
  await wait("document.querySelector('#white-time .clock-text').textContent==='00:00'");
  assert.equal(await js("document.getElementById('white-periods').textContent"), '2/3');
  await js(`(async()=>{const {encode,decode}=await import('/src/wire.ts');
    matchSession.gameMessage(108,decode(encode({2:0,3:1,4:29,5:matchSession.uid+1})))})()`);
  await wait("document.getElementById('white-periods').textContent==='1/3'");
  const liveStats = await playerStats();
  assert.equal(liveStats[0].time,'PT90S');
  assert.equal(liveStats[0].active,false);
  assert.match(liveStats[1].time,/^PT2[0-9]S$/);
  assert.equal(liveStats[1].active,true);
  await js(`window.staticMutations=0;window.staticObserver=new MutationObserver(records=>staticMutations+=records.length);
    for (const id of ['menu-title','black-captures','white-captures','white-time-label'])
      staticObserver.observe(document.getElementById(id),{childList:true,subtree:true,characterData:true});`);
  await pause(1100);
  assert.equal(await js('staticMutations'),0);
  await js('staticObserver.disconnect()');
  await js(`matchSession.board.turn=1;matchSession.clocks[1].main=1;
    matchSession.clocks[1].at=Date.now()/1000;matchSession.changed()`);
  await wait("document.getElementById('black-time-label').textContent==='Main time'");
  await wait("document.getElementById('black-time-label').textContent==='Byoyomi: 3/3'");
  await js(`matchSession.clocks[1]={main:0,periods:3,byoyomi:1,periodLength:30,at:Date.now()/1000-0.6};
    matchSession.changed()`);
  await wait("document.querySelector('#black-time .clock-text').textContent==='00:00'");
  assert.equal(await js("document.getElementById('black-periods').textContent"), '3/3');
  await wait("document.getElementById('black-periods').textContent==='2/3'");
  for (const width of [1280,800,390,320]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await pause(150);
    for (const seconds of [0,9,3599,3600,86399]) {
      await js(`matchSession.phase='finished';matchSession.clocks[1].main=${seconds};matchSession.clocks[1].byoyomi=0;matchSession.changed()`);
      await wait(`document.getElementById('hours').dateTime==='PT${seconds}S'`);
      assert.equal(await js(`[...document.querySelectorAll('time.clock-display')].every(clock=>{
        const r=clock.getBoundingClientRect(), panel=clock.closest('.player-panel').getBoundingClientRect();
        const text=clock.querySelector('.clock-text').getBoundingClientRect();
        const label=clock.closest('dl').querySelector('dt').getBoundingClientRect();
        return r.left>=panel.left && r.right<=panel.right && r.top>=panel.top && r.bottom<=panel.bottom &&
          text.left>=r.left && text.right<=r.right && label.right<=r.left;
      })`), true, `Clock overflow at ${width}px and ${seconds}s`);
      assert.equal(await js(`[...document.querySelectorAll('time.clock-display')].every(clock=>{
        const r=clock.getBoundingClientRect(), panel=clock.closest('.player-panel').getBoundingClientRect();
        const text=clock.querySelector('.clock-text').getBoundingClientRect();
        return Math.abs((panel.right-r.right)-(panel.bottom-r.bottom))<0.5 &&
          Math.abs((text.top-r.top)-(r.bottom-text.bottom))<0.5 &&
          Math.abs((text.left-r.left)-(r.right-text.right))<0.5;
      })`), true, `Asymmetric clock spacing at ${width}px and ${seconds}s`);
    }
    const panels = await js(`['black','white'].map(name=>{
      const panel=document.getElementById(name+'-player'),r=panel.getBoundingClientRect();
      return {left:r.left,right:r.right,width:r.width,scroll:panel.scrollWidth};
    })`);
    for (const panel of panels) {
      assert.ok(panel.left>=0 && panel.right<=width,JSON.stringify({width,panel}));
      assert.ok(panel.scroll<=panel.width,JSON.stringify({width,panel}));
    }
    assert.equal(await js(`[...document.querySelectorAll('.player-panel')].every(panel=>{
      const rows=['.player-title','.player-captures','dt'].map(selector=>panel.querySelector(selector).getBoundingClientRect());
      return rows.length===3 && rows[0].bottom<=rows[1].top && rows[1].bottom<=rows[2].top;
    })`), true);
    assert.equal(await js(`[...document.querySelectorAll('.player-panel')].every(panel=>{
      const title=panel.querySelector('.player-title'), captures=panel.querySelector('.player-captures');
      const label=panel.querySelector('dt');
      const rows=[title,captures,label].map(node=>node.getBoundingClientRect());
      const clock=panel.querySelector('.clock-display').getBoundingClientRect();
      const expected=innerWidth<=800?20:28;
      return getComputedStyle(label).fontSize===getComputedStyle(captures).fontSize &&
        getComputedStyle(label).lineHeight===getComputedStyle(captures).lineHeight &&
        parseFloat(getComputedStyle(label).minHeight)===expected &&
        parseFloat(getComputedStyle(captures).minHeight)===expected &&
        rows[1].right<=clock.left && rows[2].right<=clock.left;
    })`), true, `Expanded player label spacing or inconsistent fonts at ${width}px`);
    assert.equal(await js(`['black','white'].every(name=>{
      const time=document.getElementById(name+'-time'), display=time.querySelector('time');
      const r=display.getBoundingClientRect(), row=time.getBoundingClientRect();
      return Math.abs(r.right-row.right)<1 && r.width<=row.width &&
        r.width<time.closest('.player-panel').getBoundingClientRect().width &&
        time.parentElement===time.closest('dl').lastElementChild;
    })`), true);
  }
  for (const color of [1,2]) {
    await js(`matchSession.color=${color};matchSession.changed()`);
    const expected=color===1?['white-player','black-player']:['black-player','white-player'];
    await wait(`JSON.stringify([...document.querySelectorAll('#sidebar-content > .player-panel')].map(panel=>panel.id))===${JSON.stringify(JSON.stringify(expected))}`);
    const positions=await js(`[...document.querySelectorAll('#sidebar-content > .player-panel')].map(panel=>panel.getBoundingClientRect().left)`);
    assert.ok(positions[0]<positions[1]);
    await js('matchSession.board.turn=3-matchSession.board.turn;matchSession.changed()');
    assert.deepEqual(await js("[...document.querySelectorAll('#sidebar-content > .player-panel')].map(panel=>panel.id)"),expected);
  }
  await js('matchSession.close()');
  console.log('Browser player panels passed: captures, zero/reverse komi, main/byoyomi clocks, periods, active player, responsive player sections');


  // Clock contents resize the capture column; keep the panels and label anchors stable.
  const sidebarBounds = () => js(`['black-player','white-player','black-captures','white-captures'].map(id=>{
      const node=document.getElementById(id);
      const r=node.getBoundingClientRect();
      const bounds={id,x:r.x,y:r.y-document.querySelector('aside').getBoundingClientRect().y,height:r.height};
      return id.endsWith('-captures') ? bounds : {...bounds,width:r.width};
    })`);
  for (const width of [1280,800,390]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await js(`matchSession.phase='playing';matchSession.board.turn=1;
      matchSession.status='Stable sidebar baseline';matchSession.result='';
      matchSession.board.captures={1:120,2:450};matchSession.komi=7.5;
      matchSession.clocks={1:{main:600,periods:3,byoyomi:30,periodLength:30,at:Date.now()/1000},
                           2:{main:0,periods:2,byoyomi:30,periodLength:30,at:Date.now()/1000}};
      matchSession.gameOver=false;matchSession.pendingConfirmation=null;matchSession.changed()`);
    await wait("document.getElementById('board-status').textContent==='Stable sidebar baseline'");
    const before = await sidebarBounds();
    if (width > 800) {
      const top = await js(`(() => {
        const board=document.getElementById('board').getBoundingClientRect();
        const core=document.getElementById('sidebar-content').getBoundingClientRect();
        return {board:board.top,core:core.top};
      })()`);
      assert.ok(Math.abs(top.board-top.core)<1, 'Sidebar controls should align with the top of the board');
    }
    await js(`for(let i=0;i<3;i++) {
      const panel=document.createElement('section');panel.className='quest-panel layout-check';
      panel.textContent='Additional panel '.repeat(30);document.getElementById('sidebar-quests').append(panel);
    }`);
    assert.deepEqual(await sidebarBounds(), before, `Extra panels moved core controls at ${width}px`);
    assert.equal(await js('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
    await js("document.querySelectorAll('.layout-check').forEach(panel=>panel.remove())");
    for (const phase of ['playing','finished']) {
      await js(`matchSession.phase='${phase}';
        matchSession.board.turn=2;matchSession.board.captures={1:123,2:456};matchSession.komi=7.5;
        matchSession.status='A long status message that wraps over several lines while the game updates: ${phase}';
        matchSession.result=${phase === 'finished' ? "'W+123.5'" : "''"};
        matchSession.gameOver=${phase === 'finished'};
        matchSession.pendingConfirmation=${phase === 'playing' ? "['counting-request',{}]" : 'null'};
        matchSession.clocks={1:{main:600,periods:3,byoyomi:30,periodLength:30,at:Date.now()/1000},
                             2:{main:0,periods:2,byoyomi:30,periodLength:30,at:Date.now()/1000}};matchSession.changed()`);
      await wait(phase === 'finished'
        ? "document.getElementById('board-status').textContent==='Result: W+123.5'"
        : "document.getElementById('board-status').textContent.endsWith('playing')");
      assert.deepEqual(await sidebarBounds(), before, `Player panels moved within the sidebar at ${width}px during ${phase}`);
      if (phase === 'playing') {
        assert.equal(await js("getComputedStyle(document.querySelector('#white-player .clock-text')).color"), await js("getComputedStyle(document.body).color"));
        assert.notEqual(await js("getComputedStyle(document.querySelector('#black-player .clock-text')).color"), await js("getComputedStyle(document.body).color"));
        assert.equal(await js("[...document.querySelectorAll('.player-stone')].every(stone=>getComputedStyle(stone).outlineStyle==='none')"), true);
        assert.equal(await js("getComputedStyle(document.getElementById('black-player')).borderTopWidth"), '1px');
        assert.equal(await js("getComputedStyle(document.getElementById('white-player')).borderTopWidth"), '1px');
        const activeColor = await js("getComputedStyle(document.querySelector('#white-player .clock-text')).color");
        assert.equal(await js("getComputedStyle(document.getElementById('white-player')).borderTopColor"), activeColor);
        assert.equal(await js("getComputedStyle(document.querySelector('#white-player .clock-display')).borderTopColor"), activeColor);
        assert.equal(await js("getComputedStyle(document.getElementById('black-player')).borderTopColor"), 'rgb(98, 98, 98)');
        assert.equal(await js("getComputedStyle(document.querySelector('#black-player .clock-display')).borderTopColor"), 'rgb(98, 98, 98)');
      }
    }
  }
  console.log('Browser player panel stability passed: turns, captures, clocks, long statuses, results, and action visibility');

  await call('Page.navigate', { url });
  await wait("document.getElementById('pass') != null");
  if (process.argv.includes('--live')) {
    const [username, password] = (await readFile('creds','utf8')).trimEnd().split(/\r?\n/);
    await js(`document.getElementById('username').value=${JSON.stringify(username)};document.getElementById('password').value=${JSON.stringify(password)};document.getElementById('remember').checked=true;document.getElementById('login-form').requestSubmit()`);
    await wait("!document.getElementById('match').disabled || document.getElementById('status').textContent.includes('failed')");
    assert.equal(await js("document.getElementById('match').disabled"), false, await js("document.getElementById('status').textContent"));
    assert.equal(await js(`document.getElementById('password').value===${JSON.stringify(password)}`), true);
    assert.equal(await js("document.getElementById('match').disabled"), false);
    await call('Page.navigate', { url });
    await wait("document.getElementById('pass') != null");

    assert.equal(await js(`document.getElementById('username').value===${JSON.stringify(username)} && document.getElementById('password').value===${JSON.stringify(password)} && document.getElementById('remember').checked`), true, 'Remembered login changed credentials after reloading');
    await js("document.getElementById('login-form').requestSubmit()");
    await wait("!document.getElementById('match').disabled || document.getElementById('status').classList.contains('is-error')");
    assert.equal(await js("document.getElementById('match').disabled"), false, await js("document.getElementById('status').textContent"));
    await call('Page.navigate', { url });
    await wait("document.getElementById('pass') != null");
    await js("(async()=>{const {rememberCredentials}=await import('/src/credentials.ts');rememberCredentials('','',false);document.getElementById('username').value='';})()");
    console.log('Browser live fresh and remembered login through Cloudflare proxy and normal-match availability verified');
  }
  assert.deepEqual(browserErrors, []);
  }
} finally {
  await browser.close();
}

if (!process.argv.includes('--production-shortcuts')) await import('./player-info-browser-check.ts');
