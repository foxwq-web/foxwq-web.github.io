import { test, expect } from 'playwright/test';

test('replay controls and shortcuts stay disabled until the estimate is closed', async ({ page }) => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/*.wasm*', async route => {
    await waiting;
    await route.continue();
  });
  await page.goto('/?dev-screen=replay-variation');
  const numbers = page.locator('#board .variation-number');
  await expect(numbers).toHaveCount(15);
  await page.locator('#estimate-score').click();
  const checkBlocked = async () => {
    for (const direction of ['first', 'previous', 'next', 'last'])
      await expect(page.locator(`#review-${direction}`)).toBeDisabled();
    await expect(page.locator('#save-sgf')).toBeDisabled();
    await expect(page.locator('#quit-room')).toBeDisabled();
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'])
      await page.keyboard.press(key);
    await expect(numbers).toHaveCount(15);
    await expect(page.locator('#estimate-score')).toHaveText('Return to Game');
  };
  await checkBlocked();
  release();
  await expect(page.locator('#estimation-lead')).toBeVisible();
  await checkBlocked();
  await page.locator('#estimate-score').click();
  await expect(page.locator('#review-previous')).toBeEnabled();
  await expect(page.locator('#save-sgf')).toBeEnabled();
  await page.keyboard.press('ArrowLeft');
  await expect(numbers).toHaveCount(14);
  await page.keyboard.press('Escape');
  await expect(numbers).toHaveCount(0);
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
  await expect(numbers).toHaveCount(15);
  await expect(numbers).toHaveText(Array.from({ length: 15 }, (_, i) => String(i + 1)));
  await expect(page.locator('#review-first')).toHaveAccessibleName('First move');
  await expect(page.locator('#review-first')).toBeDisabled();
  await expect(page.locator('#review-last')).toBeDisabled();
  await expect(page.locator('#review-next')).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(numbers).toHaveCount(15);
  await page.keyboard.press('ArrowLeft');
  await expect(numbers).toHaveCount(14);
  await expect(page.locator('#review-next')).toBeEnabled();
  await page.locator('#review-next').click();
  await expect(numbers).toHaveCount(15);
  await page.keyboard.press('ArrowUp');
  await expect(numbers).toHaveCount(15);
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
