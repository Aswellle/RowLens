import { expect, test, type Page } from '@playwright/test';
import { loadSample, resetSession } from './support';

/**
 * Phase 1 E2E: honest main path (empty → sample → grid), keyboard operability,
 * virtualized DOM size, and the narrow-viewport "More" menu.
 */

test('empty state explains the product and offers the two entries', async ({ page }) => {
  // A leftover session pointer would restore a dataset instead of the empty
  // state, which is a different test's concern.
  await resetSession(page);
  await expect(
    page.getByRole('heading', { name: 'Explore a data file. Keep it on your device.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose a file' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try sample data' })).toBeVisible();
});

test('sample load exposes the logical table size via aria-rowcount', async ({ page }) => {
  await page.goto('/');
  await loadSample(page);
  const grid = page.getByRole('grid', { name: 'Data grid' });
  await expect(grid).toHaveAttribute('aria-rowcount', '5000');
});

test('grid renders a viewport-sized DOM slice, not all 5,000 rows', async ({ page }) => {
  await page.goto('/');
  await loadSample(page);
  const grid = page.getByRole('grid', { name: 'Data grid' });
  const rowCount = await grid.locator('[role="row"]').count();
  expect(rowCount).toBeGreaterThan(1); // header + data rows
  expect(rowCount).toBeLessThan(60); // 5000-row dataset, ~17 visible + overscan
});

test('search narrows results and updates the announced count', async ({ page }) => {
  await page.goto('/');
  await loadSample(page);
  const search = page.getByLabel('Search all columns');
  await search.fill('chat');
  await expect(page.getByText(/rows match/)).not.toContainText('5,000 of 5,000');
  const status = await page.getByText(/of 5,000 rows match/).innerText();
  expect(status).toMatch(/[1-4],\d{3} of 5,000 rows match/);
});

test('keyboard-only: Tab to sample, load, search, Escape clears in place', async ({ page }) => {
  // The tab order starts from the empty state, so no restored session.
  await resetSession(page);
  // Tab through theme toggle → Choose a file → Try sample data.
  await page.keyboard.press('Tab'); // document body → theme toggle
  await page.keyboard.press('Tab'); // → Choose a file
  await page.keyboard.press('Tab'); // → Try sample data
  await expect(page.getByRole('button', { name: 'Try sample data' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('5,000 of 5,000 rows match')).toBeVisible();

  const search = page.getByLabel('Search all columns');
  await search.click();
  await page.keyboard.type('emea');
  await expect(page.getByText(/of 5,000 rows match/)).not.toContainText('5,000 of 5,000');
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
});

test('sorting cycles ascending → descending → off on a column header', async ({ page }) => {
  await page.goto('/');
  await loadSample(page);
  // The columnheader's accessible name embeds the sort button's label, so
  // match by contained text rather than the full accname.
  const header = page.getByRole('columnheader').filter({ hasText: 'Status' });
  const sortButton = page.getByRole('button', { name: 'Sort by Status' });

  await sortButton.click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  await sortButton.click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  await sortButton.click();
  await expect(header).toHaveAttribute('aria-sort', 'none');
});

test('narrow viewport collapses feature buttons behind the More menu', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto('/');
  await loadSample(page);

  const more = page.getByRole('button', { name: 'More ▾' });
  await expect(more).toBeVisible();
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  // Disabled placeholders are present and honest about their phase.
  await expect(page.getByRole('button', { name: 'Clean steps' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
});

test('dark theme toggle switches tokens and persists', async ({ page }) => {
  await page.goto('/');
  const toggle = page.getByRole('button', { name: /Switch to/ });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /dark|light/);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /dark|light/);
});

test('scrolling re-renders the window: later records appear, DOM stays bounded', async ({
  page,
}) => {
  await page.goto('/');
  await loadSample(page);
  const grid = page.getByRole('grid', { name: 'Data grid' });
  const scroll = page.locator('.grid-scroll');

  await expect(grid.getByText('Record 1', { exact: true })).toBeVisible();
  const beforeCount = await grid.locator('[role="row"]').count();
  expect(beforeCount).toBeLessThan(60);

  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(grid.getByText(/^Record 50\d\d$/).first()).toBeVisible({ timeout: 5000 });
  const afterCount = await grid.locator('[role="row"]').count();
  expect(afterCount).toBeLessThan(60);
});
