/**
 * text.js — X (Twitter) text engine: weighted character counting, entity
 * parsing, rich-text formatting, HTML rendering and thread auto-splitting.
 *
 * Zero dependencies, ES module, works from file:// and GitHub Pages.
 *
 * Counting follows twitter-text's `config/v3.json`:
 *   defaultWeight 200, scale 100, maxWeightedTweetLength 280,
 *   transformedURLLength 23, and four "light" code point ranges that weigh 100.
 * Divided by the scale that means: most of the Latin/Greek/Cyrillic/Hebrew/
 * Arabic world counts 1, everything else (CJK, Kana, Hangul, …) counts 2, and
 * every URL counts exactly 23 no matter how long it really is.
 *
 * Formatting markers (`**bold**`, `*italic*`, `_italic_`, `~~strike~~`) are
 * free: X stores formatting beside the text, so it costs no characters. Every
 * count, entity lookup and render therefore runs on the marker-free plain text.
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
 * Rich text: **bold**, *italic* / _italic_, ~~strikethrough~~
 * ------------------------------------------------------------------ *
 *
 * X Premium keeps formatting *beside* the text rather than in it, so bolding a
 * word costs no characters. Our composer is a plain <textarea>, so a draft
 * carries markdown-ish markers instead; we parse them out, count and render the
 * plain text, and treat the markers themselves as free.
 *
 * Boundary rules are strict on purpose, so ordinary prose never formats itself:
 *   - a run only OPENS when the character after it is not a space,
 *   - a run only CLOSES when the character before it is not a space,
 *   - `_` additionally refuses to open after, or close before, a letter or
 *     digit — that is what keeps `snake_case_name` literal,
 *   - `~` only counts in pairs (`~~`); a single tilde is always literal.
 * So `2 * 3 * 4`, `$NVDA * 2`, `snake_case_name` and a bare `**` stay text.
 *
 * `\*`, `\_`, `\~` and `\\` are escapes: the backslash disappears and the
 * character after it is literal (and, like a marker, the backslash is free).
 *
 * Markers are honoured inside URLs too (`example.com/**a**` links to
 * `example.com/a`); escape them if you need a literal asterisk in a link.
 */

/** Characters a backslash may escape. */
const ESCAPABLE = '*_~\\';
/** Cheap pre-test: no marker character anywhere means nothing to parse. */
const RE_FORMAT_CHAR = /[*_~\\]/;

/**
 * splitThread swaps whitespace *inside* a formatted span for these placeholders
 * so the packer cannot cut `**bold text**` in half (see maskFormatted). They
 * are weight-1 characters that never occur in a real draft, and the rules above
 * treat them as whitespace so masked and unmasked text always parse alike.
 */
const MASK_LO = 0x01;
const MASK_HI = 0x07;

const RE_ALNUM = safeRe('[\\p{L}\\p{N}]', 'u', '[A-Za-z0-9]');

/** Whitespace, a mask placeholder, or the edge of the string. */
function isSpacey(ch) {
  if (!ch) return true;
  const c = ch.charCodeAt(0);
  if (c >= MASK_LO && c <= MASK_HI) return true;
  return /\s/.test(ch);
}

function isAlnum(ch) {
  return !!ch && RE_ALNUM.test(ch);
}

/**
 * Split the source into literal-text tokens and delimiter-run tokens.
 * Escapes are resolved here, so a `\*` lands in a text token and can never be
 * mistaken for a marker. Returns the source offsets of the removed backslashes.
 */
