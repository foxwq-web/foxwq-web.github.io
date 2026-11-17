import { test, expect } from 'playwright/test';

test('Back leaves a finished game and then returns from matchmaking to login', async ({ page }) => {
  await page.goto('/matchmaking?dev-screen=finished-resign');
  await expect(page).toHaveURL(/\/play\?dev-screen=finished-resign$/);
  await expect(page.locator('#game-result')).toHaveText('W+R');

  await page.goBack();
  await expect(page).toHaveURL(/\/matchmaking\?dev-screen=finished-resign$/);
  await expect(page.locator('#time-controls')).toBeVisible();
  await expect(page.locator('#login-form')).toBeHidden();

  await page.goBack();
  await expect(page).toHaveURL(/\/\?dev-screen=finished-resign$/);
  await expect(page.locator('#login-form')).toBeVisible();
  await expect(page.locator('#time-controls')).toBeHidden();
});

test('loading /play with no game still opens matchmaking', async ({ page }) => {
  await page.goto('/play?dev-screen=matchmaking');
  await expect(page).toHaveURL(/\/matchmaking\?dev-screen=matchmaking$/);
  await expect(page.locator('#time-controls')).toBeVisible();

  await page.goBack();
  await expect(page.locator('#login-form')).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/\?dev-screen=matchmaking$/);
  await expect(page.locator('#login-form')).toBeVisible();
});

test('Back from reviewing the finished live game returns to matchmaking', async ({ page }) => {
  await page.goto('/?dev-screen=finished-resign');
  await page.locator('#review-previous').click();
  await expect(page).toHaveURL(/\/game\//);

  await page.goBack();
  await expect(page).toHaveURL(/\/matchmaking\?dev-screen=finished-resign$/);
  await expect(page.locator('#time-controls')).toBeVisible();
});

test('Back from active play requires confirmation before leaving', async ({ page }) => {
  await page.goto('/?dev-screen=board-black');
  await expect(page).toHaveURL(/\/play\?/);

  await page.goBack();
  await expect(page.locator('#action-title')).toHaveText('Leave this room?');
  await expect(page).toHaveURL(/\/play\?/);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#action-panel')).toBeHidden();
  await expect(page.locator('#board')).toBeVisible();

  await page.goBack();
  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(page.locator('#board-status')).toHaveText('Leaving room; waiting for confirm resignation...');
  await expect(page).toHaveURL(/\/play\?/);
});
