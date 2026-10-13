import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiDenial, buildSiteMap, classifyAccess, renderSiteMap, skeletonMismatch } from './site-map.mjs';
import { TemplateIndex } from './url-template.mjs';

const ORIGIN = 'https://app.test';
const common = { probe: false, status: 200, loginRedirect: false, errors: [], failedRequests: [] };
const pageVisit = (role, pathname, extra = {}) => ({
  ...common, role, url: `${ORIGIN}${pathname}`, kind: 'page',
  skeleton: { fields: 1, buttons: 2, landmarks: ['main'] }, evidence: null, ...extra,
});
const fileVisit = (role, pathname, extra = {}) => ({
  ...common, role, url: `${ORIGIN}${pathname}`, kind: 'file',
  contentType: 'application/pdf', bytes: 2048, method: 'head', ...extra,
});

function siteMap(visits, overrides = {}) {
  const index = new TemplateIndex();
  for (const visit of visits) index.add(visit.url);
  return buildSiteMap({
    baseUrl: ORIGIN, roles: ['admin', 'user'], config: {}, startedAt: 'T0', finishedAt: 'T1',
    pagesVisited: { admin: 4, user: 2 }, limitWarnings: [], unsafeSkipped: [], externalOrigins: [],
    visits, ...overrides,
  }, index);
}

test('classifyAccess', () => {
  assert.equal(classifyAccess(undefined), 'not-probed');
  assert.equal(classifyAccess({ status: 200, loginRedirect: false }), 'allowed');
  assert.equal(classifyAccess({ status: 403, loginRedirect: false }), 'denied');
  assert.equal(classifyAccess({ status: 401, loginRedirect: false }), 'denied');
  assert.equal(classifyAccess({ status: 200, loginRedirect: true }), 'login-redirect');
  assert.equal(classifyAccess({ status: 404, loginRedirect: false }), 'http 404');
  assert.equal(classifyAccess({ status: null, loginRedirect: false }), 'error');
  assert.equal(classifyAccess({ status: 200, loginRedirect: false, redirectedTo: '/home' }), 'redirected → /home');
  assert.equal(classifyAccess({ status: 200, loginRedirect: false, apiDenied: 404 }), 'API 404',
    'an SPA page answers 200 while its own API refuses the role');
});

test('apiDenial: the first 401/403/404 a page\'s own API gave it, ignoring assets and other sites', () => {
  const req = (url, status, type = 'fetch') => ({ url, status, type, method: 'GET', failed: status >= 400 });
  const origin = 'https://dev.app.test';
  assert.equal(apiDenial([req('https://dev.app.test/api/me', 200), req('https://api.dev.app.test/api/meetings/9', 404)], origin), 404,
    'an API on a sibling subdomain of the same site counts');
  assert.equal(apiDenial([req('https://dev.app.test/api/admin', 403, 'xhr')], origin), 403);
  assert.equal(apiDenial([req('https://dev.app.test/logo.png', 404, 'image')], origin), null, 'a missing asset is not a refusal');
  assert.equal(apiDenial([req('https://tracker.example.org/api/x', 404)], origin), null, 'another site is not this app');
  assert.equal(apiDenial([req('https://dev.app.test/api/report', 500)], origin), null, 'a server error is not a refusal');
  assert.equal(apiDenial([req('http://127.0.0.1:4000/api/reports/7', 404)], 'http://127.0.0.1:4000'), 404);
  assert.equal(apiDenial([], origin), null);
});

test('skeletonMismatch flags samples whose structure differs', () => {
  const s = (fields, buttons, landmarks = ['main']) => ({ fields, buttons, landmarks });
  assert.equal(skeletonMismatch([s(3, 2)]), false);
  assert.equal(skeletonMismatch([s(3, 2), s(3, 2)]), false);
  assert.equal(skeletonMismatch([s(0, 0), s(0, 0)]), false);
  assert.equal(skeletonMismatch([s(10, 2), s(2, 2)]), true);
  assert.equal(skeletonMismatch([s(3, 2), s(3, 2, ['main', 'navigation'])]), true);
});

test('buildSiteMap groups visits into templates with counts, evidence and deduplicated health', () => {
  const boom = { type: 'error', text: 'boom' };
  const map = siteMap([
    pageVisit('admin', '/orders', { evidence: 'pages/orders-1a2b3c4d/exploration.md', skeleton: { fields: 0, buttons: 5, landmarks: ['main'] } }),
    pageVisit('admin', '/orders/1', { errors: [boom], failedRequests: [{ status: 500, method: 'GET', url: `${ORIGIN}/api/x` }] }),
    pageVisit('admin', '/orders/2', { errors: [boom] }),
    fileVisit('admin', '/invoices/7.pdf'),
  ]);

  const orders = map.templates.find((t) => t.template === '/orders');
  assert.equal(orders.evidence, 'pages/orders-1a2b3c4d/exploration.md');
  assert.equal(orders.buttons, 5);
  const order = map.templates.find((t) => t.template === '/orders/:id');
  assert.deepEqual([order.kind, order.urlsSeen, order.errors, order.failedRequests], ['page', 2, 1, 1]);
  assert.deepEqual(map.health.find((h) => h.text === 'boom'), { template: '/orders/:id', type: 'error', text: 'boom', count: 2 });
  const invoice = map.templates.find((t) => t.template === '/invoices/:id.pdf');
  assert.deepEqual([invoice.kind, invoice.bytes, invoice.status], ['file', 2048, 200]);
});

