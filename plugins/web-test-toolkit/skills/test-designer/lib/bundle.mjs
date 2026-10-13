// bundle.mjs — where a target site's artifacts live.
//
// Every phase reads and writes artifacts/<host>/, so the host must be derived the same way
// everywhere: sanitized with /[^a-z0-9.-]/gi -> '_' (localhost:3000 -> localhost_3000).
// The same rule lives in test-runner/playwright.config.mjs and test-runner/report.mjs —
// change all three together.

import path from 'node:path';

/** Bundle folder name for a URL; WEBTEST_HOST overrides the derived host. */
export function hostOf(url) {
  return (process.env.WEBTEST_HOST || new URL(url).host).replace(/[^a-z0-9.-]/gi, '_');
}

/** artifacts/<host> for a URL, relative to the working directory. */
export function bundleDir(url) {
  return path.posix.join('artifacts', hostOf(url));
}
