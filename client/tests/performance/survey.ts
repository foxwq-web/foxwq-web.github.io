import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Browser, CDPSession, Page } from 'playwright';

const viewports = [{ width: 1280, height: 900 }, { width: 390, height: 844 }];
async function metrics(cdp: CDPSession) {
  await cdp.send('HeapProfiler.collectGarbage');
  return Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics
    .filter(m => ['Nodes', 'JSEventListeners', 'JSHeapUsedSize', 'LayoutCount', 'LayoutDuration', 'RecalcStyleCount', 'TaskDuration'].includes(m.name))
    .map(m => [m.name, m.value]));
}
async function dom(page: Page) {
  return page.evaluate(() => {
    const w = window as any;
    const root = document.getElementById('root')!;
    const depth = (node: Element): number => 1 + Math.max(0, ...Array.from(node.children, depth));
    return {
      elements: document.querySelectorAll('*').length, depth: depth(root),
      stones: document.querySelectorAll('.board-stones > g').length,
      territory: document.querySelectorAll('.estimated-territory > rect, .counted-territory > rect').length,
      historyRows: document.querySelectorAll('.player-info tbody tr').length,
      variationNumbers: document.querySelectorAll('.variation-number').length,
      coordinates: document.querySelectorAll('.board-coordinates text').length,
      countingOpen: (document.getElementById('counting-dialog') as HTMLDialogElement).open,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      workers: w.__runtime.workers, longTasks: w.__runtime.longTasks,
      calls: w.__calls,
      // Preserve an exact checksum without storing hundreds of SVG attributes.
      position: document.querySelector('.board-stones')!.innerHTML,
    };
  });
}
function compact(result: Awaited<ReturnType<typeof dom>>) {
  return { ...result, position: createHash('sha256').update(result.position).digest('hex') };
}
async function downloadContents(page: Page, action: () => Promise<unknown>) {
  const pending = page.waitForEvent('download');
  await action();
  const download = await pending;
  const stream = await download.createReadStream();
  assert.ok(stream);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return { text, filename: download.suggestedFilename(), bytes: Buffer.byteLength(text) };
}

async function open(browser: Browser, url: string, viewport: { width: number; height: number }, screen: string) {
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
  // tsx preserves names in serialized nested functions/classes.
  await page.addInitScript('window.__name = target => target');
  await page.addInitScript(() => {
    const w = window as any;
    w.__runtime = { workers: { created: 0, terminated: 0, active: 0 }, longTasks: [] };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private stopped = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        w.__runtime.workers.created++; w.__runtime.workers.active++;
      }
      terminate() {
        if (!this.stopped) {
          this.stopped = true;
          w.__runtime.workers.terminated++; w.__runtime.workers.active--;
        }
        super.terminate();
      }
    };
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) w.__runtime.longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
  });
  await page.goto(url);
  await page.waitForFunction(() => !!(window as any).__bench);
  const load = await page.evaluate(async screen => {
    const start = performance.now();
    const phase = await (window as any).__bench.load(screen);
    return { loadMs: performance.now() - start, ...phase };
  }, screen);
  assert.equal(load.actual, load.expected, screen);
  if (screen.includes('player-info')) {
    await page.waitForFunction(() => document.querySelectorAll('.player-info tbody tr').length === 10);
  }
  await page.waitForTimeout(300);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  return { page, cdp, load, errors };
}

