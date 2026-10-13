#!/usr/bin/env node
// crawl.mjs — multi-page, multi-role exploration driver for the test-designer skill (phase 1).
//
// Reuses each role's saved session (login.mjs), walks same-origin links breadth-first (plus
// sitemap.xml and routes declared in the SPA's JS bundle), groups URLs
// into route templates, captures one representative page per template, probes files
// without downloading them, then checks which role can open which template.
// Read-only by design: it follows links, never clicks or submits, skips URLs that look
// state-changing, and aborts any request a page itself makes to one. A server-side redirect
// to such a URL (from a link, an image or a fetch) is not intercepted.
//
// Usage:  node crawl.mjs <url> [--roles admin,user] [--login-path /login]
//           [--max-pages 200] [--max-depth 5] [--concurrency 3] [--delay-ms 250]
//           [--samples 3] [--slug-threshold 20] [--max-minutes 15]
//           [--exclude <regex>]... [--allow <regex>]... [--no-bundle-routes]
// Roles default to a single 'default' role. Each needs artifacts/<host>/.auth/<role>.json,
// which the tester creates by signing in with `login.mjs <url> --role <role>`; the crawler
// never sees a password. A session that dies mid-crawl stops that role (sign in again, re-crawl).
//
// Output: artifacts/<host>/crawl/site-map.md    (what an agent reads)
//         artifacts/<host>/crawl/site-map.json  (everything, untruncated)
//         artifacts/<host>/crawl/pages/<url>/   (exploration.md + screenshot.png; cleared per crawl)
//         artifacts/<host>/.auth/<role>.json    (saved sessions — they contain tokens)

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { missingSessions, sessionPath } from './lib/auth.mjs';
import { bundleDir, hostOf } from './lib/bundle.mjs';
import { capturePage, probeFile, renderExploration } from './lib/capture.mjs';
import { launchOptions, playwrightOrExit } from './lib/playwright.mjs';
import { extractRoutes, instantiate, scriptUrls } from './lib/route-discovery.mjs';
import { apiDenial, buildSiteMap, renderSiteMap } from './lib/site-map.mjs';
import { isFileUrl, isUnsafe, normalizeUrl, TemplateIndex } from './lib/url-template.mjs';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    roles: { type: 'string', default: 'default' },
    'login-path': { type: 'string', default: '/login' },
    'max-pages': { type: 'string', default: '200' },
    'max-depth': { type: 'string', default: '5' },
    concurrency: { type: 'string', default: '3' },
    'delay-ms': { type: 'string', default: '250' },
    samples: { type: 'string', default: '3' },
    'slug-threshold': { type: 'string', default: '20' },
    'max-minutes': { type: 'string', default: '15' },
    exclude: { type: 'string', multiple: true, default: [] },
    allow: { type: 'string', multiple: true, default: [] },
    'no-bundle-routes': { type: 'boolean', default: false },
  },
});
const startUrl = positionals[0];
if (!startUrl) {
  console.error('Usage: node crawl.mjs <url> [--roles admin,user] [--login-path /login] [--max-pages 200] ...');
  process.exit(1);
}

const { chromium } = playwrightOrExit();

const host = hostOf(startUrl);

const limits = {
  maxPages: Number(args['max-pages']),
  maxDepth: Number(args['max-depth']),
  concurrency: Number(args.concurrency),
  delayMs: Number(args['delay-ms']),
  samples: Number(args.samples),
  slugThreshold: Number(args['slug-threshold']),
  maxMinutes: Number(args['max-minutes']),
};
if (Object.values(limits).some((n) => !Number.isFinite(n) || n < 0) || limits.concurrency < 1) {
  console.error(`Invalid numeric flag: ${JSON.stringify(limits)} (all must be >= 0, --concurrency >= 1)`);
  process.exit(1);
}
const config = {
  roles: args.roles.split(',').map((r) => r.trim()).filter(Boolean),
  ...limits,
  loginPath: args['login-path'],
  exclude: args.exclude,
  allow: args.allow,
  bundleRoutes: !args['no-bundle-routes'],
};
const filters = {
  exclude: config.exclude.map((pattern) => new RegExp(pattern, 'i')),
  allow: config.allow.map((pattern) => new RegExp(pattern, 'i')),
};

