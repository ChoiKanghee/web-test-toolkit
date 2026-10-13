// playwright.mjs — load @playwright/test from the tester's work folder.
//
// The plugin's install folder has no node_modules, and the generated specs in
// artifacts/<host>/tests/ import '@playwright/test' from the work folder. Playwright refuses
// to run when the config and the specs load two different copies, so the work folder is
// tried first. The second root (this file's own location) only resolves in the development
// repo, where node_modules sits at the repo root.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const EXIT_NO_PLAYWRIGHT = 4;

/**
 * Return the @playwright/test module from the first of `roots` that has it installed.
 * Throws an Error with code 'PLAYWRIGHT_MISSING' when none does; any other load error
 * (a broken install) is rethrown as is.
 */
export function loadPlaywright(roots = [process.cwd(), HERE]) {
  for (const root of roots) {
    try {
      return createRequire(path.join(root, 'package.json'))('@playwright/test');
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  const error = new Error(`@playwright/test is not installed in ${roots.join(' or ')}`);
  error.code = 'PLAYWRIGHT_MISSING';
  throw error;
}

/** loadPlaywright for CLI scripts: a missing install prints one line and exits 4. */
export function playwrightOrExit(roots) {
  try {
    return loadPlaywright(roots);
  } catch (error) {
    if (error.code !== 'PLAYWRIGHT_MISSING') throw error;
    console.error('Chưa cài Playwright ở thư mục này. Hãy chạy skill "setup" của web-test-toolkit rồi thử lại.');
    process.exit(EXIT_NO_PLAYWRIGHT);
  }
}

/**
 * Browser channel to launch instead of Playwright's bundled Chromium, from WEBTEST_BROWSER_CHANNEL
 * (e.g. "chrome" for the installed Google Chrome). Needed on systems Playwright has no Chromium build
 * for, such as Ubuntu 26.04. Unset or empty → undefined (bundled Chromium).
 */
export function browserChannel(env = process.env) {
  const channel = (env.WEBTEST_BROWSER_CHANNEL || '').trim();
  return channel || undefined;
}

/** chromium.launch() options with the configured channel added when one is set. */
export function launchOptions(options = {}, env = process.env) {
  const channel = browserChannel(env);
  return channel ? { ...options, channel } : { ...options };
}
