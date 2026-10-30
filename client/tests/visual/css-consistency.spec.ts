import { test, expect } from 'playwright/test';

test('action gaps, control heights, and panel spacing stay linked', async ({ page }) => {
  await page.goto('/?dev-screen=finished');
  await expect(page.locator('#save-sgf')).toBeVisible();
  for (const [gap, height, padding] of [[8, 32, 12], [10, 36, 18]]) {
    const metrics = await page.evaluate(([gap, height, padding]) => {
      const root = document.documentElement.style;
      root.setProperty('--action-gap', `${gap}px`);
      root.setProperty('--control-height', `${height}px`);
      root.setProperty('--panel-padding', `${padding}px`);
      const panel = document.getElementById('game-state-panel')!;
      const download = document.getElementById('save-sgf')!.getBoundingClientRect();
      const quit = document.getElementById('quit-room')!.getBoundingClientRect();
      const title = document.getElementById('game-state-title')!.getBoundingClientRect();
      const panelStyle = getComputedStyle(panel);
      return {
        gaps: ['#primary-actions', '#game-state-panel', '#game-downloads', '#game-review', '#game-review .actions']
          .map(selector => parseFloat(getComputedStyle(document.querySelector(selector)!).gap)),
        buttonGap: innerWidth <= 800 ? quit.left - download.right : quit.top - download.bottom,
        textGap: download.top - title.bottom,
        padding: [panelStyle.paddingTop, panelStyle.paddingRight, panelStyle.paddingBottom, panelStyle.paddingLeft].map(parseFloat),
        buttonHeights: [...document.querySelectorAll('#primary-actions button, #save-sgf, #quit-room')]
          .map(button => button.getBoundingClientRect().height),
        reservedHeight: parseFloat(getComputedStyle(document.querySelector('.primary-actions-slot')!).minHeight),
      };
    }, [gap, height, padding]);
    expect(metrics.gaps).toEqual(Array(5).fill(gap));
    expect(metrics.buttonGap).toBe(gap);
    expect(metrics.textGap).toBe(padding);
    expect(metrics.padding).toEqual(Array(4).fill(padding));
    expect(metrics.buttonHeights).toEqual(Array(6).fill(height));
    expect(metrics.reservedHeight).toBe(test.info().project.name === 'mobile' ? 0 : 4 * height + 3 * gap);
  }
});

test('matching control surfaces and disabled text share their styling', async ({ page }) => {
  for (const background of ['#2b2b2b', '#3a3040']) {
    await page.goto('/?dev-screen=finished');
    await expect(page.locator('.clock-display').first()).toBeVisible();
    const clockStyle = await page.evaluate(background => {
      document.documentElement.style.setProperty('--field-background', background);
      document.documentElement.style.setProperty('--disabled-text', '#96a0aa');
      const clock = getComputedStyle(document.querySelector('.clock-display')!);
      const button = getComputedStyle(document.getElementById('pass')!);
      return { background: clock.backgroundColor, radius: clock.borderRadius, color: clock.color, buttonColor: button.color, buttonRadius: button.borderRadius };
    }, background);
    expect(clockStyle.color).toBe('rgb(150, 160, 170)');
    expect(clockStyle.buttonColor).toBe(clockStyle.color);
    expect(clockStyle.buttonRadius).toBe(clockStyle.radius);
    await page.goto('/?dev-screen=login');
    await expect(page.locator('#username')).toBeVisible();
    const inputStyle = await page.locator('#username').evaluate((input, background) => {
      document.documentElement.style.setProperty('--field-background', background);
      const style = getComputedStyle(input);
      return { background: style.backgroundColor, radius: style.borderRadius };
    }, background);
    expect(inputStyle).toEqual({ background: clockStyle.background, radius: clockStyle.radius });
  }
});

test('player stones keep their width, height, and flex basis together', async ({ page }) => {
  await page.goto('/?dev-screen=board-black-player-info');
  await expect(page.locator('.player-info')).toBeVisible();
  for (const selector of ['.player-title .player-stone', '.history-opponent .player-stone']) {
    const stone = page.locator(selector).first();
    for (const size of [12, 16]) {
      const dimensions = await stone.evaluate((element, size) => {
        (element as HTMLElement).style.setProperty('--stone-size', `${size}px`);
        const style = getComputedStyle(element);
        return [style.width, style.height, style.flexBasis].map(parseFloat);
      }, size);
      expect(dimensions).toEqual([size, size, size]);
    }
  }
  const shadows = await page.locator('#connection-menu, .player-info').evaluateAll(elements =>
    elements.map(element => getComputedStyle(element).boxShadow));
  expect(shadows).toHaveLength(2);
  expect(shadows[0]).not.toBe('none');
  expect(shadows[0]).toBe(shadows[1]);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--player-info-inset', '16px');
    dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => {
    const bounds = (await page.locator('.player-info').boundingBox())!;
    return [bounds.x, 320 - bounds.x - bounds.width];
  }).toEqual([16, 16]);
});
