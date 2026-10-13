// Template spec — copy to artifacts/<site>/tests/<area>.spec.mjs and fill in.
// Each test() maps to a TC-NNN in the matching artifacts/<site>/test-plan.md.
import { test, expect } from '@playwright/test';

test.describe('<SITE> — <area>', () => {
  // TC-NNN — <name>
  test('<what it verifies>', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/'); // baseURL comes from playwright.config / BASE_URL

    // ... act: fill / click / press ...

    // ... assert: expect(...).toBeVisible() etc ...

    expect(errors, 'no uncaught page errors').toEqual([]);
  });
});
