import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { build, preview } from 'vite';
import { chromium } from 'playwright';
import { survey, estimatorSoak } from './survey.ts';

// Only the temporary benchmark build exposes a driver; shipped code is unchanged.
const driver = `
import { flushSync } from 'react-dom';
import { applyDevScreen, DEV_SCREENS } from './dev-screens.ts';
import { localEstimate } from '../../score-estimator/src/local-score-estimation.ts';
import { netMsgToBytes as encodeNetMsg } from './framing.ts';
window.__calls = { App: 0, BoardView: 0, Stone: 0 };
window.__bench = {
  screens: DEV_SCREENS.map(({ id, phase, playerName }) => ({ id, phase, playerName })),
  async load(screen) {
    controller.preview = true;
    controller.scheduleClock();
    const result = await applyDevScreen(controller.session, screen);
    controller.previewCoordinates = result.fixture.coordinates ?? false;
    flushSync(() => controller.emit({ type: 'initialize', state: {
      ...controller.state, session: controller.snapshot(), frozen: false,
      now: controller.session.clocks[controller.session.board.turn]?.at ?? controller.state.now,
      preview: null, prompt: result.prompt, menuError: result.menuError, error: result.boardError, review: null
    }}));
    if (result.fixture.variation) {
      flushSync(() => controller.review('previous'));
      for (const [x, y] of result.fixture.variation) flushSync(() => controller.playVariation(x, y));
    }
    if (result.fixture.playerName) document.querySelector(result.fixture.playerName).focus();
    return { expected: result.fixture.phase, actual: controller.state.session.phase };
  },
  realEstimator() { controller.session.estimationFetcher = localEstimate; },
  phase() { return controller.state.session.estimation?.phase; },
  async networkLog(count) {
    const log = controller.session.networkLog;
    const initial = JSON.parse(await log.serialize()).length;
    const connection = log.connection('offline.invalid', 1);
    const frame = encodeNetMsg(1000, new Uint8Array(128));
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      log.traffic(connection, 'inbound', frame);
      if (i % 100 === 99) await log.flush();
    }
    log.closeConnection(connection);
    await log.flush();
    const writeMs = performance.now() - start;
    const readStart = performance.now(), json = await log.serialize();
    return { writeMs, readMs: performance.now() - readStart, initial, records: JSON.parse(json).length, bytes: new Blob([json]).size };
  },
  interact(kind, count) {
    const start = performance.now();
    if (kind.endsWith('-clock')) {
      window.__bench.run('clock', count);
      return { workMs: performance.now() - start };
    }
    for (let i = 0; i < count; i++) {
      if (kind === 'history') {
        flushSync(() => document.getElementById('black-player-name').click());
        flushSync(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      } else if (kind === 'replay' || kind === 'variation') {
        flushSync(() => document.getElementById(i % 2 === 0 ? 'review-previous' : 'review-next').click());
      } else if (kind === 'coordinates') {
        flushSync(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true })));
      } else if (kind === 'form') {
        const input = document.getElementById('username');
        flushSync(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'benchmark-' + i);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
    }
    return { workMs: performance.now() - start, username: controller.state.form.username };
  },
  run(kind, count) {
    const svg = document.getElementById('board');
    const rect = svg.getBoundingClientRect(), box = svg.viewBox.baseVal;
    const start = controller.state.now;
    for (let i = 0; i < count; i++) {
      flushSync(() => {
        if (kind === 'clock') controller.emit({ type: 'clock.tick', now: start + (i + 1) / 4 });
        else {
          const p = i % 361;
          svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true,
            clientX: rect.left + (48 + p % 19 * (744 / 18) - box.x) / box.width * rect.width,
            clientY: rect.top + (48 + Math.floor(p / 19) * (744 / 18) - box.y) / box.height * rect.height
          }));
        }
      });
    }
  }
};`;

