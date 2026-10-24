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
    if (screen.playerName) {
      await expect(page.locator(screen.playerName)).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.player-info-games tbody tr')).toHaveCount(10);
      await expect(page.locator('.player-info-summary')).toContainText('128 wins');
    }
    if (screen.id === 'score-estimation') {
      await expect(page.locator('#estimation-lead')).toBeVisible();
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
