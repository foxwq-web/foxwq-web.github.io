import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  testMatch: '*.spec.ts',
  outputDir: './tests/visual/results',
  snapshotPathTemplate: '{testDir}/baselines/{projectName}/{arg}{ext}',
  updateSnapshots: 'none',
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  reporter: 'list',
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 },
  },
  use: {
    browserName: 'chromium',
    headless: true,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    baseURL: 'http://127.0.0.1:4174',
    launchOptions: { args: ['--mute-audio'] },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4174 --strictPort',
    cwd: '..',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    env: { CLIENT_BUILD_SHA: 'visual-regression' },
  },
});
