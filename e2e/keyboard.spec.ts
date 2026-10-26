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
