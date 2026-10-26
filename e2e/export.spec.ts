import { readFileSync } from 'node:fs';
import { loadSample, resetSession } from './support';
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
  options: { safety?: 'safe' | 'raw'; scope?: 'filtered' | 'all' | 'selection' } = {},
): Promise<{ fileName: string; content: string }> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export CSV' });
  await expect(dialog).toBeVisible();

  if (options.scope === 'all') {
    await dialog.getByRole('radio', { name: /All rows/ }).check();
  }
  if (options.scope === 'selection') {
    await dialog.getByRole('radio', { name: /Selected range/ }).check();
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

test('the selected range exports exactly the rectangle on screen', async ({ page }) => {
  // Two columns of three rows: selecting the last two rows of both columns
  // exercises row order, column order and the header row of the slice.
  await importFixture(page, 'e2e/fixtures/preset-source.csv');
  await expect(page.getByText('4 of 4 rows match')).toBeVisible({ timeout: 20_000 });

  const cell = (row: number, column: number) => page.locator(`[data-cell="${row}-${column}"]`);
  await expect(async () => {
    await cell(1, 0).locator('.grid-cell__text').click();
    await expect(cell(1, 0)).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.getByText('3 × 2 selected')).toBeVisible();

  const { fileName, content } = await exportCurrent(page, { scope: 'selection' });
  expect(fileName).toMatch(/\.csv$/);
  const lines = content.split('\r\n').filter((line) => line !== '');
  // Header + the three selected rows (records 2–4), both columns.
  expect(lines).toEqual(['Ticket,Status', 'A-2,pending', 'A-2,pending', 'A-3,closed']);
});

test('a single focused cell offers no Selected-range scope', async ({ page }) => {
  await importFixture(page, 'e2e/fixtures/duplicates.csv');
  await expect(page.getByText('3 of 3 rows match')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export CSV' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Selected range/ })).toHaveCount(0);
  await expect(dialog.getByRole('radio', { name: /Filtered rows/ })).toBeChecked();
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('exporting a restored dataset writes real values beyond the restored window', async ({
  page,
}) => {
  // Regression (ADR-037): after a reload the dataset is backed by the lazy
  // chunk store; only the prefetched window is in memory. Exporting used to
  // read the render cache and wrote empty cells for every unloaded chunk.
  await resetSession(page);
  await loadSample(page);
  await page.reload();
  await expect(page.getByText('5,000 of 5,000 rows match')).toBeVisible({ timeout: 30_000 });

  const { content } = await exportCurrent(page, { scope: 'all' });
  const lines = content.split('\r\n').filter((line) => line !== '');
  expect(lines).toHaveLength(5_001); // header + 5,000 records
  expect(lines[1]).toContain('T-00001');
  // Chunk 6 (rows 3,000+) is far beyond the restored prefetch window.
  expect(lines[3_001]).toContain('T-03001');
  expect(lines[5_000]).toContain('T-05000');
});
