// Konfiguracja testów dymnych. Aplikacja jest serwowana przez `python3 -m http.server`,
// Wikipedia i Wikimedia są w całości mockowane w tests/smoke.spec.mjs (page.route).
import { defineConfig } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './tests',
  testMatch: /smoke\.spec\.mjs$/,
  outputDir: './tests/artifacts/test-results',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: true,
    timeout: 20_000,
    stdout: 'ignore',
    stderr: 'ignore',
  },
  projects: [
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    },
    {
      name: 'desktop',
      use: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
  ],
});
