import { expect, test } from '@playwright/test';

/**
 * Real-browser import flows against the production preview build. Fixtures
 * are tiny synthetic files; the unsupported-format case writes a temp file
 * at runtime.
 */

async function importFixture(page: import('@playwright/test').Page, path: string): Promise<void> {
  await page.goto('/');
  await page.setInputFiles('#file-input', path);
  // CSV/TSV files pass through the import-options step; start with defaults.
  const start = page.getByRole('button', { name: 'Start import' });
  if (await start.isVisible()) await start.click();
}

test('imports a CSV, preserving leading zeros and quoted commas as text', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/basic.csv');

  await expect(page.getByText('2 of 2 rows match')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('basic.csv')).toBeVisible();
  await expect(page.getByText('00123')).toBeVisible(); // leading zeros intact
  await expect(page.getByText('1,050')).toBeVisible(); // quoted comma stays one field
  await expect(page.getByText('Record 1')).toBeVisible();
});

test('keeps quoted fields containing newlines and escaped quotes', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/quoted-newlines.csv');

  await expect(page.getByText('2 of 2 rows match')).toBeVisible({ timeout: 10_000 });
  // The embedded-newline cell renders as one text value inside the grid.
  await expect(
    page.getByRole('grid', { name: 'Data grid' }).getByText('line2 with "quotes"'),
  ).toBeVisible();
});

test('duplicate and empty header labels stay separate columns', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/duplicate-headers.csv');

  await expect(page.getByText('2 of 2 rows match')).toBeVisible({ timeout: 10_000 });
  const grid = page.getByRole('grid', { name: 'Data grid' });
  // Two distinct columns labelled "code" plus one placeholder.
  const codeHeaders = grid.getByRole('columnheader').filter({ hasText: 'code' });
  await expect(codeHeaders).toHaveCount(2);
  await expect(grid.getByRole('columnheader').filter({ hasText: 'Column 2' })).toHaveCount(1);
  // Values from both id columns are present — nothing merged or dropped.
  await expect(grid.getByText('A1')).toBeVisible();
  await expect(grid.getByText('C9')).toBeVisible();
});

test('imports JSONL with invalid lines: valid rows appear, warnings are visible', async ({
  page,
}) => {
  await importFixture(page, 'e2e/fixtures/invalid-lines.jsonl');

  await expect(page.getByText('3 of 3 rows match')).toBeVisible({ timeout: 10_000 });
  const grid = page.getByRole('grid', { name: 'Data grid' });
  await expect(grid.getByText('Ada')).toBeVisible();
  await expect(grid.getByText('Linus')).toBeVisible();
  await expect(page.getByText(/Imported with 2 parse warnings/)).toBeVisible();
});

test('keeps mid-file blank lines and the final record without a newline', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/trailing-blank.csv');

  // Blank line preserved as a record (3 total); final line has no \n.
  await expect(page.getByText('3 of 3 rows match')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('grid', { name: 'Data grid' }).getByText('Cairo')).toBeVisible();
});

test('rejects unsupported formats with an actionable notice', async ({ page }) => {
  await page.goto('/');
  const temp = test.info().outputPath('unsupported.xlsx');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(temp, 'not really xlsx');

  await page.setInputFiles('#file-input', temp);

  await expect(page.getByRole('status')).toContainText(/not a CSV, TSV or JSONL file/, {
    timeout: 5_000,
  });
  // Still on the empty state — no partial import UI.
  await expect(
    page.getByRole('heading', { name: 'Explore a data file. Keep it on your device.' }),
  ).toBeVisible();
});

test('remove clears the dataset and returns to the empty state', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/basic.csv');
  await expect(page.getByText('2 of 2 rows match')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(
    page.getByRole('heading', { name: 'Explore a data file. Keep it on your device.' }),
  ).toBeVisible();
});
