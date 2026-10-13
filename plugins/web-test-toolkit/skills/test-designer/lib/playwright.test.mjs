import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlaywright } from './playwright.mjs';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'playwright.mjs');
const emptyRoot = () => mkdtempSync(path.join(tmpdir(), 'webtest-pw-'));

/** A folder whose node_modules holds a stand-in @playwright/test with the given index.js. */
function rootWith(indexSource) {
  const root = emptyRoot();
  const pkg = path.join(root, 'node_modules', '@playwright', 'test');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@playwright/test', main: 'index.js' }));
  writeFileSync(path.join(pkg, 'index.js'), indexSource);
  return root;
}
const marked = (marker) => rootWith(`module.exports = { marker: ${JSON.stringify(marker)} };`);

test('the default roots find the real Playwright in this repo', () => {
  assert.equal(typeof loadPlaywright().chromium.launch, 'function');
});

test('the first root wins, so the config and the specs share one copy', () => {
  assert.equal(loadPlaywright([marked('work'), marked('plugin')]).marker, 'work');
});

test('a root without Playwright falls through to the next one', () => {
  assert.equal(loadPlaywright([emptyRoot(), marked('plugin')]).marker, 'plugin');
});

test('no root with Playwright throws PLAYWRIGHT_MISSING', () => {
  assert.throws(() => loadPlaywright([emptyRoot()]), { code: 'PLAYWRIGHT_MISSING' });
});

test('a broken install surfaces its own error instead of "run setup"', () => {
  const broken = rootWith("throw new Error('boom');");
  assert.throws(() => loadPlaywright([broken, marked('plugin')]), /boom/);
});

test('playwrightOrExit exits 4 with one line for the tester, no stack trace', async () => {
  const code = `const { playwrightOrExit } = await import(${JSON.stringify(pathToFileURL(HELPER).href)});
playwrightOrExit([${JSON.stringify(emptyRoot())}]);`;
  const result = await new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', code],
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stderr }));
  });
  assert.equal(result.code, 4);
  assert.match(result.stderr, /Chưa cài Playwright/);
  assert.match(result.stderr, /setup/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('browserChannel reads WEBTEST_BROWSER_CHANNEL', async () => {
  const { browserChannel, launchOptions } = await import('./playwright.mjs');
  assert.equal(browserChannel({}), undefined);
  assert.equal(browserChannel({ WEBTEST_BROWSER_CHANNEL: '  ' }), undefined);
  assert.equal(browserChannel({ WEBTEST_BROWSER_CHANNEL: 'chrome' }), 'chrome');
  assert.deepEqual(launchOptions({ headless: false }, {}), { headless: false });
  assert.deepEqual(launchOptions({ headless: false }, { WEBTEST_BROWSER_CHANNEL: 'chrome' }),
    { headless: false, channel: 'chrome' });
});
