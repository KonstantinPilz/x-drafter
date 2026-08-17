// render.js — turns draft state into X-timeline markup.
//
// Everything here is pure: state in, HTML string out. `renderPreview` is the
// only function that touches the DOM, and it does nothing but assign
// `root.innerHTML`, so export.js can screenshot the node straight afterwards.
//
// The emitted class names are fixed by CONTRACT.md's "CANONICAL POST MARKUP"
// appendix — x.css is written blind against them, so do not rename anything.
//
// SECURITY: every value that originates from the user is passed through esc()
// before it reaches a string template. The only unescaped HTML injected is our
// own markup and the return value of text.js's renderTextHTML(), which the
// contract guarantees is already escaped.

import { icon } from './icons.js';

// ── text.js is loaded dynamically ───────────────────────────────────────────
// A parallel agent owns text.js. A static import would take render.js down with
// it if that module throws at parse time, blanking the whole preview. So we
// load it lazily, fall back to a local escape+linebreak renderer until (or
// unless) it arrives, and re-render once it does.
let renderTextHTML = null;
let weightedLength = null;
let maxWeighted = null;
let lastRoot = null;
let lastState = null;

import('./text.js')
  .then((mod) => {
    if (!mod) return;
    let upgraded = false;
    if (typeof mod.renderTextHTML === 'function') {
      renderTextHTML = mod.renderTextHTML;
      upgraded = true;
    }
    // Long-post clamping needs both the counter and the limit; without them we
    // render every post un-clamped rather than guess at a character budget.
    if (typeof mod.weightedLength === 'function' && typeof mod.MAX_WEIGHTED === 'number') {
      weightedLength = mod.weightedLength;
      maxWeighted = mod.MAX_WEIGHTED;
      upgraded = true;
    }
    // Upgrade the already-painted preview now that entity linking works.
    if (upgraded && lastRoot && lastState) renderPreview(lastState, lastRoot);
  })
  .catch(() => {
    /* text.js unavailable — the local fallback below keeps the preview alive */
  });

// ── Primitives ──────────────────────────────────────────────────────────────

/** Escape a value for interpolation into HTML text or a quoted attribute. */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Local stand-in for renderTextHTML: escape, then honour hard line breaks. */
function fallbackTextHTML(text) {
  return esc(text).replace(/\r\n|\r|\n/g, '<br>');
}

/** Body text as HTML — delegated to text.js when it is available. */
function textHTML(text) {
  if (!text) return '';
  if (renderTextHTML) {
    try {
      const html = renderTextHTML(text);
      if (typeof html === 'string') return html;
    } catch (e) {
      /* text.js blew up on this input — degrade rather than blank the preview */
    }
  }
  return fallbackTextHTML(text);
}

// Only these schemes may reach an href/src. Blocks javascript:, vbscript: etc.
const SAFE_SCHEME = /^(https?:|mailto:|blob:|data:image\/)/i;

/** Sanitise a URL for src/href. Relative paths are allowed; odd schemes are not. */
function safeUrl(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !SAFE_SCHEME.test(raw)) return '';
  return esc(raw);
}

// ── Trailing-URL stripping ──────────────────────────────────────────────────
// X removes a URL from the post body when that URL is what produced the
// attachment below it — you never see both the blue link and its own card. The
// rule is positional: only a URL that is the LAST token of the post is dropped.
// A URL mid-sentence stays visible.

/** Loosen scheme/www/trailing-slash differences so "x.com/a" matches "https://x.com/a/". */
function normalizeUrl(url) {
  return String(url == null ? '' : url)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Drop `url` from `text` when it is the final non-whitespace token. */
function stripTrailingUrl(text, url) {
  const body = String(text == null ? '' : text);
  const target = normalizeUrl(url);
  if (!body || !target) return body;

  const trimmed = body.replace(/\s+$/, '');
  const match = trimmed.match(/(\S+)$/);
  if (!match || normalizeUrl(match[1]) !== target) return body;

  // Remove the token, then tidy the whitespace/newlines it left behind.
  return trimmed.slice(0, trimmed.length - match[1].length).replace(/\s+$/, '');
}

// A trailing link to another post is consumed by the quote embed. The state's
// quote object carries no url field, so match the status-permalink shape.
const STATUS_URL = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter)\.com\/[^/\s]+\/status(?:es)?\/\d+/i;

/** Drop a trailing x.com/twitter.com status permalink — the quote card replaces it. */
function stripTrailingStatusUrl(text) {
  const body = String(text == null ? '' : text);
  const trimmed = body.replace(/\s+$/, '');
  const match = trimmed.match(/(\S+)$/);
  if (!match || !STATUS_URL.test(match[1])) return body;
  return trimmed.slice(0, trimmed.length - match[1].length).replace(/\s+$/, '');
}

