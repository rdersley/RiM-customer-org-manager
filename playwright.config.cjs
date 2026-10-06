const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './ui-tests',
  timeout: 45000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  use: {
    storageState: '.auth/jira.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }]]
});
