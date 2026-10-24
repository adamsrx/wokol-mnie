// Konfiguracja dodatkowych testów QA (tests/qa/*.spec.mjs). Uruchomienie z katalogu projektu:
//   npx playwright test -c tests/qa/playwright.qa.config.mjs
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const PORT = 4173;

export default defineConfig({
  testDir: here,
  testMatch: /\.spec\.mjs$/,
  outputDir: join(root, 'tests', 'artifacts', 'qa-test-results'),
  timeout: 60_000,
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
    cwd: root,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: true,
    timeout: 20_000,
    stdout: 'ignore',
    stderr: 'ignore',
  },
  projects: [
    { name: 'm360', grep: /@all|@mobile|@m360/, use: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
    { name: 'm430', grep: /@all|@mobile/, use: { viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
    { name: 'desktop', grep: /@all|@desktop/, use: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
  ],
});
