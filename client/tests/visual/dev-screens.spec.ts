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
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot(`${screen.id}.png`, { fullPage: true });
  });
}
