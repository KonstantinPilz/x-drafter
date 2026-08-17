/**
 * text.js — X (Twitter) text engine: weighted character counting, entity
 * parsing, HTML rendering and thread auto-splitting.
 *
 * Zero dependencies, ES module, works from file:// and GitHub Pages.
 *
 * Counting follows twitter-text's `config/v3.json`:
 *   defaultWeight 200, scale 100, maxWeightedTweetLength 280,
 *   transformedURLLength 23, and four "light" code point ranges that weigh 100.
 * Divided by the scale that means: most of the Latin/Greek/Cyrillic/Hebrew/
 * Arabic world counts 1, everything else (CJK, Kana, Hangul, …) counts 2, and
 * every URL counts exactly 23 no matter how long it really is.
 */

export const MAX_WEIGHTED = 280;
/** X Premium "long post" ceiling. Same weighting rules, bigger budget. */
export const LONG_MAX = 25000;
export const URL_WEIGHT = 23;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Coerce anything (null/undefined/number/…) to a string. */
function str(v) {
  return v === null || v === undefined ? '' : String(v);
}

/** Build a RegExp, falling back to a simpler pattern if the engine chokes
 *  on Unicode property escapes (very old browsers). */
function safeRe(pattern, flags, fallbackPattern) {
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    return new RegExp(fallbackPattern, flags.replace('u', ''));
  }
}

/* ------------------------------------------------------------------ *
 * Grapheme segmentation
 * ------------------------------------------------------------------ */

let _segmenter = null;
try {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    _segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  }
} catch (e) {
  _segmenter = null;
}

const ZWJ = '‍';
const VS16 = '️';
const KEYCAP = '⃣';
const RE_COMBINING = safeRe('^\\p{M}$', 'u', '^[\\u0300-\\u036F\\u1AB0-\\u1AFF\\u20D0-\\u20FF\\uFE20-\\uFE2F]$');
const RE_VARSEL = /^[︀-️]$/;
const RE_SKIN = /^[\u{1F3FB}-\u{1F3FF}]$/u;
const RE_RI_CP = /^[\u{1F1E6}-\u{1F1FF}]$/u;
const RE_EPICT = safeRe('\\p{Extended_Pictographic}', 'u', '[\\u2190-\\u2BFF\\u{1F000}-\\u{1FAFF}]');

/**
 * Surrogate-pair-aware grapheme fallback for engines without Intl.Segmenter.
 * Handles the cases that matter for tweet counting: combining marks, variation
 * selectors, skin-tone modifiers, keycaps, regional-indicator (flag) pairs and
 * ZWJ sequences such as the 👨‍👩‍👧‍👦 family emoji.
 */
function fallbackGraphemes(s) {
  const cps = Array.from(s); // Array.from iterates by code point, not code unit
  const out = [];
  let i = 0;
  while (i < cps.length) {
    let g = cps[i++];
    // Flags are exactly two regional indicators.
    if (RE_RI_CP.test(g) && i < cps.length && RE_RI_CP.test(cps[i])) g += cps[i++];
    for (;;) {
      const nx = cps[i];
      if (nx === undefined) break;
      if (nx === ZWJ) {
        // ZWJ always glues the *next* code point onto the cluster.
        if (i + 1 < cps.length) { g += nx + cps[i + 1]; i += 2; continue; }
        break;
      }
      if (RE_COMBINING.test(nx) || RE_VARSEL.test(nx) || RE_SKIN.test(nx) || nx === KEYCAP) {
        g += nx; i++; continue;
      }
      break;
    }
    out.push(g);
  }
  return out;
}

/**
 * Code points that can pull a neighbour into a multi-code-point cluster —
 * combining marks, ZWJ/ZWNJ, variation selectors, Hangul jamo, Indic prepends,
 * regional indicators, skin tones, tag characters — or that read as emoji. CR is
 * included because CR LF is one cluster. Every UAX #29 rule that joins two code
 * points needs at least one operand from this set, so two code points that are
 * both absent from it always have a cluster boundary between them.
 * The ranges were derived by testing every code point below U+30000 against
 * Intl.Segmenter; the non-unicode fallback keeps only plain ASCII off the list.
 */
