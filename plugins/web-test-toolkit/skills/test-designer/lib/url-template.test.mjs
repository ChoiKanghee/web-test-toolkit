import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFileUrl, isUnsafe, normalizeUrl, TemplateIndex } from './url-template.mjs';

const BASE = 'https://app.test/orders/';

test('normalizeUrl resolves relative links, drops fragments and tracking, sorts the query', () => {
  assert.equal(normalizeUrl('42#top', BASE), 'https://app.test/orders/42');
  assert.equal(
    normalizeUrl('/list?b=2&utm_source=x&a=1&gclid=z&fbclid=y', BASE),
    'https://app.test/list?a=1&b=2',
  );
  assert.equal(normalizeUrl('https://app.test', BASE), 'https://app.test/');
});

test('normalizeUrl rejects other origins, non-http schemes and malformed hrefs', () => {
  for (const href of [
    'https://other.test/',
    'http://app.test/',
    'mailto:help@app.test',
    'tel:+84123',
    'javascript:alert(1)',
    'http://[',
  ]) {
    assert.equal(normalizeUrl(href, BASE), null, href);
  }
});

test('normalizeUrl treats "#" and "" as the current page', () => {
  assert.equal(normalizeUrl('#', 'https://app.test/a?x=1'), 'https://app.test/a?x=1');
  assert.equal(normalizeUrl('', 'https://app.test/a'), 'https://app.test/a');
});

test('isUnsafe blocks state-changing path segments', () => {
  for (const pathname of [
    '/logout',
    '/sign-out',
    '/items/5/delete',
    '/settings/delete-account',
    '/team/remove_member/3',
    '/reports/export.csv',
    '/remove-bg-tool',
  ]) {
    assert.equal(isUnsafe(`https://app.test${pathname}`), true, pathname);
  }
});

test('isUnsafe blocks underscore, path-parameter and camelCase logout forms', () => {
  for (const pathname of ['/users/sign_out', '/log_out', '/logout;jsessionid=abc', '/api/logoutAll', '/deleteItem/4']) {
    assert.equal(isUnsafe(`https://app.test${pathname}`), true, pathname);
  }
});

test('isUnsafe blocks live sessions and auth callbacks', () => {
  for (const pathname of ['/auth/callback', '/meetings/9c57/live', '/live-session']) {
    assert.equal(isUnsafe(`https://app.test${pathname}`), true, pathname);
  }
  assert.equal(isUnsafe('https://app.test/delivery'), false);
});

test('isUnsafe allows look-alike words', () => {
  for (const pathname of ['/', '/orders/42', '/deleted-items', '/deletedItems', '/tools/bg-remover', '/exports']) {
    assert.equal(isUnsafe(`https://app.test${pathname}`), false, pathname);
  }
});

test('isUnsafe blocks actions carried in the query string (Review Focus)', () => {
  assert.equal(isUnsafe('https://app.test/items/5?action=delete'), true);
  assert.equal(isUnsafe('https://app.test/items/5?_method=DELETE'), true);
  assert.equal(isUnsafe('https://app.test/items?sort=created'), false);
});

test('--exclude adds blocks; --allow reopens defaults but never overrides --exclude', () => {
  const filters = { exclude: [/\/billing/], allow: [/\/remove-bg-tool/, /\/billing/] };
  assert.equal(isUnsafe('https://app.test/billing/plans', filters), true);
  assert.equal(isUnsafe('https://app.test/remove-bg-tool', filters), false);
  assert.equal(isUnsafe('https://app.test/logout', filters), true);
});

test('isFileUrl recognises file extensions but not sitemap.xml or dotted folders', () => {
  assert.equal(isFileUrl('https://app.test/invoices/1042.PDF'), true);
  assert.equal(isFileUrl('https://app.test/data/export.csv?x=1'), true);
  assert.equal(isFileUrl('https://app.test/sitemap.xml'), false);
  assert.equal(isFileUrl('https://app.test/orders/42'), false);
  assert.equal(isFileUrl('https://app.test/v1.2/docs'), false);
});

const at = (pathname) => `https://app.test${pathname}`;

test('numbers, UUIDs, long hex and dates become :id', () => {
  const index = new TemplateIndex();
  assert.equal(index.add(at('/orders/42')), '/orders/:id');
  assert.equal(
    index.add(at('/users/3f2c1a9e-8b7d-4c6e-9f10-1a2b3c4d5e6f/settings')),
    '/users/:id/settings',
  );
  assert.equal(index.add(at('/commits/9fceb02d0ae598e9')), '/commits/:id');
  assert.equal(index.add(at('/reports/2026-09-27')), '/reports/:id');
});

test('file extensions survive templating', () => {
  const index = new TemplateIndex();
  assert.equal(index.add(at('/invoices/1042.pdf')), '/invoices/:id.pdf');
});

test('root and trailing slashes', () => {
  const index = new TemplateIndex();
  assert.equal(index.add(at('/')), '/');
  assert.equal(index.add(at('/orders/')), '/orders');
});

test('the query does not split a template, but every URL is kept once', () => {
  const index = new TemplateIndex();
  index.add(at('/files/get?id=3'));
  index.add(at('/files/get?id=4'));
  index.add(at('/files/get?id=3'));
  assert.deepEqual(index.groups().get('/files/get'), [at('/files/get?id=3'), at('/files/get?id=4')]);
});

test('siblings beyond the threshold collapse to :slug and earlier URLs regroup', () => {
  const index = new TemplateIndex({ slugThreshold: 3 });
  const urls = ['a', 'b', 'c', 'd'].map((slug) => at(`/products/widget-${slug}`));
  urls.slice(0, 3).forEach((url) => index.add(url));
  assert.equal(index.templateOf(urls[0]), '/products/widget-a');

  index.add(urls[3]);

  assert.equal(index.templateOf(urls[0]), '/products/:slug');
  assert.deepEqual(index.groups().get('/products/:slug'), urls);
});

test('ids do not count towards the slug threshold', () => {
  const index = new TemplateIndex({ slugThreshold: 3 });
  for (let id = 1; id <= 10; id += 1) index.add(at(`/orders/${id}`));
  assert.equal(index.add(at('/orders/new')), '/orders/new');
});

test('top-level sections never collapse, however many there are (Review Focus)', () => {
  const index = new TemplateIndex({ slugThreshold: 3 });
  for (const section of ['about', 'pricing', 'careers', 'blog', 'docs']) index.add(at(`/${section}`));
  assert.equal(index.templateOf(at('/pricing')), '/pricing');
});
