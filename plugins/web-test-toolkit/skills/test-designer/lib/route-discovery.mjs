// route-discovery.mjs — find client-side routes in an SPA's JavaScript bundle, so the
// crawler can reach pages the UI only opens through buttons. Router configs keep their
// property names through minification (React Router, Vue Router, Angular all write
// `path: "/x", element|component|...`), so a path string followed by one of those keys is a
// route; `path:` strings in other libraries (socket.io, docx writers) are not.

import { normalizeUrl } from './url-template.mjs';

const ROUTE = /path\s*:\s*(["'`])([^"'`]*?)\1\s*,\s*(?:element|Component|component|lazy|children|loader|redirect|redirectTo|name|meta|loadComponent|loadChildren|beforeEnter|props)\b/g;

/**
 * Absolute route paths declared in `source`, deduplicated in order of appearance. Wildcard
 * routes are dropped. Relative child routes ('members' under '/team') are only counted:
 * their parent prefix cannot be recovered reliably from minified code.
 */
export function extractRoutes(source) {
  const routes = new Set();
  let relative = 0;
  for (const [, , path] of source.matchAll(ROUTE)) {
    if (path.includes('*')) continue;
    if (path.startsWith('/')) routes.add(path);
    else if (path !== '') relative += 1;
  }
  return { routes: [...routes], relative };
}

/**
 * A concrete path for `route`: optional params (':lang?') are dropped, and required params
 * are filled from the first seen path that matches the route up to its last param. Returns
 * null when no seen path fits, so the route can be reported instead of guessed.
 */
export function instantiate(route, seenPaths) {
  const segments = route.split('/').filter((segment) => segment && !/^:[^/]+\?$/.test(segment));
  const lastParam = segments.findLastIndex((segment) => segment.startsWith(':'));
  if (lastParam === -1) return `/${segments.join('/')}`;
  for (const seen of seenPaths) {
    const parts = seen.split('/').filter(Boolean);
    if (parts.length <= lastParam) continue;
    const fits = segments.slice(0, lastParam + 1).every((segment, i) => segment.startsWith(':') || segment === parts[i]);
    if (fits) return `/${segments.map((segment, i) => (segment.startsWith(':') ? parts[i] : segment)).join('/')}`;
  }
  return null;
}

/** Same-origin script and module-preload URLs referenced by an HTML page. */
export function scriptUrls(html, pageUrl) {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const preloads = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => /\brel\s*=\s*["']?modulepreload/i.test(tag))
    .map((tag) => /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1])
    .filter(Boolean);
  const urls = [...scripts, ...preloads].map((src) => normalizeUrl(src, pageUrl)).filter((url) => url !== null);
  return [...new Set(urls)];
}
