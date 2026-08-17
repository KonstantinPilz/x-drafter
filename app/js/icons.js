// icons.js — inline SVG strings for the X post card.
//
// Contract:
//   * every value is a complete <svg> string with viewBox="0 0 24 24"
//   * fill="currentColor" on the root so the CSS colour cascades in
//   * NO width/height attributes — x.css sizes these (1.25em on the action bar)
//   * the only hardcoded colours live in the verified badges, which are
//     brand-coloured by definition (blue #1d9bf0 / gold #ffd400 / grey #829aab)
//
// Geometry follows X's shipped action-bar icons where I could recall the real
// path data (reply, repost, like, views, bookmark, share, more, image, gif,
// emoji, verified). The rest are clean visual equivalents drawn to the same
// 24x24 grid and optical weight.

// `fill` defaults to currentColor; icons that colour their own children (the
// badges) or that are pure line art pass 'none' so nothing is double-filled.
const S = (body, fill = 'currentColor') =>
  `<svg viewBox="0 0 24 24" fill="${fill}" aria-hidden="true" focusable="false">${body}</svg>`;

// A stroked group — used for icons that read better as line art (globe, calendar).
const stroke = (d, w = 1.8) =>
  `<g fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</g>`;

export const icons = {
  // ── Action bar ────────────────────────────────────────────────────────────
  reply: S(
    '<path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z"/>'
  ),

  repost: S(
    '<path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"/>'
  ),

  like: S(
    '<path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/>'
  ),

  likeFilled: S(
    '<path d="M20.884 13.19c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/>'
  ),

  // X's analytics/"views" glyph — four ascending bars.
  views: S(
    '<path d="M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z"/>'
  ),

  bookmark: S(
    '<path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zM6.5 4c-.276 0-.5.22-.5.5v14.56l6-4.29 6 4.29V4.5c0-.28-.224-.5-.5-.5h-11z"/>'
  ),

  share: S(
    '<path d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z"/>'
  ),

  more: S(
    '<path d="M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/>'
  ),

  // ── Verified badges ───────────────────────────────────────────────────────
  // Scalloped ("gear") circle with a knocked-out check — the single most
  // recognisable element on the card, so it keeps its own brand fill.
  verifiedBlue: S(
    '<path fill="#1d9bf0" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.67-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.26 2.52-.81 3.91c-1.31.67-2.19 1.91-2.19 3.34s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.67-.88 3.34-2.19c1.39.46 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z"/>' +
      '<path fill="#fff" d="M10.75 16.44L6.6 12.3l1.5-1.5 2.65 2.65 5.15-5.15 1.5 1.5z"/>',
    'none'
  ),

  // Organisation badge: X uses a square-ish scalloped outline rather than the
  // round one. Drawn to match its silhouette (see note in the module summary).
  verifiedGold: S(
    '<path fill="#ffd400" d="M12 1.5l2.62 2.19 3.38-.55.88 3.31 3.12 1.43-1.37 3.12 1.37 3.12-3.12 1.43-.88 3.31-3.38-.55L12 22.5l-2.62-2.19-3.38.55-.88-3.31L2 16.12l1.37-3.12L2 9.88 5.12 8.45 6 5.14l3.38.55L12 1.5z"/>' +
      '<path fill="#fff" d="M10.75 16.44L6.6 12.3l1.5-1.5 2.65 2.65 5.15-5.15 1.5 1.5z"/>',
    'none'
  ),

  verifiedGrey: S(
    '<path fill="#829aab" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.67-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.26 2.52-.81 3.91c-1.31.67-2.19 1.91-2.19 3.34s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.67-.88 3.34-2.19c1.39.46 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z"/>' +
      '<path fill="#fff" d="M10.75 16.44L6.6 12.3l1.5-1.5 2.65 2.65 5.15-5.15 1.5 1.5z"/>',
    'none'
  ),

  // ── Composer / toolbar ────────────────────────────────────────────────────
  globe: S(
    stroke(
      '<circle cx="12" cy="12" r="9.2"/><ellipse cx="12" cy="12" rx="4.1" ry="9.2"/><path d="M3.3 8.9h17.4M3.3 15.1h17.4"/>'
    ),
    'none'
  ),

  image: S(
    '<path d="M3 5.5C3 4.119 4.119 3 5.5 3h13C19.881 3 21 4.119 21 5.5v13c0 1.381-1.119 2.5-2.5 2.5h-13C4.119 21 3 19.881 3 18.5v-13zM5.5 5c-.276 0-.5.224-.5.5v9.086l3-3 3 3 5-5 3 3V5.5c0-.276-.224-.5-.5-.5h-13zM19 15.414l-3-3-5 5-3-3-3 3V18.5c0 .276.224.5.5.5h13c.276 0 .5-.224.5-.5v-3.086zM9.75 7C8.784 7 8 7.784 8 8.75s.784 1.75 1.75 1.75 1.75-.784 1.75-1.75S10.716 7 9.75 7z"/>'
  ),

  gif: S(
    '<path d="M3 5.5C3 4.119 4.119 3 5.5 3h13C19.881 3 21 4.119 21 5.5v13c0 1.381-1.119 2.5-2.5 2.5h-13C4.119 21 3 19.881 3 18.5v-13zM5.5 5c-.276 0-.5.224-.5.5v13c0 .276.224.5.5.5h13c.276 0 .5-.224.5-.5v-13c0-.276-.224-.5-.5-.5h-13z"/>' +
      '<path d="M18 10.711V9.25h-3.74v5.5h1.44v-1.719h1.7V11.57h-1.7v-.859H18zM11.79 9.25h1.44v5.5h-1.44v-5.5zm-3.07 1.375c.34 0 .77.172 1.02.43l1.03-.86c-.51-.601-1.28-.945-2.05-.945C7.19 9.25 6 10.453 6 12s1.19 2.75 2.72 2.75c.85 0 1.54-.344 2.05-.945v-2.149H8.38v1.032h1.02v.542c-.18.144-.4.211-.68.211-.71 0-1.28-.618-1.28-1.441 0-.82.57-1.375 1.28-1.375z"/>'
  ),

  // Poll: three vertical bars (distinct from the four-bar `views` glyph).
  poll: S('<path d="M5 20.5V9h3.3v11.5H5zm5.35 0v-17h3.3v17h-3.3zm5.35 0V13H19v7.5h-3.3z"/>'),

  emoji: S(
    '<path d="M12 22.75C6.072 22.75 1.25 17.928 1.25 12S6.072 1.25 12 1.25 22.75 6.072 22.75 12 17.928 22.75 12 22.75zm0-20C6.9 2.75 2.75 6.9 2.75 12S6.9 21.25 12 21.25s9.25-4.15 9.25-9.25S17.1 2.75 12 2.75zm0 15.5c-2.34 0-4.47-1.28-5.58-3.35l1.32-.71c.85 1.59 2.49 2.56 4.26 2.56s3.41-.97 4.26-2.56l1.32.71c-1.11 2.07-3.24 3.35-5.58 3.35zM8.5 10.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5S10 8.17 10 9s-.67 1.5-1.5 1.5zm7 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5S17 8.17 17 9s-.67 1.5-1.5 1.5z"/>'
  ),

  schedule: S(
    stroke(
      '<rect x="3.4" y="4.6" width="17.2" height="16" rx="2.6"/><path d="M3.4 9.6h17.2M8 2.6v4M16 2.6v4M12 12.4v3.1l2.1 1.2"/>'
    ),
    'none'
  ),

  location: S(
    '<path fill-rule="evenodd" d="M12 1.9c-4.03 0-7.3 3.27-7.3 7.3 0 2.66 1.6 5.65 3.28 8.03a34.6 34.6 0 003.5 4.2c.29.29.75.29 1.04 0a34.6 34.6 0 003.5-4.2c1.68-2.38 3.28-5.37 3.28-8.03 0-4.03-3.27-7.3-7.3-7.3zm0 9.85a2.55 2.55 0 110-5.1 2.55 2.55 0 010 5.1z"/>'
  ),

  plus: S('<path d="M11 11V4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/>'),

  close: S(
    '<path d="M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"/>'
  ),

  // ALT badge — X renders this as a text pill, so we do too.
  alt: S(
    '<rect x="2.6" y="5.4" width="18.8" height="13.2" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
      '<text x="12" y="15.6" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="8.4" font-weight="700" fill="currentColor">ALT</text>'
  ),

  // Play overlay for video media — filled disc with the triangle knocked out.
  play: S(
    '<path fill-rule="evenodd" d="M12 1.75C6.34 1.75 1.75 6.34 1.75 12S6.34 22.25 12 22.25 22.25 17.66 22.25 12 17.66 1.75 12 1.75zM9.8 7.4l7 4.6-7 4.6V7.4z"/>'
  ),
};

/**
 * Return an icon's SVG string with an optional class attribute injected.
 * `icon('like', 'is-active')` → `<svg class="is-active" viewBox="0 0 24 24" …>`
 * Unknown names return '' so a typo degrades to a blank slot, never a crash.
 */
export function icon(name, cls = '') {
  const svg = icons[name];
  if (!svg) return '';
  if (!cls) return svg;
  const safeCls = String(cls).replace(/"/g, '');
  return svg.replace('<svg ', `<svg class="${safeCls}" `);
}

export default icons;
