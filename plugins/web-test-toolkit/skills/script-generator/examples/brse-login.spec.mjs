// brse.ai — login surface (black-box). Each test maps to a TC in
// artifacts/brse.ai/test-plan.md. Run: BASE_URL=https://brse.ai npx playwright test
import { test, expect } from '@playwright/test';

test.describe('brse.ai — login', () => {
  // TC-001 — home redirects to /login
  test('TC-001 [P0] home redirects to login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page).toHaveTitle(/BrSE\.ai/i);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  // TC-002 — login form shows all parts
  test('TC-002 [P0] login form renders fields and button', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('input[type=email]')).toBeVisible();
    await expect(page.locator('input[type=password]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  // TC-003 — fields keep typed values
  test('TC-003 [P1] fields accept input', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type=email]').fill('tester@example.com');
    await page.locator('input[type=password]').fill('secret123');
    await expect(page.locator('input[type=email]')).toHaveValue('tester@example.com');
    await expect(page.locator('input[type=password]')).toHaveValue('secret123');
  });

  // TC-004 — wrong credentials do not log in
  test('TC-004 [P0] invalid credentials stay on login', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type=email]').fill('nope@example.com');
    await page.locator('input[type=password]').fill('wrongpassword');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForTimeout(2000); // allow auth round-trip
    await expect(page).toHaveURL(/\/login/);
  });

  // TC-005 — page loads without JS errors
  test('TC-005 [P1] no page errors on load', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const resp = await page.goto('/login');
    expect(resp?.status()).toBeLessThan(400);
    expect(errors, 'no uncaught page errors').toEqual([]);
  });
});