function scanFormatting(s) {
  const toks = [];
  const escapes = [];
  const re = /[*_~\\]/g;
  let buf = [];
  const flush = () => {
    if (buf.length) { toks.push({ type: 't', value: buf.join('') }); buf = []; }
  };
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    const p = m.index;
    if (p > last) buf.push(s.slice(last, p));
    if (m[0] === '\\') {
      const nx = s.charAt(p + 1);
      if (nx && ESCAPABLE.indexOf(nx) !== -1) {
        escapes.push(p);
        buf.push(nx);
        last = p + 2;
      } else {
        buf.push('\\');
        last = p + 1;
      }
      re.lastIndex = last;
      continue;
    }
    let j = p + 1;
    while (j < s.length && s.charAt(j) === m[0]) j++;
    flush();
    toks.push({
      type: 'd', char: m[0], start: p, end: j, len: j - p,
      openUsed: 0, closeUsed: 0, canOpen: false, canClose: false,
      plainOpen: 0, plainClose: 0
    });
    last = j;
    re.lastIndex = j;
  }
  if (last < s.length) buf.push(s.slice(last));
  flush();
  return { toks, escapes };
}

function lastCharOf(t) { return t.type === 't' ? t.value.charAt(t.value.length - 1) : t.char; }
function firstCharOf(t) { return t.type === 't' ? t.value.charAt(0) : t.char; }

/**
 * Pair delimiter runs off, innermost first, CommonMark-style: a closer takes
 * the nearest still-open run of the same character, two characters at a time
 * when both sides have two to give (bold), otherwise one (italic). Runs left
 * over stay literal.
 *
 * `floors` is what keeps this linear: once a closer has scanned the stack and
 * found no partner, nothing below that point can ever match that character
 * either, so later closers start above it. The floor only moves back down when
 * the stack itself shrinks.
 */
function matchDelims(toks) {
  const pairs = [];
  const stack = [];
  const floors = { '*': 0, _: 0, '~': 0 };
  const clamp = () => {
    if (floors['*'] > stack.length) floors['*'] = stack.length;
    if (floors._ > stack.length) floors._ = stack.length;
    if (floors['~'] > stack.length) floors['~'] = stack.length;
  };
  for (const t of toks) {
    if (t.type !== 'd') continue;
    if (t.canClose) {
      while (t.len - t.openUsed - t.closeUsed > 0) {
        let idx = -1;
        for (let p = stack.length - 1; p >= floors[t.char]; p--) {
          if (stack[p].char === t.char) { idx = p; break; }
        }
        if (idx < 0) { floors[t.char] = stack.length; break; }
        const op = stack[idx];
        const oRem = op.len - op.openUsed - op.closeUsed;
        const cRem = t.len - t.openUsed - t.closeUsed;
        const both = oRem >= 2 && cRem >= 2;
        const n = t.char === '~' ? (both ? 2 : 0) : (both ? 2 : 1);
        if (n === 0) { stack.length = idx; clamp(); continue; }
        op.openUsed += n;      // consumed from the RIGHT end of the opening run
        t.closeUsed += n;      // consumed from the LEFT end of the closing run
        pairs.push({
          kind: t.char === '~' ? 'strike' : (n === 2 ? 'bold' : 'italic'),
          opener: op, closer: t, n
        });
        // Anything still open above the opener can never be closed now.
        stack.length = (op.len - op.openUsed - op.closeUsed > 0) ? idx + 1 : idx;
        clamp();
      }
    }
    if (t.canOpen && t.len - t.openUsed - t.closeUsed > 0) stack.push(t);
  }
  return pairs;
}

const EMPTY = [];

/**
 * Full analysis of a marked-up string.
 *
 * @returns {{plain:string,
 *            marks:Array<{start:number,end:number,kind:string}>,  // into plain
 *            spans:Array<{kind,marker,openStart,openEnd,closeStart,closeEnd}>,
 *            toks:Array, escapes:number[]}}                        // into source
 */
