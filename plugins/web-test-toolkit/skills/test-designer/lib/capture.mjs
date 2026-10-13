// capture.mjs — collect the evidence an agent needs from one page. Shared by explore.mjs
// (single page) and crawl.mjs (many pages). Per page: console errors, the network log, an
// outline of interactive elements, every link href (visible or not), and a structural
// skeleton (field/button counts, landmarks) used to spot mis-grouped route templates.

/** Attach console/network listeners to `page`; the returned arrays fill as it loads. */
export function observe(page) {
  const consoleMsgs = [];
  const network = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') consoleMsgs.push({ type: t, text: m.text() });
  });
  page.on('pageerror', (e) => consoleMsgs.push({ type: 'pageerror', text: String(e) }));
  page.on('response', (r) => {
    const s = r.status();
    network.push({ status: s, method: r.request().method(), type: r.request().resourceType(), url: r.url(), failed: s >= 400 });
  });
  return { consoleMsgs, network };
}

/**
 * Navigate `page` to `url`. 'networkidle' waits up to 30s for the network to go quiet
 * (explore.mjs). 'settled' waits for DOMContentLoaded, then at most 5s of network idle, so
 * websocket and long-poll pages do not time out (crawl.mjs). A navigation that turns into a
 * download is cancelled at once and reported as isFile, as is any non-HTML response.
 */
export async function navigate(page, url, { waitStrategy = 'networkidle', consoleMsgs }) {
  let downloaded = false;
  const onDownload = (download) => {
    downloaded = true;
    // cancel() rejects only if the download already finished or failed; either way it is gone.
    download.cancel().catch(() => {});
  };
  page.on('download', onDownload);
  let response = null;
  try {
    if (waitStrategy === 'settled') {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // A network that never goes idle is expected here, not an error.
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    } else {
      response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    }
  } catch (e) {
    if (/Download is starting/i.test(String(e))) {
      // The download event can land just after goto rejects: wait for it while onDownload is
      // still attached, so the transfer really is cancelled. No event within 5s means none.
      if (!downloaded) await page.waitForEvent('download', { timeout: 5000 }).catch(() => {});
      downloaded = true;
    } else {
      consoleMsgs.push({ type: 'nav-error', text: String(e) });
    }
  } finally {
    page.off('download', onDownload);
  }
  const contentType = response?.headers()['content-type'] ?? '';
  return {
    status: response ? response.status() : null,
    contentType,
    isFile: downloaded || (contentType !== '' && !contentType.includes('html')),
  };
}

/** Read the loaded page: title, outline, every link, skeleton; optionally a screenshot. */
export async function snapshot(page, { screenshotPath } = {}) {
  const finalUrl = page.url();
  const title = await page.title();
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
  const { elements, hrefs, landmarks } = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const grab = (sel, kind) =>
      [...document.querySelectorAll(sel)].filter(visible).map((el) => ({
        kind,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || el.getAttribute('id') || '',
        label:
          (el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.textContent ||
            '').trim().slice(0, 60),
        href: el.getAttribute('href') || '',
      }));
    const implicitRole = {
      header: 'banner', nav: 'navigation', main: 'main', aside: 'complementary', footer: 'contentinfo', form: 'form',
    };
    const landmarkEls = document.querySelectorAll(
      'header, nav, main, aside, footer, form, [role=banner], [role=navigation], [role=main], [role=complementary], [role=contentinfo], [role=search]',
    );
    return {
      elements: [
        ...grab('input, textarea, select', 'field'),
        ...grab('button, [role=button], input[type=submit]', 'button'),
        ...grab('a[href]', 'link'),
        ...grab('form', 'form'),
      ],
      hrefs: [...document.querySelectorAll('a[href]')].map((a) => a.href),
      landmarks: [
        ...new Set([...landmarkEls].map((el) => el.getAttribute('role') || implicitRole[el.tagName.toLowerCase()])),
      ].sort(),
    };
  });
  const count = (kind) => elements.filter((e) => e.kind === kind).length;
  return { finalUrl, title, elements, hrefs, skeleton: { fields: count('field'), buttons: count('button'), landmarks } };
}

/** Navigate and snapshot in one go (no screenshot). File responses skip the snapshot. */
export async function capturePage(page, url, { waitStrategy } = {}) {
  const { consoleMsgs, network } = observe(page);
  const navigation = await navigate(page, url, { waitStrategy, consoleMsgs });
  if (navigation.isFile) return { url, ...navigation, consoleMsgs, network };
  return { url, ...navigation, ...(await snapshot(page)), consoleMsgs, network };
}

