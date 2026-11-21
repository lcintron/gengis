// End-to-end tests: the real app in a real browser (Playwright). Run with: npm run e2e
//
// Needs Playwright's Chromium once:  npx playwright install chromium
// (or use a browser already on the computer:  GENGIS_E2E_CHANNEL=msedge npm run e2e   - or "chrome")
//
// Not part of `npm test` (which needs no browser). The app is served by serve.js on port 8080, started here.
'use strict';
const { defineConfig, devices } = require('@playwright/test');

const channel = process.env.GENGIS_E2E_CHANNEL || undefined;

module.exports = defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  fullyParallel: false,
  workers: 1, // one page at a time: the tests share the server, and each has its own browser storage
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8080',
    serviceWorkers: 'block', // the page under test is the files as they are now, never a cached copy
    trace: 'retain-on-failure'
  },
  projects: [{ name: 'chromium', use: Object.assign({}, devices['Desktop Chrome'], channel ? { channel } : {}) }],
  webServer: {
    command: 'node serve.js 8080',
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
