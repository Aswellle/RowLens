import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { loadSample } from './support';

/**
 * Captures the README screenshots from the production preview build.
 * Gated behind SHOTS=1; images land in docs/screenshots/. All content is
 * the synthetic sample — nothing personal.
 */

test.skip(!process.env.SHOTS, 'set SHOTS=1 to regenerate README screenshots');

const DIR = 'docs/screenshots';

test('capture the main views', async ({ page }) => {
  test.setTimeout(60_000);
  await mkdir(DIR, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto('/');
  await page.screenshot({ path: `${DIR}/empty.png` });

  await loadSample(page);
  await page.screenshot({ path: `${DIR}/grid.png` });

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Export CSV' })).toBeVisible();
  await page.screenshot({ path: `${DIR}/export-dialog.png` });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /Switch to dark theme/ }).click();
  await page.screenshot({ path: `${DIR}/grid-dark.png` });
});
