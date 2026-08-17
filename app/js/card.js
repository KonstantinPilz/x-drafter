// card.js — Open Graph link previews for the drafter.
//
// ─── PRIVACY / DEPENDENCY NOTE (please read before shipping) ───────────────────
// This site is static, so there is no server of ours to proxy metadata requests
// through. To read a page's Open Graph tags from the browser we have to borrow
// somebody else's CORS-enabled proxy. Consequences:
//
//   1. The URL you type into "Link preview" is sent to a THIRD PARTY
//      (api.allorigins.win, corsproxy.io, or r.jina.ai — tried in that order).
//      Those operators can see, log, and retain the URL and your IP. Don't fetch
//      previews for private, unlisted, or tokenised URLs.
//   2. They are free public services with no uptime guarantee. When they are
//      down, rate-limited, or blocked, the fetch simply fails.
//   3. Failure is never fatal. fetchCard() always resolves — worst case with an
//      empty skeleton {url, domain, title:'', description:'', image:''} — and
//      the UI degrades to MANUAL ENTRY: type the title/description/image
//      yourself and the preview card renders identically.
//
// Nothing here runs at import time, so the module also parses under Node.
// ──────────────────────────────────────────────────────────────────────────────

const PROXY_TIMEOUT_MS = 6000;

/* ── URL helpers ───────────────────────────────────────────────────────────── */

/**
 * Tidy user input into an absolute http(s) URL.
 * "example.com/x" → "https://example.com/x". Returns '' if unusable.
 */
export function normalizeUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : 'https://' + raw.replace(/^\/+/, '');
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
  } catch (e) {
    return '';
  }
}

/** Hostname without a leading "www.". */
function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch (e) {
    return '';
  }
}

/** Collapse whitespace; OG tags are frequently pretty-printed across lines. */
function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** Resolve a possibly relative asset path against the page it came from. */
function absolutize(src, base) {
  if (!src) return '';
  try {
    return new URL(src, base).href;
  } catch (e) {
    return '';
  }
}

function skeleton(url) {
  return {
    url,
    title: '',
    description: '',
    image: '',
    domain: domainOf(url),
    loading: false,
  };
}

/* ── Network: proxy attempts with a per-attempt abort timeout ──────────────── */

async function fetchText(target, headers) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), PROXY_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      signal: ctrl ? ctrl.signal : undefined,
      redirect: 'follow',
      credentials: 'omit',
      headers: headers || undefined,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (!text || text.length < 16) throw new Error('empty body');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/* ── Parsing ───────────────────────────────────────────────────────────────── */

/** First non-empty content= among the given meta property/name keys. */
function metaContent(doc, keys) {
  for (const key of keys) {
    const el = doc.querySelector(
      `meta[property="${key}"], meta[name="${key}"], meta[itemprop="${key}"]`
    );
    const v = el && clean(el.getAttribute('content'));
    if (v) return v;
  }
  return '';
}

/** Read OG/Twitter/standard metadata out of a fetched HTML document. */
function parseHTML(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const card = skeleton(url);

  // A <base href> beats the request URL for resolving relative assets.
  const baseEl = doc.querySelector('base[href]');
  const base = absolutize(baseEl ? baseEl.getAttribute('href') : '', url) || url;

  card.title =
    metaContent(doc, ['og:title', 'twitter:title']) ||
    clean(doc.querySelector('title') && doc.querySelector('title').textContent);

  card.description = metaContent(doc, [
    'og:description',
    'twitter:description',
    'description',
  ]);

  let image = metaContent(doc, [
    'og:image:secure_url',
    'og:image:url',
    'og:image',
    'twitter:image',
    'twitter:image:src',
  ]);
  if (!image) {
    const link = doc.querySelector('link[rel="image_src"]');
    image = link ? clean(link.getAttribute('href')) : '';
  }
  card.image = absolutize(image, base);

  const ogSite = metaContent(doc, ['og:site_name']);
  card.domain = domainOf(url) || clean(ogSite);
  return card;
}