export async function survey(browser: Browser, url: string, report: any) {
  report.method = 'All offline screens plus focused production UI workloads; one screen-load sample, three interaction samples per viewport.';
  for (const viewport of viewports) {
    const index = await open(browser, url, viewport, 'login');
    const screens: { id: string; phase: string }[] = await index.page.evaluate(() => (window as any).__bench.screens);
    await index.page.close();
    for (const screen of screens) {
      const { page, cdp, load, errors } = await open(browser, url, viewport, screen.id);
      const before = await metrics(cdp);
      await page.waitForTimeout(200);
      const after = await metrics(cdp), state = compact(await dom(page));
      assert.equal(state.horizontalOverflow, false, `${screen.id}: horizontal overflow`);
      assert.equal(state.workers.active, 0, `${screen.id}: worker not terminated`);
      if (screen.id.includes('player-info')) assert.equal(state.historyRows, 10);
      if (screen.id === 'replay-variation') assert.equal(state.variationNumbers, 5);
      if (screen.id === 'board-coordinates') assert.equal(state.coordinates, 76);
      if (['score-estimation', 'counting-result'].includes(screen.id)) assert.ok(state.territory > 0, `${screen.id}: missing ownership overlay`);
      if (['counting-request', 'counting-result'].includes(screen.id)) assert.ok(state.countingOpen);
      assert.deepEqual(errors, []);
      const sample = { viewport, kind: 'screen', screen: screen.id, ...load, ...state,
        idleDelta: Object.fromEntries(Object.entries(after).map(([k,v]) => [k, v-before[k]])), errors };
      report.samples.push(sample);
      console.log(JSON.stringify(sample));
      await page.close();
    }
    for (const [kind, screen] of Object.entries({ history: 'board-black-player-info', replay: 'finished-resign', variation: 'replay-variation', coordinates: 'board-black', form: 'login', 'history-clock': 'board-black-player-info', 'white-history-clock': 'board-white-player-info', 'lobby-history-clock': 'matchmaking-player-info', 'counting-clock': 'counting-result', 'estimation-clock': 'score-estimation', 'byoyomi-clock': 'byoyomi', 'coordinates-clock': 'board-coordinates' })) {
      for (let repeat = 0; repeat < 3; repeat++) {
        const { page, cdp, errors } = await open(browser, url, viewport, screen);
        await page.evaluate(kind => (window as any).__bench.interact(kind, 20), kind);
        const beforeDOM = compact(await dom(page)), before = await metrics(cdp);
        const result = await page.evaluate(kind => {
          const w = window as any;
          let mutations = 0;
          const observer = new MutationObserver(r => { mutations += r.length; });
          observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
          w.__calls = { App: 0, BoardView: 0, Stone: 0 };
          const result = w.__bench.interact(kind, 200);
          mutations += observer.takeRecords().length;
          observer.disconnect();
          return { ...result, mutations };
        }, kind);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const after = await metrics(cdp), afterDOM = compact(await dom(page));
        if (kind !== 'form') assert.equal(afterDOM.position, beforeDOM.position, `${kind}: position changed`);
        if (kind === 'variation') assert.equal(afterDOM.variationNumbers, 5);
        if (kind === 'form') assert.equal(result.username, 'benchmark-199');
        assert.equal(afterDOM.elements, beforeDOM.elements, `${kind}: DOM growth`);
        if (!kind.endsWith('-clock')) assert.equal(after.Nodes, before.Nodes, `${kind}: retained node growth`);
        assert.equal(after.JSEventListeners, before.JSEventListeners, `${kind}: listener growth`);
        assert.deepEqual(errors, []);
        const sample = { viewport, kind, repeat, events: 200, ...result, before, after, finalDOM: afterDOM, errors };
        report.samples.push(sample);
        console.log(JSON.stringify(sample));
        await page.close();
      }
    }
    // Real WASM estimator: completion, repeated requests, and immediate cancellation.
    for (let repeat = 0; repeat < 3; repeat++) {
      const { page, cdp, errors } = await open(browser, url, viewport, 'board-black');
      await page.evaluate(() => (window as any).__bench.realEstimator());
      const before = await metrics(cdp), beforeDOM = compact(await dom(page));
      const start = Date.now();
      const gaps = await page.evaluate(async () => {
        const w = window as any, gaps: number[] = [];
        let previous = performance.now(), stopped = false;
        const frame = (now: number) => { gaps.push(now - previous); previous = now; if (!stopped) requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        document.getElementById('estimate-score')!.click();
        while (w.__bench.phase() === 'loading') await new Promise(r => setTimeout(r, 10));
        stopped = true;
        if (w.__bench.phase() !== 'result') throw Error('Real estimator failed');
        return gaps;
      });
      const elapsedMs = Date.now() - start, resultDOM = compact(await dom(page));
      assert.ok(resultDOM.territory > 0);
      assert.equal(resultDOM.workers.active, 0);
      await page.locator('#estimate-score').click();
      // Start a new real worker and cancel through Return to Game.
      await page.locator('#estimate-score').click();
      await page.locator('#estimate-score').click();
      await page.waitForFunction(() => !(window as any).__bench.phase());
      const after = await metrics(cdp), finalDOM = compact(await dom(page));
      assert.equal(finalDOM.workers.active, 0);
      assert.equal(finalDOM.position, beforeDOM.position);
      assert.equal(finalDOM.elements, beforeDOM.elements);
      assert.deepEqual(errors, []);
      const retained = [];
      for (let block = 0; block < 6; block++) {
        await page.locator('#estimate-score').click();
        await page.waitForFunction(() => (window as any).__bench.phase() === 'result');
        await page.locator('#estimate-score').click();
        await page.waitForTimeout(40);
        retained.push(await metrics(cdp));
        assert.equal((await dom(page)).workers.active, 0);
      }
      const sample = { viewport, kind: 'real-estimator', repeat, retained, elapsedMs, frames: gaps.length, maxFrameGapMs: Math.max(0, ...gaps), before, after, resultDOM, finalDOM, errors };
      report.samples.push(sample);
      console.log(JSON.stringify(sample));
      await page.close();
    }
    for (const screen of ['counting-request', 'counting-result']) {
      for (const choice of ['accept', 'reject']) {
        const { page, cdp, errors } = await open(browser, url, viewport, screen);
        const before = await metrics(cdp);
        await page.locator(`#counting-${choice}`).click();
        const after = await metrics(cdp), finalDOM = compact(await dom(page));
        assert.ok(await page.locator('#counting-accept').isDisabled());
        assert.ok(await page.locator('#counting-reject').isDisabled());
        assert.deepEqual(errors, []);
        report.samples.push({ viewport, kind: 'counting-action', screen, choice, before, after, finalDOM, errors });
        await page.close();
      }
    }
    const { page, cdp, errors } = await open(browser, url, viewport, 'finished-resign');
    const before = await metrics(cdp);
    const network = await page.evaluate(() => (window as any).__bench.networkLog(1000));
    assert.equal(network.records - network.initial, 1000);
    const sgf = await downloadContents(page, () => page.locator('#save-sgf').click());
    assert.ok(sgf.text.startsWith('(;GM[1]'));
    const log = await downloadContents(page, () => page.evaluate(() => (window as any).downloadNetworkLog()));
    assert.equal(JSON.parse(log.text).length, network.records);
    await page.waitForTimeout(1100); // App revokes download URLs after 1 second.
    const after = await metrics(cdp);
    assert.deepEqual(errors, []);
    const sample = { viewport, kind: 'storage-downloads', network, sgf: { filename: sgf.filename, bytes: sgf.bytes }, log: { filename: log.filename, bytes: log.bytes }, before, after, finalDOM: compact(await dom(page)), errors };
    report.samples.push(sample);
    console.log(JSON.stringify(sample));
    await page.close();
  }
}

async function heapSummary(cdp: CDPSession) {
  const chunks: string[] = [];
  const listener = ({ chunk }: { chunk: string }) => chunks.push(chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', listener);
  try {
    await cdp.send('HeapProfiler.takeHeapSnapshot');
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', listener);
  }
  const snapshot = JSON.parse(chunks.join(''));
  const fields: string[] = snapshot.snapshot.meta.node_fields;
  const types: string[] = snapshot.snapshot.meta.node_types[fields.indexOf('type')];
  const groups: Record<string, { count: number; bytes: number }> = {};
  for (let i = 0; i < snapshot.nodes.length; i += fields.length) {
    const type = types[snapshot.nodes[i + fields.indexOf('type')]];
    const name = snapshot.strings[snapshot.nodes[i + fields.indexOf('name')]];
    // Group code/string nodes by type; preserve object classes for attribution.
    const key = type === 'object' || type === 'closure' || type === 'native' ? type + ':' + name : type;
    const group = groups[key] ??= { count: 0, bytes: 0 };
    group.count++;
    group.bytes += snapshot.nodes[i + fields.indexOf('self_size')];
  }
  return groups;
}

// A longer single-page run distinguishes retained memory from per-page startup.
export async function estimatorSoak(browser: Browser, url: string, report: any) {
  const captureHeap = process.argv.includes('--heap');
  for (const viewport of (captureHeap ? viewports.slice(0, 1) : viewports)) {
    const { page, cdp, errors } = await open(browser, url, viewport, 'board-black');
    await page.evaluate(() => (window as any).__bench.realEstimator());
    const initial = compact(await dom(page));
    const retained: Record<string, unknown>[] = [];
    const heaps: Awaited<ReturnType<typeof heapSummary>>[] = [];
    for (let cycle = 0; cycle < 60; cycle++) {
      await page.locator('#estimate-score').click();
      await page.waitForFunction(() => (window as any).__bench.phase() === 'result');
      await page.locator('#estimate-score').click();
      await page.waitForTimeout(20);
      const state = compact(await dom(page));
      assert.equal(state.workers.active, 0);
      assert.equal(state.position, initial.position);
      assert.equal(state.elements, initial.elements);
      const counters = await metrics(cdp);
      retained.push({ cycle, ...counters, workers: state.workers });
      assert.equal(counters.Nodes, retained[0].Nodes);
      assert.equal(counters.JSEventListeners, retained[0].JSEventListeners);
      if (captureHeap && (cycle === 9 || cycle === 59)) heaps.push(await heapSummary(cdp));
    }
    const { targetInfos } = await cdp.send('Target.getTargets');
    const remainingWorkerTargets = targetInfos.filter(t => t.type === 'worker').length;
    assert.equal(remainingWorkerTargets, 0);
    assert.deepEqual(errors, []);
    const heapGrowth = heaps.length === 2 ? Object.entries(heaps[1]).map(([group, value]) => ({ group, count: value.count - (heaps[0][group]?.count ?? 0), bytes: value.bytes - (heaps[0][group]?.bytes ?? 0) })).sort((a,b) => b.bytes-a.bytes).filter(x => x.bytes !== 0).slice(0,40) : [];
    report.samples.push({ viewport, kind: 'estimator-soak', retained, heapGrowth, remainingWorkerTargets, errors });
    console.log(JSON.stringify(report.samples.at(-1)));
    await page.close();
  }
}