function analyzeFormatting(s) {
  const { toks, escapes } = scanFormatting(s);

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type !== 'd') continue;
    const prev = k > 0 ? lastCharOf(toks[k - 1]) : '';
    const next = k + 1 < toks.length ? firstCharOf(toks[k + 1]) : '';
    const usable = t.char !== '~' || t.len >= 2;
    t.canOpen = usable && !isSpacey(next) && (t.char !== '_' || !isAlnum(prev));
    t.canClose = usable && !isSpacey(prev) && (t.char !== '_' || !isAlnum(next));
  }

  const pairs = matchDelims(toks);

  // Build the plain string. A matched delimiter contributes nothing, so every
  // consumption of one run collapses to a single plain offset.
  const parts = [];
  let len = 0;
  for (const t of toks) {
    if (t.type === 't') { parts.push(t.value); len += t.value.length; continue; }
    t.plainClose = len;
    const leftover = t.len - t.closeUsed - t.openUsed;
    if (leftover > 0) { parts.push(t.char.repeat(leftover)); len += leftover; }
    t.plainOpen = len;
  }

  const marks = [];
  const spans = [];
  for (const p of pairs) {
    const start = p.opener.plainOpen, end = p.closer.plainClose;
    if (end > start) marks.push({ start, end, kind: p.kind });
    spans.push({
      kind: p.kind, marker: p.opener.char.repeat(p.n),
      openStart: p.opener.start, openEnd: p.opener.end,
      closeStart: p.closer.start, closeEnd: p.closer.end
    });
  }
  marks.sort((a, b) => a.start - b.start || b.end - a.end);
  spans.sort((a, b) => a.openStart - b.openStart || b.closeEnd - a.closeEnd);

  return { plain: parts.join(''), marks, spans, toks, escapes };
}

// The composer counts, renders and previews the same string on every keystroke,
// so one memo slot removes most of the repeat work.
let _fmtKey = null;
let _fmtVal = null;

/** Cached analysis. The result is shared — treat it as read-only. */
function formatting(text) {
  const s = str(text);
  if (!s || !RE_FORMAT_CHAR.test(s)) {
    return { plain: s, marks: EMPTY, spans: EMPTY, toks: EMPTY, escapes: EMPTY };
  }
  if (s === _fmtKey) return _fmtVal;
  const v = analyzeFormatting(s);
  _fmtKey = s;
  _fmtVal = v;
  return v;
}

/**
 * Plain text plus the formatting that was applied to it.
 * `marks` offsets index `plain`, never the marked-up source, and the ranges are
 * properly nested (sorted outermost-first).
 */
export function parseFormatting(text) {
  const f = formatting(text);
  return {
    plain: f.plain,
    marks: f.marks.map(m => ({ start: m.start, end: m.end, kind: m.kind }))
  };
}

/** The text a reader actually sees: markers gone, escapes resolved. */
export function stripFormatting(text) {
  return formatting(text).plain;
}

/** Does this draft carry any bold/italic/strikethrough? */
export function hasFormatting(text) {
  return formatting(text).marks.length > 0;
}

/* ---- Unicode math-alphanumeric styling (for "copy for elsewhere") ---- */

// Mathematical Sans-Serif Bold / Italic / Bold Italic. Only ASCII letters and
// digits have a mapping; there are no sans-serif *italic* digits in Unicode, so
// digits inside a plain italic run are left as they are.
const MATH_ALPHA = {
  bold: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec },
  italic: { upper: 0x1d608, lower: 0x1d622, digit: 0 },
  bolditalic: { upper: 0x1d63c, lower: 0x1d656, digit: 0x1d7ec }
};
// Unicode has no strikethrough alphabet, so struck text gets U+0336 COMBINING
// LONG STROKE OVERLAY after each grapheme cluster instead. It renders as a line
// through the text in most fonts, and it is the only portable option.
const STRIKE_OVERLAY = '̶';

function mathAlpha(ch, bold, italic) {
  const set = MATH_ALPHA[bold && italic ? 'bolditalic' : (bold ? 'bold' : 'italic')];
  const c = ch.charCodeAt(0);
  if (c >= 65 && c <= 90) return String.fromCodePoint(set.upper + c - 65);
  if (c >= 97 && c <= 122) return String.fromCodePoint(set.lower + c - 97);
  if (c >= 48 && c <= 57 && set.digit) return String.fromCodePoint(set.digit + c - 48);
  return ch;
}

