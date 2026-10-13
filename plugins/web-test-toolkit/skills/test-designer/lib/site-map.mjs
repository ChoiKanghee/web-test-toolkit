// site-map.mjs — turn raw crawl state into a site map (templates, files, access matrix,
// health, warnings) and render the Markdown an agent reads. Pure: no browser, no disk.

import { isFileUrl } from './url-template.mjs';

const EXAMPLE_LIMIT = 20;
const MESSAGE_LIMIT = 200;

/** One role's verdict on one template, from the first visit that role made to it. */
export function classifyAccess(visit) {
  if (!visit) return 'not-probed';
  if (visit.loginRedirect) return 'login-redirect';
  // An SPA answers 200 and then sends the role elsewhere: the UI refused the page.
  if (visit.redirectedTo) return `redirected → ${visit.redirectedTo}`;
  if (visit.status === 401 || visit.status === 403) return 'denied';
  if (visit.status === null) return 'error';
  // An SPA answers 200 for every URL; the server's answer is the page's own API call.
  if (visit.status >= 200 && visit.status < 300) return visit.apiDenied ? `API ${visit.apiDenied}` : 'allowed';
  return `http ${visit.status}`;
}

// The site of a host: its last two labels (dev.app.test and api.dev.app.test are one site),
// or the host itself for an IP address. Hosts under a two-label suffix (.co.uk) over-match.
const siteOf = (hostname) => (/^[\d.]+$|:/.test(hostname) ? hostname : hostname.split('.').slice(-2).join('.'));
const REFUSALS = new Set([401, 403, 404]);

/**
 * The first 401/403/404 that a page's own API (a fetch or XHR to the same site) answered while
 * the page loaded, or null. Assets that 404 and other sites' calls are not refusals.
 */
export function apiDenial(network, origin) {
  const site = siteOf(new URL(origin).hostname);
  const refusal = network.find((r) => (r.type === 'fetch' || r.type === 'xhr')
    && REFUSALS.has(r.status) && siteOf(new URL(r.url).hostname) === site);
  return refusal ? refusal.status : null;
}

/** True when a template's samples differ in structure enough that it may mix pages. */
export function skeletonMismatch(skeletons) {
  if (skeletons.length < 2) return false;
  const spread = (key) => {
    const values = skeletons.map((s) => s[key]);
    const max = Math.max(...values);
    return max > 0 && (max - Math.min(...values)) / max > 0.5;
  };
  const landmarkSets = new Set(skeletons.map((s) => s.landmarks.join(',')));
  return spread('fields') || spread('buttons') || landmarkSets.size > 1;
}

function templateRow(template, urls, visits) {
  const crawled = visits.filter((v) => !v.probe);
  const first = crawled[0] ?? visits[0];
  const evidenceVisit = visits.find((v) => v.evidence);
  const isFile = visits.some((v) => v.kind === 'file') || (visits.length === 0 && isFileUrl(urls[0]));
  return {
    template,
    kind: isFile ? 'file' : 'page',
    urlsSeen: urls.length,
    urls,
    evidence: evidenceVisit?.evidence ?? null,
    fields: evidenceVisit?.skeleton.fields ?? null,
    buttons: evidenceVisit?.skeleton.buttons ?? null,
    errors: new Set(visits.flatMap((v) => v.errors.map((e) => e.text))).size,
    failedRequests: visits.reduce((sum, v) => sum + v.failedRequests.length, 0),
    status: first?.status ?? null,
    contentType: first?.contentType ?? null,
    bytes: first?.bytes ?? null,
    skeletonMismatch: skeletonMismatch(
      crawled.filter((v) => v.skeleton && !v.loginRedirect && !v.redirectedTo).map((v) => v.skeleton),
    ),
    redirectsTo: crawled.length && crawled.every((v) => v.redirectedTo) ? crawled[0].redirectedTo : null,
    visits,
  };
}

