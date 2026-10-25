import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against a production preview build so the verified behaviour is
 * what users get, not dev-server-only behaviour.
 *
 * CI uses the bundled Chromium. Locally, if the Playwright CDN download is
 * unavailable, PLAYWRIGHT_CHANNEL=msedge (or chrome) runs the same suite on
 * an installed browser.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  webServer: {
    // Bind IPv4 loopback explicitly: default binding may resolve to IPv6-only
    // on some Windows setups, which the test runner cannot reach.
    command: 'npm run preview -- --port 4173 --strictPort --host 127.0.0.1',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