const RE_CLUSTERY = safeRe(
  '[\\p{M}\\p{Extended_Pictographic}\\r\\u200C\\u200D]' +
  '|[\\u0600-\\u0605\\u06DD\\u070F\\u0890\\u0891\\u08E2\\u0D4E\\u0E33\\u0EB3]' +
  '|[\\u1100-\\u11FF\\uA960-\\uA97C\\uD7B0-\\uD7FF\\uFF9E\\uFF9F]' +
  '|[\\u{110BD}\\u{110CD}\\u{111C2}\\u{111C3}\\u{1193F}\\u{11941}\\u{11A3A}' +
    '\\u{11A84}-\\u{11A89}\\u{11D46}\\u{11F02}]' +
  '|[\\u{1F1E6}-\\u{1F1FF}\\u{1F3FB}-\\u{1F3FF}\\u{E0020}-\\u{E007F}]',
  'u',
  '[^\\x20-\\x7E\\t\\n]'
);

/**
 * V8's Intl.Segmenter iterator degrades quadratically with input length (25k
 * characters cost ~250ms, 32k ~350ms), which a Premium long post feels on every
 * keystroke. So we hand it bounded windows instead of the whole string.
 *
 * A window may not end just anywhere: truncating mid-cluster can make the
 * segmenter emit a *spurious* break (chop a ZWJ emoji chain and the surviving
 * prefix looks like a finished cluster), which corrupts more than the final
 * cluster. So we only ever cut where a boundary is guaranteed — between two
 * code points that are both absent from RE_CLUSTERY — and segment each window
 * independently.
 */
const SEG_WINDOW = 4096;

/** The code point starting at `p`, as a string. */
function cpAt(s, p) {
  return String.fromCodePoint(s.codePointAt(p));
}

/** The code point *ending* at `p`, as a string. */
function cpBefore(s, p) {
  const c = s.charCodeAt(p - 1);
  if (c >= 0xdc00 && c <= 0xdfff && p >= 2) return String.fromCodePoint(s.codePointAt(p - 2));
  return String.fromCharCode(c);
}

/** First index at or after `from` where a cluster boundary is guaranteed. */
function safeBreakAt(s, from) {
  for (let p = from; p < s.length; p++) {
    const c = s.charCodeAt(p);
    if (c >= 0xdc00 && c <= 0xdfff) continue; // never split a surrogate pair
    if (RE_CLUSTERY.test(cpBefore(s, p)) || RE_CLUSTERY.test(cpAt(s, p))) continue;
    return p;
  }
  return s.length;
}

function segmentWindowed(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const end = safeBreakAt(s, Math.min(i + SEG_WINDOW, s.length));
    for (const seg of _segmenter.segment(s.slice(i, end))) out.push(seg.segment);
    i = end;
  }
  return out;
}

/** Split a string into grapheme clusters. */
export function graphemes(text) {
  const s = str(text);
  if (!s) return [];
  if (_segmenter) return segmentWindowed(s);
  return fallbackGraphemes(s);
}

/* ------------------------------------------------------------------ *
 * Weighted counting
 * ------------------------------------------------------------------ */

/** twitter-text v3: these code point ranges weigh 100 (i.e. 1); all else 200 (2). */
function codePointWeight(cp) {
  if (cp <= 0x10ff) return 1;                    // Latin, Greek, Cyrillic, Hebrew, Arabic, …
  if (cp >= 0x2000 && cp <= 0x200d) return 1;    // general punctuation / spaces / ZWJ
  if (cp >= 0x2010 && cp <= 0x201f) return 1;    // dashes and quotes
  if (cp >= 0x2032 && cp <= 0x2037) return 1;    // primes
  return 2;                                      // CJK, Kana, Hangul, emoji, everything wide
}

/** Does this grapheme cluster count as a single 2-weight emoji? */
function isEmojiCluster(g) {
  const first = Array.from(g)[0] || '';
  if (RE_RI_CP.test(first)) return true;    // flag sequence (two regional indicators)
  if (g.indexOf(KEYCAP) !== -1) return true; // keycap, e.g. 1️⃣
  if (!RE_EPICT.test(g)) return false;
  if (g.indexOf(VS16) !== -1 || g.indexOf(ZWJ) !== -1) return true;
  for (const ch of g) if (ch.codePointAt(0) >= 0x1f000) return true;
  // Bare legacy pictographs like © ™ ‼ without VS16: count by range, as X does.
  return false;
}

