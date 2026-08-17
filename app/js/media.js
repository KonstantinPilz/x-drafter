// media.js — image / GIF / video attachments for the composer.
//
// Responsibilities:
//   * turn File objects into serialisable Media records (downscaled, so drafts
//     still fit inside localStorage's ~5 MB budget),
//   * wire the three ways a user attaches media (file input, drag-drop, paste),
//   * paint + manage the composer's thumbnail strip (remove, alt text, reorder).
//
// Zero dependencies beyond state.js. No top-level DOM access, no globals:
// everything per-element lives in module-scoped WeakMaps/WeakSets so the module
// can be imported in a non-browser environment (e.g. a syntax check under node).

import { activePost, update, uid } from './state.js';

// ── Constants ──────────────────────────────────────────────────────────────
export const MAX_MEDIA = 4;

const MAX_EDGE = 1600;              // longest edge kept after downscaling, px
const JPEG_QUALITY = 0.85;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;  // ~10 MB pre-downscale guard
const MAX_ALT = 1000;
const VIDEO_TIMEOUT_MS = 10000;     // give up on a stuck poster grab
const POSTER_SEEK_SECONDS = 0.1;

// Element bookkeeping. WeakMap/WeakSet so nothing leaks and nothing is global.
const wired = new WeakSet();                 // elements whose listeners are attached
const stripCtx = new WeakMap();              // strip -> { getPost, onChange, post }
const dragDepth = new WeakMap();             // dropZone -> dragenter/leave counter

// ── Small promise helpers ──────────────────────────────────────────────────

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(friendly(`Couldn't read "${file.name || 'that file'}".`));
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(friendly("That image couldn't be decoded — try a PNG or JPEG."));
    img.src = src;
  });
}

function friendly(message) {
  const err = new Error(message);
  err.friendly = true;
  return err;
}

// ── Type classification ────────────────────────────────────────────────────

function kindOf(file) {
  const type = (file && file.type) || '';
  if (type === 'image/gif') return 'gif';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'image';
  // Some drops arrive with an empty MIME type; fall back to the extension.
  const name = ((file && file.name) || '').toLowerCase();
  if (/\.gif$/.test(name)) return 'gif';
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(name)) return 'video';
  if (/\.(png|jpe?g|webp|avif|bmp|svg)$/.test(name)) return 'image';
  return null;
}

// ── Canvas downscaling ─────────────────────────────────────────────────────

// Scale factor that brings the longest edge down to MAX_EDGE (never upscales).
function fitScale(w, h) {
  const longest = Math.max(w, h);
  return longest > MAX_EDGE ? MAX_EDGE / longest : 1;
}

function drawToCanvas(source, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

// Cheap alpha probe: sample every 4th pixel of the already-scaled canvas.
// Only worth running for formats that can carry transparency.
function hasTransparency(ctx, canvas) {
  try {
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 16) {
      if (data[i] < 255) return true;
    }
    return false;
  } catch (e) {
    return true; // tainted canvas or similar — assume alpha and keep PNG
  }
}

// Re-encode a decoded image at <= MAX_EDGE. Returns null when no work is needed.
function downscaleImage(img, mimeType) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = fitScale(w, h);
  if (scale === 1) return null;

  const { canvas, ctx } = drawToCanvas(img, w * scale, h * scale);
  const alphaCapable = /png|webp|avif|svg/.test(mimeType || '');
  const keepPNG = alphaCapable && hasTransparency(ctx, canvas);
  const src = keepPNG
    ? canvas.toDataURL('image/png')
    : canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return { src, w: canvas.width, h: canvas.height };
}

// ── Video poster frame ─────────────────────────────────────────────────────

