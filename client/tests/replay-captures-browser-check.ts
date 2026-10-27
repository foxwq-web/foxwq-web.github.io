import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const url = process.env.FOX_BROWSER_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.locator('#username').waitFor();
  await page.evaluate(async () => {
    // Exercise the real application with an offline finished game.
    const sessionPath = '/src/session.ts';
    const { Session } = await import(sessionPath);
    const login = Session.prototype.login;
    Session.prototype.login = function () {
      Session.prototype.login = login;
      this.phase = 'finished';
      this.gameOver = true;
      this.color = 1;
      this.roomKey = { 1: 31000, 2: 63 };
      this.komi = 7.5;
      for (const [color, x, y] of [
        [2, 1, 1], [1, 0, 1], [1, 1, 0], [1, 2, 1], [1, 1, 2],
        [1, 5, 5], [2, 4, 5], [2, 5, 4], [2, 6, 5], [2, 5, 6],
      ]) this.board.play(x, y, color);
      this.board.passTurn();
      this.changed();
    };
  });
  await page.locator('#username').fill('replay-test');
  await page.locator('#password').fill('offline');
  await page.locator('#login').click();
  await page.locator('#game-review').waitFor();

  const captures = async (black: number, white: number) => {
    await page.waitForFunction(({ black, white }) =>
      document.getElementById('black-captures')?.textContent === `Captures: ${black}` &&
      document.getElementById('white-captures')?.textContent === `Captures: ${white} + 7.5`,
    { black, white });
  };
  await captures(1, 1);
  // Passing preserves totals; stepping over each capture changes the relevant panel.
  await page.locator('#review-previous').click();
  await captures(1, 1);
  await page.locator('#review-previous').click();
  await captures(1, 0);
  for (let move = 9; move > 4; move--) await page.locator('#review-previous').click();
  await captures(0, 0);
  await page.locator('#review-next').click();
  await captures(1, 0);
  await page.locator('#review-first').click();
  await captures(0, 0);
  await page.locator('#review-last').click();
  await captures(1, 1);

  // A variation has its own captures, independent of the final game totals.
  await page.locator('#review-first').click();
  const play = async (x: number, y: number) => {
    const board = page.locator('#board');
    const point = await board.evaluate((element, { x, y }) => {
      const svg = element as unknown as SVGSVGElement;
      const point = svg.createSVGPoint();
      point.x = 48 + x * 744 / 18;
      point.y = 48 + y * 744 / 18;
      const screen = point.matrixTransform(svg.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    }, { x, y });
    await page.mouse.click(point.x, point.y);
  };
  for (const [x, y] of [[1, 1], [0, 1], [10, 10], [1, 0], [11, 10], [2, 1], [12, 10]])
    await play(x, y);
  await captures(0, 0);
  await play(1, 2);
  await captures(0, 1);
  await page.locator('#review-previous').click();
  await captures(0, 0);
  await page.locator('#review-next').click();
  await captures(0, 1);
  await page.locator('#review-previous').click();
  await play(4, 4);
  await captures(0, 0);
  for (let move = 8; move > 0; move--) await page.locator('#review-previous').click();
  await captures(0, 0);
  await page.locator('#review-last').click();
  await captures(1, 1);
  assert.deepEqual(errors, []);
  console.log('Replay capture panels: both colors, passes, navigation and alternate variations passed.');
} finally {
  await browser.close();
}
