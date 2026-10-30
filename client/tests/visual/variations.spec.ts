import { test, expect } from 'playwright/test';

test('Estimate Score stays disabled throughout game-over replay and variations', async ({ page }) => {
  for (const screen of ['finished', 'replay-variation']) {
    await page.goto(`/?dev-screen=${screen}`);
    const estimate = page.locator('#estimate-score');
    await expect(estimate).toBeVisible();
    await expect(estimate).toBeDisabled();
    await expect(page.locator('#save-sgf')).toBeEnabled();
    await expect(page.locator('#quit-room')).toBeEnabled();
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape']) {
      await page.keyboard.press(key);
      await expect(estimate).toBeVisible();
      await expect(estimate).toBeDisabled();
      await expect(page.locator('#estimation-panel')).toBeHidden();
    }
  }
});

test('Home and End jump to the beginning and end of replay', async ({ page }) => {
  await page.goto('/?dev-screen=finished');
  const first = page.locator('#review-first');
  const last = page.locator('#review-last');
  await expect(first).toBeEnabled();
  await expect(last).toBeDisabled();
  await page.keyboard.press('Home');
  await expect(first).toBeDisabled();
  await expect(page.locator('#review-previous')).toBeDisabled();
  await expect(last).toBeEnabled();
  await page.keyboard.press('End');
  await expect(last).toBeDisabled();
  await expect(page.locator('#review-next')).toBeDisabled();
  await expect(first).toBeEnabled();
});

test('variation navigation and board placement', async ({ page }) => {
  await page.goto('/?dev-screen=replay-variation');
  const numbers = page.locator('#board .variation-number');
  await expect(numbers).toHaveCount(5);
  // Labels render in board order; the actual continuation crosses several rows.
  await expect.poll(async () => (await numbers.allTextContents()).map(Number).sort((a, b) => a - b))
    .toEqual(Array.from({ length: 5 }, (_, i) => i + 1));
  await expect(page.locator('#review-first')).toHaveAccessibleName('First move');
  await expect(page.locator('#review-first')).toBeDisabled();
  await expect(page.locator('#review-last')).toBeDisabled();
  await expect(page.locator('#review-next')).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(numbers).toHaveCount(5);
  await page.keyboard.press('ArrowLeft');
  await expect(numbers).toHaveCount(4);
  await expect(page.locator('#review-next')).toBeEnabled();
  await page.locator('#review-next').click();
  await expect(numbers).toHaveCount(5);
  await page.keyboard.press('ArrowUp');
  await expect(numbers).toHaveCount(5);
  await page.keyboard.press('Escape');
  await expect(numbers).toHaveCount(0);
  await expect(page.locator('#review-first')).toHaveAccessibleName('First move');
  // Click a legal intersection to enter a new variation from the branch point.
  const board = page.locator('#board');
  const bounds = (await board.boundingBox())!;
  const inset = 48 - (744 / 18) / 2 - (744 / 18) * 0.025;
  await board.click({ position: {
    x: (48 + 2 * 744 / 18 - inset) / (840 - 2 * inset) * bounds.width,
    y: (48 + 10 * 744 / 18 - inset) / (840 - 2 * inset) * bounds.height,
  } });
  await expect(numbers).toHaveCount(1);
  await page.keyboard.press('ArrowLeft');
  await expect(numbers).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(numbers).toHaveCount(0);
  await expect(page.locator('#review-next')).toBeDisabled();
});
