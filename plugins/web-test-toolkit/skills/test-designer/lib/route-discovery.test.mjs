import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRoutes, instantiate, scriptUrls } from './route-discovery.mjs';

const BUNDLE = [
  'l.jsx(_r,{path:"/admin",element:l.jsx(wV,{})})',
  '{path:"/meetings/:id/live",element:l.jsx(rH,{})}',
  '{path: "/settings", Component: Settings}',
  "{path:'/vue-page',component:VuePage}",
  '{path:"/nested",children:[{path:"members",element:x}]}',
  '{path:"*",element:NotFound}',
  'Object.assign({path:"/engine.io",agent:!1})',
  '{data:x,path:"word/document.xml"}',
  '{path:"/admin",element:duplicate}',
].join(';');

test('extractRoutes keeps absolute router paths once, in order', () => {
  assert.deepEqual(extractRoutes(BUNDLE).routes, ['/admin', '/meetings/:id/live', '/settings', '/vue-page', '/nested']);
});

test('extractRoutes ignores non-router path strings and wildcards, and counts relative routes', () => {
  const { routes, relative } = extractRoutes(BUNDLE);
  assert.ok(!routes.includes('/engine.io'));
  assert.ok(!routes.some((route) => route.includes('*') || route.startsWith('word/')));
  assert.equal(relative, 1);
});

test('instantiate returns a static route unchanged', () => {
  assert.equal(instantiate('/admin', []), '/admin');
});

test('instantiate fills :params from a path already seen under the same prefix', () => {
  assert.equal(instantiate('/meetings/:id/live', ['/home', '/meetings/9c57']), '/meetings/9c57/live');
  assert.equal(
    instantiate('/teams/:team/members/:member', ['/teams/a/members/b']),
    '/teams/a/members/b',
  );
});

test('instantiate returns null when no seen path can fill a param', () => {
  assert.equal(instantiate('/invoices/:id', ['/orders/1']), null);
});

test('instantiate drops optional params', () => {
  assert.equal(instantiate('/docs/:lang?/intro', []), '/docs/intro');
});

test('scriptUrls lists same-origin scripts and module preloads', () => {
  const html = `<script type="module" src="/assets/index-AB.js"></script>
<link rel="modulepreload" href="/assets/vendor-CD.js">
<script src="https://cdn.other.test/lib.js"></script><script>inline()</script>`;
  assert.deepEqual(scriptUrls(html, 'https://app.test/home'), [
    'https://app.test/assets/index-AB.js',
    'https://app.test/assets/vendor-CD.js',
  ]);
});