/** Weight of one grapheme cluster. */
function graphemeWeight(g) {
  if (isEmojiCluster(g)) return 2;               // whole cluster counts 2, not per code point
  let w = 0;
  for (const ch of g) w += codePointWeight(ch.codePointAt(0));
  return w;
}

/**
 * Weight of a plain (URL-free) run of text. Text with no cluster-forming code
 * point in it is exactly one cluster per code point, so the weights can just be
 * added up and the segmenter skipped — the common case, and ~10x faster.
 */
function rawWeight(s) {
  let w = 0;
  if (!RE_CLUSTERY.test(s)) {
    for (const ch of s) w += codePointWeight(ch.codePointAt(0));
    return w;
  }
  for (const g of graphemes(s)) w += graphemeWeight(g);
  return w;
}

/**
 * X's weighted length of `text`. URLs contribute exactly URL_WEIGHT (23)
 * because X rewrites them to t.co links.
 */
export function weightedLength(text) {
  const s = str(text);
  if (!s) return 0;
  let total = 0;
  for (const e of parseEntities(s)) {
    total += e.type === 'url' ? URL_WEIGHT : rawWeight(e.value);
  }
  return total;
}

/**
 * Characters left before hitting `max` (may go negative). Pass LONG_MAX for a
 * Premium long post; the default keeps the classic 280 budget.
 */
export function remainingIn(text, max = MAX_WEIGHTED) {
  const m = typeof max === 'number' && isFinite(max) ? max : MAX_WEIGHTED;
  return m - weightedLength(text);
}

/** Characters left before hitting the 280 limit (may go negative). */
export function remaining(text) {
  return remainingIn(text, MAX_WEIGHTED);
}

/**
 * Does this text need a Premium long post? True past 280 weighted characters,
 * including past LONG_MAX — "too long to post at all" is still a long post.
 */
export function isLongPost(text) {
  return weightedLength(text) > MAX_WEIGHTED;
}

/* ------------------------------------------------------------------ *
 * Entity parsing
 * ------------------------------------------------------------------ */

// A pragmatic TLD list. Bare domains (no scheme, no path) must end in one of
// these; anything with a scheme or a path may use the generic 2+ letter
// fallback. Keeps "I went to the store.The next day" from becoming a link.
const TLDS = (
  'com net org edu gov mil int info biz io co ai app dev me ly sh gg tv fm cc ' +
  'us uk ca de fr jp cn in au nz ru br mx es it nl se no fi dk pl ch at be ie ' +
  'pt gr cz sk hu ro bg hr si lt lv ee is il tr sa ae za ke ng eg ar cl pe ve ' +
  'tw hk sg my th vn ph id kr ua kz by rs ba mk al cy mt lu li mc sm ad gi je ' +
  'im fo gl ax md tm su ge az am nu ws la st cx re to tk ml ga cf gq ' +
  'xyz online site tech store blog news press live life space website cloud ' +
  'digital network systems solutions agency studio design media group team ' +
  'ventures capital fund finance money bank shop click link one wiki page pro ' +
  'name tel mobi asia eu chat email games host ink lol run today zone software'
).split(/\s+/).filter(Boolean);
// Longest first so the alternation prefers ".online" over ".on".
const TLD_ALT = Array.from(new Set(TLDS)).sort((a, b) => b.length - a.length).join('|');

// One host label: alphanumeric, internal hyphens allowed.
const LABEL = '[a-z0-9](?:[a-z0-9\\-]*[a-z0-9])?';
// The lookahead forces the TLD to end at a non-alphanumeric, otherwise the
// alternation happily matches ".th" inside "store.The" or ".ba" in "foo.bar@…".
const TLD_END = '(?![a-z0-9\\-])';
const HOST_ANY = '(?:' + LABEL + '\\.)+[a-z]{2,24}' + TLD_END;
const HOST_LISTED = '(?:' + LABEL + '\\.)+(?:' + TLD_ALT + ')' + TLD_END;
const PORT = '(?::\\d{2,5})?';
// Path/query/fragment: everything up to whitespace or a quote/bracket that can
// never appear in a bare URL. Parentheses ARE allowed here and balanced later.
const PATH = '[/?#][^\\s<>"\'`{}\\[\\]|\\\\^]*';