/**
 * Last-resort parse of r.jina.ai output, which is readable text shaped like:
 *   Title: Some headline
 *   URL Source: https://…
 *   Markdown Content:
 *   …body…
 */
function parseJina(text, url) {
  const card = skeleton(url);
  const title = /^Title:\s*(.+)$/m.exec(text);
  if (title) card.title = clean(title[1]);

  const bodyStart = text.indexOf('Markdown Content:');
  const body = bodyStart === -1 ? text : text.slice(bodyStart + 'Markdown Content:'.length);

  // Find the first line that reads like prose: skip headings, list items, table
  // rows and image lines, unwrap markdown links, then require a real sentence.
  const para = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !/^([*+>#=|-]|\d+[.)]|!?\[)/.test(l))
    .map((l) => l.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim())
    .find((l) => l.length > 60 && /[.!?]/.test(l));
  if (para) card.description = clean(para).slice(0, 300);

  const img = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/.exec(body);
  if (img) card.image = img[1];
  return card;
}

/* ── Public fetch ──────────────────────────────────────────────────────────── */

/**
 * Fetch Open Graph metadata for `url` through public CORS proxies.
 * Never rejects: on total failure it resolves to a fill-in-by-hand skeleton.
 */
export async function fetchCard(url) {
  const target = normalizeUrl(url);
  if (!target) return skeleton(String(url || ''));

  const encoded = encodeURIComponent(target);
  const attempts = [
    { url: `https://api.allorigins.win/raw?url=${encoded}`, parse: parseHTML },
    { url: `https://corsproxy.io/?${encoded}`, parse: parseHTML },
    // r.jina.ai, last resort. Asking for x-return-format: html gets us the
    // original markup (so the full OG set), and the service allows that header
    // on its CORS preflight. If the preflight or header is ever refused we
    // retry plain, which returns readable text we scrape a title out of.
    {
      url: `https://r.jina.ai/${target}`,
      headers: { 'x-return-format': 'html' },
      parse: parseHTML,
    },
    { url: `https://r.jina.ai/${target}`, parse: parseJina },
  ];

  for (const attempt of attempts) {
    try {
      const body = await fetchText(attempt.url, attempt.headers);
      const card = attempt.parse(body, target);
      // Consider it a hit only if we actually learned something.
      if (card.title || card.description || card.image) return card;
    } catch (e) {
      /* try the next proxy */
    }
  }
  return skeleton(target);
}

/* ── UI wiring ─────────────────────────────────────────────────────────────── */

const ID = {
  url: 'in-card-url',
  fetch: 'btn-fetch-card',
  title: 'in-card-title',
  desc: 'in-card-desc',
  image: 'in-card-image',
  imageFile: 'in-card-image-file',
  domain: 'in-card-domain',
  clear: 'btn-clear-card',
  status: 'card-status',
  panel: 'panel-card',
};

let ui = null; // { els, getPost, onChange }

function $(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

function emptyCard() {
  return { url: '', title: '', description: '', image: '', domain: '', loading: false };
}

function ensureCard(post) {
  if (!post.card) post.card = emptyCard();
  return post.card;
}

function setStatus(msg) {
  if (ui && ui.els.status) ui.els.status.textContent = msg || '';
}

/** Push the active post's card back into the form fields. */
export function syncCardUI() {
  if (!ui) return;
  const post = ui.getPost();
  const card = (post && post.card) || emptyCard();
  const { els } = ui;
  if (els.url) els.url.value = card.url || '';
  if (els.title) els.title.value = card.title || '';
  if (els.desc) els.desc.value = card.description || '';
  // The image field holds the literal value, data: URLs included, so that
  // editing it round-trips correctly.
  if (els.image) els.image.value = card.image || '';
  if (els.domain) els.domain.value = card.domain || '';
}

function commit(mutate) {
  const post = ui.getPost();
  if (!post) return;
  mutate(ensureCard(post));
  ui.onChange();
}

let fetchToken = 0;

async function runFetch() {
  const post = ui.getPost();
  if (!post) return;

  const target = normalizeUrl(ui.els.url ? ui.els.url.value : '');
  if (!target) {
    setStatus('Enter a URL first.');
    return;
  }
  if (ui.els.url) ui.els.url.value = target;

  // Mark loading so render.js can show a skeleton card.
  const card = ensureCard(post);
  card.url = target;
  card.domain = card.domain || domainOf(target);
  card.loading = true;
  setStatus('Fetching…');
  ui.onChange();

  const token = ++fetchToken;
  const fetched = await fetchCard(target);
  if (token !== fetchToken) return; // superseded by a newer fetch

  // Write onto the post captured at click time, so switching thread tabs
  // mid-flight can't scribble on the wrong post.
  card.loading = false;
  card.url = target;
  if (fetched.title) card.title = fetched.title;
  if (fetched.description) card.description = fetched.description;
  if (fetched.image) card.image = fetched.image;
  card.domain = fetched.domain || card.domain || domainOf(target);

  const gotSomething = !!(fetched.title || fetched.description || fetched.image);
  setStatus(
    gotSomething
      ? `Loaded from ${card.domain}`
      : "Couldn't fetch — fill in manually"
  );
  ui.onChange();
  if (ui.getPost() === post) syncCardUI();
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsDataURL(file);
  });
}

/**
 * Bind the "Link preview" panel.
 * @param {{ getPost: () => object, onChange: () => void }} opts
 */
export function initCardUI(opts) {
  if (typeof document === 'undefined') return;
  const getPost = (opts && opts.getPost) || (() => null);
  const onChange = (opts && opts.onChange) || (() => {});

  const els = {};
  for (const key of Object.keys(ID)) els[key] = $(ID[key]);
  ui = { els, getPost, onChange };

  // URL field: keep card.url current and auto-fill the domain while it's blank.
  if (els.url) {
    els.url.addEventListener('input', () => {
      const raw = els.url.value.trim();
      commit((card) => {
        card.url = raw;
        const d = domainOf(normalizeUrl(raw));
        if (d && (!card.domain || els.domain && !els.domain.value)) {
          card.domain = d;
          if (els.domain) els.domain.value = d;
        }
      });
    });
    // Enter in the URL box fetches.
    els.url.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runFetch();
      }
    });
  }

  // Plain text overrides.
  const textFields = [
    [els.title, 'title'],
    [els.desc, 'description'],
    [els.image, 'image'],
    [els.domain, 'domain'],
  ];
  for (const [el, field] of textFields) {
    if (!el) continue;
    el.addEventListener('input', () => {
      const v = el.value;
      commit((card) => {
        card[field] = v;
      });
    });
  }

  if (els.fetch) els.fetch.addEventListener('click', () => runFetch());

  // Local image upload → data URL (also keeps the export self-contained).
  if (els.imageFile) {
    els.imageFile.addEventListener('change', async () => {
      const file = els.imageFile.files && els.imageFile.files[0];
      if (!file) return;
      try {
        const dataUrl = await readFileAsDataURL(file);
        commit((card) => {
          card.image = dataUrl;
        });
        if (els.image) els.image.value = dataUrl;
        setStatus(`Using uploaded image (${Math.round(file.size / 1024)} KB)`);
      } catch (e) {
        setStatus("Couldn't read that image file.");
      }
      els.imageFile.value = '';
    });
  }

  if (els.clear) {
    els.clear.addEventListener('click', () => {
      const post = getPost();
      if (post) post.card = null;
      for (const el of [els.url, els.title, els.desc, els.image, els.domain]) {
        if (el) el.value = '';
      }
      setStatus('');
      onChange();
    });
  }

  // Re-sync when the panel is opened, and on an app-wide sync event, so the
  // fields follow the active post without card.js subscribing to state itself.
  if (els.panel) els.panel.addEventListener('toggle', () => syncCardUI());
  document.addEventListener('x-drafter:sync', () => syncCardUI());

  syncCardUI();
}