const origin = new URL(startUrl).origin;
const outDir = bundleDir(startUrl);
const crawlDir = path.join(outDir, 'crawl');
const stateDir = path.join(outDir, '.auth');
const unsigned = missingSessions(stateDir, config.roles);
if (unsigned.length) {
  console.error(`No saved session for role(s): ${unsigned.join(', ')}. Sign each in first:`);
  for (const role of unsigned) {
    console.error(`  node login.mjs ${startUrl} --role ${role} --login-path ${config.loginPath}`);
  }
  process.exit(1);
}
const index = new TemplateIndex({ slugThreshold: config.slugThreshold });
const state = {
  baseUrl: startUrl,
  roles: config.roles,
  config,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  pagesVisited: {},
  limitWarnings: [],
  unsafeSkipped: new Set(),
  externalOrigins: new Set(),
  visits: [],
  bundle: null,
};
const fullCaptures = new Set(); // templates that already have a screenshot + exploration.md
const deadline = Date.now() + config.maxMinutes * 60_000;
let stopReason = null;
process.on('SIGINT', () => {
  stopReason ??= 'interrupted (SIGINT)';
});

const UNGUARDED_TYPES = new Set(['script', 'stylesheet', 'font']);
const SCREENSHOT_TIMEOUT_MS = 15_000;
const MAX_SCRIPTS = 20;
const MAX_SCRIPT_BYTES = 10 * 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isBusy = (record) => record.status === 429 || record.status === 503;
const failedVisit = (role, url, kind, probe, error) => ({
  role, url, kind, probe, status: null, loginRedirect: false, errors: [], failedRequests: [], navError: String(error),
});

/** True once the crawl must wind down (time limit or SIGINT). */
function shouldStop() {
  if (Date.now() > deadline) stopReason ??= `time limit (${config.maxMinutes} min) reached`;
  return stopReason !== null;
}

/** Normalize a discovered link and register it; returns the URL to enqueue, or null. */
function intake(href, from) {
  const url = normalizeUrl(href, from);
  if (url === null) {
    if (URL.canParse(href, from)) {
      const target = new URL(href, from);
      if (/^https?:$/.test(target.protocol) && target.origin !== origin) state.externalOrigins.add(target.origin);
    }
    return null;
  }
  if (new URL(url).pathname === config.loginPath) return null; // visiting it proves nothing
  if (isUnsafe(url, filters)) {
    state.unsafeSkipped.add(url);
    return null;
  }
  index.add(url);
  return url;
}

/** Folder name for one URL's evidence: readable path, cut to 80 chars, plus a short hash. */
function pageDir(url) {
  const { pathname, search } = new URL(url);
  const name = `${pathname}${search}`.replace(/^\//, '').replaceAll('/', '__').replace(/[^a-z0-9.-]/gi, '_').slice(0, 80);
  return `${name || '_root'}-${createHash('sha1').update(url).digest('hex').slice(0, 8)}`;
}

/** A browser context for `role` whose pages cannot request state-changing URLs themselves. */
async function openContext(browser, statePath) {
  const context = await browser.newContext({ baseURL: origin, storageState: statePath });
  // A page may itself request a state-changing URL (<img src="/logout">, an auto-firing
  // fetch). Abort those. Scripts, styles and fonts are left alone so that a file merely
  // named reset.css still loads.
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = request.url();
    if (UNGUARDED_TYPES.has(request.resourceType()) || !url.startsWith(origin) || !isUnsafe(url, filters)) {
      return route.continue();
    }
    state.unsafeSkipped.add(url);
    return route.abort('blockedbyclient');
  });
  return context;
}

async function visitFile(role, context, url, { probe = false } = {}) {
  const result = await probeFile(context, url, {
    loginPath: config.loginPath,
    canFollow: (target) => normalizeUrl(target, origin) !== null && !isUnsafe(target, filters),
  });
  return {
    record: {
      role, url, kind: 'file', probe,
      status: result.status,
      loginRedirect: result.outcome === 'login-redirect',
      contentType: result.contentType ?? '',
      bytes: result.bytes ?? null,
      method: result.method,
      outcome: result.outcome,
      errors: [],
      failedRequests: [],
    },
    hrefs: [],
  };
}

