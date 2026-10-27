import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const width of [1280, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const screen of ['finished', 'finished-resign']) {
      await page.goto(`${process.env.FOX_BROWSER_URL || 'http://127.0.0.1:5173'}/?dev-screen=${screen}`);
      await page.locator('#review-previous').waitFor();
      // Counting adds one final move; resignation ends at the sample position.
      if (screen === 'finished') await page.locator('#review-previous').click();
      const clocks = async (text: string) => {
        await page.waitForFunction(text =>
          [...document.querySelectorAll('.clock-text')].every(node => node.textContent === text), text);
        return page.locator('.clock-display').evaluateAll(nodes => nodes.map(node => {
          const { x, y, width, height } = node.getBoundingClientRect();
          const panel = node.closest('.player-panel')!.getBoundingClientRect();
          return { x: x - panel.x, y: y - panel.y, width, height };
        }));
      };
      const nines = await clocks('09:09');
      await page.locator('#review-previous').click();
      await page.locator('#review-previous').click();
      const ones = await clocks('11:11');
      assert.equal(ones.length, 2);
      assert.deepEqual(ones, nines, `${screen}: clock boxes moved or resized at ${width}px`);
      await page.locator('#review-next').click();
      await page.locator('#review-next').click();
      assert.deepEqual(await clocks('09:09'), nines);
      console.log(`${screen} at ${width}px: 11:11 and 09:09 both ${ones[0].width} × ${ones[0].height}px`);
    }
  }
} finally {
  await browser.close();
}