// Seeks a hidden <video> to ~0.1s and grabs a JPEG poster. The object URL is
// deliberately NOT revoked here: it becomes media.videoSrc so the preview can
// play the clip. releaseMedia() revokes it when the item is removed.
function posterFromVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);            // transient URL: revoke on failure
      reject(friendly(msg));
    };

    const timer = setTimeout(
      () => fail("Couldn't read that video — try an MP4 or WebM."),
      VIDEO_TIMEOUT_MS
    );

    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    // Browsers differ on which of these fires first for a seekable frame, so
    // request the seek from either and let a flag keep it to one attempt.
    let seekRequested = false;
    const requestSeek = () => {
      if (seekRequested || settled) return;
      seekRequested = true;
      const at = Math.min(POSTER_SEEK_SECONDS, Math.max(0, (video.duration || 1) - 0.05));
      try {
        video.currentTime = at;
      } catch (e) {
        fail("Couldn't read that video — try an MP4 or WebM.");
      }
    };
    video.addEventListener('loadedmetadata', requestSeek);
    video.addEventListener('loadeddata', requestSeek);

    video.addEventListener('seeked', () => {
      if (settled) return;
      const w = video.videoWidth || 1280;
      const h = video.videoHeight || 720;
      const scale = fitScale(w, h);
      try {
        const { canvas } = drawToCanvas(video, w * scale, h * scale);
        settled = true;
        clearTimeout(timer);
        resolve({
          src: canvas.toDataURL('image/jpeg', JPEG_QUALITY),
          w,
          h,
          videoSrc: url,
        });
      } catch (e) {
        fail("Couldn't grab a frame from that video.");
      }
    });

    video.addEventListener('error', () => fail("That video couldn't be decoded."));
    video.src = url;
  });
}

// ── filesToMedia ───────────────────────────────────────────────────────────

async function fileToMedia(file) {
  const kind = kindOf(file);
  if (!kind) {
    throw friendly(`"${file.name || 'That file'}" isn't an image, GIF or video.`);
  }

  if (kind !== 'video' && file.size > MAX_IMAGE_BYTES) {
    const mb = (file.size / 1048576).toFixed(1);
    throw friendly(`"${file.name || 'That image'}" is ${mb} MB — please keep images under 10 MB.`);
  }

  if (kind === 'video') {
    // Only the poster is persisted; the clip itself stays an in-memory blob URL.
    const shot = await posterFromVideo(file);
    return { id: uid(), src: shot.src, alt: '', w: shot.w, h: shot.h, kind: 'video', videoSrc: shot.videoSrc };
  }

  const dataURL = await readAsDataURL(file);
  const img = await loadImage(dataURL);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;

  // GIFs are never re-encoded — a canvas round-trip would flatten the animation.
  const scaled = kind === 'gif' ? null : downscaleImage(img, file.type);

  return {
    id: uid(),
    src: scaled ? scaled.src : dataURL,
    alt: '',
    w: scaled ? scaled.w : w,
    h: scaled ? scaled.h : h,
    kind,
  };
}

/**
 * Convert a FileList (or array) into Media records, capped at MAX_MEDIA.
 * Without `onError`, the first unsupported/oversized file throws a friendly
 * Error. With `onError`, bad files are reported one by one and the good ones
 * are still returned — that's the mode the UI paths use.
 */
export async function filesToMedia(files, { onError } = {}) {
  const list = Array.from(files || []).slice(0, MAX_MEDIA);
  const out = [];
  for (const file of list) {
    try {
      out.push(await fileToMedia(file));
    } catch (err) {
      if (!onError) throw err;
      onError(err);
    }
  }
  return out;
}

// ── Grid geometry ──────────────────────────────────────────────────────────

/** 'x-media--1' .. 'x-media--4' (matches the canonical markup in CONTRACT.md). */
export function mediaGridClass(n) {
  const count = Math.min(MAX_MEDIA, Math.max(1, Number(n) || 1));
  return `x-media--${count}`;
}

// ── Object-URL lifecycle ───────────────────────────────────────────────────

/** Revoke blob URLs held by removed media. Safe to call with one item or many. */
export function releaseMedia(media) {
  const items = Array.isArray(media) ? media : [media];
  items.forEach((m) => {
    if (m && typeof m.videoSrc === 'string' && m.videoSrc.startsWith('blob:')) {
      URL.revokeObjectURL(m.videoSrc);
    }
  });
}

// ── initMedia: the three input paths ───────────────────────────────────────

function resolveEl(value, selector) {
  if (typeof value === 'function') value = value();
  if (value) return value;
  return typeof document === 'undefined' ? null : document.querySelector(selector);
}

