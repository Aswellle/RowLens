import { expect, test, type Page } from '@playwright/test';
import { PROFILES, generateProfile } from './generate';

/**
 * Startup-restore benchmark (gated behind PERF=1).
 *
 * Measures how long a reload takes to bring back the dataset the user was
 * viewing: the app rebuilds its in-memory store from IndexedDB window reads,
 * so this number is dominated by how many transactions that takes. Results
 * are transcribed into docs/performance-results.md by hand — no number in the
 * docs exists without a real run behind it.
 */

test.skip(!process.env.PERF, 'set PERF=1 to run the restore benchmark');

test.describe.configure({ mode: 'serial' });

const generated = new Map<string, string>();

test.beforeAll(async () => {
  for (const profile of PROFILES) {
    const fixture = await generateProfile(profile, '.bench');
    generated.set(profile.name, fixture.path);
  }
});

async function measureRestore(page: Page, rows: number): Promise<number> {
  const fullStatus = `${rows.toLocaleString('en-US')} of ${rows.toLocaleString('en-US')} rows match`;
  // The debounced session write must land before the reload, otherwise the
  // app has nothing to restore and the measurement is meaningless.
  await page.waitForTimeout(1_000);
  const startedAt = Date.now();
  await page.reload();
  await expect(page.getByText(fullStatus)).toBeVisible({ timeout: 240_000 });
  // The grid paints only after the store is rebuilt and the first query ran.
  await expect(page.locator('[data-cell="0-0"]')).toBeVisible({ timeout: 60_000 });
  return Date.now() - startedAt;
}

for (const profile of PROFILES) {
  test(`${profile.name}: reload restores the dataset`, async ({ page }) => {
    test.setTimeout(300_000);
    const fixturePath = generated.get(profile.name);
    if (!fixturePath) throw new Error(`fixture for ${profile.name} missing`);
    const fullStatus = `${profile.rows.toLocaleString('en-US')} of ${profile.rows.toLocaleString('en-US')} rows match`;

    await page.goto('/');
    await page.setInputFiles('#file-input', fixturePath);
    await page.getByRole('button', { name: 'Start import' }).click();
    await expect(page.getByText(fullStatus)).toBeVisible({ timeout: 240_000 });

    const restoredMs = await measureRestore(page, profile.rows);
    const renderedRows = await page.evaluate(
      () => document.querySelectorAll('[role="grid"] [role="row"]').length,
    );

    // eslint-disable-next-line no-console
    console.log(
      `RESTORE ${profile.name} rows=${profile.rows} ms=${restoredMs} renderedRows=${renderedRows}`,
    );
  });
}