/**
 * 1200 → "1.2K", 1500000 → "1.5M", 316 → "316".
 * Strings pass through untouched so hand-typed values like "24.1K" survive.
 */
function fmtCount(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  const n = Number(value);
  if (!isFinite(n)) return '';
  const abs = Math.abs(n);
  const shorten = (v, suffix) => v.toFixed(1).replace(/\.0$/, '') + suffix;
  if (abs >= 1e6) return shorten(n / 1e6, 'M');
  if (abs >= 1e3) return shorten(n / 1e3, 'K');
  return String(n);
}

// Grey circle with a generic person glyph — used when no avatar is uploaded.
const AVATAR_FALLBACK =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
      '<circle cx="24" cy="24" r="24" fill="#8899a6"/>' +
      '<circle cx="24" cy="18.5" r="7.8" fill="#e1e8ed"/>' +
      '<path d="M24 28.5c-8.1 0-14.7 5.2-14.7 11.7V48h29.4v-7.8c0-6.5-6.6-11.7-14.7-11.7z" fill="#e1e8ed"/>' +
      '</svg>'
  );

// ── Head row ────────────────────────────────────────────────────────────────

const BADGE_ICON = { blue: 'verifiedBlue', gold: 'verifiedGold', grey: 'verifiedGrey' };

/** `<span class="x-badge x-badge--blue">…</span>`, or '' when unverified. */
function badgeHTML(verified) {
  const kind = String(verified || 'none');
  const name = BADGE_ICON[kind];
  if (!name) return '';
  return `<span class="x-badge x-badge--${esc(kind)}">${icon(name)}</span>`;
}

function headHTML(state) {
  const author = (state && state.author) || {};
  return (
    '<div class="x-post__head">' +
    `<span class="x-name">${esc(author.name || '')}</span>` +
    badgeHTML(author.verified) +
    `<span class="x-handle">@${esc(author.handle || '')}</span>` +
    '<span class="x-dot">·</span>' +
    `<span class="x-time">${esc((state && state.timeLabel) || '')}</span>` +
    `<button class="x-more" type="button" aria-label="More">${icon('more')}</button>` +
    '</div>'
  );
}

// ── Media grid ──────────────────────────────────────────────────────────────

function mediaItemHTML(item) {
  const src = safeUrl(item && item.src);
  const alt = (item && item.alt) || '';
  const kind = (item && item.kind) || 'image';

  const inner =
    kind === 'video'
      ? `<video src="${src}" muted playsinline preload="metadata"></video>` +
        `<span class="x-media__play">${icon('play')}</span>`
      : `<img src="${src}" alt="${esc(alt)}">`;

  const altBadge = alt ? '<span class="x-alt">ALT</span>' : '';
  return `<figure class="x-media__item">${inner}${altBadge}</figure>`;
}

/** `<div class="x-media x-media--N">` — omitted entirely when there is no media. */
function mediaHTML(post) {
  const media = (post && post.media) || [];
  if (!media.length) return '';
  const items = media.slice(0, 4);
  return (
    `<div class="x-media x-media--${items.length}">` +
    items.map(mediaItemHTML).join('') +
    '</div>'
  );
}

// ── Link preview card ───────────────────────────────────────────────────────

// Takes the card object rather than the post: the caller decides whether the
// card survives (media outranks it — see postCardHTML).
function cardHTML(card) {
  if (!card) return '';

  // X falls back to the compact card whenever there is no preview image.
  const size = card.image ? 'large' : 'small';
  const loading = card.loading ? ' is-loading' : '';
  const href = safeUrl(card.url) || '#';

  const img = card.image
    ? `<div class="x-card__img"><img src="${safeUrl(card.image)}" alt=""></div>`
    : '';

  const meta =
    '<div class="x-card__meta">' +
    `<span class="x-card__domain">${esc(card.domain || '')}</span>` +
    `<span class="x-card__title">${esc(card.title || '')}</span>` +
    `<span class="x-card__desc">${esc(card.description || '')}</span>` +
    '</div>';

  return (
    `<a class="x-card x-card--${size}${loading}" href="${href}" ` +
    'target="_blank" rel="noopener noreferrer">' +
    img +
    meta +
    '</a>'
  );
}

// ── Poll ────────────────────────────────────────────────────────────────────

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "1 day left" / "6 hours left" / "30 minutes left" / "Final results". */
function pollTimeLeft(poll) {
  const days = Number(poll.days) || 0;
  const hours = Number(poll.hours) || 0;
  const minutes = Number(poll.minutes) || 0;
  if (days > 0) return `${plural(days, 'day')} left`;
  if (hours > 0) return `${plural(hours, 'hour')} left`;
  if (minutes > 0) return `${plural(minutes, 'minute')} left`;
  return 'Final results';
}

