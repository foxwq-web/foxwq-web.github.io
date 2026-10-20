
import { chromium, firefox, webkit } from 'playwright';
import { readFile, readdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Board } from '../../client/src/board.ts';
import { decodeEstimate } from '../src/score-estimation.ts';

const base = process.env.FOX_BROWSER_URL || 'http://127.0.0.1:5173';
const url = new URL(base); url.searchParams.set('dev-screen', 'board-black'); url.searchParams.set('mute', '1');
const references = JSON.parse(await readFile(new URL('../tests/fixtures/fox-native-estimates.json', import.meta.url), 'utf8')).positions;
const expected = references.find(p => p.name === 'game 1, 290 moves');
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
  let context;
  try {
    context = await engine.launchPersistentContext(profile, {
      headless: true, ...(name === 'chromium' ? { args: ['--mute-audio'] } : {}),
      ...(name === 'firefox' && process.env.FOX_FIREFOX_EXECUTABLE ? { executablePath: process.env.FOX_FIREFOX_EXECUTABLE } : {}),
    });
    const page = await context.newPage();
    const errors = [];
    const engineRequests = [];
    page.on('request', request => {
      const query = new URL(request.url()).searchParams;
      const binary = /\.(?:dll|wasm)(?:\?|$)/.test(request.url()) && !query.has('url') && !query.has('import');
      if (binary || /fox-score-worker/.test(request.url()))
        engineRequests.push(request.url());
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url.href);
    await page.waitForSelector('#estimate-score', { state: production ? 'attached' : 'visible' });
    await page.waitForLoadState('networkidle');
    assert.deepEqual(engineRequests, [], `${name}: no score worker or WASM downloads before estimation`);
    const assertEngineDownloads = () => {
      assert.ok(engineRequests.some(request => /\/fox-score(?:-[\w-]+)?\.wasm(?:\?|$)/.test(request)),
        `${name}: standalone scoring WASM downloaded on demand`);
      assert.equal(engineRequests.some(request => /\.dll(?:\?|$)/.test(request)), false,
        `${name}: no DLL downloads`);
    };
    if (production) {
      const result = await page.evaluate(({ workerUrl, status }) => new Promise((resolve, reject) => {
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
    const calculate = () => page.evaluate(async ({ status, turn }) => {
      const { Session } = await import('/src/session.ts');
      const { applyDevScreen } = await import('/src/dev-screens.ts');
      const session = new Session(), estimator = session.estimationFetcher;
      await applyDevScreen(session, 'board-black');
      session.estimationFetcher = estimator;
      session.uid = 0;
      session.board.stones = [...status].map(Number); session.board.turn = turn;
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
    const primary = await calculate();
    assert.deepEqual(primary.result, { phase: 'result', ...scored }, `${name}: full native estimate`);
    assertEngineDownloads();
    assert.equal(primary.preserved, true); assert.equal(primary.resumed, true);

    const corruptAsset = body => route => {

      const query = new URL(route.request().url()).searchParams;
      return query.has('url') || query.has('import') ? route.continue() :
        route.fulfill({ body, contentType: 'application/octet-stream' });
    };
    const allWasmAssets = /\.wasm(?:\?|$)/;
    await page.route(allWasmAssets, corruptAsset('bad asset'));
    const unavailable = await calculate();
    assert.equal(unavailable.result.phase, 'error');
    assert.match(unavailable.result.error, /load score estimation/);
    assert.equal(unavailable.preserved, true); assert.equal(unavailable.resumed, true);
    await page.unroute(allWasmAssets);
    assert.deepEqual((await calculate()).result, primary.result, `${name}: retry after asset failure`);



    await page.addInitScript(() => { window.WebAssembly = undefined; });
    const unavailableUrl = new URL(url); unavailableUrl.searchParams.set('dev-screen', 'score-estimation-local');
    await page.goto(unavailableUrl.href);
    await page.waitForSelector('#estimation-retry:visible');
    assert.match(await page.locator('#estimation-status').innerText(), /unavailable in this browser/);
    await page.locator('#estimate-score').click();
    assert.equal(await page.locator('#pass').isEnabled(), true);
    assert.deepEqual(errors, [], `${name}: no uncaught browser errors`);
    console.log(`${name}: static full search, loading failure, retry, unsupported UI, and gameplay passed`);
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
}
