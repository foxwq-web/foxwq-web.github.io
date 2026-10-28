import { test, expect } from 'playwright/test';
import { DEV_SCREENS } from '../../src/dev-screens';

for (const screen of DEV_SCREENS) {
  test(screen.id, async ({ page }) => {
    // Keep sample clocks and history dates identical across runs without
    // stopping the timers used to initialize the app and local score engine.
    await page.clock.setFixedTime('2026-10-23T12:00:00Z');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/?dev-screen=${screen.id}`);
    await page.locator('#dev-menu-toggle').waitFor({ state: 'visible' });
    if (screen.coordinates) {
      await expect(page.locator('main')).toHaveCSS('padding-bottom', '0px');
      const labels = page.locator('#board .board-coordinates text');
      await expect(labels).toHaveCount(38);
      await expect(labels).toHaveText(Array.from({ length: 19 }, (_, i) =>
        ['ABCDEFGHJKLMNOPQRST'[i], String(19 - i)]).flat());
      await page.keyboard.press('c');
      await expect(labels).toHaveCount(38);
      const layout = await page.locator('#board').evaluate(board => {
        const svg = board as unknown as SVGSVGElement;
        const view = svg.getBoundingClientRect();
        const wood = svg.querySelector<SVGRectElement>('.board-surface')!.getBoundingClientRect();
        return {
          left: wood.x - view.x,
          top: wood.y - view.y,
          right: view.x + view.width - wood.x - wood.width,
          bottom: view.y + view.height - wood.y - wood.height,
          outside: [...svg.querySelectorAll<SVGTextElement>('.board-coordinates text')].every(label => {
            const box = label.getBoundingClientRect();
            return (box.x >= wood.x + wood.width || box.y >= wood.y + wood.height) &&
              box.x + box.width <= view.x + view.width && box.y + box.height <= view.y + view.height;
          }),
        };
      });
      expect(layout.left).toBe(0);
      expect(layout.top).toBe(0);
      expect(layout.right).toBeCloseTo(26.3);
      expect(layout.bottom).toBeCloseTo(26.3);
      expect(layout.outside).toBe(true);
      const renderedFontSizes = () => labels.evaluateAll(elements => elements.map(element => {
        const text = element as SVGTextElement;
        const matrix = text.getScreenCTM()!;
        return Math.round(parseFloat(getComputedStyle(text).fontSize) * Math.hypot(matrix.a, matrix.b) * 1000) / 1000;
      }));
      await expect.poll(renderedFontSizes).toEqual(Array(38).fill(14));
      const viewport = page.viewportSize()!;
      await page.setViewportSize({ ...viewport, width: test.info().project.name === 'mobile' ? 320 : 1024 });
      await expect.poll(renderedFontSizes).toEqual(Array(38).fill(14));
      await page.setViewportSize(viewport);
      await expect.poll(renderedFontSizes).toEqual(Array(38).fill(14));
      const gap = await page.locator('.layout').evaluate(element => {
        const board = element.querySelector('.board-wrap')!.getBoundingClientRect();
        const sidebar = element.querySelector('aside')!.getBoundingClientRect();
        return innerWidth <= 800 ? sidebar.top - board.bottom : sidebar.left - board.right;
      });
      expect(gap).toBe(test.info().project.name === 'mobile' ? 0 : 4);
    }
    if (screen.playerName) {
      await expect(page.locator(screen.playerName)).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.player-info-games tbody tr')).toHaveCount(10);
      await expect(page.locator('.player-info-summary')).toContainText('128 wins');
    }
    if (screen.id === 'score-estimation') {
      await expect(page.locator('#estimation-lead')).toBeVisible();
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
      await expect(page.locator(`#${id}`)).toBeVisible();
      if (!['playing', 'finished', 'reconnecting'].includes(screen.phase))
        await expect(page.locator(`#${id}`)).toBeDisabled();
    }
    if (screen.phase === 'finished') {
      const spacing = await page.evaluate(() => {
        const result = document.getElementById('game-state-panel')!.getBoundingClientRect();
        const review = document.getElementById('game-review')!.getBoundingClientRect();
        return {
          resultToReview: review.top - result.bottom,
          sidebarGap: parseFloat(getComputedStyle(document.getElementById('sidebar-content')!).gap),
        };
      });
      expect(spacing.resultToReview).toBe(spacing.sidebarGap);
      if (test.info().project.name === 'mobile') {
        const download = await page.locator('#save-sgf').boundingBox();
        const quit = await page.locator('#quit-room').boundingBox();
        expect(download).not.toBeNull();
        expect(quit).not.toBeNull();
        expect(download!.y).toBe(quit!.y);
        expect(download!.x + download!.width).toBeLessThan(quit!.x);
        expect(download!.width).toBe(quit!.width);
        expect(quit!.x - download!.x - download!.width).toBe(spacing.sidebarGap);
        const panelSpacing = await page.locator('#game-state-panel').evaluate(panel => {
          const style = getComputedStyle(panel);
          return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft, style.gap].map(parseFloat);
        });
        expect(panelSpacing).toEqual(Array(5).fill(spacing.sidebarGap));
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
  });
}
