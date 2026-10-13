// tester.mjs — stands in for the human who types the account into the login window.
// Test-only: login() opens the page and waits; this finds that page and fills the form.

import { login } from '../lib/auth.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loginPage(browser) {
  for (;;) {
    const [page] = browser.contexts().flatMap((context) => context.pages());
    if (page) return page;
    await sleep(25);
  }
}

async function fillForm(browser, { email, password }) {
  const page = await loginPage(browser);
  const input = (label) => page.getByLabel(label).and(page.locator('input'));
  await input(/email/i).fill(email);
  if (!(await input(/password/i).isVisible())) await page.getByRole('button', { name: /continue/i }).click();
  await input(/password/i).fill(password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
}

/** Run login() while a simulated tester signs `user` in; resolves like login() does. */
export function testerSignsIn(browser, user, options) {
  const done = login(browser, options);
  done.catch(() => {}); // a failure is asserted by the caller; do not leave it unhandled meanwhile
  return fillForm(browser, user).then(() => done);
}
