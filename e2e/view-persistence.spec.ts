import { expect, test } from '@playwright/test';
import { SAMPLE_READY, loadSample, resetSession } from './support';

/**
 * View persistence in a real browser (ADR-031). A reload must return to the
 * same filtered, sorted view instead of the full table — that is the whole
 * point of saving it, and it cannot be verified from a remount alone because
 * a real reload also re-opens IndexedDB and re-runs the query from scratch.
 */

test('a reload returns to the filtered and sorted view', async ({ page }) => {
  await resetSession(page);
  await loadSample(page);

  await page.getByLabel('Search all columns').fill('T-0001');
  await expect(page.getByText(/of 5,000 rows match/)).not.toHaveText(SAMPLE_READY, {
    timeout: 20_000,
  });
  const narrowed = await page.getByText(/of 5,000 rows match/).textContent();

  await page.getByRole('button', { name: 'Sort by Status' }).click();
  await expect(page.getByRole('columnheader', { name: 'Sort by Status' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );

  // The write is debounced; give it room before reloading.
  await page.waitForTimeout(900);
  await page.reload();

  await expect(page.getByText(/of 5,000 rows match/)).toHaveText(narrowed ?? '', {
    timeout: 30_000,
  });
  await expect(page.getByLabel('Search all columns')).toHaveValue('T-0001');
  await expect(page.getByRole('columnheader', { name: 'Sort by Status' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await expect(page.getByText(/Restored your previous session/)).toBeVisible();
});

test('a reload returns to the hidden-columns view and Reset clears it', async ({ page }) => {
  await resetSession(page);
  await loadSample(page);

  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Status' }).uncheck();
  await expect(page.getByText('1 column hidden')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Sort by Status' })).toHaveCount(0);

  await page.waitForTimeout(900);
  await page.reload();

  await expect(page.getByText('1 column hidden')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('columnheader', { name: 'Sort by Status' })).toHaveCount(0);

  // Reset is a full view reset, hidden columns included.
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Sort by Status' })).toBeVisible();
  await expect(page.getByText('1 column hidden')).toHaveCount(0);
});

test('a cleared view does not come back after a reload', async ({ page }) => {
  await resetSession(page);
  await loadSample(page);

  await page.getByLabel('Search all columns').fill('T-0002');
  await expect(page.getByText(/of 5,000 rows match/)).not.toHaveText(SAMPLE_READY, {
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByText(SAMPLE_READY)).toBeVisible({ timeout: 20_000 });

  await page.waitForTimeout(900);
  await page.reload();

  await expect(page.getByText(SAMPLE_READY)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Search all columns')).toHaveValue('');
  await expect(page.getByText(/Restored your previous session/)).toHaveCount(0);
});
