import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  workers: 1,
  reporter: [['list'], ['json', {outputFile:'test-results/playwright-results.json'}]],
  use: {trace:'retain-on-failure',screenshot:'only-on-failure'},
});
