import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const ownColor of [1, 2]) {
    await page.goto(process.env.FOX_BROWSER_URL || 'http://127.0.0.1:5173');
    await page.locator('#username').waitFor();
    await page.evaluate(async ownColor => {
      const sessionPath = '/src/session.ts', wirePath = '/src/wire.ts';
      const { Session } = await import(sessionPath);
      const { encode, decode } = await import(wirePath);
      const login = Session.prototype.login;
      Session.prototype.login = function () {
        Session.prototype.login = login;
        this.uid = 42;
        this.phase = 'playing';
        this.color = ownColor;
        this.board.turn = 3 - ownColor;
        this.players = { [ownColor]: { id: 42 }, [3 - ownColor]: { id: 43 } };
        this.clocks[3 - ownColor] = { main: 1200, periods: 3, byoyomi: 60, at: Date.now() / 1000 - 10 };
        const testWindow = window as typeof window & { disconnectNotice: (op: number) => void; expireDisconnect: () => void };
        testWindow.disconnectNotice = op => this.gameSvrProcess(op,
          decode(encode(op === 503 ? { 1: 43, 2: 90 } : { 1: 43 })), decode(encode({})));
        testWindow.expireDisconnect = () => { this.opponentDisconnectDeadline = Date.now() / 1000 - 1; this.changed(); };
        this.changed();
      };
    }, ownColor);
    await page.locator('#username').fill('disconnect-test');
    await page.locator('#password').fill('offline');
    await page.locator('#login').click();
    const opponent = ownColor === 1 ? 'white' : 'black';
    const panel = page.locator(`#${opponent}-player`);
    const clock = panel.locator('time');
    await page.waitForFunction(opponent => document.getElementById(`${opponent}-player`)?.classList.contains('to-play'), opponent);
    await page.evaluate('disconnectNotice(503)');
    await page.waitForFunction(opponent => !document.getElementById(`${opponent}-player`)?.classList.contains('to-play'), opponent);
    const frozenTime = await clock.getAttribute('datetime');
    await page.waitForTimeout(1200);
    assert.equal(await clock.getAttribute('datetime'), frozenTime);
    assert.equal(await clock.evaluate(node => getComputedStyle(node).color), 'rgb(153, 153, 153)');
    await page.evaluate('expireDisconnect()');
    await page.waitForFunction(() => document.getElementById('opponent-connection-status')?.textContent === 'Opponent disconnected (0:00)');
    assert.equal(await panel.evaluate(node => node.classList.contains('to-play')), false);
    await page.evaluate('disconnectNotice(504)');
    await page.waitForFunction(opponent => document.getElementById(`${opponent}-player`)?.classList.contains('to-play'), opponent);
    await page.waitForFunction(({ opponent, frozenTime }) =>
      document.querySelector(`#${opponent}-time time`)?.getAttribute('datetime') !== frozenTime, { opponent, frozenTime });
  }
  assert.deepEqual(errors, []);
  console.log('Browser disconnect clocks passed: both colors freeze, dim, stay off after deadline expiry, and resume on reconnect');
} finally {
  await browser.close();
}