export function initMedia(options = {}) {
  const opts = options || {};
  const dropZone = resolveEl(opts.dropZone || opts.getDropZone, '[data-dropzone]');
  const fileInput = resolveEl(opts.fileInput, '#in-media');
  const strip = resolveEl(opts.strip, '#media-strip');
  const getPost = typeof opts.getPost === 'function' ? opts.getPost : activePost;
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => update();
  const reportError = typeof opts.onError === 'function'
    ? opts.onError
    : (err) => console.warn('[media]', err && err.message ? err.message : err);

  // Remember the context so delegated strip handlers can find it later.
  if (strip) {
    const prev = stripCtx.get(strip) || {};
    stripCtx.set(strip, { ...prev, getPost, onChange, onError: reportError });
    bindStrip(strip);
  }

  // Shared funnel: capacity-check, convert, append, notify.
  async function addFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    const post = getPost();
    if (!post) return;
    post.media = post.media || [];

    const room = MAX_MEDIA - post.media.length;
    if (room <= 0) {
      reportError(friendly(`A post can hold at most ${MAX_MEDIA} images.`));
      return;
    }
    if (list.length > room) {
      reportError(friendly(`Only ${room} more attachment${room === 1 ? '' : 's'} fit — the rest were ignored.`));
    }

    const media = await filesToMedia(list.slice(0, room), { onError: reportError });
    if (!media.length) return;
    post.media.push(...media);
    onChange();
  }

  // 1. Hidden <input type="file">
  if (fileInput && !wired.has(fileInput)) {
    wired.add(fileInput);
    fileInput.addEventListener('change', (e) => {
      const files = e.target.files;
      addFiles(files).finally(() => {
        e.target.value = ''; // let the same file be picked twice in a row
      });
    });
  }

  // 2. Drag and drop on the composer. preventDefault on all four events so the
  //    browser doesn't navigate to the dropped file. A depth counter keeps the
  //    highlight stable while dragging over child elements.
  if (dropZone && !wired.has(dropZone)) {
    wired.add(dropZone);
    dragDepth.set(dropZone, 0);

    const hasFiles = (e) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

    dropZone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (!hasFiles(e)) return;
      dragDepth.set(dropZone, (dragDepth.get(dropZone) || 0) + 1);
      dropZone.classList.add('is-dragover');
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!hasFiles(e)) return;
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      dropZone.classList.add('is-dragover');
    });

    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      const depth = Math.max(0, (dragDepth.get(dropZone) || 0) - 1);
      dragDepth.set(dropZone, depth);
      if (depth === 0) dropZone.classList.remove('is-dragover');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth.set(dropZone, 0);
      dropZone.classList.remove('is-dragover');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) addFiles(files);
    });
  }

  // 3. Paste — the screenshot → Ctrl+V path. Listener lives on document, added
  //    once (document is held in the same WeakSet).
  if (typeof document !== 'undefined' && !wired.has(document)) {
    wired.add(document);
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const item of Array.from(items)) {
        if (item.kind !== 'file') continue;
        if (!/^(image|video)\//.test(item.type || '')) continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      if (!files.length) return;   // plain text paste: leave it alone
      e.preventDefault();
      addFiles(files);
    });
  }
}

// ── renderStrip + delegated chip behaviour ─────────────────────────────────

function escapeAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Paint the composer thumbnail strip. Cheap to call on every re-render. */
export function renderStrip(post, strip) {
  const el = resolveEl(strip, '#media-strip');
  if (!el) return;

  const ctx = stripCtx.get(el) || {};
  stripCtx.set(el, { ...ctx, post });
  bindStrip(el);

  const media = (post && post.media) || [];
  if (!media.length) {
    el.innerHTML = '';
    el.hidden = true;
    return;
  }
  el.hidden = false;

  el.innerHTML = media
    .map((m) => {
      const hasAlt = !!(m.alt && m.alt.trim());
      return (
        `<div class="media-chip${hasAlt ? ' has-alt' : ''}" data-id="${escapeAttr(m.id)}" ` +
        `data-kind="${escapeAttr(m.kind || 'image')}" draggable="true">` +
        `<img src="${escapeAttr(m.src)}" alt="">` +
        `<button type="button" class="media-chip__remove" title="Remove">×</button>` +
        `<button type="button" class="media-chip__alt" title="${hasAlt ? 'Edit alt text' : 'Add alt text'}">ALT</button>` +
        `</div>`
      );
    })
    .join('');
}

// Contract-compatibility alias: ensures the delegated alt/remove/reorder
// handlers are attached to `root` (renderStrip already does this).
export function attachAltEditors(root) {
  const el = resolveEl(root, '#media-strip');
  if (el) bindStrip(el);
}

// Look up the post the strip is currently showing, falling back to the
// getPost() supplied at init time.
function currentPost(strip) {
  const ctx = stripCtx.get(strip) || {};
  if (ctx.post) return ctx.post;
  if (typeof ctx.getPost === 'function') return ctx.getPost();
  return activePost();
}

