#!/usr/bin/env node
// login.mjs — the tester signs in by hand; the session is saved for the crawler and the specs.
//
// Usage:  node login.mjs <url> [--role default] [--login-path /login]
//           [--timeout-min 0]
// A Chromium window opens on the login page. The tester types the account and password
// there — nothing is read from the environment or the chat. When the site lets them in, the
// window closes and the session is written to artifacts/<host>/.auth/<role>.json (it holds
// live tokens). It waits as long as it takes unless --timeout-min <n> sets a limit. Run it again
// when a session expires. Exit 1: not signed in (window closed / limit hit); 4: no Playwright.

import path from 'node:path';
import { parseArgs } from 'node:util';
import { LoginError, loginInWindow } from './lib/auth.mjs';
import { bundleDir } from './lib/bundle.mjs';
import { playwrightOrExit } from './lib/playwright.mjs';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    role: { type: 'string', default: 'default' },
    'login-path': { type: 'string', default: '/login' },
    'timeout-min': { type: 'string', default: '0' },
  },
});
const [url] = positionals;
if (!url) {
  console.error('Usage: node login.mjs <url> [--role default] [--login-path /login] [--timeout-min 0]');
  process.exit(1);
}

const timeoutMin = Number(args['timeout-min']);
if (!(timeoutMin >= 0)) {
  console.error('--timeout-min must be 0 (no limit) or a number of minutes');
  process.exit(1);
}

const { chromium } = playwrightOrExit();
try {
  const statePath = await loginInWindow(chromium, {
    baseUrl: new URL(url).origin,
    role: args.role,
    stateDir: path.join(bundleDir(url), '.auth'),
    loginPath: args['login-path'],
    timeoutMs: timeoutMin * 60_000,
  });
  console.log(`Signed in as "${args.role}" -> ${statePath}`);
} catch (error) {
  if (!(error instanceof LoginError)) throw error;
  console.error(error.message);
  process.exit(1);
}
