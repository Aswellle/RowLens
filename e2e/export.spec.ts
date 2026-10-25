import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Export flows against the production preview build with real downloads:
 * content, CRLF endings, safety modes, scopes and the dialog contract.
 */

test.beforeEach(async ({ page }) => {
  // Headless browsers expose showSaveFilePicker but cannot show it; remove it
  // so the export takes the download-fallback path under test.
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
});

async function importFixture(page: Page, path: string): Promise<void> {
  await page.goto('/');
  await page.setInputFiles('#file-input', path);
  const start = page.getByRole('button', { name: 'Start import' });
  if (await start.isVisible()) await start.click();
}

async function exportCurrent(
  page: Page,
  options: { safety?: 'safe' | 'raw'; scope?: 'filtered' | 'all' } = {},
): Promise<{ fileName: string; content: string }> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export CSV' });
  await expect(dialog).toBeVisible();

  if (options.scope === 'all') {
    await dialog.getByRole('radio', { name: /All rows/ }).check();
  }
  if (options.safety === 'raw') {
    await dialog.getByRole('radio', { name: 'Raw CSV' }).check();
    await expect(dialog.getByText(/may interpret cells/)).toBeVisible();
  }

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: /Export CSV/ }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (path === null) throw new Error('download produced no file');
  return {
    fileName: download.suggestedFilename(),
    content: readFileSync(path, 'utf8'),
  };
}

test('exports the filtered view as CRLF CSV that re-parses exactly', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/basic.csv');
  await expect(page.getByText('2 of 2 rows match')).toBeVisible({ timeout: 10_000 });

  const { fileName, content } = await exportCurrent(page);
  expect(fileName).toBe('basic-cleaned.csv');
  expect(content).toBe('id,amount\r\n00123,"1,050"\r\n42,9\r\n');
  await expect(page.getByText(/rows exported/)).toBeVisible();
});

test('spreadsheet-safe mode prefixes formula-looking cells and reports the count', async ({
  page,
}) => {
  await importFixture(page, 'e2e/fixtures/formula.csv');
  await expect(page.getByText('6 of 6 rows match')).toBeVisible({ timeout: 10_000 });

  const { content } = await exportCurrent(page); // safe is the default
  expect(content).toContain("'=1+1");
  expect(content).toContain("'+cmd");
  expect(content).toContain("'-1+2");
  expect(content).toContain("'@SUM(1)");
  expect(content).toContain("'  =spaced"); // whitespace-obscured prefix also caught
  expect(content).toContain('\nok,end\r\n'); // safe value untouched
  await expect(page.getByText('5 cells prefixed for spreadsheet safety')).toBeVisible();
});

test('raw mode exports original values after the warning is shown', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/formula.csv');
  await expect(page.getByText('6 of 6 rows match')).toBeVisible({ timeout: 10_000 });

  const { content } = await exportCurrent(page, { safety: 'raw' });
  expect(content).toContain('=1+1,x');
  expect(content).not.toContain("'=");
  await expect(page.getByText(/rows exported\.$/)).toBeVisible(); // no prefix mention
});

test('scope: filtered honours the current view, all exports the cleaned dataset', async ({
  page,
}) => {
  await importFixture(page, 'e2e/fixtures/duplicates.csv');
  await expect(page.getByText('3 of 3 rows match')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: '+ Remove duplicates' }).click();
  await expect(page.getByText('2 of 3 rows match')).toBeVisible({ timeout: 10_000 });

  const filtered = await exportCurrent(page, { scope: 'filtered' });
  expect(filtered.content).toBe('id,name\r\n1,A\r\n2,B\r\n');

  const all = await exportCurrent(page, { scope: 'all' });
  // All scope = every record through the cleaning pipeline, no query filter.
  expect(all.content).toBe('id,name\r\n1,A\r\n2,B\r\n');
});

test('filtering before export narrows the filtered scope only', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/duplicates.csv');
  await expect(page.getByText('3 of 3 rows match')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.locator('#filter-c0').fill('2');
  await expect(page.getByText('1 of 3 rows match')).toBeVisible({ timeout: 10_000 });

  const filtered = await exportCurrent(page);
  expect(filtered.content).toBe('id,name\r\n2,B\r\n');
});

test('cancel closes the dialog without claiming a save', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/basic.csv');
  await expect(page.getByText('2 of 2 rows match')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Export CSV' })).toHaveCount(0);
  await expect(page.getByText(/rows exported/)).toHaveCount(0);
});
