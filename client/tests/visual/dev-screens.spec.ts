import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from 'playwright/test';
import { DEV_SCREENS } from '../../src/dev-screens';

type Screen = (typeof DEV_SCREENS)[number];

// The 19 screens in the baselines README. Screens and baselines added by later
// commits join the suite automatically; ids not available yet are skipped.
const BASELINE_SCREENS = [
  'login', 'connecting', 'login-error',
  'matchmaking', 'matchmaking-player-info', 'history-loading', 'matching', 'game-in-progress',
  'spectating', 'board-white', 'board-black-player-info', 'board-coordinates', 'opponent-turn',
  'byoyomi', 'score-estimation', 'counting-result', 'finished-resign', 'replay-variation',
  'record-review-loading',
];
const hasBaselines = (id: string) => ['desktop', 'mobile'].every(project =>
  existsSync(fileURLToPath(new URL(`./baselines/${project}/${id}.png`, import.meta.url))));

const menu = BASELINE_SCREENS
  .map(id => DEV_SCREENS.find(screen => screen.id === id))
  .filter((screen): screen is Screen => screen !== undefined && hasBaselines(screen.id));

for (const action of ['move', 'pass']) {
  test(`Pass and Request Counting stay enabled while a ${action} is pending`, async ({ page }) => {
    // This preview leaves submitted game actions waiting for a server reply.
    await page.goto('/?dev-screen=board-black');
    const pass = page.getByRole('button', { name: 'Pass', exact: true });
    const requestCounting = page.getByRole('button', { name: 'Request Counting', exact: true });
    await expect(page.locator('#black-player.to-play')).toBeVisible();

    if (action === 'move') await page.locator('#board').click();
    else await pass.click();
    await expect(page.locator('#white-player.to-play')).toBeVisible();
    await expect(pass).toBeEnabled();
    await expect(requestCounting).toBeEnabled();

    const error = page.locator('#board-status').and(page.getByRole('alert'));
    await pass.click();
    await expect(error).toHaveText('Error: can only pass on your turn');
    await requestCounting.click();
    await expect(error).toHaveText('Error: can only request counting on your turn');
  });
}