/** Group every visit under its current template and derive the site map. */
export function buildSiteMap(state, index) {
  const visitsByTemplate = new Map();
  for (const visit of state.visits) {
    const template = index.templateOf(visit.url);
    if (!visitsByTemplate.has(template)) visitsByTemplate.set(template, []);
    visitsByTemplate.get(template).push(visit);
  }
  const templates = [...index.groups()]
    .map(([template, urls]) => templateRow(template, urls, visitsByTemplate.get(template) ?? []))
    .sort((a, b) => a.template.localeCompare(b.template));

  const access = {};
  if (state.roles.length >= 2) {
    for (const row of templates) {
      access[row.template] = Object.fromEntries(
        state.roles.map((role) => [role, classifyAccess(row.visits.find((v) => v.role === role))]),
      );
    }
  }

  const counts = new Map();
  for (const row of templates) {
    for (const visit of row.visits.filter((v) => !v.probe)) {
      const issues = [
        ...visit.errors.map((e) => [e.type, e.text]),
        ...visit.failedRequests.map((r) => ['failed-request', `${r.status} ${r.method} ${r.url}`]),
      ];
      for (const [type, text] of issues) {
        const key = JSON.stringify([row.template, type, text]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const health = [...counts].map(([key, count]) => {
    const [template, type, text] = JSON.parse(key);
    return { template, type, text, count };
  });

  // A queued bundle route is 'opened' once any role visited its URL without being sent away.
  const queuedOutcome = (url) => {
    const visits = state.visits.filter((v) => v.url === url);
    if (visits.some((v) => !v.redirectedTo)) return 'opened';
    return visits.length ? `redirected → ${visits[0].redirectedTo}` : 'not visited';
  };
  const bundleRoutes = state.bundle
    ? {
      scripts: state.bundle.scripts,
      relative: state.bundle.relative,
      routes: state.bundle.routes.map(({ route, url, outcome }) => {
        const result = outcome === 'queued' ? queuedOutcome(url) : outcome;
        return { route, url, outcome: result, template: result === 'opened' ? index.templateOf(url) : null };
      }),
    }
    : null;

  const navErrors = state.visits
    .map((v) => ({ url: v.url, role: v.role, text: v.navError ?? v.errors.find((e) => e.type === 'nav-error')?.text }))
    .filter((e) => e.text);

  return {
    baseUrl: state.baseUrl,
    roles: state.roles,
    config: state.config,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    pagesVisited: state.pagesVisited,
    limitWarnings: state.limitWarnings,
    templates,
    access,
    health,
    bundleRoutes,
    warnings: {
      skeletonMismatch: templates.filter((t) => t.skeletonMismatch).map((t) => t.template),
      unsafeSkipped: { count: state.unsafeSkipped.length, examples: state.unsafeSkipped.slice(0, EXAMPLE_LIMIT) },
      externalOrigins: state.externalOrigins.length,
      navErrors,
    },
  };
}

const cell = (value) => (value === null || value === undefined || value === '' ? '—' : String(value).replaceAll('|', '\\|'));
const table = (header, rows) => [
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
].join('\n');
const isBroken = (row) => row.status !== null && row.status >= 400;
const firstLine = (text) => text.split('\n')[0].slice(0, MESSAGE_LIMIT);

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function renderAccess(map) {
  if (map.roles.length < 2) return [];
  const rows = map.templates.map((row) => {
    const values = map.roles.map((role) => map.access[row.template][role]);
    return { row, values, differs: new Set(values).size > 1 };
  });
  rows.sort((a, b) => Number(b.differs) - Number(a.differs) || a.row.template.localeCompare(b.row.template));
  return [
    '## Access matrix',
    'Rows where roles differ come first — each is a candidate authorization test case.',
    table(['Template', ...map.roles], rows.map(({ row, values }) => [
      row.kind === 'file' ? `${row.template} [file]` : row.template,
      ...values,
    ])),
  ];
}

function renderBundleRoutes(bundle) {
  if (!bundle) return [];
  const relative = bundle.relative
    ? ` ${bundle.relative} relative route(s) skipped: their parent path cannot be recovered from the bundle.`
    : '';
  return [
    '## Routes from JS bundle',
    `Found in ${bundle.scripts} script(s). Routes are opened like links; \`unsafe\` ones and \`no-id\` ones (a :param no seen page could fill) are listed only.${relative}`,
    bundle.routes.length
      ? table(['Route', 'Result', 'Template'], bundle.routes.map((r) => [r.route, r.outcome, r.template]))
      : '_No routes found._',
  ];
}

function renderWarnings({ skeletonMismatch: mismatched, unsafeSkipped, externalOrigins, navErrors }) {
  const lines = [
    ...mismatched.map((t) => `- Template \`${t}\` has samples with different page structure; it may group unrelated pages.`),
    ...(unsafeSkipped.count
      ? [
        `- Skipped ${unsafeSkipped.count} URL(s) that look state-changing (rerun with --allow <regex> to include one):`,
        ...unsafeSkipped.examples.map((url) => `  - ${url}`),
      ]
      : []),
    ...(externalOrigins ? [`- ${externalOrigins} external origin(s) linked, not crawled.`] : []),
    ...navErrors.map((e) => `- Navigation error (${e.role}) ${e.url}: ${firstLine(e.text)}`),
  ];
  return lines.length ? lines.join('\n') : '_None._';
}

/** The site-map.md report. */
export function renderSiteMap(map) {
  const pages = map.templates.filter((t) => t.kind === 'page');
  const files = map.templates
    .filter((t) => t.kind === 'file')
    .sort((a, b) => Number(isBroken(b)) - Number(isBroken(a)) || a.template.localeCompare(b.template));
  const sections = [
    `# Site map — ${map.baseUrl}`,
    ...map.limitWarnings.map((warning) => `> **Warning:** ${warning}`),
    '## Summary',
    [
      `- **Roles:** ${map.roles.join(', ')}`,
      `- **Pages visited:** ${map.roles.map((role) => `${role} ${map.pagesVisited[role] ?? 0}`).join(', ')}`,
      `- **Templates:** ${pages.length} pages, ${files.length} files`,
      `- **Crawled:** ${map.startedAt} to ${map.finishedAt}`,
    ].join('\n'),
    '## Templates',
    pages.length
      ? table(
        ['Template', 'URLs seen', 'Fields', 'Buttons', 'Errors', 'Failed req', 'Evidence'],
        pages.map((t) => [
          t.template, t.urlsSeen, t.fields, t.buttons, t.errors, t.failedRequests,
          t.evidence ? `[exploration](${t.evidence})` : t.redirectsTo && `redirects to ${t.redirectsTo}`,
        ]),
      )
      : '_No pages found._',
    '## Files',
    files.length
      ? table(
        ['Template', 'Content-Type', 'URLs seen', 'Size (sample)', 'Status'],
        files.map((t) => [t.template, t.contentType, t.urlsSeen, formatBytes(t.bytes), t.status]),
      )
      : '_No files found._',
    ...renderAccess(map),
    ...renderBundleRoutes(map.bundleRoutes),
    '## Health',
    map.health.length
      ? table(['Template', 'Type', 'Message', 'Count'], map.health.map((h) => [h.template, h.type, firstLine(h.text), h.count]))
      : '_No console errors or failed requests._',
    '## Warnings',
    renderWarnings(map.warnings),
  ];
  return `${sections.join('\n\n')}\n`;
}
