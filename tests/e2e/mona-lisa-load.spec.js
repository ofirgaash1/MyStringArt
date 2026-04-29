import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

test('loads Mona Lisa and reaches the shared residual workflow', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Choose image')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'residual' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByLabel(/Nails:/)).toHaveValue('100');

  await page
    .locator('input[type="file"]')
    .setInputFiles(path.join(repoRoot, 'mona_lisa.PNG'));

  await expect(page.getByText('Shared residual solver')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'strings' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByText('Target dithered')).toBeVisible();
  await page.getByRole('radio', { name: 'palette' }).click();
  await expect(page.getByRole('radio', { name: 'palette' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('radio', { name: 'strings' }).click();
  await expect(page.getByRole('radio', { name: 'strings' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByText('Target palette')).toBeVisible();
  await expect(page.getByLabel(/String thickness:/)).toHaveValue('35');
  await expect(page.getByRole('button', { name: 'reset residual' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'apply one residual step' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'loop steps' })).toBeEnabled();

  await page.getByRole('button', { name: 'apply one residual step' }).click();

  await expect(page.getByText('Lines 1')).toBeVisible();
  await expect(page.getByText('1 strings')).toBeVisible();
  await expect(page.getByText(/Applied .* score/)).toBeVisible();
});