/**
 * Where a visit really ended, when that is a different page than the one asked for — a
 * server redirect, or an SPA that answered 200 and then sent the role elsewhere. Same-origin
 * targets are reported as a path; a change of query or trailing slash is not a redirect.
 */
function redirectTarget(url, finalUrl) {
  if (!/^https?:/.test(finalUrl)) return null; // about:blank / chrome-error after a failed load
  const landed = new URL(finalUrl);
  if (landed.origin !== origin) return landed.href;
  return index.templateOf(landed.href) === index.templateOf(url) ? null : landed.pathname;
}

async function visitPage(role, context, url, { probe = false } = {}) {
  const template = index.templateOf(url);
  const page = await context.newPage();
  try {
    const result = await capturePage(page, url, { waitStrategy: 'settled' });
    if (result.isFile) return visitFile(role, context, url, { probe });
    const loginRedirect = new URL(result.finalUrl).pathname === config.loginPath;
    const redirectedTo = loginRedirect ? null : redirectTarget(url, result.finalUrl);
    const record = {
      role, url, kind: 'page', probe,
      status: result.status,
      loginRedirect,
      redirectedTo,
      apiDenied: apiDenial(result.network, origin),
      skeleton: result.skeleton,
      errors: result.consoleMsgs.filter((m) => m.type !== 'warning'),
      failedRequests: result.network
        .filter((r) => r.failed)
        .map(({ status, method, url: requestUrl }) => ({ status, method, url: requestUrl })),
      evidence: null,
    };
    const capturable = !probe && !loginRedirect && !redirectedTo && result.status !== null && result.status < 400;
    if (capturable && !fullCaptures.has(template)) {
      fullCaptures.add(template);
      const dir = pageDir(url);
      mkdirSync(path.join(crawlDir, 'pages', dir), { recursive: true });
      // A failed screenshot (web fonts that never load, a huge page) must not cost the visit
      // its links: keep the report, note the error, move on.
      await page
        .screenshot({ path: path.join(crawlDir, 'pages', dir, 'screenshot.png'), fullPage: true, timeout: SCREENSHOT_TIMEOUT_MS })
        .catch((error) => record.errors.push({ type: 'screenshot-error', text: String(error) }));
      writeFileSync(path.join(crawlDir, 'pages', dir, 'exploration.md'), renderExploration(result, host));
      record.evidence = `pages/${dir}/exploration.md`;
    }
    return { record, hrefs: loginRedirect ? [] : result.hrefs };
  } finally {
    await page.close();
  }
}

const visit = (role, context, url, options) => (isFileUrl(url) ? visitFile : visitPage)(role, context, url, options);

/** URLs listed in /sitemap.xml, following a sitemap index one level down. */
async function sitemapUrls(context) {
  const read = async (url) => {
    try {
      const response = await context.request.get(url, { failOnStatusCode: false, maxRedirects: 0 });
      if (!response.ok()) return { xml: '', urls: [] };
      const xml = await response.text();
      const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replaceAll('&amp;', '&'));
      return { xml, urls };
    } catch (error) {
      console.warn(`sitemap ${url} could not be read: ${error.message}`);
      return { xml: '', urls: [] };
    }
  };
  const top = await read(`${origin}/sitemap.xml`);
  if (!/<sitemapindex/i.test(top.xml)) return top.urls;
  const nested = top.urls.filter((url) => normalizeUrl(url, origin) !== null && !isUnsafe(url, filters));
  return (await Promise.all(nested.map(read))).flatMap((sitemap) => sitemap.urls);
}

/** Routes declared in the start page's own scripts (see lib/route-discovery.mjs). */
async function discoverRoutes(browser, statePath) {
  const context = await browser.newContext({ baseURL: origin, storageState: statePath });
  try {
    const shell = await context.request.get(startUrl, { failOnStatusCode: false });
    const scripts = scriptUrls(await shell.text(), shell.url()).slice(0, MAX_SCRIPTS);
    const routes = new Set();
    let relative = 0;
    for (const url of scripts) {
      const response = await context.request.get(url, { failOnStatusCode: false });
      // Oversized scripts are not parsed; routes live in the app bundle, not in vendor blobs.
      if (!response.ok() || Number(response.headers()['content-length'] ?? 0) > MAX_SCRIPT_BYTES) continue;
      const found = extractRoutes(await response.text());
      found.routes.forEach((route) => routes.add(route));
      relative += found.relative;
    }
    return { scripts: scripts.length, relative, routes: [...routes].map((route) => ({ route, url: null, outcome: 'pending' })) };
  } catch (error) {
    console.warn(`route discovery failed: ${error.message}`);
    return null;
  } finally {
    await context.close();
  }
}

