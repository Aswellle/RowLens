import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Cell editing in a real browser: the in-cell editor, its keyboard contract,
 * undo/redo, and the guarantees that make editing safe to use on real data —
 * the stored rows and the source file are never rewritten, and exports carry
 * the edited values.
 */

async function loadSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try sample data' }).click();
  await expect(page.getByText('5,000 of 5,000 rows match')).toBeVisible({ timeout: 20_000 });
}

async function focusCell(page: Page, row: number, column: number): Promise<void> {
  const cell = page.locator(`[data-cell="${row}-${column}"]`);
  // The first render can land between the sample query settling and the grid
  // window being painted, so retry the click once focus is checkable.
  await expect(async () => {
    await cell.locator('.grid-cell__text').click();
    await expect(cell).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
}

async function cellText(page: Page, row: number, column: number): Promise<string> {
  return (
    (await page.locator(`[data-cell="${row}-${column}"] .grid-cell__text`).textContent()) ?? ''
  );
}

test('edits a cell in place and keeps the change across a re-query', async ({ page }) => {
  await loadSample(page);
  await focusCell(page, 0, 0);
  const before = await cellText(page, 0, 0);

  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: /Edit Ticket in Record 1/ });
  await expect(editor).toBeFocused();
  // Enter opens with the current value selected, so typing replaces it.
  await page.keyboard.type('EDITED-0001');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-cell="0-0"] .grid-cell__text')).toHaveText('EDITED-0001');
  await expect(page.locator('[data-cell="0-0"]')).toHaveClass(/grid-cell--edited/);
  await expect(page.getByText('1 cell edited')).toBeVisible();
  expect(before).not.toBe('EDITED-0001');

  // The edited value survives a search round trip: the query worker sees it.
  await page.fill('#global-search', 'EDITED-0001');
  await expect(page.getByText('1 of 5,000 rows match')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-cell="0-0"] .grid-cell__text')).toHaveText('EDITED-0001');
  await page.fill('#global-search', '');
  await expect(page.getByText('5,000 of 5,000 rows match')).toBeVisible({ timeout: 20_000 });
});

test('Escape cancels the draft and leaves the value untouched', async ({ page }) => {
  await loadSample(page);
  await focusCell(page, 0, 1);
  const before = await cellText(page, 0, 1);

  await page.keyboard.press('Enter');
  await page.keyboard.type('discarded');
  await page.keyboard.press('Escape');

  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.locator('[data-cell="0-1"] .grid-cell__text')).toHaveText(before);
  await expect(page.getByText(/cell edited/)).toHaveCount(0);
});

test('typing a character starts a fresh edit, and Tab commits and moves on', async ({ page }) => {
  await loadSample(page);
  await focusCell(page, 0, 2);
  const before = await cellText(page, 0, 2);

  await page.keyboard.type('Z');
  const editor = page.getByRole('textbox', { name: /Edit Priority in Record 1/ });
  // The character replaces the value instead of appending to it.
  await expect(editor).toHaveValue('Z');
  await page.keyboard.type('9');
  await page.keyboard.press('Tab');

  await expect(page.locator('[data-cell="0-2"] .grid-cell__text')).toHaveText('Z9');
  await expect(page.locator('[data-cell="0-3"]')).toBeFocused();
  expect(before).not.toBe('Z9');
});

test('undo and redo restore the stored value and the edit', async ({ page }) => {
  await loadSample(page);
  await focusCell(page, 1, 0);
  const before = await cellText(page, 1, 0);

  await page.keyboard.press('Enter');
  await page.keyboard.type('TEMPORARY');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-cell="1-0"] .grid-cell__text')).toHaveText('TEMPORARY');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('[data-cell="1-0"] .grid-cell__text')).toHaveText(before);

  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.locator('[data-cell="1-0"] .grid-cell__text')).toHaveText('TEMPORARY');

  // The keyboard shortcut works from the grid too.
  await focusCell(page, 1, 0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-cell="1-0"] .grid-cell__text')).toHaveText(before);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('[data-cell="1-0"] .grid-cell__text')).toHaveText('TEMPORARY');
});

test('an exported file contains the edited value, not the original', async ({ page }) => {
  // Headless cannot show the save picker, so the download path is exercised.
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await loadSample(page);
  await focusCell(page, 0, 0);

  await page.keyboard.press('Enter');
  await page.keyboard.type('EXPORTED-EDIT');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-cell="0-0"] .grid-cell__text')).toHaveText('EXPORTED-EDIT');

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export CSV' });
  await expect(dialog).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: /Export CSV/ }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (path === null) throw new Error('download produced no file');
  const content = readFileSync(path, 'utf8');

  const firstDataLine = content.split('\r\n')[1] ?? '';
  expect(firstDataLine.split(',')[0]).toBe('EXPORTED-EDIT');
  // Every record is still exported: editing does not drop or duplicate rows.
  expect(content.split('\r\n').filter((line) => line !== '')).toHaveLength(5001);
});

test('reloading the page discards edits: the stored dataset is untouched', async ({ page }) => {
  await loadSample(page);
  await focusCell(page, 0, 0);
  const before = await cellText(page, 0, 0);

  await page.keyboard.press('Enter');
  await page.keyboard.type('NOT-PERSISTED');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-cell="0-0"] .grid-cell__text')).toHaveText('NOT-PERSISTED');

  // Edits are an in-memory overlay, so a reload shows the imported values
  // again — the imported rows were never rewritten.
  await page.reload();
  await page.getByRole('button', { name: 'Try sample data' }).click();
  await expect(page.getByText('5,000 of 5,000 rows match')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-cell="0-0"] .grid-cell__text')).toHaveText(before);
  await expect(page.getByText(/cell edited/)).toHaveCount(0);
});
