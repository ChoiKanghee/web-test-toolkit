// auth.mjs — let the tester sign a role in by hand and save the session as a Playwright
// storageState, so the crawler and the specs can reuse it. The tester types the credentials
// into the browser window; nothing here sees, reads or stores them — only the session the
// site issues afterwards.

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchOptions } from './playwright.mjs';

// 0 = wait until the tester is in (Playwright's "no timeout").
export const LOGIN_TIMEOUT_MS = 0;

export class LoginError extends Error {
  constructor(role, step) {
    super(`login failed for role "${role}": ${step}`);
    this.name = 'LoginError';
    this.role = role;
    this.step = step;
  }
}

/** Where `role`'s saved session lives inside a bundle's .auth folder. */
export const sessionPath = (stateDir, role) => path.join(stateDir, `${role}.json`);

/** Roles in `roles` that have no saved session in `stateDir`. */
export const missingSessions = (stateDir, roles) => roles.filter((role) => !existsSync(sessionPath(stateDir, role)));

/**
 * Open `loginPath` in a window of `browser` (which must be headed) and wait for the tester to
 * sign `role` in. Success means the URL is back on the site's origin, off `loginPath`, and no
 * password field is showing — so a two-step form or an SSO round trip through another origin
 * is not mistaken for done. Writes <stateDir>/<role>.json. Closing the window or running out
 * of a non-zero `timeoutMs` throws LoginError('not-signed-in').
 */
export async function login(browser, { baseUrl, role, stateDir, loginPath = '/login', timeoutMs = LOGIN_TIMEOUT_MS }) {
  const context = await browser.newContext({ baseURL: baseUrl });
  try {
    const page = await context.newPage();
    await page.goto(loginPath, { waitUntil: 'domcontentloaded' });
    const limit = timeoutMs ? `up to ${timeoutMs / 60_000} min` : 'as long as it takes';
    console.log(`Sign in as "${role}" in the browser window (waiting ${limit})...`);
    await page
      .waitForFunction(
        ({ origin, loginPath: path }) =>
          location.origin === origin && location.pathname !== path && !document.querySelector('input[type=password]'),
        { origin: new URL(baseUrl).origin, loginPath },
        { timeout: timeoutMs, polling: 500 },
      )
      .catch(() => {
        throw new LoginError(role, 'not-signed-in');
      });

    mkdirSync(stateDir, { recursive: true });
    const statePath = sessionPath(stateDir, role);
    await context.storageState({ path: statePath });
    return statePath;
  } finally {
    await context.close();
  }
}

/** `login` in a visible Chromium window that closes afterwards. */
export async function loginInWindow(chromium, options) {
  const browser = await chromium.launch(launchOptions({ headless: false }));
  try {
    return await login(browser, options);
  } finally {
    await browser.close();
  }
}
