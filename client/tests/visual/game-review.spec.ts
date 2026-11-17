import { readFile } from 'node:fs/promises';
import { test, expect } from 'playwright/test';

test('review changes the URL on demand and keeps player cards and the connected lobby', async ({ page, isMobile }) => {
  await page.goto('/?dev-screen=finished-resign');
  await expect(page.locator('#game-result')).toHaveText('W+R');
  expect(new URL(page.url()).pathname).toBe('/play');
  await expect(page.locator('.player-panel img.player-flag')).toHaveCount(0);
  await expect(page.locator('#black-player-name .player-rank')).toHaveCSS('color', 'rgb(170, 170, 170)');
  await page.locator('#review-previous').click();
  await expect(page).toHaveURL(/\/game\/[A-Za-z0-9_-]{11}\?/);
  await expect(page.locator('.player-panel img.player-flag')).toHaveCount(0);
  const playerName = page.locator('#black-player-name');
  if (isMobile) await playerName.tap();
  else await playerName.click();
  await expect(page.locator('.player-info')).toBeVisible();
  await expect(page.locator('.player-info h2 .player-flag + span + .player-rank')).toHaveCSS('color', 'rgb(170, 170, 170)');
  await expect(page.locator('.player-info-games tbody tr')).toHaveCount(10);
  await page.keyboard.press('Escape');
  await expect(page.locator('.player-info')).toBeHidden();
  await page.locator('#quit-room').click();
  await expect(page.locator('#time-controls')).toBeVisible();
  await expect(page.locator('#matchmaking-player .player-flag')).toHaveCount(0);
  await expect(page.locator('#matchmaking-player .player-rank')).toHaveCSS('color', 'rgb(170, 170, 170)');
  await expect(page.locator('#login-form')).toBeHidden();
  await expect(page).toHaveURL(/\/matchmaking\?/);
  expect(new URL(page.url()).searchParams.has('move')).toBe(false);
});

test('reloading a game review restores its position with offline player labels', async ({ page }) => {
  await page.goto('/?dev-screen=finished-resign');
  await page.locator('#review-previous').click();
  await expect(page).toHaveURL(/\/game\/[A-Za-z0-9_-]{11}\?/);
  const url = page.url();
  await page.reload();
  await expect(page.locator('#game-result')).toHaveText('W+R');
  await expect(page.locator('#black-player-name')).toHaveJSProperty('tagName', 'SPAN');
  await expect(page.locator('.player-panel .player-name')).toHaveCount(0);
  await expect(page.locator('.player-panel img.player-flag')).toHaveCount(0);
  await expect(page.locator('#black-player-name .player-rank')).toHaveCSS('color', 'rgb(170, 170, 170)');
  expect(page.url()).toBe(url);
});

test('resignation makes review and download usable before the server replies', async ({ page }) => {
  await page.clock.install();
  await page.goto('/?dev-screen=resign-delayed');
  await page.getByRole('button', { name: 'Resign', exact: true }).click();
  await expect(page.locator('#game-state-heading')).toBeHidden();
  await page.getByRole('button', { name: 'Confirm resignation' }).click();

  const title = page.locator('#game-state-title');
  await expect(title).toHaveText('Game over: B+R');
  await expect(page.locator('#game-result')).toBeVisible();
  await expect(page.locator('#primary-actions')).toBeHidden();
  await expect(page.locator('#quit-room')).toBeVisible();
  await expect(page.locator('#quit-room')).toBeEnabled();
  await expect(page.locator('#board-status')).toBeHidden();
  await expect(page.locator('#game-review')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-sgf').click();
  const download = await downloadPromise;
  expect(await readFile(await download.path(), 'utf8')).toContain('RE[B+R]');
  await page.locator('#review-previous').click();
  await expect(page.locator('#review-next')).toBeEnabled();
  expect(new URL(page.url()).pathname).toBe('/play');
  const preview = await title.boundingBox();

  await page.clock.runFor(2000);
  await expect(page.locator('#quit-room')).toBeEnabled();
  await expect(page.locator('#game-review')).toBeVisible();
  await expect(page.locator('#review-next')).toBeEnabled();
  await expect(page.locator('#save-sgf')).toBeVisible();
  await expect(page.locator('#primary-actions')).toBeHidden();
  await expect(title).toHaveText('Game over: B+R');
  expect((await title.boundingBox())?.y).toBe(preview?.y);
});

test('quit room can be requested while resignation is pending', async ({ page }) => {
  await page.clock.install();
  await page.goto('/?dev-screen=resign-delayed');
  await page.getByRole('button', { name: 'Resign', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm resignation' }).click();
  await page.locator('#quit-room').click();
  await expect(page.locator('#quit-room')).toBeDisabled();
  await expect(page.locator('#game-state-title')).toHaveText('Game over: B+R');

  await page.clock.runFor(2000);
  await expect(page).toHaveURL(/\/matchmaking\?/);
  await expect(page.locator('#time-controls')).toBeVisible();
});