function notify(strip) {
  const ctx = stripCtx.get(strip) || {};
  if (typeof ctx.onChange === 'function') ctx.onChange();
  else update();
}

// All chip interaction is delegated from the strip itself, so re-rendering the
// innerHTML never leaks or duplicates listeners.
function bindStrip(strip) {
  if (wired.has(strip)) return;
  wired.add(strip);

  let draggingId = null;

  // --- click: remove / alt -------------------------------------------------
  strip.addEventListener('click', (e) => {
    const chip = e.target.closest && e.target.closest('.media-chip');
    if (!chip || !strip.contains(chip)) return;
    const id = chip.dataset.id;
    const post = currentPost(strip);
    if (!post || !Array.isArray(post.media)) return;

    if (e.target.closest('.media-chip__remove')) {
      e.preventDefault();
      const idx = post.media.findIndex((m) => m.id === id);
      if (idx === -1) return;
      releaseMedia(post.media[idx]);       // revoke the video blob URL, if any
      post.media.splice(idx, 1);
      notify(strip);
      return;
    }

    if (e.target.closest('.media-chip__alt')) {
      e.preventDefault();
      openAltEditor(strip, chip, post, id);
    }
  });

  // --- drag to reorder -----------------------------------------------------
  strip.addEventListener('dragstart', (e) => {
    const chip = e.target.closest && e.target.closest('.media-chip');
    if (!chip) return;
    draggingId = chip.dataset.id;
    chip.classList.add('is-dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/x-media-id', draggingId); } catch (err) { /* IE-ish */ }
    }
  });

  strip.addEventListener('dragover', (e) => {
    if (!draggingId) return;             // external file drag: let the dropzone have it
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const chip = e.target.closest && e.target.closest('.media-chip');
    strip.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'));
    if (chip && chip.dataset.id !== draggingId) chip.classList.add('is-drop-target');
  });

  strip.addEventListener('drop', (e) => {
    if (!draggingId) return;             // file drop — bubbles up to the dropzone
    e.preventDefault();
    e.stopPropagation();
    const chip = e.target.closest && e.target.closest('.media-chip');
    const post = currentPost(strip);
    const from = post && post.media ? post.media.findIndex((m) => m.id === draggingId) : -1;
    const to = chip && post && post.media ? post.media.findIndex((m) => m.id === chip.dataset.id) : -1;
    draggingId = null;
    if (from === -1 || to === -1 || from === to) return;
    const [moved] = post.media.splice(from, 1);
    post.media.splice(to, 0, moved);
    notify(strip);
  });

  strip.addEventListener('dragend', () => {
    draggingId = null;
    strip.querySelectorAll('.is-dragging, .is-drop-target')
      .forEach((n) => n.classList.remove('is-dragging', 'is-drop-target'));
  });
}

// Inline alt-text overlay (not window.prompt, which blocks and looks nothing
// like X). Inline styles keep it usable regardless of what app.css does.
function openAltEditor(strip, chip, post, id) {
  strip.querySelectorAll('.media-alt-editor').forEach((n) => n.remove());

  const item = post.media.find((m) => m.id === id);
  if (!item) return;

  const wrap = document.createElement('div');
  wrap.className = 'media-alt-editor';
  wrap.style.cssText =
    'position:absolute;left:0;right:0;bottom:0;z-index:5;padding:4px;box-sizing:border-box;background:rgba(0,0,0,.72)';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'media-alt-editor__input';
  input.maxLength = MAX_ALT;
  input.placeholder = 'Describe this image…';
  input.value = item.alt || '';
  input.style.cssText =
    'width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:3px 6px;border-radius:4px;border:1px solid #536471;background:#000;color:#fff';

  wrap.appendChild(input);
  if (getComputedStyle(chip).position === 'static') chip.style.position = 'relative';
  chip.appendChild(wrap);
  input.focus();
  input.select();

  let cancelled = false;
  const close = () => { if (wrap.isConnected) wrap.remove(); };

  const commit = () => {
    if (cancelled) return;
    cancelled = true;                       // guard against blur firing after Enter
    const next = input.value.slice(0, MAX_ALT).trim();
    close();
    if (next === (item.alt || '')) return;
    item.alt = next;
    notify(strip);
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();                    // don't trip composer-level shortcuts
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelled = true;
      close();
    }
  });
  input.addEventListener('blur', commit);
  // Clicks inside the overlay must not re-trigger the chip's delegated handler.
  wrap.addEventListener('click', (e) => e.stopPropagation());
}
