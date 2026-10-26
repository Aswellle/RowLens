import { expect, test, type Page } from '@playwright/test';
import { resetSession } from './support';

/**
 * Cleaning presets in a real browser (ADR-032).
 *
 * The point of a preset is reuse on a *different* file, so the fixture pair
 * carries the same header names in a different column order: `Ticket` is the
 * first column in the source and the second in the target. A preset that stored
 * positional column ids would trim the wrong column here, which is exactly the
 * failure this test exists to catch.
 */

async function importFixture(page: Page, path: string): Promise<void> {
  await page.setInputFiles('#file-input', path);
  const start = page.getByRole('button', { name: 'Start import' });
  if (await start.isVisible({ timeout: 2_000 }).catch(() => false)) await start.click();
}

test('a preset captured on one file trims the right columns on another', async ({ page }) => {
  await resetSession(page);

  // --- Source file: trim the Status column only, then save the recipe.
  await page.goto('/');
  await importFixture(page, 'e2e/fixtures/preset-source.csv');
  await expect(page.getByText('4 of 4 rows match')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: '+ Trim whitespace' }).click();
  await page.getByRole('button', { name: 'Trim whitespace' }).first().waitFor();
  // Restrict the step to Status, which is column 2 here.
  await page.locator('summary', { hasText: 'Edit' }).first().click();
  await page.getByRole('checkbox', { name: 'All columns' }).uncheck();
  await page.getByRole('checkbox', { name: 'Trim Status' }).check();

  // Row 0 carries " open " in Status; it becomes "open" once the step runs.
  await expect(page.locator('[data-cell="0-1"] .grid-cell__text')).toHaveText('open', {
    timeout: 20_000,
  });

  await page.getByRole('button', { name: 'Save as preset…' }).click();
  await page.getByLabel('Preset name').fill('Trim status');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply preset: Trim status' })).toBeVisible();

  // --- Target file: same headers, different order (Note, Ticket, Status).
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Explore a data file/ })).toBeVisible({
    timeout: 10_000,
  });

  await importFixture(page, 'e2e/fixtures/preset-target.csv');
  await expect(page.getByText('2 of 2 rows match')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('No cleaning steps yet.')).toBeVisible();
  // The preset outlived the dataset it was captured from and is offered here.
  await expect(page.getByRole('button', { name: 'Apply preset: Trim status' })).toBeVisible();

  await page.getByRole('button', { name: 'Apply preset: Trim status' }).click();
  await expect(page.getByText(/Applied “Trim status”/)).toBeVisible();

  // Status is column 3 in this file. Row 2 has " open " there and must be
  // trimmed; the Ticket column (now index 1) must keep its value untouched.
  await expect(page.locator('[data-cell="1-2"] .grid-cell__text')).toHaveText('open', {
    timeout: 20_000,
  });
  await expect(page.locator('[data-cell="1-1"] .grid-cell__text')).toHaveText('A-5');
});

test('a preset that matches no column is reported instead of applied silently', async ({
  page,
}) => {
  await resetSession(page);

  await page.goto('/');
  await importFixture(page, 'e2e/fixtures/preset-source.csv');
  await expect(page.getByText('4 of 4 rows match')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: '+ Select columns' }).click();
  await page.locator('summary', { hasText: 'Edit' }).first().click();
  // Keep only Note, so applying it to a file without Note fails visibly.
  for (const label of ['Keep Ticket', 'Keep Status']) {
    const box = page.getByRole('checkbox', { name: label });
    if (await box.isChecked()) await box.uncheck();
  }
  await page.getByRole('button', { name: 'Save as preset…' }).click();
  await page.getByLabel('Preset name').fill('Note only');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply preset: Note only' })).toBeVisible();

  // A file with different headers cannot satisfy the recipe.
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await importFixture(page, 'e2e/fixtures/basic.csv');
  await expect(page.getByText('2 of 2 rows match')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Apply preset: Note only' }).click();
  await expect(page.getByText(/could not be applied/)).toBeVisible({ timeout: 10_000 });
  // Nothing was applied, so the pipeline is still empty.
  await expect(page.getByText('No cleaning steps yet.')).toBeVisible();
});