/**
 * Walk `marks` alongside a position that only ever moves forward.
 * Returns the marks covering that position, outermost first. Marks nest, so the
 * open list behaves like a stack: whatever ends first is whatever went in last.
 */
function markCursor(marks) {
  let i = 0;
  const open = [];
  return function at(pos) {
    while (i < marks.length && marks[i].start <= pos) open.push(marks[i++]);
    for (let k = open.length - 1; k >= 0; k--) if (open[k].end <= pos) open.splice(k, 1);
    return open;
  };
}

/**
 * Plain text with Unicode math-alphanumeric substitutes for bold/italic, for
 * pasting somewhere that has no rich text. Anything without a mapping — CJK,
 * emoji, punctuation — is left alone.
 */
export function toUnicodeStyled(text) {
  const f = formatting(text);
  if (!f.marks.length) return f.plain;
  const cursor = markCursor(f.marks);
  const out = [];
  let pos = 0;
  for (const g of graphemes(f.plain)) {
    let bold = false, italic = false, strike = false;
    for (const m of cursor(pos)) {
      if (m.kind === 'bold') bold = true;
      else if (m.kind === 'italic') italic = true;
      else strike = true;
    }
    let piece = g;
    if (bold || italic) {
      let mapped = '';
      for (const ch of g) mapped += mathAlpha(ch, bold, italic);
      piece = mapped;
    }
    if (strike) piece += STRIKE_OVERLAY;
    out.push(piece);
    pos += g.length;
  }
  return out.join('');
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
 * X's weighted length of already-plain text. URLs contribute exactly
 * URL_WEIGHT (23) because X rewrites them to t.co links.
 */
function weightedLengthOfPlain(s) {
  let total = 0;
  for (const e of parseEntities(s)) {
    total += e.type === 'url' ? URL_WEIGHT : rawWeight(e.value);
  }
  return total;
}

/**
 * X's weighted length of `text`.
 *
 * Formatting markers are free, exactly as on X, where the bold/italic runs live
 * beside the text and bolding a word never costs a character. So the count is
 * taken on the plain text; a draft with no marker character in it skips the
 * formatting parse entirely.
 */
export function weightedLength(text) {
  const s = str(text);
  if (!s) return 0;
  return weightedLengthOfPlain(RE_FORMAT_CHAR.test(s) ? formatting(s).plain : s);
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

/**
 * First URL in the text, normalized to an absolute https:// URL, or null.
 * Runs on the plain text, so `**https://example.com**` still yields a URL.
 */
export function extractFirstUrl(text) {
  for (const e of parseEntities(stripFormatting(text))) if (e.type === 'url') return e.href;
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

const MARK_TAG = { bold: 'b', italic: 'i', strike: 's' };

function entityOpen(e) {
  return e.type === 'url'
    ? '<span class="x-link" data-url="' + escapeHTML(e.href) + '">'
    : '<span class="x-link">';
}

function entityHTML(e) {
  if (e.type === 'text') return escapeHTML(e.value);
  return entityOpen(e) + escapeHTML(e.display) + '</span>';
}

/** Sorted, unique list of every position where the active mark set can change. */
function markBounds(marks, len) {
  const set = [];
  for (const m of marks) { set.push(m.start); set.push(m.end); }
  set.push(len);
  set.sort((a, b) => a - b);
  const out = [];
  for (const v of set) if (!out.length || out[out.length - 1] !== v) out.push(v);
  return out;
}

/** Smallest boundary strictly greater than `p`. */
function nextBound(bounds, p) {
  let lo = 0, hi = bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bounds[mid] <= p) lo = mid + 1; else hi = mid;
  }
  return lo < bounds.length ? bounds[lo] : p + 1;
}

/** Marks over [from, to) rendered with their own balanced tag stack. */
function renderMarkedRange(plain, marks, bounds, from, to) {
  const out = [];
  const stack = [];
  let p = from;
  while (p < to) {
    const q = Math.min(nextBound(bounds, p), to);
    const active = [];
    for (const m of marks) if (m.start <= p && m.end > p) active.push(m);
    let k = 0;
    while (k < stack.length && k < active.length && stack[k] === active[k]) k++;
    while (stack.length > k) out.push('</' + MARK_TAG[stack.pop().kind] + '>');
    for (; k < active.length; k++) { stack.push(active[k]); out.push('<' + MARK_TAG[active[k].kind] + '>'); }
    out.push(escapeHTML(plain.slice(p, q)));
    p = q;
  }
  while (stack.length) out.push('</' + MARK_TAG[stack.pop().kind] + '>');
  return out.join('');
}

/**
 * Escaped HTML for the post body. Newlines are left as-is: the card CSS uses
 * `white-space: pre-wrap`, so no <br> is emitted.
 *
 * Entities are detected on the PLAIN text, not the marked-up source, so
 * `**https://example.com/path**` is still one URL and `**@handle**` is still a
 * mention. Mark ranges are then laid over the same plain string, which is why
 * the two never have to agree on where the markers were.
 *
 * A mark that only partly overlaps an entity would need a tag to cross the
 * <span> boundary, so it is split at that boundary instead: the tags close
 * before the span and re-open inside it. A URL is a special case — what is
 * displayed is a shortened form of the URL, so plain-text offsets cannot be
 * mapped into it and a partial mark styles the whole displayed link.
 */
export function renderTextHTML(text) {
  const f = formatting(text);
  const plain = f.plain;
  const marks = f.marks;
  const ents = parseEntities(plain);

  if (!marks.length) {
    const flat = [];
    for (const e of ents) flat.push(entityHTML(e));
    return flat.join('');
  }

  const bounds = markBounds(marks, plain.length);
  const cursor = markCursor(marks);
  const out = [];
  const stack = [];
  const closeDown = (keep) => {
    while (stack.length > keep) out.push('</' + MARK_TAG[stack.pop().kind] + '>');
  };
  const sync = (active) => {
    let k = 0;
    while (k < stack.length && k < active.length && stack[k] === active[k]) k++;
    closeDown(k);
    for (; k < active.length; k++) { stack.push(active[k]); out.push('<' + MARK_TAG[active[k].kind] + '>'); }
  };

  for (const e of ents) {
    if (e.type === 'text') {
      let p = e.start;
      while (p < e.end) {
        const q = Math.min(nextBound(bounds, p), e.end);
        sync(cursor(p));
        out.push(escapeHTML(plain.slice(p, q)));
        p = q;
      }
      continue;
    }

    const covering = [];
    let partial = false;
    for (const m of marks) {
      if (m.start >= e.end || m.end <= e.start) continue;
      if (m.start <= e.start && m.end >= e.end) covering.push(m);
      else partial = true;
    }

    if (!partial) {
      // Every mark here wraps the whole entity, so the tags can stay open
      // across it: <b>see <span class="x-link">@jack</span> now</b>.
      sync(covering);
      out.push(entityHTML(e));
      continue;
    }

    closeDown(0);
    out.push(entityOpen(e));
    if (e.type === 'url') {
      const kinds = [];
      for (const m of marks) {
        if (m.start < e.end && m.end > e.start && kinds.indexOf(m.kind) === -1) kinds.push(m.kind);
      }
      for (const k of kinds) out.push('<' + MARK_TAG[k] + '>');
      out.push(escapeHTML(e.display));
      for (let i = kinds.length - 1; i >= 0; i--) out.push('</' + MARK_TAG[kinds[i]] + '>');
    } else {
      out.push(renderMarkedRange(plain, marks, bounds, e.start, e.end));
    }
    out.push('</span>');
  }
  closeDown(0);
  return out.join('');
}

/* ------------------------------------------------------------------ *
 * Thread splitting
 * ------------------------------------------------------------------ */

/**
 * The packer cuts at whitespace, which would happily land in the middle of
 * `**bold text**` and leave a stray `**` in each half. So before packing we
 * swap every whitespace character *inside* a formatted span for a placeholder:
 * the packer then sees one unbreakable token and cuts around it. Placeholders
 * weigh the same as what they replace, and the formatter treats them as spaces
 * (see isSpacey), so masking changes neither the character count nor the parse.
 * Only ASCII whitespace and NBSP are masked; the rarer Unicode spaces are left
 * alone because no weight-preserving placeholder exists for all of them.
 */
const MASK_WS = [' ', '\u000a', '\u0009', '\u000d', '\u000c', '\u000b', '\u00a0'];
const MASK_OF = {};
const UNMASK_OF = {};
for (let i = 0; i < MASK_WS.length; i++) {
  const ph = String.fromCharCode(MASK_LO + i);   // U+0001 .. U+0007
  MASK_OF[MASK_WS[i]] = ph;
  UNMASK_OF[ph] = MASK_WS[i];
}
const RE_MASKED = /[\u0001-\u0007]/g;

function maskFormatted(s) {
  const spans = formatting(s).spans;
  if (!spans.length) return s;
  // Merge the source ranges first: nested spans would otherwise make this
  // O(text x nesting depth).
  const merged = [];
  for (const sp of spans) {
    const last = merged.length ? merged[merged.length - 1] : null;
    if (last && sp.openStart <= last[1]) { if (sp.closeEnd > last[1]) last[1] = sp.closeEnd; }
    else merged.push([sp.openStart, sp.closeEnd]);
  }
  const a = s.split(''); // code units: only ASCII/NBSP is touched, never a surrogate
  let touched = false;
  for (const r of merged) {
    for (let i = r[0]; i < r[1]; i++) {
      const rep = MASK_OF[a[i]];
      if (rep) { a[i] = rep; touched = true; }
    }
  }
  return touched ? a.join('') : s;
}

function unmaskFormatted(s) {
  return s.replace(RE_MASKED, c => UNMASK_OF[c]);
}

/** Source offsets that vanish from the plain text: markers and escape slashes. */
function freeMask(s, f) {
  const mask = new Uint8Array(s.length);
  for (const off of f.escapes) mask[off] = 1;
  for (const t of f.toks) {
    if (t.type !== 'd') continue;
    for (let i = t.start; i < t.start + t.closeUsed; i++) mask[i] = 1;
    for (let i = t.end - t.openUsed; i < t.end; i++) mask[i] = 1;
  }
  return mask;
}

/** Insert `extra` just before any trailing whitespace, so it still reads as a closer. */
function insertBeforeTrailingSpace(s, extra) {
  if (!extra) return s;
  let e = s.length;
  while (e > 0 && isSpacey(s.charAt(e - 1))) e--;
  return s.slice(0, e) + extra + s.slice(e);
}

/** Insert `extra` just after any leading whitespace, so it still reads as an opener. */
function insertAfterLeadingSpace(s, extra) {
  if (!extra) return s;
  let b = 0;
  while (b < s.length && isSpacey(s.charAt(b))) b++;
  return s.slice(0, b) + extra + s.slice(b);
}

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

  // A token wider than the budget has to be cut mid-token. When such a cut
  // lands inside a formatted span, the open markers are closed at the end of
  // the chunk and re-opened at the start of the next one, so neither half is
  // left holding a stray `**`. Markers weigh nothing, so the repair cannot
  // push a chunk over budget.
  const hardCut = (piece) => {
    flush();
    const f = formatting(piece);
    const spans = f.spans;
    const free = (spans.length || f.escapes.length) ? freeMask(piece, f) : null;

    const gs = graphemes(piece);
    const offs = new Array(gs.length);
    const pref = new Array(gs.length + 1);   // pref[i] = weight of the first i clusters
    const idxOf = new Map();
    let o = 0, sum = 0;
    for (let i = 0; i < gs.length; i++) {
      offs[i] = o;
      pref[i] = sum;
      idxOf.set(o, i);
      sum += (free && free[o]) ? 0 : graphemeWeight(gs[i]);
      o += gs[i].length;
    }
    pref[gs.length] = sum;
    idxOf.set(piece.length, gs.length);
    const offAt = (i) => (i < gs.length ? offs[i] : piece.length);

    // Never leave a chunk ending on a dangling opener or starting on a dangling
    // closer — both would render as literal asterisks. Shift the cut instead.
    const adjust = (i, floor) => {
      let ci = i;
      for (let guard = 0; guard < 64 && ci > floor; guard++) {
        const p = offAt(ci);
        let moved = false;
        for (const sp of spans) {
          if (sp.openEnd !== p || sp.openStart < offAt(floor)) continue;
          const ni = idxOf.get(sp.openStart);
          if (ni !== undefined && ni > floor) { ci = ni; moved = true; }
          break;
        }
        if (moved) continue;
        for (const sp of spans) {
          if (sp.closeStart === p && sp.openEnd <= p) { ci--; moved = true; break; }
        }
        if (!moved) break;
      }
      return ci > floor ? ci : i;
    };

    // A masked formatted span arrives here as one unbreakable token, so this is
    // also where a bold paragraph longer than the budget gets divided: cut at
    // the last word boundary that still leaves the chunk at least half full,
    // and only mid-word when a single word is itself too long.
    const cuts = [];
    let from = 0, wordStart = -1;
    for (let i = 0; i < gs.length; i++) {
      if (i > from && isSpacey(gs[i - 1]) && !isSpacey(gs[i])) wordStart = i;
      if (pref[i + 1] - pref[from] > budget && i > from) {
        const useWord = wordStart > from && wordStart <= i &&
          pref[wordStart] - pref[from] >= budget / 2;
        const ci = adjust(useWord ? wordStart : i, from);
        cuts.push(ci);
        from = ci;
        wordStart = -1;
      }
    }

    const bounds = cuts.concat([gs.length]);
    let prev = 0, pend = '';
    for (let bi = 0; bi < bounds.length; bi++) {
      const b = bounds[bi];
      let body = piece.slice(offAt(prev), offAt(b));
      if (pend) body = insertAfterLeadingSpace(body, pend);
      const open = [];
      if (b < gs.length) {
        const p = offAt(b);
        for (const sp of spans) if (sp.openEnd <= p && p <= sp.closeStart) open.push(sp);
        let closers = '';
        for (let k = open.length - 1; k >= 0; k--) closers += open[k].marker;
        body = insertBeforeTrailingSpace(body, closers);
      }
      pend = open.map(sp => sp.marker).join('');
      if (bi < bounds.length - 1) chunks.push(body.trim());
      else { cur = body; curW = weightedLength(body); }
      prev = b;
    }
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

  // Pack the marked-up text with every formatted span made unbreakable, then
  // put the real whitespace back. Markers cost nothing, so reserving room for
  // the "i/n" suffix is unaffected by them.
  const masked = maskFormatted(t);
  const runPack = (budget) => pack(masked, budget).map(c => unmaskFormatted(c).trim());

  let chunks = runPack(max);
  if (!numbered || chunks.length <= 1) return chunks;

  let n = chunks.length;
  for (let iter = 0; iter < 16; iter++) {
    // " 12/34" = space + digits + slash + digits
    const reserve = 2 + 2 * String(n).length;
    chunks = runPack(Math.max(24, max - reserve));
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
