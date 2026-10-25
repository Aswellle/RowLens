import { expect, test, type Page } from '@playwright/test';

/**
 * Column filters, column visibility and the CSV/TSV import-options step,
 * exercised against the production preview build with real workers and
 * IndexedDB.
 */

async function importFixture(
  page: Page,
  path: string,
  options: { startWithDefaults?: boolean } = { startWithDefaults: true },
): Promise<void> {
  await page.goto('/');
  await page.setInputFiles('#file-input', path);
  if (options.startWithDefaults) {
    // CSV/TSV files pass through the import-options step; start with defaults.
    const start = page.getByRole('button', { name: 'Start import' });
    if (await start.isVisible()) await start.click();
  }
}

test('column filter narrows results and reports the active filter count', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/basic.csv');
  await expect(page.getByText('2 of 2 rows match')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.locator('#filter-c1').fill('05'); // matches "1,050" only

  await expect(page.getByText('1 of 2 rows match')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('1 active filter')).toBeVisible();

  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByText('2 of 2 rows match')).toBeVisible({ timeout: 10_000 });
});

test('hiding a column removes its header and cells without changing counts', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/basic.csv');
  await expect(page.getByText('2 of 2 rows match')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('checkbox', { name: 'amount' }).uncheck();

  const grid = page.getByRole('grid', { name: 'Data grid' });
  await expect(grid.getByRole('columnheader').filter({ hasText: 'amount' })).toHaveCount(0);
  await expect(grid.getByText('1,050')).toHaveCount(0);
  // Row count is unaffected — hiding is presentation, not filtering.
  await expect(page.getByText('2 of 2 rows match')).toBeVisible();
});

test('CSV files pass through an import-options step with a header toggle', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/no-header.csv', { startWithDefaults: false });

  // The options step appears instead of importing immediately.
  const headerToggle = page.getByRole('checkbox', { name: 'First row is a header' });
  await expect(headerToggle).toBeVisible();
  await headerToggle.uncheck();
  await page.getByRole('button', { name: 'Start import' }).click();

  await expect(page.getByText('3 of 3 rows match')).toBeVisible({ timeout: 10_000 });
  const grid = page.getByRole('grid', { name: 'Data grid' });
  // Headerless mode generates placeholder labels; "Alice" stays a data row.
  await expect(grid.getByRole('columnheader').filter({ hasText: 'Column 1' })).toHaveCount(1);
  await expect(grid.getByText('Alice')).toBeVisible();
});

test('JSONL files skip the options step and import directly', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/invalid-lines.jsonl');
  // No options panel; the dataset lands straight away.
  await expect(page.getByText('3 of 3 rows match')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('checkbox', { name: 'First row is a header' })).toHaveCount(0);
});

test('sample dataset answers search through the worker path', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try sample data' }).click();
  await expect(page.getByText('5,000 of 5,000 rows match')).toBeVisible({ timeout: 15_000 });

  const search = page.getByLabel('Search all columns');
  await search.fill('chat');
  const status = page.getByText(/of 5,000 rows match/);
  await expect(status).not.toContainText('5,000 of 5,000', { timeout: 10_000 });
  await expect(status).toContainText(/[1-4],\d{3} of 5,000/);
});
