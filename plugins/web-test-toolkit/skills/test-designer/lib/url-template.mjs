// url-template.mjs — pure URL helpers for the crawler: normalize discovered links, refuse
// URLs that look like they change state, recognise file links, and group URLs into route
// templates (/orders/42 and /orders/43 -> /orders/:id).

const TRACKING_PARAM = /^(utm_.+|gclid|fbclid)$/i;
const UNSAFE_WORDS = [
  'logout', 'log-out', 'signout', 'sign-out', 'logoff', 'delete', 'remove', 'destroy',
  'unsubscribe', 'cancel', 'revoke', 'deactivate', 'disable', 'archive', 'reset', 'export',
  'generate', 'live', 'callback',
];
const FILE_EXTENSIONS = new Set([
  'pdf', 'csv', 'xls', 'xlsx', 'doc', 'docx', 'ppt', 'pptx', 'zip', 'gz', 'tar', 'rar', '7z',
  'txt', 'json', 'xml', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp3', 'mp4', 'mov', 'webm',
]);

/** Split 'report.pdf' into ['report', '.pdf']; segments without an extension keep ''. */
function splitExtension(segment) {
  const dot = segment.lastIndexOf('.');
  if (dot <= 0 || !/^[a-z0-9]{1,5}$/i.test(segment.slice(dot + 1))) return [segment, ''];
  return [segment.slice(0, dot), segment.slice(dot)];
}

/**
 * Resolve `href` against `base` and return a canonical URL, or null when it leaves the
 * origin of `base`, is not http(s), or does not parse. Fragments and tracking parameters
 * are dropped and the query is sorted by key, so equivalent links compare equal.
 */
export function normalizeUrl(href, base) {
  if (!URL.canParse(href, base)) return null;
  const url = new URL(href, base);
  if (url.origin !== new URL(base).origin) return null;
  url.hash = '';
  const params = [...url.searchParams].filter(([key]) => !TRACKING_PARAM.test(key));
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

// A token is unsafe when it is a listed word, or starts with one followed by '-', '_' or an
// uppercase letter (delete-account, remove_member, logoutAll). '_' counts as '-'
// (sign_out), and a ';jsessionid=...' path parameter is ignored.
function looksUnsafe(token) {
  const [raw] = splitExtension(token.split(';')[0]);
  const stem = raw.toLowerCase().replaceAll('_', '-');
  return UNSAFE_WORDS.some(
    (word) => stem === word
      || stem.startsWith(`${word}-`)
      || (stem.startsWith(word) && /[A-Z]/.test(raw.charAt(word.length))),
  );
}

/**
 * True when opening `url` could change state: a path segment, query key or query value looks
 * like a word such as logout or delete (see looksUnsafe). `exclude` patterns
 * always block; `allow` patterns reopen URLs the default word list would block.
 */
export function isUnsafe(url, { exclude = [], allow = [] } = {}) {
  if (exclude.some((pattern) => pattern.test(url))) return true;
  if (allow.some((pattern) => pattern.test(url))) return false;
  const { pathname, searchParams } = new URL(url);
  return [...pathname.split('/'), ...[...searchParams].flat()].some(looksUnsafe);
}

/** True when the URL's last path segment has a known file extension (sitemap.xml aside). */
export function isFileUrl(url) {
  const { pathname } = new URL(url);
  if (pathname === '/sitemap.xml') return false;
  const [, extension] = splitExtension(pathname.slice(pathname.lastIndexOf('/') + 1));
  return FILE_EXTENSIONS.has(extension.slice(1).toLowerCase());
}

const DYNAMIC_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{16,}$/i,
  /^\d{4}-\d{2}-\d{2}$/,
];

/**
 * Groups URLs into route templates. A segment that looks like an id (number, UUID, long
 * hex, date) becomes ':id'. Below the first level, once a parent has more than
 * `slugThreshold` distinct non-id children they all become ':slug' — URLs added earlier
 * regroup too, because templates are recomputed from the current state on every call.
 * Top-level segments never collapse: /about and /pricing are different pages. The query
 * never takes part; the file extension is kept (/invoices/:id.pdf).
 */
export class TemplateIndex {
  #children = new Map();
  #urls = [];
  #seen = new Set();

  constructor({ slugThreshold = 20 } = {}) {
    this.slugThreshold = slugThreshold;
  }

  #walk(url, record) {
    let prefix = '';
    for (const segment of new URL(url).pathname.split('/').filter(Boolean)) {
      const [stem, extension] = splitExtension(segment);
      let part = stem;
      if (DYNAMIC_SEGMENT.some((pattern) => pattern.test(stem))) {
        part = ':id';
      } else {
        let siblings = this.#children.get(prefix);
        if (record) {
          if (!siblings) this.#children.set(prefix, (siblings = new Set()));
          siblings.add(stem);
        }
        if (prefix !== '' && siblings && siblings.size > this.slugThreshold) part = ':slug';
      }
      prefix += `/${part}${extension}`;
    }
    return prefix || '/';
  }

  add(url) {
    if (this.#seen.has(url)) return this.templateOf(url);
    this.#seen.add(url);
    this.#urls.push(url);
    return this.#walk(url, true);
  }

  templateOf(url) {
    return this.#walk(url, false);
  }

  groups() {
    const groups = new Map();
    for (const url of this.#urls) {
      const template = this.templateOf(url);
      if (!groups.has(template)) groups.set(template, []);
      groups.get(template).push(url);
    }
    return groups;
  }
}