test('access matrix classifies every role; probe visits stay out of health', () => {
  const map = siteMap([
    pageVisit('admin', '/'),
    pageVisit('user', '/'),
    pageVisit('admin', '/admin'),
    pageVisit('user', '/admin', { probe: true, status: 403, failedRequests: [{ status: 403, method: 'GET', url: `${ORIGIN}/admin` }] }),
  ]);

  assert.deepEqual(map.access['/admin'], { admin: 'allowed', user: 'denied' });
  assert.deepEqual(map.access['/'], { admin: 'allowed', user: 'allowed' });
  assert.deepEqual(map.health, []);
});

test('bundle routes: queued routes resolve to opened or not visited, with their template', () => {
  const map = siteMap([pageVisit('admin', '/'), pageVisit('admin', '/admin')], {
    bundle: {
      scripts: 2,
      relative: 3,
      routes: [
        { route: '/admin', url: `${ORIGIN}/admin`, outcome: 'queued' },
        { route: '/settings', url: `${ORIGIN}/settings`, outcome: 'queued' },
        { route: '/meetings/:id/live', url: `${ORIGIN}/meetings/7/live`, outcome: 'unsafe' },
        { route: '/reports/:id', url: null, outcome: 'no-id' },
      ],
    },
  });

  assert.deepEqual(map.bundleRoutes.routes.map((r) => [r.route, r.outcome, r.template]), [
    ['/admin', 'opened', '/admin'],
    ['/settings', 'not visited', null],
    ['/meetings/:id/live', 'unsafe', null],
    ['/reports/:id', 'no-id', null],
  ]);
  const md = renderSiteMap(map);
  assert.ok(md.includes('## Routes from JS bundle'));
  assert.ok(md.includes('3 relative route(s)'));
  assert.equal(renderSiteMap(siteMap([pageVisit('admin', '/')])).includes('## Routes from JS bundle'), false);
});

test('client-side redirects are not evidence, not skeletons, and not "allowed"', () => {
  const map = siteMap([
    pageVisit('user', '/admin', { redirectedTo: '/home', skeleton: { fields: 0, buttons: 40, landmarks: ['main'] } }),
    pageVisit('admin', '/admin', { evidence: 'pages/admin-1/exploration.md' }),
    pageVisit('user', '/register', { redirectedTo: '/home' }),
  ], {
    bundle: { scripts: 1, relative: 0, routes: [{ route: '/register', url: `${ORIGIN}/register`, outcome: 'queued' }] },
  });

  assert.deepEqual(map.access['/admin'], { admin: 'allowed', user: 'redirected → /home' });
  const admin = map.templates.find((t) => t.template === '/admin');
  assert.equal(admin.skeletonMismatch, false, 'the redirected sample is not compared');
  const register = map.templates.find((t) => t.template === '/register');
  assert.equal(register.redirectsTo, '/home');
  assert.equal(map.bundleRoutes.routes[0].outcome, 'redirected → /home');
  assert.ok(renderSiteMap(map).includes('| redirects to /home |'));
});

test('a single-role crawl has no access matrix', () => {
  const map = siteMap([pageVisit('default', '/')], { roles: ['default'], pagesVisited: { default: 1 } });
  assert.deepEqual(map.access, {});
  assert.ok(!renderSiteMap(map).includes('## Access matrix'));
});

test('renderSiteMap: limit warnings first, differing access rows first, broken files first', () => {
  const map = siteMap([
    pageVisit('admin', '/'),
    pageVisit('user', '/'),
    pageVisit('admin', '/admin'),
    pageVisit('user', '/admin', { probe: true, status: 403 }),
    fileVisit('admin', '/docs/a.pdf'),
    fileVisit('admin', '/docs/missing.pdf', { status: 404 }),
    pageVisit('admin', '/slow', { status: null, navError: 'page.goto: Timeout 30000ms exceeded.\nCall log: ...' }),
  ], {
    limitWarnings: ['page limit (200) reached for role admin — coverage incomplete'],
    unsafeSkipped: [`${ORIGIN}/logout`],
    externalOrigins: ['https://cdn.test'],
  });

  const md = renderSiteMap(map);

  assert.ok(md.startsWith(`# Site map — ${ORIGIN}\n`));
  assert.ok(md.indexOf('> **Warning:** page limit (200)') < md.indexOf('## Summary'));
  const files = md.slice(md.indexOf('## Files'), md.indexOf('## Access matrix'));
  assert.ok(files.indexOf('/docs/missing.pdf') < files.indexOf('/docs/a.pdf'));
  const access = md.slice(md.indexOf('## Access matrix'), md.indexOf('## Health'));
  assert.ok(access.indexOf('| /admin |') < access.indexOf('| / |'));
  assert.ok(access.includes('| /docs/a.pdf [file] |'));
  assert.ok(md.includes(`  - ${ORIGIN}/logout`));
  assert.ok(md.includes('1 external origin(s)'));
  assert.ok(md.includes('Navigation error (admin) https://app.test/slow: page.goto: Timeout 30000ms exceeded.'));
  assert.ok(!md.includes('Call log'));
});