for (const screen of menu) {
  test(screen.id, async ({ page }) => {
    // Keep sample clocks and history dates identical across runs without
    // stopping the timers used to initialize the app and local score engine.
    await page.clock.setFixedTime('2026-10-23T12:00:00Z');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/?dev-screen=${screen.id}`);
    await page.locator('#dev-menu-toggle').waitFor({ state: 'visible' });
    const loginBackground = ['disconnected', 'error', 'connecting', 'authenticating', 'bootstrap', 'gateway', 'resuming'].includes(screen.phase);
    if (loginBackground) {
      await expect(page.locator('main .layout')).toBeHidden();
      await expect(page.locator('main')).toHaveAttribute('inert', '');
      await expect(page.locator('#board')).toBeHidden();
      await expect(page.locator('#connection-layer')).toBeVisible();
      expect(await page.locator('#connection-layer').evaluate(el => getComputedStyle(el).backdropFilter)).toBe('none');
    }
    if (screen.coordinates) {
      const padding = await page.locator('main').evaluate(main => {
        const style = getComputedStyle(main);
        return { top: style.paddingTop, bottom: style.paddingBottom };
      });
      expect(padding).toEqual({ top: '0px', bottom: '0px' });
      const labels = page.locator('#board .board-coordinates text');
      await expect(labels).toHaveCount(76);
      await expect(labels).toHaveText(Array.from({ length: 19 }, (_, i) =>
        ['ABCDEFGHJKLMNOPQRST'[i], 'ABCDEFGHJKLMNOPQRST'[i], String(19 - i), String(19 - i)]).flat());
      await page.keyboard.press('c');
      await expect(labels).toHaveCount(76);
      const layout = await page.locator('#board').evaluate(board => {
        const svg = board as unknown as SVGSVGElement;
        const view = svg.getBoundingClientRect();
        const wood = svg.querySelector<SVGRectElement>('.board-surface')!.getBoundingClientRect();
        return {
          outerTop: view.top - svg.closest('main')!.getBoundingClientRect().top,
          outerBottom: svg.closest('main')!.getBoundingClientRect().bottom - view.bottom,
          left: wood.x - view.x,
          top: wood.y - view.y,
          right: view.x + view.width - wood.x - wood.width,
          bottom: view.y + view.height - wood.y - wood.height,
          outside: [...svg.querySelectorAll<SVGTextElement>('.board-coordinates text')].every(label => {
            const box = label.getBoundingClientRect();
            return (box.x + box.width <= wood.x || box.y + box.height <= wood.y ||
              box.x >= wood.x + wood.width || box.y >= wood.y + wood.height) &&
              box.x >= view.x && box.y >= view.y &&
              box.x + box.width <= view.x + view.width && box.y + box.height <= view.y + view.height;
          }),
        };
      });
      if (test.info().project.name === 'desktop')
        expect(layout.outerBottom).toBeCloseTo(layout.outerTop);
      expect(layout.left).toBeCloseTo(27);
      expect(layout.top).toBeCloseTo(27);
      expect(layout.right).toBeCloseTo(27);
      expect(layout.bottom).toBeCloseTo(27);
      expect(layout.outside).toBe(true);
      const playerAlignment = () => page.evaluate(() => {
        const wood = document.querySelector('#board .board-surface')!.getBoundingClientRect();
        const player = document.querySelector('.player-panel')!.getBoundingClientRect();
        return Math.round((player.top - wood.top) * 1000) / 1000;
      });
      if (test.info().project.name === 'desktop')
        await expect.poll(playerAlignment).toBeCloseTo(0, 1);
      const renderedFontSizes = () => labels.evaluateAll(elements => elements.map(element => {
        const text = element as SVGTextElement;
        const matrix = text.getScreenCTM()!;
        return Math.round(parseFloat(getComputedStyle(text).fontSize) * Math.hypot(matrix.a, matrix.b) * 1000) / 1000;
      }));
      await expect.poll(renderedFontSizes).toEqual(Array(76).fill(14));
      const viewport = page.viewportSize()!;
      await page.setViewportSize({ ...viewport, width: test.info().project.name === 'mobile' ? 320 : 1024 });
      await expect.poll(renderedFontSizes).toEqual(Array(76).fill(14));
      if (test.info().project.name === 'desktop')
        await expect.poll(playerAlignment).toBeCloseTo(0, 1);
      await page.setViewportSize(viewport);
      await expect.poll(renderedFontSizes).toEqual(Array(76).fill(14));
      const gap = await page.locator('.layout').evaluate(element => {
        const board = element.querySelector('.board-wrap')!.getBoundingClientRect();
        const sidebar = element.querySelector('aside')!.getBoundingClientRect();
        return innerWidth <= 800 ? sidebar.top - board.bottom : sidebar.left - board.right;
      });
      expect(gap).toBe(test.info().project.name === 'mobile' ? 0 : 4);
    }
    if (screen.playerName) {
      await expect(page.locator('.player-info')).toBeVisible();
      if (screen.id === 'history-loading') {
        await expect(page.locator('.player-info-summary')).toContainText('Loading player details');
      } else {
        await expect(page.locator('.player-info-games tbody tr')).toHaveCount(20);
        await expect(page.locator('.player-info-summary')).toContainText(screen.id === 'board-white-player-info' ? '157 wins' : '427 wins');
      }
    }
    if (screen.id === 'matchmaking-rejected') {
      await expect(page.locator('#matchmaking-error')).toHaveCount(0);
      await expect(page.locator('#match')).toBeEnabled();
    }
    if (screen.id === 'matchmaking') {
      await expect(page.locator('#time-controls .matchmaking-button')).toHaveText([
        '19,1m20s(727)',
        '19,5m30s(612)',
        '19,20m60s(493)',
      ]);
    }
    if (screen.id === 'score-estimation') {
      await expect(page.locator('#estimation-lead')).toBeVisible();
    }
    if (screen.id === 'counting-result') {
      await expect(page.locator('#board .counted-territory .territory-black').first()).toBeVisible();
      await expect(page.locator('#board .counted-territory .territory-white').first()).toBeVisible();
      await expect(page.locator('#counting-dialog')).toBeVisible();
      await expect(page.locator('#counting-result')).toHaveText('B+33.5');
    }
    if (screen.id === 'byoyomi') {
      await expect(page.locator('#board .byoyomi-countdown')).toHaveText('9');
      await expect(page.locator('#board .byoyomi-countdown')).toHaveCSS('font-size', '24px');
      await expect(page.locator('#board .byoyomi-countdown')).toHaveCSS('font-weight', '700');
      await expect(page.locator('#board .byoyomi-countdown')).toHaveAttribute('fill', '#000');
      await expect(page.locator('#board polygon')).toHaveCount(0);
    }
    await page.evaluate(() => document.fonts.ready);
    for (const id of ['pass', 'request-score', 'resign', 'estimate-score']) {
      if (loginBackground || ['ready', 'matching', 'joining', 'finished'].includes(screen.phase)) {
        await expect(page.locator(`#${id}`)).toBeHidden();
        continue;
      }
      await expect(page.locator(`#${id}`)).toBeVisible();
      if (!['playing', 'finished', 'reconnecting'].includes(screen.phase))
        await expect(page.locator(`#${id}`)).toBeDisabled();
    }
    if (screen.phase === 'finished' && !screen.record) {
      const spacing = await page.evaluate(() => {
        const panel = document.getElementById('game-state-panel')!.getBoundingClientRect();
        const review = document.getElementById('game-review')!.getBoundingClientRect();
        const heading = document.getElementById('game-state-heading')!.getBoundingClientRect();
        const quit = document.getElementById('quit-room')!.getBoundingClientRect();
        const primary = getComputedStyle(document.getElementById('primary-actions')!);
        return {
          quitBottom: quit.bottom,
          panelTop: panel.top,
          reviewTop: review.top,
          headingBottom: heading.bottom,
          actionGap: parseFloat(primary.gap),
          panelGap: parseFloat(getComputedStyle(document.getElementById('game-state-panel')!).gap),
          sidebarGap: parseFloat(getComputedStyle(document.getElementById('sidebar-content')!).gap),
        };
      });
      expect(spacing.panelTop - spacing.quitBottom).toBe(spacing.sidebarGap);
      expect(spacing.reviewTop - spacing.headingBottom).toBe(spacing.panelGap);
      if (test.info().project.name === 'mobile') {
        const download = await page.locator('#game-downloads').boundingBox();
        const quit = await page.locator('#quit-room').boundingBox();
        expect(download).not.toBeNull();
        expect(quit).not.toBeNull();
        const heading = await page.locator('#game-state-heading').boundingBox();
        const title = await page.locator('#game-result').boundingBox();
        expect(download!.y + download!.height / 2).toBe(heading!.y + heading!.height / 2);
        expect(download!.x - title!.x - title!.width).toBe(spacing.actionGap / 2);
        expect(download!.width).toBe(download!.height);
        expect(quit!.y + quit!.height).toBeLessThan(heading!.y);
        const panelSpacing = await page.locator('#game-state-panel').evaluate(panel => {
          const style = getComputedStyle(panel);
          return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft, style.gap].map(parseFloat);
        });
        expect(panelSpacing).toEqual([12, 12, 12, 12, spacing.panelGap]);
      }
      const offsets = await page.locator('#game-review button').evaluateAll(buttons =>
        buttons.map(button => {
          const bounds = button.getBoundingClientRect();
          const icon = button.querySelector('svg')!.getBoundingClientRect();
          const path = button.querySelector('path')!.getBoundingClientRect();
          return {
            id: button.id,
            svgX: icon.x + icon.width / 2 - bounds.x - bounds.width / 2,
            svgY: icon.y + icon.height / 2 - bounds.y - bounds.height / 2,
            pathX: path.x + path.width / 2 - bounds.x - bounds.width / 2,
            pathY: path.y + path.height / 2 - bounds.y - bounds.height / 2,
          };
        }),
      );
      expect(offsets).toHaveLength(4);
      for (const { id, ...offset } of offsets)
        for (const [axis, pixels] of Object.entries(offset))
          expect(Math.abs(pixels), `${id} ${axis} offset in pixels`).toBeLessThan(0.01);
    }
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot(`${screen.id}.png`, { fullPage: true });
    if (screen.id === 'opponent-turn') {
      const error = page.locator('#game-state-panel #board-status').and(page.getByRole('alert'));
      await page.getByRole('button', { name: 'Pass', exact: true }).click();
      await expect(error).toHaveText('Error: can only pass on your turn');
      await expect(error).toBeInViewport();
      await page.getByRole('button', { name: 'Request Counting', exact: true }).click();
      await expect(error).toHaveText('Error: can only request counting on your turn');
      await expect(error).toBeInViewport();
    }
    if (screen.id === 'matchmaking') {
      const timeControls = page.locator('#time-controls button');
      await expect(timeControls).toHaveCount(3);
      const chosen = timeControls.nth(1);
      await chosen.click();
      await expect(chosen).toHaveText('Searching for 19,5m30s...');
      for (const button of await timeControls.all()) await expect(button).toBeDisabled();
    }
  });
}
