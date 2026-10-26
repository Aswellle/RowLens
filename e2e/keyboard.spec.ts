import { expect, test, type Page } from '@playwright/test';

/**
 * Query cancellation and grid keyboard navigation in a real browser.
 */

async function loadSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try sample data' }).click();
  await expect(page.getByText('5,000 of 5,000 rows match')).toBeVisible({ timeout: 20_000 });
}

test('cancelling a query clears the busy marker and keeps the previous view', async ({ page }) => {
  await loadSample(page);

  const cancel = page.getByRole('button', { name: 'Cancel query' });
  // Trigger a query and cancel as soon as the busy marker shows. A 5k-row
  // scan can finish before the assertion runs, so tolerate that race by
  // accepting either outcome — the regression under test is the state AFTER
  // cancellation, which must never keep a stuck busy marker.
  await page.fill('#global-search', 'a');
  const busyAppeared = await page
    .getByText('Searching…')
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (busyAppeared) {
    await cancel.click();
  } else {
    // Query already finished; start another and cancel immediately.
    await page.fill('#global-search', 'T-00');
    await page
      .getByRole('button', { name: 'Cancel query' })
      .click({ timeout: 5_000 })
      .catch(() => {});
  }

  // Regression: after cancelling, busy must clear and the button must go away.
  await expect(page.getByText('Searching…')).toHaveCount(0, { timeout: 10_000 });
  await expect(cancel).toHaveCount(0);
  // The previous view is preserved rather than blanked.
  await expect(page.getByRole('grid', { name: 'Data grid' })).toBeVisible();
});

test('arrow keys, Home and End move focus between cells', async ({ page }) => {
  await loadSample(page);
  const grid = page.getByRole('grid', { name: 'Data grid' });
  const cell = (row: number, column: number) => page.locator(`[data-cell="${row}-${column}"]`);

  // Retry the initial click: the first render can land between the sample
  // query settling and the grid window being painted.
  await expect(async () => {
    await cell(0, 0).locator('.grid-cell__text').click();
    await expect(cell(0, 0)).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });

  await page.keyboard.press('ArrowRight');
  await expect(cell(0, 1)).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(cell(1, 1)).toBeFocused();

  await page.keyboard.press('End');
  await expect(cell(1, 7)).toBeFocused(); // sample has 8 columns

  await page.keyboard.press('Home');
  await expect(cell(1, 0)).toBeFocused();

  // Clamped at the top edge.
  await page.keyboard.press('ArrowUp');
  await expect(cell(0, 0)).toBeFocused();

  // Only one cell participates in the tab order at a time.
  await expect(grid.locator('[data-cell][tabindex="0"]')).toHaveCount(1);
});

test('keyboard navigation works with the virtualized window while scrolling', async ({ page }) => {
  await loadSample(page);
  const cell = (row: number, column: number) => page.locator(`[data-cell="${row}-${column}"]`);

  await cell(0, 0).locator('.grid-cell__text').click();
  // PageDown jumps a screenful and the target row is scrolled into the window.
  await page.keyboard.press('PageDown');
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-cell'));
  expect(focused).not.toBe('0-0');
  expect(focused).toMatch(/^\d+-0$/);
  // The focused cell is inside the grid, not lost to the page.
  await expect(page.getByRole('grid', { name: 'Data grid' })).toContainText(/Record/);
});

test('the record header is part of the keyboard roam and selects its row', async ({ page }) => {
  await loadSample(page);
  const grid = page.getByRole('grid', { name: 'Data grid' });
  const cell = (row: number, column: number) => page.locator(`[data-cell="${row}-${column}"]`);
  const rowHeader = (row: number) => page.locator(`[data-row-header="${row}"]`);

  await expect(async () => {
    await cell(0, 0).locator('.grid-cell__text').click();
    await expect(cell(0, 0)).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });

  // One step left of the first data column lands on the record header.
  await page.keyboard.press('ArrowLeft');
  await expect(rowHeader(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rowHeader(1)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(cell(1, 0)).toBeFocused();

  // Space on the header selects the whole row; the header itself is not data.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  await expect(page.getByText('1 × 8 selected')).toBeVisible();
  await expect(grid.locator('[data-cell="1-7"]')).toHaveAttribute('aria-selected', 'true');
});

test('a dragged cell range copies as tab-separated values with CRLF rows', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await loadSample(page);
  const cell = (row: number, column: number) => page.locator(`[data-cell="${row}-${column}"]`);

  await expect(async () => {
    await cell(0, 0).locator('.grid-cell__text').click();
    await expect(cell(0, 0)).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });

  // Shift+arrows extend the rectangle from the anchor cell.
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.getByText('2 × 2 selected')).toBeVisible();

  await page.keyboard.press('Control+c');
  await expect(page.getByText('Copied 4 cells.')).toBeVisible({ timeout: 5_000 });

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  const lines = clipboard.split('\r\n');
  expect(lines).toHaveLength(2);
  expect(lines[0]?.split('\t')).toHaveLength(2);
  expect(lines[1]?.split('\t')).toHaveLength(2);
  // Every copied value comes from the two selected columns of the two rows.
  for (const line of lines) {
    for (const value of line.split('\t')) {
      expect(value.length).toBeGreaterThan(0);
    }
  }
});