/** Turn a bundle route into a URL to crawl, or record why it will not be opened. */
function resolveBundleRoute(entry, seenPaths) {
  const route = instantiate(entry.route, seenPaths);
  if (route === null) {
    entry.outcome = 'no-id';
    return;
  }
  entry.url = normalizeUrl(route, startUrl);
  if (intake(route, startUrl) !== null) entry.outcome = 'queued';
  else entry.outcome = new URL(entry.url).pathname === config.loginPath ? 'login-page' : 'unsafe';
}

/** Breadth-first crawl as one role, `config.concurrency` pages at a time. */
async function crawlRole(browser, role, statePaths) {
  console.log(`crawling as ${role}...`);
  const context = await openContext(browser, statePaths[role]);
  const queue = [];
  const queued = new Set();
  const samplesTaken = new Map();
  let loginRedirects = 0;
  let visited = 0;
  let active = 0;
  let delayMs = config.delayMs;
  let sessionCheck = null;
  let roleStop = null;

  const enqueue = (url, depth) => {
    if (url === null || depth > config.maxDepth || queued.has(url)) return;
    queued.add(url);
    queue.push({ url, depth });
  };
  // Bundle routes with :params are retried whenever the queue runs dry, since the pages
  // crawled so far may have revealed an id to fill them with. Returns how many were queued.
  const enqueueBundleRoutes = () => {
    if (!state.bundle) return 0;
    const seenPaths = [...index.groups().values()].flat().map((url) => new URL(url).pathname);
    let added = 0;
    for (const entry of state.bundle.routes) {
      if (entry.outcome === 'pending' || entry.outcome === 'no-id') resolveBundleRoute(entry, seenPaths);
      if (entry.outcome === 'queued' && !queued.has(entry.url)) {
        enqueue(entry.url, 1);
        added += 1;
      }
    }
    return added;
  };
  // Three login redirects in a row mean either a dead session or pages this role may not
  // open (many frameworks answer "forbidden" with a redirect to login). If the start page
  // still loads, it is the latter: keep those records as access findings. Otherwise the
  // session is dead and only the tester can sign in again: stop the role.
  async function checkSession() {
    const check = await context.request
      .get(startUrl, { maxRedirects: 0, failOnStatusCode: false, timeout: 15_000 })
      .catch(() => null);
    if (check?.ok()) loginRedirects = 0;
    else roleStop = `session for role ${role} expired — sign in again with login.mjs and re-crawl, coverage incomplete`;
  }

  function onLoginRedirect() {
    loginRedirects += 1;
    if (loginRedirects < 3 || sessionCheck) return sessionCheck;
    sessionCheck = checkSession().finally(() => {
      sessionCheck = null;
    });
    return sessionCheck;
  }

  async function handle(item) {
    let { record, hrefs } = await visit(role, context, item.url);
    if (isBusy(record)) {
      delayMs = Math.max(delayMs * 2, 500);
      await sleep(delayMs);
      ({ record, hrefs } = await visit(role, context, item.url));
      if (isBusy(record)) {
        roleStop = `rate limited (HTTP ${record.status}) at ${item.url} — stopped role ${role}, coverage incomplete`;
        return;
      }
    }
    state.visits.push(record);
    if (record.loginRedirect) {
      await onLoginRedirect();
      return;
    }
    if (!sessionCheck) loginRedirects = 0;
    for (const href of hrefs) enqueue(intake(href, item.url), item.depth + 1);
  }

  async function worker() {
    while (!shouldStop() && !roleStop) {
      const item = queue.shift();
      if (!item) {
        if (active === 0 && enqueueBundleRoutes() === 0) return;
        if (active > 0) await sleep(50);
        continue;
      }
      const sampleKey = index.templateOf(item.url);
      if ((samplesTaken.get(sampleKey) ?? 0) >= config.samples) continue;
      if (visited >= config.maxPages) {
        roleStop = `page limit (${config.maxPages}) reached for role ${role} — coverage incomplete`;
        return;
      }
      samplesTaken.set(sampleKey, (samplesTaken.get(sampleKey) ?? 0) + 1);
      visited += 1;
      active += 1;
      try {
        await handle(item);
      } catch (error) {
        state.visits.push(failedVisit(role, item.url, isFileUrl(item.url) ? 'file' : 'page', false, error));
      } finally {
        active -= 1;
      }
      await sleep(delayMs);
    }
  }

  try {
    enqueue(intake(startUrl, startUrl), 0);
    for (const url of await sitemapUrls(context)) enqueue(intake(url, startUrl), 1);
    enqueueBundleRoutes();
    await Promise.all(Array.from({ length: config.concurrency }, worker));
  } finally {
    state.pagesVisited[role] = visited;
    if (roleStop) state.limitWarnings.push(roleStop);
    await context.close();
  }
}