function pollHTML(post) {
  const poll = post && post.poll;
  if (!poll) return '';
  const options = Array.isArray(poll.options) ? poll.options : [];

  const opts = options
    .map((label) => `<div class="x-poll__opt"><span class="x-poll__label">${esc(label)}</span></div>`)
    .join('');

  const votes = fmtCount(poll.votes == null ? 0 : poll.votes);
  const foot = `${votes} vote${String(poll.votes) === '1' ? '' : 's'} · ${pollTimeLeft(poll)}`;

  return `<div class="x-poll">${opts}<div class="x-poll__foot">${esc(foot)}</div></div>`;
}

// ── Quoted post ─────────────────────────────────────────────────────────────

function quoteHTML(post) {
  const q = post && post.quote;
  if (!q) return '';

  const avatar = safeUrl(q.avatar) || AVATAR_FALLBACK;
  // The quote's verified flag may be a boolean (checkbox) or a badge name.
  const badge = q.verified ? badgeHTML(q.verified === true ? 'blue' : q.verified) : '';

  const head =
    '<div class="x-quote__head">' +
    `<img class="x-quote__avatar" src="${avatar}" alt="">` +
    `<span class="x-name">${esc(q.name || '')}</span>` +
    badge +
    `<span class="x-handle">@${esc(q.handle || '')}</span>` +
    '<span class="x-dot">·</span>' +
    `<span class="x-time">${esc(q.time || '')}</span>` +
    '</div>';

  const body = q.text ? `<div class="x-quote__text">${textHTML(q.text)}</div>` : '';
  const media = q.image
    ? `<div class="x-quote__media"><img src="${safeUrl(q.image)}" alt=""></div>`
    : '';

  return `<blockquote class="x-quote">${head}${body}${media}</blockquote>`;
}

// ── Action bar ──────────────────────────────────────────────────────────────

// Canonical order; the last two live inside `.x-actions__end`.
const ACTIONS = [
  { key: 'reply', icon: 'reply', metric: 'replies', label: 'Reply' },
  { key: 'repost', icon: 'repost', metric: 'reposts', label: 'Repost' },
  { key: 'like', icon: 'like', metric: 'likes', label: 'Like' },
  { key: 'views', icon: 'views', metric: 'views', label: 'View count' },
];

const END_ACTIONS = [
  { key: 'bookmark', icon: 'bookmark', metric: 'bookmarks', label: 'Bookmark' },
  { key: 'share', icon: 'share', metric: null, label: 'Share' },
];

function actionHTML(spec, metrics, showCounts) {
  const count = showCounts && spec.metric ? fmtCount(metrics[spec.metric]) : '';
  const countSpan = count === '' ? '' : `<span class="x-action__count">${esc(count)}</span>`;
  return (
    `<button class="x-action x-action--${spec.key}" type="button" aria-label="${esc(spec.label)}">` +
    `<span class="x-action__icon">${icon(spec.icon)}</span>` +
    countSpan +
    '</button>'
  );
}

/** Always rendered. `state.showMetrics === false` drops the counts, keeps icons. */
function actionsHTML(state) {
  const metrics = (state && state.metrics) || {};
  const showCounts = !(state && state.showMetrics === false);
  return (
    '<div class="x-actions">' +
    ACTIONS.map((a) => actionHTML(a, metrics, showCounts)).join('') +
    '<div class="x-actions__end">' +
    END_ACTIONS.map((a) => actionHTML(a, metrics, showCounts)).join('') +
    '</div>' +
    '</div>'
  );
}

// ── Long posts (X Premium) ──────────────────────────────────────────────────
// Past 280 weighted characters X clamps the body to ~10 lines in the timeline
// and puts a blue "Show more" under it. The clamp itself is CSS
// (`.x-text--clamped`); render.js only decides who gets the class and button.

// Ids whose long post the user has expanded. Module-level because renderPreview
// rebuilds innerHTML on every keystroke — without this the block would snap
// shut mid-sentence while typing.
const expandedIds = new Set();

/** True when `text` runs past the 280-weighted-char limit. */
function isLongPost(text) {
  if (!weightedLength || !maxWeighted) return false; // text.js not in yet
  try {
    return weightedLength(text) > maxWeighted;
  } catch (e) {
    return false; // counting blew up — render un-clamped rather than blank
  }
}

// ── Post card ───────────────────────────────────────────────────────────────

/**
 * Full `<article class="x-post">` markup for one post.
 * @param {object} post   a Post from state.posts
 * @param {object} state  the whole draft state (author, theme, metrics…)
 * @param {object} [opts] { connector: 'none'|'top'|'bottom'|'both' }
 * @returns {string} HTML
 */
