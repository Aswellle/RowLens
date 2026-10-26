import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { loadSample } from './support';

/**
 * Cell editing in a real browser: the in-cell editor, its keyboard contract,
 * undo/redo, and the guarantees that make editing safe to use on real data —
 * the stored rows and the source file are never rewritten, and exports carry
 * the edited values.
 */

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

test('reloading restores the dataset and its edits from the separate store', async ({ page }) => {
  await loadSample(page);
  await focusCell(page, 0, 0);
  const before = await cellText(page, 0, 0);

  await page.keyboard.press('Enter');
  await page.keyboard.type('PERSISTED-EDIT');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-cell="0-0"] .grid-cell__text')).toHaveText('PERSISTED-EDIT');
  await expect(page.getByText('1 cell edited')).toBeVisible();

  // Give the debounced write time to land, then reload without touching the UI.
  await page.waitForTimeout(1_000);
  await page.reload();

  // The app reopens the last dataset on its own and restores the edit. The
  // row count can appear before the restored overlay has rendered, so the
  // assertion polls instead of racing the restore.
  await expect(page.getByText('5,000 of 5,000 rows match')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-cell="0-0"]')).toHaveClass(/grid-cell--edited/, {
    timeout: 10_000,
  });
  await expect(page.locator('[data-cell="0-0"] .grid-cell__text')).toHaveText('PERSISTED-EDIT');
  await expect(page.getByText('1 cell edited')).toBeVisible();

  // A reloaded session has no undo history (undo cannot reach past the
  // reload), so the way back to the imported value is Reset edits.
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await page.getByRole('button', { name: 'Reset edits' }).click();
  await expect(page.locator('[data-cell="0-0"] .grid-cell__text')).toHaveText(before);
  await expect(page.getByText(/cells? edited/)).toHaveCount(0);
});

/**
 * Paste is exercised through the real clipboard: Playwright writes text and
 * the page reads it back through the same `paste` event a user produces.
 * (Ctrl+V needs an OS-level key chord, so the event is dispatched with the
 * clipboard payload the browser would deliver.)
 */
