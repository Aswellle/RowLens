import { expect, test } from '@playwright/test';
import { PROFILES, generateProfile } from './generate';

/**
 * Memory behaviour of a restored dataset while scrolling the whole file
 * (gated behind PERF=1).
 *
 * Before eviction, scrolling through a 250k-row file left every chunk in
 * memory, so a restored session ended up holding as much as a fresh import.
 * The number that matters is the chunk count and the JS heap after a full
 * pass, not the first-paint latency (that is measured separately).
 */

test.skip(!process.env.PERF, 'set PERF=1 to run the scroll-memory benchmark');

test.describe.configure({ mode: 'serial' });

const profile = PROFILES[2]!; // P3: 250k rows × 40 columns
let fixturePath = '';

test.beforeAll(async () => {
  const fixture = await generateProfile(profile, '.bench');
  fixturePath = fixture.path;
});

test(`${profile.name}: scrolling the whole file keeps memory bounded`, async ({ page }) => {
  test.setTimeout(600_000);
  const fullStatus = `${profile.rows.toLocaleString('en-US')} of ${profile.rows.toLocaleString('en-US')} rows match`;

  await page.goto('/');
  await page.setInputFiles('#file-input', fixturePath);
  await page.getByRole('button', { name: 'Start import' }).click();
  await expect(page.getByText(fullStatus)).toBeVisible({ timeout: 300_000 });
  await page.waitForTimeout(1_000);

  // Reload so the session runs on the lazy store rather than the import store.
  await page.reload();
  await expect(page.getByText(fullStatus)).toBeVisible({ timeout: 300_000 });

  const heapBefore = await page.evaluate(
    () =>
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
      -1,
  );

  // Walk the file in jumps of 20 chunks (10,000 rows): enough to touch every
  // chunk, few enough steps to stay inside the timeout. A jump also exercises
  // the eviction path harder than smooth scrolling, because each step makes
  // the previous window evictable.
  const jumpRows = 10_000;
  const steps = Math.ceil(profile.rows / jumpRows);
  const startedAt = Date.now();
  for (let step = 0; step < steps; step += 1) {
    const row = Math.min(profile.rows - 1, step * jumpRows);
    await page.evaluate((topRow) => {
      const container = document.querySelector<HTMLElement>('.grid-scroll');
      if (container) container.scrollTop = topRow * 36; // row height
    }, row);
    // Let the chunk fetch for this position land before jumping again.
    await page.waitForTimeout(120);
  }
  const scrollMs = Date.now() - startedAt;
  expect(steps).toBeGreaterThan(1);

  await page.waitForTimeout(1_000);
  const heapAfter = await page.evaluate(
    () =>
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
      -1,
  );

  // eslint-disable-next-line no-console
  console.log(
    `SCROLL-MEM ${profile.name} steps=${steps} scrollMs=${scrollMs} ` +
      `heapBeforeMB=${Math.round(heapBefore / 1e6)} heapAfterMB=${Math.round(heapAfter / 1e6)}`,
  );
});