export function postCardHTML(post, state, opts) {
  const p = post || {};
  const options = opts || {};
  const connector = options.connector || 'none';

  // Media outranks the link card: X suppresses the card entirely when a post
  // carries images or video, so only one of the two is ever rendered.
  const hasMedia = Boolean(p.media && p.media.length);
  const card = hasMedia ? null : p.card;

  // Strip the URL that produced an attachment, so the body doesn't show both
  // the blue link and the card/quote it generated. Only done when that
  // attachment actually renders — a suppressed card leaves its URL visible.
  let text = p.text || '';
  if (card && card.url) text = stripTrailingUrl(text, card.url);
  if (p.quote) text = stripTrailingStatusUrl(text);

  const hasAttachments = Boolean(hasMedia || p.card || p.poll || p.quote);
  const hasText = Boolean(text && String(text).trim());

  // Empty draft: show a muted placeholder rather than a collapsed, broken card.
  let textBlock = '';
  if (hasText) {
    // Long posts clamp to ~10 lines with a "Show more" toggle underneath,
    // unless this id is already expanded.
    const long = isLongPost(text);
    const expanded = long && expandedIds.has(String(p.id || ''));
    const cls = long && !expanded ? 'x-text x-text--clamped' : 'x-text';
    textBlock = `<div class="${cls}">${textHTML(text)}</div>`;
    if (long) {
      textBlock +=
        '<button type="button" class="x-showmore">' +
        (expanded ? 'Show less' : 'Show more') +
        '</button>';
    }
  } else if (!hasAttachments) {
    textBlock = '<div class="x-text"><span class="x-placeholder">What’s happening?</span></div>';
  }

  const avatar = safeUrl(state && state.author && state.author.avatar) || AVATAR_FALLBACK;

  const gutter =
    '<div class="x-post__gutter">' +
    '<div class="x-line x-line--top"></div>' +
    `<img class="x-avatar" src="${avatar}" alt="">` +
    '<div class="x-line x-line--bottom"></div>' +
    '</div>';

  const body =
    '<div class="x-post__body">' +
    headHTML(state) +
    textBlock +
    mediaHTML(p) +
    cardHTML(card) +
    pollHTML(p) +
    quoteHTML(p) +
    actionsHTML(state) +
    '</div>';

  return (
    `<article class="x-post" data-connector="${esc(connector)}" data-id="${esc(p.id || '')}">` +
    gutter +
    body +
    '</article>'
  );
}

// ── Thread ──────────────────────────────────────────────────────────────────

/** none for a lone post; bottom / both / top down a thread. */
function connectorFor(index, total) {
  if (total <= 1) return 'none';
  if (index === 0) return 'bottom';
  if (index === total - 1) return 'top';
  return 'both';
}

// ── "Show more" toggle ──────────────────────────────────────────────────────
// One delegated listener per root, attached once. renderPreview replaces
// innerHTML on every keystroke, so per-button listeners would leak and a second
// root-level listener would double-toggle (expand then instantly collapse).

const wiredRoots = new WeakSet();

/** Expand/collapse the long post whose "Show more" button was clicked. */
function onPreviewClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  const button = target.closest('.x-showmore');
  if (!button) return;

  const article = button.closest('.x-post');
  const block = article && article.querySelector('.x-text');
  if (!block) return;

  const nowExpanded = block.classList.toggle('x-text--clamped') === false;
  button.textContent = nowExpanded ? 'Show less' : 'Show more';

  // Remember it, so the next re-render doesn't undo the click.
  const id = String((article.dataset && article.dataset.id) || '');
  if (nowExpanded) expandedIds.add(id);
  else expandedIds.delete(id);
}

/** Idempotent — safe to call on every render. */
function wirePreview(root) {
  if (!root || typeof root.addEventListener !== 'function') return;
  if (wiredRoots.has(root)) return;
  wiredRoots.add(root);
  root.addEventListener('click', onPreviewClick);
}

/**
 * Rebuild the preview from state. Full re-render — cheap at thread sizes and it
 * keeps the output a pure function of state.
 * @param {object} state
 * @param {HTMLElement} root  the #preview-thread element
 */
export function renderPreview(state, root) {
  if (!root) return;
  lastRoot = root;
  lastState = state;
  wirePreview(root);

  const posts = (state && Array.isArray(state.posts) && state.posts.length)
    ? state.posts
    : [{ id: '', text: '', media: [], card: null, poll: null, quote: null }];

  root.innerHTML = posts
    .map((post, i) => postCardHTML(post, state, { connector: connectorFor(i, posts.length) }))
    .join('');
}

export default renderPreview;
