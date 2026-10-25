import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PROFILES, generateProfile, type BenchProfile } from './bench/generate';

/**
 * Performance benchmarks (testing doc §4). Gated behind PERF=1 so regular
 * runs stay fast; results land in test-results/bench/results.json and are
 * transcribed into docs/performance-results.md by hand — no number in the
 * docs exists without a real run behind it.
 */

test.skip(!process.env.PERF, 'set PERF=1 to run performance benchmarks');

test.describe.configure({ mode: 'serial' });

const BENCH_DIR = join(process.cwd(), 'test-results', 'bench');
const results: Array<Record<string, string | number>> = [];

const generated = new Map<string, { path: string; bytes: number; markerRows: number }>();

test.beforeAll(async () => {
  await mkdir(BENCH_DIR, { recursive: true });
  for (const profile of PROFILES) {
    generated.set(profile.name, await generateProfile(profile, BENCH_DIR));
  }
});

test.afterAll(async () => {
  if (results.length === 0) return;
  await writeFile(join(BENCH_DIR, 'results.json'), JSON.stringify(results, null, 2));
  console.table(results);
});

async function now(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

async function statusText(page: Page): Promise<string> {
  return page.locator('.status-line span').first().textContent() ?? '';
}

async function waitStatusNot(page: Page, previous: string): Promise<void> {
  await page.waitForFunction(
    (prev) => {
      const el = document.querySelector('.status-line span');
      return el !== null && el.textContent !== prev;
    },
    previous,
    { timeout: 120_000 },
  );
}

async function waitBusyCleared(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('.status-line [role="status"]') === null,
    undefined,
    { timeout: 120_000 },
  );
}

for (const profile of PROFILES) {
  test(`${profile.name}: import, search, sort, export`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.addInitScript(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    const fixture = generated.get(profile.name);
    if (!fixture) throw new Error(`fixture for ${profile.name} missing`);

    await page.goto('/');
    const environment = await page.evaluate(() => ({
      ua: navigator.userAgent,
      cores: navigator.hardwareConcurrency,
      memoryGB: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? -1,
    }));

    const heapBefore = await page.evaluate(
      () =>
        (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize ?? -1,
    );

    const fullStatus = `${profile.rows.toLocaleString('en-US')} of ${profile.rows.toLocaleString('en-US')} rows match`;

    const importStart = await now(page);
    await page.setInputFiles('#file-input', fixture.path);
    await page.getByRole('button', { name: 'Start import' }).click();
    await expect(page.getByText(fullStatus)).toBeVisible({ timeout: 240_000 });
    const importMs = (await now(page)) - importStart;

    // Search: fill and wait for the announced count to leave the full value.
    const searchStart = await now(page);
    await page.fill('#global-search', 'PERFNEEDLE');
    await waitStatusNot(page, fullStatus);
    const searchMs = (await now(page)) - searchStart;
    const searchStatus = await statusText(page);

    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(page.getByText(fullStatus)).toBeVisible({ timeout: 120_000 });

    // Sort by col_1: the header state flips immediately; the work ends when
    // the busy marker disappears.
    const sortStart = await now(page);
    await page.getByRole('button', { name: 'Sort by col_1', exact: true }).click();
    await page
      .locator('[role="columnheader"][aria-sort="ascending"]')
      .first()
      .waitFor({ timeout: 120_000 });
    await waitBusyCleared(page);
    const sortMs = (await now(page)) - sortStart;

    // Export the filtered scope (still the full view here) via download.
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const exportStart = await now(page);
    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 });
    await page
      .getByRole('dialog', { name: 'Export CSV' })
      .getByRole('button', { name: /Export CSV/ })
      .click();
    await downloadPromise;
    const exportMs = (await now(page)) - exportStart;

    const heapAfter = await page.evaluate(
      () =>
        (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize ?? -1,
    );

    results.push({
      profile: profile.name,
      fileMiB: +(fixture.bytes / (1024 * 1024)).toFixed(1),
      rows: profile.rows,
      columns: profile.columns,
      importMs: Math.round(importMs),
      searchMs: Math.round(searchMs),
      searchResult: searchStatus,
      sortMs: Math.round(sortMs),
      exportMs: Math.round(exportMs),
      heapBeforeMB: Math.round(heapBefore / 1e6),
      heapAfterMB: Math.round(heapAfter / 1e6),
      cores: environment.cores,
      memoryGB: environment.memoryGB,
      ua: environment.ua.split(' ').slice(-2).join(' '),
    });
  });
}
