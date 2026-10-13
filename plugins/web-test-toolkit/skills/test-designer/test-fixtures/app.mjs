// app.mjs — a fake web app the crawler's tests run against. It serves pages behind a cookie
// login with two roles, files that stream slowly (so a test can tell whether a client read a
// whole file), and trap URLs that must never be requested.
// Test-only: the credentials below exist nowhere but here.

import { createServer } from 'node:http';

export const USERS = {
  admin: { email: 'admin@fixture.test', password: 'admin-fixture-pass' },
  user: { email: 'user@fixture.test', password: 'user-fixture-pass' },
};
export const FILE_BYTES = 5 * 1024 * 1024;
export const TRAPS = ['/logout', '/items/1/delete', '/reports/export.csv'];
export const PRODUCT_SLUGS = Array.from(
  { length: 30 },
  (_, i) => `widget-${String.fromCharCode(97 + (i % 26))}${i < 26 ? '' : 'x'}`,
);

const CHUNK = Buffer.alloc(64 * 1024, 37);
// The SPA bundle the home page loads: routes no link points to, plus path strings that are
// not routes (a socket.io option, a docx part name).
const APP_BUNDLE = `window.__routes = [
  { path: "/hidden-route", element: "Hidden" },
  { path: "/orders/:id/receipt", element: "Receipt" },
  { path: "/orders/:id/live", element: "Live" },
  { path: "/reports/:reportId", element: "Report" },
  { path: "/team", children: [{ path: "members", element: "Members" }] },
  { path: "*", element: "NotFound" },
];
window.__io = { path: "/engine.io", agent: false };
window.__docx = { data: "", path: "word/document.xml" };`;
const PUBLIC_PATHS = new Set([
  '/login', '/login2', '/login-sso', '/oauth/google', '/public', '/long-poll', '/never-ends', '/no-form',
  '/go-export',
]);

const html = (title, body) =>
  `<!doctype html><html><head><title>${title}</title><link rel="icon" href="data:,"></head><body>${body}</body></html>`;

const loginForm = (error = '') => html('Sign in', `<main>${error}<form method="post" action="/login">
<label>Email <input name="email" type="email"></label>
<label>Password <input name="password" type="password"></label>
<button type="button" aria-label="Show password">eye</button>
<button type="submit">Sign in</button></form></main>`);

// An SSO button that sits before the form and also matches "sign in" must never be pressed.
const loginWithSso = html('Sign in', `<main>
<button type="button" onclick="location.href='/oauth/google'">Sign in with Google</button>
<form method="post" action="/login">
<label>Email <input name="email" type="email"></label>
<label>Password <input name="password" type="password"></label>
<button type="submit">Sign in</button></form></main>`);

const loginStepOne = html('Sign in', `<main><form method="post" action="/login2">
<label>Email <input name="email" type="email"></label>
<button type="submit">Continue</button></form></main>`);

const loginStepTwo = (email) => html('Sign in', `<main><form method="post" action="/login2">
<input type="hidden" name="email" value="${email}">
<label>Password <input name="password" type="password"></label>
<button type="submit">Sign in</button></form></main>`);

const PUBLIC_PAGE = html('Fixture public', `<header><nav>
<a href="/orders">Orders</a> <a href="/docs/manual.pdf">Manual</a>
</nav></header>
<main><h1>Fixture public</h1>
<form><label>Email <input name="email" type="email" placeholder="you@example.com"></label>
<button type="submit">Subscribe</button></form>
<button aria-label="Dark mode"></button>
<div hidden><a href="/hidden-menu">Hidden menu</a></div>
</main><script>console.error('fixture-error')</script>`);

