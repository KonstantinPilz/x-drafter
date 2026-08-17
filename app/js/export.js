// export.js — turn the live preview node into a PNG (download / clipboard),
// plus plain-text thread export.
//
// Rendering uses html-to-image (MIT), vendored at ../vendor/html-to-image.js —
// there is NO runtime CDN dependency. That file is the UMD build, so importing
// it from an ES module simply runs its global branch and leaves the API on
// globalThis.htmlToImage; we read it from there.
//
// If the vendored file is ever missing or fails to load, renderToBlob() falls
// back to a self-contained foreignObject-SVG → canvas rasteriser implemented at
// the bottom of this file. The fallback inlines the page's stylesheets and the
// node's --x-* custom properties into the SVG, since a foreignObject document
// inherits nothing from the host page.
//
// The import is dynamic and nothing runs at module load, so this file also
// parses under Node.

const DEFAULT_SCALE = 2; // 2× device pixels → retina-sharp output
const IMAGE_FETCH_TIMEOUT_MS = 8000;

/* ── Vendored library loader ───────────────────────────────────────────────── */

let libPromise = null;

async function loadLib() {
  if (libPromise) return libPromise;
  libPromise = import('../vendor/html-to-image.js')
    .then((mod) => {
      if (mod && typeof mod.toBlob === 'function') return mod; // ESM build
      const g = typeof globalThis !== 'undefined' ? globalThis.htmlToImage : null;
      return g && typeof g.toBlob === 'function' ? g : null; // UMD global
    })
    .catch(() => null);
  return libPromise;
}

/* ── Shared helpers ────────────────────────────────────────────────────────── */

/** Background colour: the node's own --x-bg theme token, never transparent. */
function backgroundOf(node) {
  try {
    const cs = getComputedStyle(node);
    const token = cs.getPropertyValue('--x-bg').trim();
    if (token) return token;
    const bg = cs.backgroundColor;
    if (bg && bg !== 'transparent' && !/^rgba\(0,\s*0,\s*0,\s*0\)$/.test(bg)) return bg;
  } catch (e) {
    /* fall through */
  }
  return '#ffffff';
}

/** Elements tagged [data-export-ignore] are dropped from the render. */
function exportFilter(el) {
  return !(el && el.nodeType === 1 && el.hasAttribute && el.hasAttribute('data-export-ignore'));
}

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function defaultFilename() {
  return `x-post-${todayStamp()}.png`;
}

/* ── Image embedding ───────────────────────────────────────────────────────── */
// Remote <img> sources are converted to data: URLs before rasterising, so that
// nothing is silently dropped by CORS or by canvas tainting. We mutate the live
// DOM briefly and always restore the original src values afterwards.

async function urlToDataURL(url) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res.ok) return '';
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => resolve('');
      fr.readAsDataURL(blob);
    });
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function embedImages(node) {
  const undo = [];
  let imgs = [];
  try {
    imgs = Array.from(node.querySelectorAll('img'));
  } catch (e) {
    return () => {};
  }
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') || '';
      if (!/^https?:/i.test(src)) return; // already data:/blob:/relative-inline
      const data = await urlToDataURL(src);
      if (!data) return; // leave the original; html-to-image will try too
      undo.push(() => img.setAttribute('src', src));
      img.setAttribute('src', data);
    })
  );
  return () => undo.forEach((fn) => fn());
}

/* ── Core render ───────────────────────────────────────────────────────────── */

/**
 * Rasterise `node` to a PNG Blob.
 * @param {Element} node
 * @param {number} [scale=2] pixel ratio
 * @returns {Promise<Blob>}
 */
export async function renderToBlob(node, scale) {
  if (!node) throw new Error('renderToBlob: no node given');
  const ratio = Number(scale) > 0 ? Number(scale) : DEFAULT_SCALE;
  const background = backgroundOf(node);
  const restore = await embedImages(node);

  try {
    const lib = await loadLib();
    if (lib) {
      const blob = await lib.toBlob(node, {
        pixelRatio: ratio,
        backgroundColor: background,
        filter: exportFilter,
        width: node.offsetWidth || undefined,
        height: node.offsetHeight || undefined,
        cacheBust: false, // we already inlined remote images
      });
      if (blob && blob.size > 0) return blob;
    }
    return await foreignObjectBlob(node, ratio, background);
  } finally {
    restore();
  }
}