/** Open each template's first URL as every role that never reached it. */
async function probeAccess(browser, statePaths) {
  if (config.roles.length < 2) return;
  const templates = new Map();
  for (const record of state.visits) {
    const template = index.templateOf(record.url);
    const entry = templates.get(template) ?? { url: record.url, kind: record.kind, roles: new Set() };
    if (record.kind === 'file') entry.kind = 'file';
    entry.roles.add(record.role);
    templates.set(template, entry);
  }
  for (const role of config.roles) {
    const context = await openContext(browser, statePaths[role]);
    try {
      for (const entry of templates.values()) {
        if (entry.roles.has(role)) continue;
        if (shouldStop()) return;
        const probe = entry.kind === 'file' ? visitFile : visitPage;
        try {
          state.visits.push((await probe(role, context, entry.url, { probe: true })).record);
        } catch (error) {
          state.visits.push(failedVisit(role, entry.url, entry.kind, true, error));
        }
        await sleep(config.delayMs);
      }
    } finally {
      await context.close();
    }
  }
}

function writeOutputs() {
  state.finishedAt = new Date().toISOString();
  if (stopReason) state.limitWarnings.unshift(`${stopReason} — partial site map`);
  mkdirSync(crawlDir, { recursive: true });
  const siteMap = buildSiteMap(
    { ...state, unsafeSkipped: [...state.unsafeSkipped], externalOrigins: [...state.externalOrigins] },
    index,
  );
  writeFileSync(path.join(crawlDir, 'site-map.json'), JSON.stringify(siteMap, null, 2));
  writeFileSync(path.join(crawlDir, 'site-map.md'), renderSiteMap(siteMap));
  return siteMap;
}

const browser = await chromium.launch(launchOptions({ handleSIGINT: false }));
const statePaths = Object.fromEntries(config.roles.map((role) => [role, sessionPath(stateDir, role)]));

let siteMap;
// Evidence from an earlier crawl would sit beside this one's unlinked but easy to mistake for
// current; clear it now that the sessions are known to exist.
rmSync(path.join(crawlDir, 'pages'), { recursive: true, force: true });
try {
  if (config.bundleRoutes) state.bundle = await discoverRoutes(browser, statePaths[config.roles[0]]);
  for (const role of config.roles) {
    if (shouldStop()) break;
    await crawlRole(browser, role, statePaths);
  }
  await probeAccess(browser, statePaths);
} finally {
  await browser.close().catch((error) => console.error(`browser did not close cleanly: ${error.message}`));
  siteMap = writeOutputs();
}

console.log(`Crawled ${startUrl} as ${config.roles.join(', ')}`);
console.log(`  pages visited: ${config.roles.map((role) => `${role} ${state.pagesVisited[role] ?? 0}`).join(', ')}`);
console.log(`  templates: ${siteMap.templates.length}  unsafe skipped: ${siteMap.warnings.unsafeSkipped.count}`);
for (const warning of siteMap.limitWarnings) console.log(`  WARNING: ${warning}`);
console.log(`  site map -> ${path.join(crawlDir, 'site-map.md')}`);
process.exit(0);
