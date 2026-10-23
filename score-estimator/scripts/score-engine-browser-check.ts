
import { chromium, firefox, webkit } from 'playwright';
import type { BrowserContext, Route } from 'playwright';
import { readFile, readdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { Session } from '../../client/src/session.ts';
import { Board } from '../../client/src/board.ts';
import { decodeEstimate } from '../src/score-estimation.ts';

const base = process.env.FOX_BROWSER_URL || 'http://127.0.0.1:5173';
const url = new URL(base); url.searchParams.set('dev-screen', 'board-black');
type ReferencePosition = { name: string; status: string; turn: number; ownership: string; black_penalty: number; white_penalty: number };
const references: ReferencePosition[] = JSON.parse(await readFile(new URL('../tests/fixtures/fox-native-estimates.json', import.meta.url), 'utf8')).positions;
const expected = references.find(p => p.name === 'game 1, 290 moves');
assert.ok(expected, 'Reference scoring position must exist');
const board = new Board(); board.stones = [...expected.status].map(Number); board.turn = expected.turn;
const scored = decodeEstimate({ ret: 0, board_size: 19,
  judge_status: expected.ownership.replaceAll('3', '0'), black_penalty: expected.black_penalty,
  white_penalty: expected.white_penalty }, board, 7.5);
const production = process.argv.includes('--score-production');
const productionWorker = production ? (await readdir(new URL('../../client/dist/assets', import.meta.url)))
  .find(name => /^fox-score-worker-(?!client-)[\w-]+\.js$/.test(name)) : null;

for (const [name, engine] of Object.entries({ chromium, firefox, webkit }).filter(([name]) =>
  !process.env.FOX_BROWSER_ENGINES || process.env.FOX_BROWSER_ENGINES.split(',').includes(name))) {
  const profile = await mkdtemp(join(await realpath(tmpdir()), 'foxwq-web-score-browser-'));
  let context: BrowserContext | undefined;
  try {
    context = await engine.launchPersistentContext(profile, {
      headless: true, ...(name === 'chromium' ? { args: ['--mute-audio'] } : {}),
      ...(name === 'firefox' && process.env.FOX_FIREFOX_EXECUTABLE ? { executablePath: process.env.FOX_FIREFOX_EXECUTABLE } : {}),
    });
    // Keep Web Audio processing active without sending sound to the speakers.
    await context.addInitScript(() => {
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (this: AudioNode, ...args: Parameters<AudioNode['connect']>) {
        if (args[0] instanceof AudioDestinationNode) return args[0];
        return Reflect.apply(connect, this, args);
      } as AudioNode['connect'];
    });
    const page = await context.newPage();
    const errors: string[] = [];
    const engineRequests: string[] = [];
    const soundRequests: string[] = [];
    page.on('request', request => {
      if (/\/sounds\/.*\.mp3$/.test(request.url())) soundRequests.push(request.url());
      const query = new URL(request.url()).searchParams;
      const binary = /\.(?:dll|wasm)(?:\?|$)/.test(request.url()) && !query.has('url') && !query.has('import');
      if (binary || /fox-score-worker/.test(request.url()))
        engineRequests.push(request.url());
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForSelector('#login-form:visible');
    await page.locator('#username').fill('test');
    await page.waitForLoadState('networkidle');
    assert.deepEqual(engineRequests, [], `${name}: login does not download the score engine`);
    assert.deepEqual(soundRequests, [], `${name}: login gestures do not download sounds`);
    let releaseAssets!: () => void;
    const assetsReady = new Promise<void>(resolve => { releaseAssets = resolve; });
    const gameplayAssets = /(?:\/sounds\/.*\.mp3|\.wasm)$/;
    if (!production) await page.route(gameplayAssets, async route => {
      await assetsReady;
      await route.continue();
    });
    await page.goto(url.href);
    await page.waitForSelector('#estimate-score', { state: production ? 'attached' : 'visible' });
    // The game becomes usable even while its background downloads are stalled.
    releaseAssets();
    await page.waitForLoadState('networkidle');
    if (!production) await page.unroute(gameplayAssets);
    if (production) assert.deepEqual(engineRequests, []);
    else {
      assert.equal(engineRequests.filter(request => /\.wasm$/.test(request)).length, 1,
        `${name}: WASM preloads after leaving login`);
      assert.equal(soundRequests.length, 17, `${name}: sounds preload after leaving login`);
    }
    const assertEngineDownloads = () => {
      assert.ok(engineRequests.some(request => /\/fox-score(?:-[\w-]+)?\.wasm(?:\?|$)/.test(request)),
        `${name}: standalone scoring WASM downloaded`);
      assert.equal(engineRequests.some(request => /\.dll(?:\?|$)/.test(request)), false,
        `${name}: no DLL downloads`);
    };
    if (production) {
      assert.ok(productionWorker, 'Production scoring worker must be bundled');
      const result: unknown = await page.evaluate(({ workerUrl, status }) => new Promise((resolve, reject) => {
        const worker = new Worker(workerUrl);
        const timer = setTimeout(() => { worker.terminate(); reject(Error('Production worker timed out')); }, 20000);
        worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
        worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(Error('Production worker failed')); };
        worker.postMessage(status);
      }), { workerUrl: new URL(`/assets/${productionWorker}`, base).href, status: expected.status });
      assert.deepEqual(result, { result: { ret: 0, board_size: 19,
        judge_status: expected.ownership.replaceAll('3', '0'), black_penalty: expected.black_penalty,
        white_penalty: expected.white_penalty } }, `${name}: packaged production worker`);
      assertEngineDownloads();
      assert.deepEqual(errors, []);
      console.log(`${name}: packaged production worker and hashed engine assets passed`);
      continue;
    }
    const calculate = (): Promise<{ result: Session['estimation']; preserved: boolean; resumed: boolean }> => page.evaluate(async ({ status, turn }) => {
      const { Session } = await import(`${'/src'}/session.ts`) as typeof import('../../client/src/session.ts');
      const { applyDevScreen } = await import(`${'/src'}/dev-screens.ts`) as typeof import('../../client/src/dev-screens.ts');
      const session = new Session(), estimator = session.estimationFetcher;
      await applyDevScreen(session, 'board-black');
      session.estimationFetcher = estimator;
      session.uid = 0;
      session.board.stones = [...status].map(Number); session.board.turn = turn;
      session.board.captures = [0, 0, 0];
      const before = JSON.stringify(session.board), clocks = JSON.stringify(session.clocks);
      await session.estimateScore();
      const result = session.estimation;
      const preserved = before === JSON.stringify(session.board) && clocks === JSON.stringify(session.clocks);
      session.returnToGame();
      session.passTurn();
      const resumed = session.pending;
      session.close();
      return { result, preserved, resumed };
    }, { status: expected.status, turn: expected.turn });
    const downloadsBeforeEstimate = engineRequests.filter(request => /\.wasm$/.test(request)).length;
    const primary = await calculate();
    assert.equal(engineRequests.filter(request => /\.wasm$/.test(request)).length, downloadsBeforeEstimate,
      `${name}: estimation reuses the precompiled module`);
    assert.deepEqual(primary.result, { phase: 'result', stones: board.stones, ...scored }, `${name}: full native estimate`);
    assertEngineDownloads();
    assert.equal(primary.preserved, true); assert.equal(primary.resumed, true);

    const corruptAsset = (body: string) => (route: Route) => {

      const query = new URL(route.request().url()).searchParams;
      return query.has('url') || query.has('import') ? route.continue() :
        route.fulfill({ body, contentType: 'application/octet-stream' });
    };
    const allWasmAssets = /\.wasm(?:\?|$)/;
    await page.route(allWasmAssets, corruptAsset('bad asset'));
    await page.reload();
    await page.waitForSelector('#estimate-score:visible');
    await page.waitForLoadState('networkidle');
    const unavailable = await calculate();
    assert.ok(unavailable.result);
    assert.equal(unavailable.result.phase, 'error');
    assert.ok(unavailable.result.phase === 'error');
    assert.match(unavailable.result.error, /load score estimation/);
    assert.equal(unavailable.preserved, true); assert.equal(unavailable.resumed, true);
    await page.unroute(allWasmAssets);
    assert.deepEqual((await calculate()).result, primary.result, `${name}: retry after asset failure`);



    await page.addInitScript(() => { Object.defineProperty(window, 'WebAssembly', { value: undefined, configurable: true }); });
    const unavailableUrl = new URL(url); unavailableUrl.searchParams.set('dev-screen', 'score-estimation');
    await page.goto(unavailableUrl.href);
    await page.waitForSelector('#estimation-retry:visible');
    assert.match(await page.locator('#estimation-status').innerText(), /unavailable in this browser/);
    await page.locator('#estimate-score').click();
    assert.equal(await page.locator('#pass').isEnabled(), true);
    assert.deepEqual(errors, [], `${name}: no uncaught browser errors`);
    console.log(`${name}: static full search, loading failure, retry, unsupported UI, and gameplay passed`);
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
}