/**
 * URL matcher. Group 1 is a boundary character that is NOT part of the URL
 * (excluding `@`, `.`, `-`, `/`, `+`, `%` and word chars stops us from
 * matching "example.com" inside "foo@example.com" or mid-token).
 * Group 2 is the URL itself, in three flavours:
 *   1. scheme + any host (+ optional path)
 *   2. bare host with a known TLD (+ optional path)
 *   3. bare host with any TLD but only when a path/query/fragment follows
 */
const URL_RE = new RegExp(
  '(^|[^\\w@.+%\\-/])(' +
    '(?:https?://' + HOST_ANY + PORT + '(?:' + PATH + ')?)' +
    '|(?:' + HOST_LISTED + PORT + '(?:' + PATH + ')?)' +
    '|(?:' + HOST_ANY + PORT + PATH + ')' +
  ')',
  'gi'
);

/**
 * @handle — 1–15 word chars. Group 1 is the boundary: a mention may not follow
 * a word character (kills the "@example" in "foo@example.com"), nor another
 * @/#/$ sigil. The lookahead rejects over-long handles outright.
 */
const MENTION_RE = /(^|[^\w!@#$%&*＠])[@＠]([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g;

/**
 * #hashtag — unicode letters/marks/digits/underscore, must contain at least one
 * non-digit (so "#123" is not a hashtag). May not follow a word char or `&`
 * (avoids eating HTML entities like `&#39;`).
 */
const HASHTAG_RE = safeRe(
  '(^|[^\\p{L}\\p{M}\\p{N}_&])[#＃]([\\p{L}\\p{M}\\p{N}_]*[\\p{L}\\p{M}_][\\p{L}\\p{M}\\p{N}_]*)',
  'gu',
  '(^|[^A-Za-z0-9_&])[#＃]([A-Za-z0-9_]*[A-Za-z_][A-Za-z0-9_]*)'
);

/** $TICKER — 1–6 letters with an optional 1–2 letter class suffix ($BRK.B). */
const CASHTAG_RE = /(^|[^\w$])\$([A-Za-z]{1,6})(\.[A-Za-z]{1,2})?(?![A-Za-z0-9])/g;

/**
 * Trim punctuation that people write *after* a URL but that isn't part of it.
 * A trailing "." or "," never belongs to the URL; a trailing ")" belongs only
 * when it closes a paren opened inside the URL.
 */
function trimUrlTail(url) {
  let out = url;
  for (;;) {
    const last = out.charAt(out.length - 1);
    if (!last) break;
    if (last === ')' || last === ']' || last === '}') {
      const open = last === ')' ? '(' : last === ']' ? '[' : '{';
      let opens = 0, closes = 0;
      for (const c of out) { if (c === open) opens++; else if (c === last) closes++; }
      if (closes > opens) { out = out.slice(0, -1); continue; }
      break;
    }
    if ('.,;:!?\'"'.indexOf(last) !== -1 || '’”‘“»«…'.indexOf(last) !== -1) {
      out = out.slice(0, -1);
      continue;
    }
    break;
  }
  return out;
}

function normalizeUrl(u) {
  return /^https?:\/\//i.test(u) ? u : 'https://' + u;
}

/**
 * Shorten a URL the way X displays it: no scheme, no "www.", path truncated so
 * the whole thing stays around 30 characters.
 */
export function displayUrl(url, max = 30) {
  let d = str(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (d.charAt(d.length - 1) === '/' && d.indexOf('/') === d.length - 1) d = d.slice(0, -1);
  const chars = Array.from(d);
  if (chars.length <= max) return d;
  const slash = d.search(/[/?#]/);
  if (slash > 0) {
    const host = d.slice(0, slash);
    const hostLen = Array.from(host).length;
    if (hostLen >= max - 1) return Array.from(host).slice(0, max - 1).join('') + '…';
    return host + Array.from(d.slice(slash)).slice(0, max - 1 - hostLen).join('') + '…';
  }
  return chars.slice(0, max - 1).join('') + '…';
}

function overlaps(ranges, start, end) {
  for (const r of ranges) if (start < r[1] && end > r[0]) return true;
  return false;
}

/**
 * Parse `text` into a flat, ordered, non-overlapping list of segments that
 * covers the whole string. Indices are JS string offsets (code units).
 *
 * @returns {Array<{type:'text'|'mention'|'hashtag'|'cashtag'|'url',
 *                  value:string, display:string, href:string|null,
 *                  start:number, end:number}>}
 */
export function parseEntities(text) {
  const s = str(text);
  if (!s) return [];

  const found = [];

  // URLs first — they may legitimately contain # and @ (example.com/a#b).
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(s)) !== null) {
    const start = m.index + m[1].length;
    const raw = trimUrlTail(m[2]);
    if (!raw) continue;
    found.push({
      type: 'url',
      value: raw,
      display: displayUrl(raw),
      href: normalizeUrl(raw),
      start,
      end: start + raw.length
    });
    // Resume right after the (possibly trimmed) URL.
    URL_RE.lastIndex = start + raw.length;
  }

  const urlRanges = found.map(e => [e.start, e.end]);

  const scan = (re, type, hrefFn, valueFn) => {
    re.lastIndex = 0;
    let mm;
    while ((mm = re.exec(s)) !== null) {
      const start = mm.index + mm[1].length;
      const value = valueFn(mm);
      const end = start + value.length;
      if (end <= start) { re.lastIndex = start + 1; continue; }
      if (!overlaps(urlRanges, start, end)) {
        found.push({ type, value, display: value, href: hrefFn(mm), start, end });
      }
      re.lastIndex = end;
    }
  };

  scan(MENTION_RE, 'mention',
    mm => 'https://x.com/' + mm[2],
    mm => s.slice(mm.index + mm[1].length, mm.index + mm[0].length));
  scan(HASHTAG_RE, 'hashtag',
    mm => 'https://x.com/hashtag/' + encodeURIComponent(mm[2]),
    mm => s.slice(mm.index + mm[1].length, mm.index + mm[0].length));
  scan(CASHTAG_RE, 'cashtag',
    mm => 'https://x.com/search?q=' + encodeURIComponent('$' + mm[2]),
    mm => '$' + mm[2] + (mm[3] || ''));

  found.sort((a, b) => a.start - b.start || b.end - a.end);

  // Stitch plain-text segments into the gaps; drop any leftover overlap.
  const out = [];
  let cursor = 0;
  for (const e of found) {
    if (e.start < cursor) continue;
    if (e.start > cursor) {
      const v = s.slice(cursor, e.start);
      out.push({ type: 'text', value: v, display: v, href: null, start: cursor, end: e.start });
    }
    out.push(e);
    cursor = e.end;
  }
  if (cursor < s.length) {
    const v = s.slice(cursor);
    out.push({ type: 'text', value: v, display: v, href: null, start: cursor, end: s.length });
  }
  return out;
}

/** First URL in the text, normalized to an absolute https:// URL, or null. */
export function extractFirstUrl(text) {
  for (const e of parseEntities(text)) if (e.type === 'url') return e.href;
  return null;
}

/* ------------------------------------------------------------------ *
 * HTML rendering
 * ------------------------------------------------------------------ */

export function escapeHTML(v) {
  return str(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escaped HTML for the post body. Newlines are left as-is: the card CSS uses
 * `white-space: pre-wrap`, so no <br> is emitted.
 */
export function renderTextHTML(text) {
  const parts = [];
  for (const e of parseEntities(text)) {
    if (e.type === 'text') {
      parts.push(escapeHTML(e.value));
    } else if (e.type === 'url') {
      parts.push('<span class="x-link" data-url="' + escapeHTML(e.href) + '">' +
        escapeHTML(e.display) + '</span>');
    } else {
      parts.push('<span class="x-link">' + escapeHTML(e.display) + '</span>');
    }
  }
  return parts.join('');
}

/* ------------------------------------------------------------------ *
 * Thread splitting
 * ------------------------------------------------------------------ */

/**
 * Sentence boundaries: terminal punctuation (optionally followed by a closing
 * quote/paren) plus whitespace. Boundaries that land inside a URL are skipped
 * so "see example.com. Next" never breaks the link.
 */
function splitSentences(s) {
  const urlRanges = parseEntities(s).filter(e => e.type === 'url').map(e => [e.start, e.end]);
  const re = /[.!?…。！？]+["'”’)\]]*\s+/g;
  const out = [];
  let last = 0, mm;
  while ((mm = re.exec(s)) !== null) {
    const punctAt = mm.index;
    if (overlaps(urlRanges, punctAt, punctAt + 1)) continue;
    const cutAt = mm.index + mm[0].length;
    if (cutAt >= s.length) break;
    out.push(s.slice(last, cutAt));
    last = cutAt;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.map(x => x.trim()).filter(Boolean);
}

/**
 * Greedy packer. Splits on paragraph breaks first, then single newlines, then
 * sentences, then whitespace; a single token longer than the budget is cut at
 * grapheme boundaries as a last resort.
 */
function pack(text, budget) {
  const chunks = [];
  let cur = '', curW = 0; // curW tracks weightedLength(cur) incrementally

  const flush = () => { const t = cur.trim(); if (t) chunks.push(t); cur = ''; curW = 0; };

  const hardCut = (piece) => {
    flush();
    let buf = '', w = 0;
    for (const g of graphemes(piece)) {
      const gw = graphemeWeight(g);
      if (w + gw > budget && buf) { chunks.push(buf.trim()); buf = ''; w = 0; }
      buf += g; w += gw;
    }
    cur = buf;
    curW = weightedLength(buf); // `w` is raw: it misses the 23-per-URL collapse
  };

  // level 0 -> split on single newlines, 1 -> sentences, 2 -> words
  const subdivide = (piece, level) => {
    for (let l = level; l <= 2; l++) {
      let parts, sep;
      if (l === 0) { parts = piece.split(/\n/); sep = '\n'; }
      else if (l === 1) { parts = splitSentences(piece); sep = ' '; }
      else { parts = piece.split(/\s+/); sep = ' '; }
      parts = parts.filter(p => p.length);
      if (parts.length > 1) return { parts, sep, next: l + 1 };
    }
    return null;
  };

  // Re-weighing `cur + sep + piece` on every append is quadratic, which a 25k
  // long post feels badly. Separators are always ASCII whitespace and no entity
  // (URL, @, #, $) can span whitespace — each one's leading boundary class
  // accepts it — so weights simply add across the join and `cur` never needs
  // re-counting.
  const tryAdd = (piece, sep, level) => {
    if (!piece || !piece.trim()) return;
    const pieceW = weightedLength(piece);
    const candW = cur ? curW + sep.length + pieceW : pieceW;
    if (candW <= budget) {
      cur = cur ? cur + sep + piece : piece;
      curW = candW;
      return;
    }
    if (pieceW <= budget) { flush(); cur = piece; curW = pieceW; return; }
    const sub = subdivide(piece, level);
    if (!sub) { hardCut(piece); return; }
    for (const p of sub.parts) tryAdd(p, sub.sep, sub.next);
  };

  for (const para of str(text).split(/\n{2,}/)) tryAdd(para, '\n\n', 0);
  flush();
  return chunks.length ? chunks : [''];
}

/**
 * Split `text` into a thread of chunks that each fit `maxWeighted`.
 *
 * When `numbered`, a " i/n" suffix is appended and room is reserved for it.
 * The suffix changes the available budget, which can change n, so we iterate to
 * a fixed point with a monotonically increasing n (guaranteed to terminate).
 */
export function splitThread(text, opts) {
  const o = opts || {};
  const t = str(text);
  const numbered = o.numbered !== false;
  const max = typeof o.maxWeighted === 'number' && o.maxWeighted > 0 ? o.maxWeighted : MAX_WEIGHTED;

  if (!t.trim()) return [''];

  let chunks = pack(t, max);
  if (!numbered || chunks.length <= 1) return chunks;

  let n = chunks.length;
  for (let iter = 0; iter < 16; iter++) {
    // " 12/34" = space + digits + slash + digits
    const reserve = 2 + 2 * String(n).length;
    chunks = pack(t, Math.max(24, max - reserve));
    if (chunks.length <= n) break;
    n = chunks.length;
  }
  const total = chunks.length;
  return chunks.map((c, i) => c + ' ' + (i + 1) + '/' + total);
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

/** X-style compact counts: 1200 -> "1.2K", 1500000 -> "1.5M". Truncates. */
export function formatCount(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  const neg = v < 0;
  const a = Math.abs(v);
  const fmt = (x, suffix) => {
    // One decimal below 100, whole numbers above — and truncate, like X does.
    const s = x < 100 ? (Math.floor(x * 10) / 10).toFixed(1).replace(/\.0$/, '') : String(Math.floor(x));
    return s + suffix;
  };
  let out;
  if (a < 1000) out = String(Math.floor(a));
  else if (a < 1e6) out = fmt(a / 1e3, 'K');
  else if (a < 1e9) out = fmt(a / 1e6, 'M');
  else out = fmt(a / 1e9, 'B');
  return (neg ? '-' : '') + out;
}