// slowFontHome: a web font that never loads, so screenshots of / time out.
// denyByRedirect: non-admins get hidden admin links, and forbidden pages redirect to login.
function home(role, { slowFontHome, denyByRedirect }) {
  const adminLinks = role === 'admin' ? '<a href="/admin">Admin</a> <a href="/invoices">Invoices</a>' : '';
  const deniedLinks = denyByRedirect && role !== 'admin'
    ? `<div hidden><a href="/admin">Admin</a> <a href="/admin/users">Users</a> <a href="/admin/billing">Billing</a>
<a href="/admin/audit">Audit</a></div> <a href="/login?next=/orders">Switch account</a>`
    : '';
  const font = slowFontHome ? '<style>@font-face{font-family:slow;src:url(/never-ends)} body{font-family:slow}</style>' : '';
  return html('Home', `${font}${deniedLinks}<script type="module" src="/assets/app.js"></script><header><nav>
<a href="/orders">Orders</a> <a href="/products">Products</a> <a href="/broken">Broken</a> <a href="/spa-admin">Console</a> <a href="/statements/7">Statement</a> ${adminLinks}
<a href="/docs/manual.pdf">Manual</a> <a href="/files/get?id=3">Export file</a>
<a href="/legacy/report.pdf">Legacy report</a> <a href="/docs/missing.pdf">Missing</a>
<a href="/logout">Log out</a> <a href="/items/1/delete">Delete item</a> <a href="/reports/export.csv">Export CSV</a>
<a href="https://example.org/">External</a> <a href="mailto:help@fixture.test">Mail</a>
<div hidden><a href="/hidden-menu">Hidden menu</a></div>
</nav></header><main><h1>Home</h1></main>`);
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

export async function startFixture({
  requireAuth = true,
  loginPath = '/login',
  expireSessionsAfter = Infinity,
  tooManyRequests = null,
  slowFontHome = false,
  denyByRedirect = false,
} = {}) {
  const requests = [];
  const logins = { admin: 0, user: 0 };
  const streams = new Map();
  let epoch = 0;
  let authenticatedHits = 0;
  let expireAt = expireSessionsAfter;

  const roleOf = (req) => {
    const match = /(?:^|;\s*)sid=(\w+)\.(\d+)/.exec(req.headers.cookie ?? '');
    return match && Number(match[2]) === epoch && match[1] in USERS ? match[1] : null;
  };
  const roleFor = (form) =>
    Object.keys(USERS).find(
      (role) => USERS[role].email === form.get('email') && USERS[role].password === form.get('password'),
    );

  function sendFile(req, res, pathname, { type, honorRange = true, headAllowed = true, attachment = false }) {
    if (req.method === 'HEAD' && !headAllowed) {
      res.writeHead(405);
      return res.end();
    }
    const headers = { 'content-type': type };
    if (attachment) headers['content-disposition'] = 'attachment; filename="export.bin"';
    if (honorRange && req.headers.range === 'bytes=0-0') {
      res.writeHead(206, { ...headers, 'content-range': `bytes 0-0/${FILE_BYTES}`, 'content-length': 1 });
      return res.end('%');
    }
    res.writeHead(200, { ...headers, 'content-length': FILE_BYTES });
    if (req.method === 'HEAD') return res.end();
    streams.set(pathname, new Promise((resolve) => {
      res.on('close', () => resolve({ completed: res.writableFinished }));
    }));
    let sent = 0;
    const timer = setInterval(() => {
      res.write(CHUNK);
      sent += CHUNK.length;
      if (sent >= FILE_BYTES) {
        clearInterval(timer);
        res.end();
      }
    }, 50);
    res.on('close', () => clearInterval(timer));
    return undefined;
  }

  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://fixture');
    requests.push({ method: req.method, path: pathname, url: req.url });
    const send = (status, body, type = 'text/html') => {
      res.writeHead(status, { 'content-type': `${type}; charset=utf-8` });
      res.end(body);
    };

    if (TRAPS.includes(pathname)) return send(200, html('Trap', '<p>trap</p>'));
    if (pathname === tooManyRequests) return send(429, html('Slow down', '<p>429</p>'));

    if (req.method === 'POST' && (pathname === '/login' || pathname === '/login2')) {
      const form = new URLSearchParams(await readBody(req));
      if (pathname === '/login2' && !form.has('password')) return send(200, loginStepTwo(form.get('email') ?? ''));
      const role = roleFor(form);
      if (!role) return send(200, pathname === '/login' ? loginForm('<p>Invalid credentials</p>') : loginStepOne);
      logins[role] += 1;
      res.writeHead(302, { location: '/', 'set-cookie': `sid=${role}.${epoch}; Path=/; HttpOnly` });
      return res.end();
    }

    const role = roleOf(req);
    if (requireAuth && !PUBLIC_PATHS.has(pathname)) {
      if (!role) {
        res.writeHead(302, { location: loginPath });
        return res.end();
      }
      authenticatedHits += 1;
      if (authenticatedHits >= expireAt) {
        epoch += 1;
        expireAt = Infinity;
      }
    }

    const order = /^\/orders\/(\d+)$/.exec(pathname);
    const receipt = /^\/orders\/(\d+)\/receipt$/.exec(pathname);
    const product = /^\/products\/([\w-]+)$/.exec(pathname);
    const invoice = /^\/invoices\/(\d+)\.pdf$/.exec(pathname);
    const statement = /^\/statements\/(\d+)$/.exec(pathname);
    const statementApi = /^\/api\/statements\/(\d+)$/.exec(pathname);
    const origin = `http://${req.headers.host}`;

    if (pathname === '/login') return send(200, loginForm());
    if (pathname === '/login2') return send(200, loginStepOne);
    if (pathname === '/login-sso') return send(200, loginWithSso);
    if (pathname === '/oauth/google') return send(200, html('Google', '<main><p>Choose an account</p></main>'));
    if (pathname === '/') return send(200, home(role, { slowFontHome, denyByRedirect }));
    if (pathname === '/public') return send(200, PUBLIC_PAGE);
    if (pathname === '/no-form') return send(200, html('No form', '<main><p>Nothing to fill</p></main>'));
    if (pathname === '/long-poll') {
      return send(200, html('Long poll', "<main><p>Live</p></main><script>fetch('/never-ends')</script>"));
    }
    if (pathname === '/never-ends') return undefined; // never answered: keeps the network busy
    if (pathname === '/go-export') {
      res.writeHead(302, { location: '/reports/export.csv' });
      return res.end();
    }
    if (pathname === '/orders') {
      const links = Array.from({ length: 50 }, (_, i) => `<a href="/orders/${i + 1}">Order ${i + 1}</a>`);
      return send(200, html('Orders', `<main>${links.join(' ')}</main>`));
    }
    if (order) {
      const trap = order[1] === '1' ? '<img src="/logout" alt="">' : '';
      return send(200, html(`Order ${order[1]}`, `<main><h1>Order ${order[1]}</h1><button>Refund</button>${trap}</main>`));
    }
    if (pathname === '/spa-admin') {
      // An SPA guard: every role gets 200, non-admins are then sent home by the page itself.
      const body = role === 'admin' || !requireAuth ? '<main><h1>Console</h1></main>' : "<script>location.replace('/')</script>";
      return send(200, html('Console', body));
    }
    if (statement) {
      // An SPA page: 200 for every role; the data comes from an API that refuses non-admins.
      // The missing image 404s for everyone and must not read as a refusal.
      return send(200, html(`Statement ${statement[1]}`, `<main><h1 id="t">Loading</h1><img src="/missing.png" alt=""></main>
<script>fetch('/api/statements/${statement[1]}').then((r) => { document.getElementById('t').textContent = r.ok ? 'Statement' : 'Not found'; })</script>`));
    }
    if (statementApi) {
      return role === 'admin' ? send(200, '{"id":7}', 'application/json') : send(404, '{"error":"not found"}', 'application/json');
    }
    if (pathname === '/missing.png') return send(404, 'missing', 'text/plain');
    if (receipt) return send(200, html(`Receipt ${receipt[1]}`, `<main><h1>Receipt ${receipt[1]}</h1></main>`));
    if (pathname === '/assets/app.js') return send(200, APP_BUNDLE, 'text/javascript');
    if (pathname === '/team' || pathname === '/team/members') return send(200, html('Team', '<main><p>Team</p></main>'));
    if (pathname === '/products') {
      const links = PRODUCT_SLUGS.map((slug) => `<a href="/products/${slug}">${slug}</a>`);
      return send(200, html('Products', `<main>${links.join(' ')}</main>`));
    }
    if (product && PRODUCT_SLUGS.includes(product[1])) {
      return send(200, html(product[1], `<main><form>
<label>Quantity <input name="qty"></label><label>Note <input name="note"></label>
<button>Add to cart</button></form></main>`));
    }
    if (pathname === '/broken') {
      return send(200, html('Broken', "<main><p>Broken</p></main><script>console.error('fixture-error')</script>"));
    }
    if (pathname === '/hidden-menu' || pathname === '/sitemap-only' || pathname === '/hidden-route') {
      return send(200, html(pathname.slice(1), `<main><p>${pathname}</p></main>`));
    }
    if (pathname === '/admin' || pathname.startsWith('/admin/') || pathname === '/invoices') {
      if (requireAuth && role !== 'admin') {
        if (!denyByRedirect) return send(403, html('Forbidden', '<main><p>Forbidden</p></main>'));
        res.writeHead(302, { location: loginPath });
        return res.end();
      }
      const body = pathname.startsWith('/admin')
        ? '<p>Admin</p>'
        : Array.from({ length: 5 }, (_, i) => `<a href="/invoices/${i + 1}.pdf">Invoice ${i + 1}</a>`).join(' ');
      return send(200, html(pathname.slice(1), `<main>${body}</main>`));
    }
    if (invoice) {
      if (requireAuth && role !== 'admin') return send(403, 'Forbidden', 'text/plain');
      return sendFile(req, res, pathname, { type: 'application/pdf' });
    }
    if (pathname === '/docs/manual.pdf') return sendFile(req, res, pathname, { type: 'application/pdf' });
    if (pathname === '/files/get') {
      return sendFile(req, res, pathname, { type: 'application/octet-stream', attachment: true });
    }
    if (pathname === '/legacy/report.pdf') {
      return sendFile(req, res, pathname, { type: 'application/pdf', honorRange: false, headAllowed: false });
    }
    if (pathname === '/sitemap.xml') {
      return send(200, `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>${origin}/sitemap-pages.xml</loc></sitemap></sitemapindex>`, 'application/xml');
    }
    if (pathname === '/sitemap-pages.xml') {
      return send(200, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${origin}/orders</loc></url><url><loc>${origin}/sitemap-only</loc></url></urlset>`, 'application/xml');
    }
    return send(404, html('Not found', '<main><p>Not found</p></main>'));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    logins,
    called: (path) => requests.some((request) => request.path === path),
    streamEnded: (path) => streams.get(path) ?? Promise.resolve(null),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
