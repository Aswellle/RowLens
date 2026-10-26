import { expect, test, type Page } from '@playwright/test';

/**
 * Viewport coverage for the acceptance checklist: 360, 768, 1280 and 1440 px.
 * Each size asserts the layout contract (toolbar reachability, grid scroll)
 * rather than pixel-perfect rendering.
 */

async function loadSample(page: Page): Promise<void> {
  await page.goto('/');
  // A second visit in the same context restores the remembered dataset, so the
  // empty state may be replaced by the restored one before anything is
  // clicked. Wait for whichever appears, then only click if the button is
  // still there.
  const sampleButton = page.getByRole('button', { name: 'Try sample data' });
  const ready = page.getByText('5,000 of 5,000 rows match');
  await expect(sampleButton.or(ready).first()).toBeVisible({ timeout: 20_000 });
  if (await sampleButton.isVisible()) {
    await sampleButton.click();
  }
  await expect(ready).toBeVisible({ timeout: 20_000 });
}

const SIZES = [
  { width: 360, height: 720 },
  { width: 768, height: 900 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];

for (const size of SIZES) {
  test(`layout holds at ${size.width}px: search reachable, grid scrollable, counts visible`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await loadSample(page);

    const search = page.getByLabel('Search all columns');
    await expect(search).toBeVisible();

    const status = page.getByText('5,000 of 5,000 rows match');
    await expect(status).toBeVisible();

    const scroll = page.locator('.grid-scroll');
    await expect(scroll).toBeVisible();
    // The grid scrolls internally rather than the page scrolling away.
    const scrollable = await scroll.evaluate(
      (el) => el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth,
    );
    expect(scrollable).toBe(true);
  });
}

test('360px keeps search and export reachable without horizontal page scroll', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await loadSample(page);

  // No horizontal page overflow: the body does not scroll sideways.
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(pageOverflow).toBe(false);

  // Every feature button is directly reachable, no menu in between.
  await expect(page.getByRole('button', { name: 'Filter', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
});

test('768px and 1440px keep the direct Export button visible', async ({ page }) => {
  for (const size of [768, 1440]) {
    await page.setViewportSize({ width: size, height: 900 });
    await loadSample(page);
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
  }
});