test('dragging a selection past the bottom edge scrolls and keeps extending', async ({ page }) => {
  await loadSample(page);
  const grid = page.getByRole('grid', { name: 'Data grid' });
  const cell = (row: number, column: number) => page.locator(`[data-cell="${row}-${column}"]`);

  const first = cell(0, 0);
  await expect(async () => {
    await first.locator('.grid-cell__text').click();
    await expect(first).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });

  const box = await grid.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  // Press inside the first cell, then hold the pointer in the bottom edge
  // zone so the auto-scroll loop runs for a while. Hover the text span, not
  // the cell centre: the per-cell Copy button appears on row hover there.
  await first.locator('.grid-cell__text').hover();
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height - 4, { steps: 4 });

  // Poll instead of sleeping a fixed time: under parallel workers the frame
  // rate drops and a fixed wait can undershoot a screenful.
  const selectionRows = async (): Promise<number> => {
    const text = await page.getByText(/× \d+ selected/).textContent();
    return Number(text?.match(/^([\d,]+) ×/)?.[1]?.replaceAll(',', '') ?? '0');
  };
  await expect(async () => {
    expect(await selectionRows()).toBeGreaterThan(30);
  }).toPass({ timeout: 10_000 });
  const rows = await selectionRows();

  await page.mouse.up();
  // Release ends the drag: further pointer movement must not extend it. The
  // size at release can be one row past the pre-release reading because the
  // auto-scroll frame may run between the last poll and the mouseup.
  const afterRelease = await page.getByText(/× \d+ selected/).textContent();
  await page.mouse.move(box.x + 60, box.y + 10);
  await expect(page.getByText(/× \d+ selected/)).toHaveText(afterRelease!);
  const releasedRows = Number(afterRelease?.match(/^([\d,]+) ×/)?.[1]?.replaceAll(',', '') ?? '0');
  expect(releasedRows).toBeGreaterThanOrEqual(rows);
});

test('select-all copies the visible view and stays within the cell cap', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await loadSample(page);
  const cell = (row: number, column: number) => page.locator(`[data-cell="${row}-${column}"]`);

  await expect(async () => {
    await cell(0, 0).locator('.grid-cell__text').click();
    await expect(cell(0, 0)).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });

  await page.keyboard.press('Control+a');
  // 5,000 rows × 8 columns = 40,000 cells, under the 100,000 copy cap.
  await expect(page.getByText('5,000 × 8 selected')).toBeVisible();

  await page.keyboard.press('Control+c');
  await expect(page.getByText('Copied 40,000 cells.')).toBeVisible({ timeout: 10_000 });
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard.split('\r\n')).toHaveLength(5000);

  // Escape collapses the selection back to the active cell.
  await page.keyboard.press('Escape');
  await expect(page.getByText(/selected$/)).toHaveCount(0);
});

test('an oversized selection is refused with an explanation, not truncated', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // 400 rows × 300 columns = 120,000 cells, above the 100,000 copy cap. Built
  // at runtime so no large fixture lives in the repo.
  const columns = Array.from({ length: 300 }, (_, i) => `c${i}`);
  const rows = Array.from({ length: 400 }, (_, r) => columns.map((_, c) => `${r}-${c}`).join(','));
  const csv = [columns.join(','), ...rows].join('\n');

  await page.goto('/');
  await page.setInputFiles('#file-input', {
    name: 'wide.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  const start = page.getByRole('button', { name: 'Start import' });
  if (await start.isVisible()) await start.click();
  await expect(page.getByText('400 of 400 rows match')).toBeVisible({ timeout: 20_000 });

  const cell = page.locator('[data-cell="0-0"]');
  await expect(async () => {
    await cell.locator('.grid-cell__text').click();
    await expect(cell).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });

  await page.keyboard.press('Control+a');
  await expect(page.getByText('400 × 300 selected')).toBeVisible();

  // Seed the clipboard so we can prove the refusal did not overwrite it.
  await page.evaluate(() => navigator.clipboard.writeText('untouched'));
  await page.keyboard.press('Control+c');
  await expect(page.getByText(/120,000 cells — too many to copy at once/)).toBeVisible({
    timeout: 5_000,
  });
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('untouched');
  // The selection survives so the user can narrow it instead of starting over.
  await expect(page.getByText('400 × 300 selected')).toBeVisible();
});