/* ── Public actions ────────────────────────────────────────────────────────── */

/** Render and trigger a browser download. Default name: x-post-YYYY-MM-DD.png */
export async function exportPNG(node, filename) {
  const blob = await renderToBlob(node, DEFAULT_SCALE);
  const name = filename || defaultFilename();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Copy the render to the clipboard as a PNG.
 * @returns {Promise<boolean>} false when the browser lacks async clipboard
 *   image support (Firefox <127, http: origins, …) — never throws.
 */
export async function copyPNG(node) {
  const hasClipboard =
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.write === 'function' &&
    typeof ClipboardItem !== 'undefined';
  if (!hasClipboard) return false;

  try {
    // Start the render but hand ClipboardItem the *promise*, built synchronously
    // so Safari still sees us inside the originating user gesture.
    const blobPromise = renderToBlob(node, DEFAULT_SCALE);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
      return true;
    } catch (e) {
      // Some engines reject promise-valued entries — retry with a settled Blob.
      const blob = await blobPromise;
      if (!blob) return false;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    }
  } catch (e) {
    return false;
  }
}

/** Whole thread as plain text, posts separated by a --- rule. */
export function exportThreadText(state) {
  const posts = (state && Array.isArray(state.posts) ? state.posts : []) || [];
  return posts
    .map((p) => String((p && p.text) || '').trim())
    .filter((t) => t.length > 0)
    .join('\n\n---\n\n');
}

/* ── Fallback rasteriser: foreignObject SVG → canvas ───────────────────────── */
// Used only when the vendored html-to-image build can't be loaded. It clones the
// node, strips [data-export-ignore], inlines every readable stylesheet plus the
// node's computed --x-* custom properties (a foreignObject document inherits
// nothing from the host page), serialises to XML and draws it onto a canvas.
// Limitations vs html-to-image: no web-font embedding, and cross-origin images
// that failed the embedImages() pass above will be missing.

function escapeForXML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** Concatenate the cssText of every same-origin stylesheet. */
function collectCSS() {
  let out = '';
  const sheets = Array.from(document.styleSheets || []);
  for (const sheet of sheets) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch (e) {
      continue; // cross-origin sheet — not readable
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) out += rule.cssText + '\n';
  }
  return out;
}

/** Every custom-property name mentioned by our stylesheets. */
function collectCustomPropNames(css) {
  const names = new Set();
  const re = /(--[A-Za-z0-9_-]+)\s*:/g;
  let m;
  while ((m = re.exec(css))) names.add(m[1]);
  return Array.from(names);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('SVG rasterise failed'));
    img.src = src;
  });
}

async function foreignObjectBlob(node, scale, background) {
  const w = Math.ceil(node.offsetWidth || node.getBoundingClientRect().width || 598);
  const h = Math.ceil(node.offsetHeight || node.getBoundingClientRect().height || 400);

  const clone = node.cloneNode(true);
  clone.querySelectorAll('[data-export-ignore]').forEach((el) => el.remove());

  const css = collectCSS();
  const cs = getComputedStyle(node);
  const vars = collectCustomPropNames(css)
    .map((name) => {
      const value = cs.getPropertyValue(name).trim();
      return value ? `${name}:${value}` : '';
    })
    .filter(Boolean)
    .join(';');

  clone.setAttribute(
    'style',
    `${clone.getAttribute('style') || ''};${vars};width:${w}px;background:${background};`
  );

  const html = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml">` +
    `<style>${escapeForXML(css)}</style>${html}` +
    `</div></foreignObject></svg>`;

  const img = await loadImage(
    'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  );

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png');
  });
}
