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

/** Clears the session pointer and IndexedDB so the next visit starts empty. */
export async function resetSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('rowlens:last-dataset');
    } catch {
      // Storage may be blocked; the empty state is the fallback anyway.
    }
  });
  await page.goto('/');
  await page.evaluate(async () => {
    try {
      window.localStorage.removeItem('rowlens:last-dataset');
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs
          .filter((info) => info.name !== undefined)
          .map(
            (info) =>
              new Promise<void>((resolve) => {
                const request = indexedDB.deleteDatabase(info.name!);
                request.onsuccess = () => resolve();
                request.onerror = () => resolve();
                request.onblocked = () => resolve();
              }),
          ),
      );
    } catch {
      // Best effort: a leftover database only affects the restore path.
    }
  });
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