/** Split a capture into the lists the report and the CLI summary both print. */
export function summarize({ consoleMsgs, network, elements }) {
  return {
    errors: consoleMsgs.filter((m) => m.type !== 'warning'),
    warnings: consoleMsgs.filter((m) => m.type === 'warning'),
    failedReqs: network.filter((r) => r.failed),
    fields: elements.filter((e) => e.kind === 'field'),
    buttons: elements.filter((e) => e.kind === 'button'),
    links: elements.filter((e) => e.kind === 'link'),
  };
}

/** The exploration.md report for one captured page. */
export function renderExploration(result, host) {
  const { url, finalUrl, status, title, network } = result;
  const { errors, warnings, failedReqs, fields, buttons, links } = summarize(result);
  return `# Exploration report — ${host}

- **Entered URL:** ${url}
- **Final URL:** ${finalUrl}${finalUrl !== url ? ' _(redirected)_' : ''}
- **HTTP status:** ${status ?? 'n/a'}
- **Page title:** ${title}
- **Screenshot:** ./screenshot.png

## Health
- Console errors/page errors: **${errors.length}**
- Console warnings: **${warnings.length}**
- Network requests: **${network.length}** (failed ≥400: **${failedReqs.length}**)

${errors.length ? '### Errors\n' + errors.map((e) => `- \`${e.type}\` ${e.text}`).join('\n') : '_No console/page errors._'}

${failedReqs.length ? '### Failed requests\n' + failedReqs.map((r) => `- ${r.status} ${r.method} ${r.url}`).join('\n') : '_No failed requests._'}

## Interactive surface (raw material for test cases)
### Fields (${fields.length})
${fields.map((f) => `- \`${f.tag}${f.type ? '[type=' + f.type + ']' : ''}\` name=\`${f.name}\` — ${f.label}`).join('\n') || '_none_'}

### Buttons (${buttons.length})
${buttons.map((b) => `- ${b.label || '(no text)'}`).join('\n') || '_none_'}

### Links (${links.length})
${links.slice(0, 30).map((l) => `- ${l.label || '(no text)'} → ${l.href}`).join('\n') || '_none_'}${links.length > 30 ? `\n- … and ${links.length - 30} more` : ''}
`;
}

const MAX_REDIRECTS = 5;

/**
 * Status, type and size of a file link without downloading it. Uses Node's fetch rather
 * than Playwright's context.request, which always buffers the whole body: HEAD first, and
 * if the server refuses HEAD (405/501) a GET for one byte (Range: bytes=0-0). Either way the
 * body is cancelled as soon as headers arrive, so a server that ignores Range and starts
 * sending the whole file is cut off. Cookies come from `context`, so the probe runs as the
 * logged-in role. Redirects are followed by hand: one to `loginPath` is reported, one that
 * `canFollow` rejects is not taken. A request with no response headers after `timeoutMs`
 * rejects with a TimeoutError.
 */
export async function probeFile(context, url, { loginPath = '/login', canFollow = () => true, timeoutMs = 30_000 } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const cookie = (await context.cookies(current)).map((c) => `${c.name}=${c.value}`).join('; ');
    const headers = cookie ? { cookie } : {};
    let method = 'head';
    const request = { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) };
    let response = await fetch(current, { ...request, method: 'HEAD', headers });
    if (response.status === 405 || response.status === 501) {
      method = 'range';
      response = await fetch(current, { ...request, headers: { ...headers, range: 'bytes=0-0' } });
    }
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, current).href;
      if (new URL(next).pathname === loginPath) {
        return { outcome: 'login-redirect', status: response.status, method, finalUrl: next };
      }
      if (!canFollow(next)) return { outcome: 'blocked-redirect', status: response.status, method, finalUrl: next };
      current = next;
      continue;
    }
    const size = response.headers.get('content-range')?.split('/')[1] ?? response.headers.get('content-length');
    const total = size == null ? NaN : Number(size);
    return {
      outcome: 'ok',
      status: response.status,
      method,
      finalUrl: current,
      contentType: response.headers.get('content-type') ?? '',
      bytes: Number.isFinite(total) ? total : null,
    };
  }
  return { outcome: 'too-many-redirects', status: null, method: 'head', finalUrl: current };
}