const work = await mkdtemp(join(tmpdir(), 'fox-performance-'));
let server: Awaited<ReturnType<typeof preview>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const configFile = resolve('client/vite.config.ts'), outDir = join(work, 'dist');
  await build({ configFile, logLevel: 'warn', build: { outDir, emptyOutDir: true }, plugins: [{
    name: 'benchmark-driver', enforce: 'pre',
    transform(code, id) {
      if (id.endsWith('/src/main.tsx')) return code + driver;
      if (id.endsWith('/src/BoardView.tsx')) return code
        .replace('const { cx, cy } = location(point),', 'window.__calls.Stone++; const { cx, cy } = location(point),')
        .replace('const svg = useRef', 'window.__calls.BoardView++; const svg = useRef');
      if (id.endsWith('/src/PlayerInfo.tsx')) return code.replace("const [downloadError, setDownloadError]", "window.__calls.InfoContent = (window.__calls.InfoContent ?? 0) + 1; const [downloadError, setDownloadError]");
      if (id.endsWith('/src/Application.tsx')) return code.replace('const [coordinates, setCoordinates]', 'window.__calls.App++; const [coordinates, setCoordinates]');
    }
  }] });
  server = await preview({ configFile, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ args: ['--mute-audio'] });
  const report: any = { environment: { node: process.version, browser: browser.version(), platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, samples: [] };
  if (process.argv.includes('--soak') || process.argv.includes('--heap')) {
    await estimatorSoak(browser, url, report);
  } else if (process.argv.includes('--survey')) {
    await survey(browser, url, report);
  } else for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    for (const kind of ['clock', 'hover', 'idle']) {
      const samples = kind === 'idle' ? 1 : 5;
      for (let repeat = 0; repeat < samples; repeat++) {
        const page = await browser.newPage({ viewport });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
        await page.goto(url);
        await page.waitForFunction(() => !!(window as any).__bench);
        await page.evaluate(() => (window as any).__bench.load('board-black'));
        // Finish WASM/audio preload before measuring UI work.
        await page.waitForTimeout(750);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Performance.enable');
        await page.evaluate(kind => (window as any).__bench.run(kind, 80), kind);
        await cdp.send('HeapProfiler.collectGarbage');
        const before = await cdp.send('Performance.getMetrics');
        const result = await page.evaluate(async ({ kind }) => {
          const w = window as any;
          w.__calls = { App: 0, BoardView: 0, Stone: 0 };
          let mutations = 0, added = 0, removed = 0;
          const mutationTargets: Record<string, number> = {};
          const observer = new MutationObserver(records => { for (const r of records) {
            const target = r.target as Element;
            const key = `${target.nodeName}:${r.attributeName ?? r.type}`;
            mutationTargets[key] = (mutationTargets[key] ?? 0) + 1;
            mutations++; added += r.addedNodes.length; removed += r.removedNodes.length;
          }});
          observer.observe(document.getElementById('root')!, { subtree: true, childList: true, attributes: true, characterData: true });
          const start = performance.now();
          if (kind === 'idle') await new Promise(r => setTimeout(r, 2000));
          else w.__bench.run(kind, 720);
          const workMs = performance.now() - start;
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          observer.disconnect();
          return { workMs, mutationTargets, elapsedMs: performance.now() - start, mutations, added, removed,
            calls: w.__calls, elements: document.querySelectorAll('*').length,
            stones: document.querySelectorAll('.board-stones > g').length,
            clock: document.querySelector('#hours')?.textContent,
            preview: document.querySelector('.stone-preview')?.innerHTML };
        }, { kind });
        await cdp.send('HeapProfiler.collectGarbage');
        const after = await cdp.send('Performance.getMetrics');
        const metrics = Object.fromEntries(after.metrics.map(({ name, value }: any) => [name, value - (before.metrics.find((m: any) => m.name === name)?.value ?? 0)]));
        const sample = { viewport, kind, repeat, ...result, metrics: Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount', 'JSHeapUsedSize', 'Nodes', 'JSEventListeners'].map(k => [k, metrics[k]])), errors };
        assert.deepEqual(errors, []);
        report.samples.push(sample);
        if (kind === 'hover' && repeat === 4) {
          const retained = [];
          for (let block = 0; block < 8; block++) {
            await page.evaluate(() => (window as any).__bench.run('hover', 720));
            await cdp.send('HeapProfiler.collectGarbage');
            const { metrics } = await cdp.send('Performance.getMetrics');
            retained.push(Object.fromEntries(metrics.filter((m: any) => ['JSHeapUsedSize', 'Nodes', 'JSEventListeners'].includes(m.name)).map((m: any) => [m.name, m.value])));
          }
          report.samples.push({ viewport, kind: 'retention', retained });
        }
        if (kind === 'clock' && repeat === 4) {
          await cdp.send('Profiler.enable');
          await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
          await cdp.send('Profiler.start');
          await page.evaluate(() => (window as any).__bench.run('clock', 7200));
          const { profile } = await cdp.send('Profiler.stop');
          await writeFile(join(work, 'cpu-profile.json'), JSON.stringify(profile));
          const hits: Record<string, number> = {};
          for (const n of profile.nodes) {
            const key = `${n.callFrame.functionName || '(anonymous)'}:${n.callFrame.lineNumber}`;
            hits[key] = (hits[key] ?? 0) + (n.hitCount ?? 0);
          }
          report.samples.push({ viewport, kind: 'cpu-profile', top: Object.entries(hits).sort((a,b) => b[1]-a[1]).slice(0, 15) });
        }
        console.log(JSON.stringify(sample));
        await page.close();
      }
    }
  }
  const destination = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'analysis/performance.json');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${destination}`);
} finally {
  await browser?.close();
  if (server) await new Promise<void>((done, reject) => server!.httpServer.close(error => error ? reject(error) : done()));
  await rm(work, { recursive: true, force: true });
}
