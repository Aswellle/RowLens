import type { Page } from '@playwright/test';

/**
 * Shared E2E entry point for the synthetic sample.
 *
 * Since session restore exists, a second visit in the same browser context
 * reopens the remembered dataset instead of showing the empty state, so
 * "click Try sample data" is not a valid assumption on its own. Two rules keep
 * the suites independent of each other:
 *
 * 1. `resetSession` clears the remembered dataset pointer before navigating.
 *    Tests that want a clean start call it; tests that exercise restore do not.
 * 2. `loadSample` tolerates both entry points, so a test that inherits a
 *    restored dataset still ends up in the same known state.
 */
export const SAMPLE_READY = '5,000 of 5,000 rows match';

/**
 * Clears the session pointer and IndexedDB so the next visit starts empty.
 *
 * Two traps this has to avoid:
 *
 * 1. `addInitScript` would re-run on every later navigation and silently wipe
 *    the pointer on the reload a restore test depends on, so the pointer is
 *    cleared by evaluating in the page instead.
 * 2. `indexedDB.deleteDatabase` cannot be used from a blank page: `about:blank`
 *    has an opaque origin, so it sees (and deletes) nothing. Deleting from the
 *    app's own origin is blocked by the connection the app opens at startup.
 *    `Storage.clearDataForOrigin` sidesteps both — it clears the origin's data
 *    through the browser itself, with no connection to block it.
 */
export async function resetSession(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => {
    try {
      window.localStorage.removeItem('rowlens:last-dataset');
    } catch {
      // Storage may be blocked; the empty state is the fallback anyway.
    }
  });
  const origin = new URL(page.url()).origin;
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Storage.clearDataForOrigin', { origin, storageTypes: 'indexeddb' });
  } finally {
    await client.detach().catch(() => undefined);
  }
  // Reload so the next step starts from a fresh app with a clean database.
  await page.goto('/');
}

/**
 * Ensures the synthetic sample is loaded, whether the app started empty or
 * restored a previous dataset.
 */
export async function loadSample(page: Page): Promise<void> {
  await page.goto('/');
  const sampleButton = page.getByRole('button', { name: 'Try sample data' });
  const ready = page.getByText(SAMPLE_READY);
  await expectFirst(sampleButton, ready, page);
  if (await sampleButton.isVisible()) {
    await sampleButton.click();
  }
  await ready.waitFor({ state: 'visible', timeout: 20_000 });
}

/** Waits for whichever of two locators appears first, then returns. */
async function expectFirst(
  first: ReturnType<Page['getByRole']>,
  second: ReturnType<Page['getByText']>,
  page: Page,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await first.isVisible().catch(() => false)) return;
    if (await second.isVisible().catch(() => false)) return;
    await page.waitForTimeout(100);
  }
  throw new Error('neither the sample button nor the restored dataset appeared');
}