async function pasteIntoGrid(page: Page, row: number, column: number, text: string): Promise<void> {
  // Focus the cell directly (no click): after a programmatic scroll the row
  // node can be re-created mid-click, and the paste anchor is the focused
  // cell, so focus is all this needs.
  await expect(page.locator(`[data-cell="${row}-${column}"]`)).toHaveCount(1, {
    timeout: 10_000,
  });
  await page.locator(`[data-cell="${row}-${column}"]`).focus();
  await page.evaluate((payload) => {
    const grid = document.querySelector('[role="grid"]');
    if (!grid) throw new Error('grid not found');
    const data = new DataTransfer();
    data.setData('text/plain', payload);
    grid.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

test('pasting a block fills cells and a single undo takes it back', async ({ page }) => {
  await loadSample(page);
  const before = await cellText(page, 0, 0);

  await pasteIntoGrid(page, 0, 0, 'P1\tP2\r\nP3\tP4');
  await expect(page.locator('[data-cell="0-0"] .grid-cell__text')).toHaveText('P1');
  await expect(page.locator('[data-cell="0-1"] .grid-cell__text')).toHaveText('P2');
  await expect(page.locator('[data-cell="1-0"] .grid-cell__text')).toHaveText('P3');
  await expect(page.locator('[data-cell="1-1"] .grid-cell__text')).toHaveText('P4');
  await expect(page.getByText('Pasted 4 cells.')).toBeVisible();
  await expect(page.getByText('4 cells edited')).toBeVisible();

  // One paste, one undo entry.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('[data-cell="0-0"] .grid-cell__text')).toHaveText(before);
  await expect(page.getByText(/cells? edited/)).toHaveCount(0);
});

test('a pasted value is searchable and appears in the export', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await loadSample(page);

  await pasteIntoGrid(page, 0, 0, 'PASTED-TOKEN');
  await expect(page.locator('[data-cell="0-0"] .grid-cell__text')).toHaveText('PASTED-TOKEN');

  await page.fill('#global-search', 'PASTED-TOKEN');
  await expect(page.getByText('1 of 5,000 rows match')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export CSV' });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: /Export CSV/ }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (path === null) throw new Error('download produced no file');
  const content = readFileSync(path, 'utf8');
  expect(content.split('\r\n')[1]?.split(',')[0]).toBe('PASTED-TOKEN');
});

test('a block that overflows the last row is clipped and reported', async ({ page }) => {
  await loadSample(page);
  // Scroll to the end of the dataset so the very last record is the active
  // row: a two-row block then has nowhere to put its second row.
  await page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('.grid-scroll');
    if (container) container.scrollTop = container.scrollHeight;
  });
  await expect
    .poll(() => page.locator('[data-cell="4999-0"]').count(), { timeout: 10_000 })
    .toBe(1);

  await pasteIntoGrid(page, 4999, 0, 'kept\r\ndropped');

  await expect(page.getByText(/outside the view/)).toBeVisible();
  await expect(page.locator('[data-cell="4999-0"] .grid-cell__text')).toHaveText('kept');
});

test('a restored dataset fills in rows as they scroll into view', async ({ page }) => {
  await loadSample(page);
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByText('5,000 of 5,000 rows match')).toBeVisible({ timeout: 30_000 });

  // The restore reads chunks on demand, so jumping to the end exercises a
  // chunk that was never loaded. Every visible record must show its ticket id.
  await page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('.grid-scroll');
    if (container) container.scrollTop = container.scrollHeight;
  });
  await expect(page.locator('[data-cell="4999-0"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-cell="4999-0"] .grid-cell__text')).toHaveText('T-05000');

  // No cell in the window is blank in the first column: a blank there would
  // mean a chunk that never arrived.
  const blanks = await page.evaluate(
    () =>
      [...document.querySelectorAll('[data-cell$="-0"] .grid-cell__text')].filter(
        (cell) => (cell.textContent ?? '') === '',
      ).length,
  );
  expect(blanks).toBe(0);

  // Scrolling back up reads from the already-loaded chunks and still shows data.
  await page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('.grid-scroll');
    if (container) container.scrollTop = 0;
  });
  await expect(page.locator('[data-cell="0-0"] .grid-cell__text')).toHaveText('T-00001');
});

test('evicted chunks reload correctly when the user scrolls back', async ({ page }) => {
  // The sample is only 10 chunks, below the 40-chunk cap, so eviction would
  // never run. A synthetic file big enough to exceed the cap exercises the
  // real path: read a chunk, get it evicted, read it again from IndexedDB.
  const rows = 60_000; // 120 chunks at 500 rows each
  const lines = ['id,value'];
  for (let i = 0; i < rows; i += 1) lines.push(`R${i},v${i}`);
  await page.goto('/');
  await page.setInputFiles('#file-input', {
    name: 'wide.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(lines.join('\n'), 'utf8'),
  });
  const start = page.getByRole('button', { name: 'Start import' });
  if (await start.isVisible()) await start.click();
  await expect(page.getByText('60,000 of 60,000 rows match')).toBeVisible({ timeout: 60_000 });

  await page.waitForTimeout(1_000);
  await page.reload();
  await expect(page.getByText('60,000 of 60,000 rows match')).toBeVisible({ timeout: 60_000 });

  const cellText = (row: number) =>
    page.evaluate(
      (topRow) =>
        document.querySelector(`[data-cell="${topRow}-0"] .grid-cell__text`)?.textContent ?? '',
      row,
    );
  const jumpTo = async (row: number) => {
    await page.evaluate((topRow) => {
      const container = document.querySelector<HTMLElement>('.grid-scroll');
      if (container) container.scrollTop = topRow * 36;
    }, row);
    await expect.poll(() => cellText(row), { timeout: 15_000 }).toBe(`R${row}`);
  };

  // Visit chunks far enough apart to push the first ones out of the cache.
  await jumpTo(0);
  for (let row = 5_000; row <= 55_000; row += 5_000) await jumpTo(row);

  // Back to the top: that chunk was evicted long ago and must be re-read.
  await jumpTo(0);
  await expect(page.locator('[data-cell="0-0"] .grid-cell__text')).toHaveText('R0');
  // And the far end still resolves.
  await jumpTo(59_000);
});
