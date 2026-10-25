import { expect, test } from '@playwright/test';

/**
 * Measures the folded-value cache: two consecutive identical searches on the
 * same dataset. The first pass builds the cache; the second should be much
 * faster. PERF=1 gated.
 */
test.skip(!process.env.PERF, 'set PERF=1');

test('search cache: second pass faster than first (P2)', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await page.setInputFiles('#file-input', '.bench/P2-50MB-100kx30.csv');
  await page.getByRole('button', { name: 'Start import' }).click();
  await expect(page.getByText('100,000 of 100,000 rows match')).toBeVisible({
    timeout: 240_000,
  });

  const times: number[] = [];
  const statuses: string[] = [];
  for (let i = 0; i < 2; i++) {
    const start = Date.now();
    await page.fill('#global-search', 'PERFNEEDLE');
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.status-line span');
        return el !== null && !el.textContent?.startsWith('100,000');
      },
      undefined,
      { timeout: 180_000 },
    );
    times.push(Date.now() - start);
    statuses.push((await page.locator('.status-line span').first().textContent()) ?? '');
    if (i === 0) {
      await page.getByRole('button', { name: 'Reset', exact: true }).click();
      await expect(page.getByText('100,000 of 100,000 rows match')).toBeVisible({
        timeout: 120_000,
      });
    }
  }
  console.log('CACHE_BENCH', JSON.stringify({ firstMs: times[0], secondMs: times[1], statuses }));
  expect(statuses[0]).toBe(statuses[1]);
});
