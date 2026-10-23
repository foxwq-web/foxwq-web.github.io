import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const url = process.env.FOX_BROWSER_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const screen of ['board-black', 'matchmaking']) {
    await page.goto(`${url}/?dev-screen=${screen}`);
    const name = page.locator(screen === 'board-black' ? '#white-player-name' : '#matchmaking-player button');
    await name.hover();
    const card = page.locator('.player-info');
    await card.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.player-info tbody tr').length === 10);
    assert.match(await card.innerText(), /9 wins to promote \(13 for 2 ranks\) \/ 10 losses to demote/);
    assert.doesNotMatch(await card.innerText(), /Recent games|last 20|↑|↓|·/);
    assert.match(await card.locator('tbody td').first().innerText(), /^[A-Z][a-z]{2} \d{1,2}$/);
    assert.equal(await name.evaluate(element => getComputedStyle(element).textDecorationLine), 'none');
    assert.equal(await card.locator('.player-recent span').count(), 20);
    assert.equal(await card.locator('.player-recent').innerText(), '');
    assert.equal(await card.locator('.player-recent .win').first().evaluate(element =>
      getComputedStyle(element, '::before').borderRadius), '50%');
    assert.equal(await card.evaluate(element => getComputedStyle(element).borderTopWidth), '1px');
    assert.equal(await card.locator('th:last-child').evaluate(element => getComputedStyle(element).textAlign), 'right');
    assert.equal(await card.locator('button, a').count(), 0);
    await card.hover();
    await page.waitForTimeout(250);
    assert.equal(await card.count(), 1);
    await page.mouse.move(0, 0);
    await card.waitFor({ state: 'detached' });
    await name.focus();
    await card.waitFor();
    await page.keyboard.press('ArrowDown');
    assert.equal(await card.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached' });
    assert.equal(await name.evaluate(element => element === document.activeElement), true);
    // Escape is consumed by the card and does not open/close the room menu.
    assert.equal(await page.locator('#connection-layer').isVisible(), screen === 'matchmaking');
  }
  for (const [width, height] of [[320, 640], [360, 640], [640, 360]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${url}/?dev-screen=matchmaking`);
    await page.locator('#matchmaking-player button').tap();
    const card = page.locator('.player-info');
    await card.waitFor();
    const bounds = await card.boundingBox();
    assert.ok(bounds);
    assert.ok(bounds.x >= 0 && bounds.y >= 0);
    assert.ok(bounds.x + bounds.width <= width && bounds.y + bounds.height <= height);
    assert.equal(await card.evaluate(element => element.scrollWidth > element.clientWidth), false);
    assert.equal(await page.locator('.player-info-games').evaluate(element => element.scrollHeight > element.clientHeight), false);
    assert.equal(await card.evaluate(element => element.scrollHeight > element.clientHeight), false);
    assert.equal(await card.locator('.player-recent span').evaluateAll(elements =>
      elements.length === 20 && elements.every(element => element.getBoundingClientRect().top === elements[0].getBoundingClientRect().top)), true);
    assert.equal(await page.locator('#connection-menu').evaluate(element => getComputedStyle(element).borderTopWidth), '1px');
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached' });
  }
  assert.deepEqual(errors, []);
  console.log('Player hover cards: game, matchmaking, pointer, keyboard, touch and viewport checks passed.');
} finally { await browser.close(); }
