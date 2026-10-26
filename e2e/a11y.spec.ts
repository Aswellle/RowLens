import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Accessibility scans with axe-core over the main states. The bar: no
 * critical or serious violations on the empty state, a loaded dataset and
 * the export dialog. WCAG AA contrast issues that axe can measure are also
 * surfaced; anything axe cannot judge (keyboard flow details) stays covered
 * by the interaction tests elsewhere.
 *
 * Each scan injects axe into the page and walks the accessibility tree of a
 * 5,000-row virtual grid, so tests that scan twice need more than the
 * default 30 s budget when several workers share the machine.
 */
test.describe.configure({ timeout: 90_000 });

async function loadSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try sample data' }).click();
  await expect(page.getByText('5,000 of 5,000 rows match')).toBeVisible({ timeout: 20_000 });
}

async function scan(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  );
}

test('empty state has no critical or serious violations', async ({ page }) => {
  await page.goto('/');
  const violations = await scan(page);
  expect(violations.map((v) => `${v.id}: ${v.help}`).join('\n') || 'none').toBe('none');
});

test('loaded dataset view has no critical or serious violations', async ({ page }) => {
  await loadSample(page);
  const violations = await scan(page);
  expect(violations.map((v) => `${v.id}: ${v.help}`).join('\n') || 'none').toBe('none');
});

test('filter panel and export dialog have no critical or serious violations', async ({ page }) => {
  await loadSample(page);

  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  let violations = await scan(page);
  expect(violations.map((v) => v.id).join(',') || 'none').toBe('none');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  violations = await scan(page);
  expect(violations.map((v) => `${v.id}: ${v.help}`).join('\n') || 'none').toBe('none');
});

test('a grid range selection and its toolbar have no critical or serious violations', async ({
  page,
}) => {
  await loadSample(page);
  const cell = page.locator('[data-cell="0-0"]');
  await expect(async () => {
    await cell.locator('.grid-cell__text').click();
    await expect(cell).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });

  // Selected cells change background and gain aria-selected; the floating
  // selection bar adds buttons. Both must keep the contrast/ARIA contract.
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.getByText('2 × 2 selected')).toBeVisible();

  const violations = await scan(page);
  expect(violations.map((v) => `${v.id}: ${v.help}`).join('\n') || 'none').toBe('none');
});
