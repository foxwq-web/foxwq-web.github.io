import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  // Playwright disables this optimization by default; exercise Chrome's real
  // history cache instead of silently testing ordinary page loads.
  ignoreDefaultArgs: ["--disable-back-forward-cache"],
});
try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    sessionStorage.setItem("history-loads", String(Number(sessionStorage.getItem("history-loads")) + 1));
    window.addEventListener("pageshow", event => {
      if (event.persisted) sessionStorage.setItem("history-restored", "true");
    });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const url = process.env.FOX_BROWSER_URL!;
  await page.goto(`${url}/?history-predecessor`);
  await page.locator("#username").waitFor();
  await page.goto(url);
  await page.locator("#username").fill("BeforeNavigation");
  const loads = await page.evaluate(() => Number(sessionStorage.getItem("history-loads")));

  // Repeat to catch reload loops or a handler that only works on the first trip.
  for (let trip = 1; trip <= 2; trip++) {
    await page.goBack({ waitUntil: "commit" });
    await page.waitForURL(`${url}/?history-predecessor`, { waitUntil: "commit" });
    await page.locator("#username").waitFor();
    await page.goForward({ waitUntil: "commit" });
    await page.waitForURL(url, { waitUntil: "commit" });
    await page.waitForFunction(expected =>
      Number(sessionStorage.getItem("history-loads")) === expected &&
      document.getElementById("username") != null, loads + trip * 2, { timeout: 10000 });
    assert.equal(await page.evaluate(() => sessionStorage.getItem("history-restored")), "true",
      "Navigation must exercise an actual back/forward cache restoration");

    // Exercise controlled React state, not just DOM input values: the disposed
    // controller suppresses these updates and leaves the login button disabled.
    await page.locator("#username").fill(`AfterNavigation${trip}`);
    await page.locator("#password").fill("test-password");
    await page.locator("#remember").check();
    assert.equal(await page.locator("#remember").isChecked(), true);
    assert.equal(await page.locator("#login").isEnabled(), true);
    await page.locator("#remember").uncheck();
    assert.equal(await page.locator("#remember").isChecked(), false);
  }
  assert.deepEqual(errors, []);
  console.log("Browser history passed: cached back/forward restores restart with responsive controls");
} finally {
  await browser.close();
}
