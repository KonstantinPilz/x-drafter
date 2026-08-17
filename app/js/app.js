// x-drafter — wiring. Owns the composer UI; every other concern lives in its own module.
import { state, subscribe, update, activePost, newPost, load, reset, uid } from './state.js';
import { renderPreview } from './render.js';
import * as T from './text.js';
import * as M from './media.js';
import * as C from './card.js';
import * as E from './export.js';
import * as D from './drafts.js';
import { icons } from './icons.js';

const $ = (sel) => document.querySelector(sel);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

// A module that failed to load shouldn't take the whole app down with it.
function guard(label, fn) {
  try { return fn(); } catch (err) { console.error(`[x-drafter] ${label}:`, err); }
}

load();
if (!state.activeId) state.activeId = state.posts[0].id;

/* ── theme ─────────────────────────────────────────────────────────── */

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const root = $('#preview-root');
  if (root) root.dataset.theme = state.theme;
  document.querySelectorAll('#theme-switch button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.themeValue === state.theme));
  });
}
document.querySelectorAll('#theme-switch button').forEach((b) => {
  on(b, 'click', () => update((s) => { s.theme = b.dataset.themeValue; }));
});

/* ── profile fields ────────────────────────────────────────────────── */

const profileBindings = [
  ['#in-name', (s, v) => { s.author.name = v; }, (s) => s.author.name],
  ['#in-handle', (s, v) => { s.author.handle = v.replace(/^@/, ''); }, (s) => s.author.handle],
  ['#in-verified', (s, v) => { s.author.verified = v; }, (s) => s.author.verified],
  ['#in-time', (s, v) => { s.timeLabel = v; }, (s) => s.timeLabel],
  ['#in-m-replies', (s, v) => { s.metrics.replies = v; }, (s) => s.metrics.replies],
  ['#in-m-reposts', (s, v) => { s.metrics.reposts = v; }, (s) => s.metrics.reposts],
  ['#in-m-likes', (s, v) => { s.metrics.likes = v; }, (s) => s.metrics.likes],
  ['#in-m-views', (s, v) => { s.metrics.views = v; }, (s) => s.metrics.views],
];
profileBindings.forEach(([sel, set]) => {
  on($(sel), 'input', (e) => update((s) => set(s, e.target.value)));
  on($(sel), 'change', (e) => update((s) => set(s, e.target.value)));
});
on($('#in-metrics'), 'change', (e) => update((s) => { s.showMetrics = e.target.checked; }));

function readImage(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}
on($('#in-avatar'), 'change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) { const src = await readImage(f); update((s) => { s.author.avatar = src; }); }
});

/* ── editor + thread ───────────────────────────────────────────────── */

const editor = $('#editor');

on(editor, 'input', () => {
  update((s) => { const p = activePost(); if (p) p.text = editor.value; });
  scheduleAutoCard();
});

function switchTo(id) {
  update((s) => { s.activeId = id; });
  editor.value = (activePost() || {}).text || '';
  editor.focus();
}

on($('#btn-add-post'), 'click', () => {
  const p = newPost();
  update((s) => {
    const i = s.posts.findIndex((x) => x.id === s.activeId);
    s.posts.splice(i + 1, 0, p);
    s.activeId = p.id;
  });
  editor.value = '';
  editor.focus();
});

on($('#btn-del-post'), 'click', () => {
  if (state.posts.length === 1) { update((s) => { s.posts[0] = newPost(); s.activeId = s.posts[0].id; }); }
  else {
    update((s) => {
      const i = s.posts.findIndex((x) => x.id === s.activeId);
      s.posts.splice(i, 1);
      s.activeId = s.posts[Math.max(0, i - 1)].id;
    });
  }
  editor.value = (activePost() || {}).text || '';
});

on($('#btn-autosplit'), 'click', () => {
  const text = state.posts.map((p) => p.text).join('\n\n').trim();
  if (!text) return;
  const chunks = guard('splitThread', () => T.splitThread(text, { numbered: false })) || [text];
  update((s) => {
    const first = s.posts[0];
    s.posts = chunks.map((t, i) => {
      const p = i === 0 ? first : newPost();
      p.text = t;
      if (i > 0) { p.media = []; p.card = null; p.poll = null; p.quote = null; }
      return p;
    });
    s.activeId = s.posts[0].id;
  });
  editor.value = state.posts[0].text;
});

on($('#btn-number'), 'click', () => {
  const n = state.posts.length;
  update((s) => {
    s.posts.forEach((p, i) => {
      p.text = `${p.text.replace(/\s*\d+\/\d+\s*$/, '').trimEnd()} ${i + 1}/${n}`.trim();
    });
  });
  editor.value = (activePost() || {}).text || '';
});

function renderThreadTabs() {
  const bar = $('#thread-tabs');
  if (!bar) return;
  bar.innerHTML = state.posts.map((p, i) => {
    const over = (guard('remaining', () => T.remaining(p.text)) ?? 280) < 0;
    return `<button type="button" class="thread-tab${p.id === state.activeId ? ' is-active' : ''}${over ? ' is-over' : ''}" data-id="${p.id}">${i + 1}</button>`;
  }).join('');
}
on($('#thread-tabs'), 'click', (e) => {
  const btn = e.target.closest('.thread-tab');
  if (btn) switchTo(btn.dataset.id);
});

/* ── character counter ─────────────────────────────────────────────── */

const CIRC = 2 * Math.PI * 10;
function renderCounter() {
  const p = activePost();
  const used = guard('weightedLength', () => T.weightedLength(p ? p.text : '')) ?? 0;
  const left = (T.MAX_WEIGHTED || 280) - used;
  const counter = $('#counter');
  const ring = $('.ring');
  const fg = $('#ring-fg');
  if (counter) {
    counter.textContent = left <= 20 ? String(left) : '';
    counter.classList.toggle('is-warning', left <= 20 && left >= 0);
    counter.classList.toggle('is-over', left < 0);
  }
  if (fg) {
    const frac = Math.min(1, used / (T.MAX_WEIGHTED || 280));
    fg.style.strokeDasharray = `${(frac * CIRC).toFixed(2)} ${CIRC.toFixed(2)}`;
  }
  if (ring) {
    ring.classList.toggle('is-warning', left <= 20 && left >= 0);
    ring.classList.toggle('is-over', left < 0);
  }
}

/* ── tool buttons ──────────────────────────────────────────────────── */

function paintToolIcons() {
  const map = { '#btn-add-media': 'image', '#btn-add-poll': 'poll', '#btn-add-quote': 'emoji', '#btn-add-card': 'globe' };
  Object.entries(map).forEach(([sel, name]) => {
    const el = $(sel);
    if (el && icons && icons[name] && !el.querySelector('svg')) el.insertAdjacentHTML('afterbegin', icons[name]);
  });
}

on($('#btn-add-media'), 'click', () => $('#in-media') && $('#in-media').click());
on($('#btn-add-poll'), 'click', () => {
  update((s) => { const p = activePost(); if (p && !p.poll) p.poll = { options: ['', ''], days: 1, hours: 0, minutes: 0 }; });
  const panel = $('#panel-poll'); if (panel) panel.open = true;
  renderPollOptions();
});
on($('#btn-add-quote'), 'click', () => {
  update((s) => {
    const p = activePost();
    if (p && !p.quote) p.quote = { name: 'Quoted User', handle: 'quoted', avatar: '', verified: false, text: '', time: 'Aug 14', image: '' };
  });
  const panel = $('#panel-quote'); if (panel) panel.open = true;
  syncQuoteInputs();
});
on($('#btn-add-card'), 'click', () => {
  const panel = $('#panel-card'); if (panel) panel.open = true;
  const url = guard('extractFirstUrl', () => T.extractFirstUrl((activePost() || {}).text || ''));
  if (url && $('#in-card-url') && !$('#in-card-url').value) $('#in-card-url').value = url;
  const fetchBtn = $('#btn-fetch-card'); if (fetchBtn) fetchBtn.click();
});

/* Auto-detect a URL in the text and fetch its card once, unobtrusively. */
let cardTimer = null;
let lastAutoUrl = '';
function scheduleAutoCard() {
  clearTimeout(cardTimer);
  cardTimer = setTimeout(async () => {
    const p = activePost();
    if (!p || p.card || p.media.length || p.quote) return;
    const url = guard('extractFirstUrl', () => T.extractFirstUrl(p.text || ''));
    if (!url || url === lastAutoUrl) return;
    lastAutoUrl = url;
    const status = $('#card-status');
    if (status) status.textContent = 'Fetching link preview…';
    const card = await guard('fetchCard', () => C.fetchCard(url));
    if (card) {
      update((s) => { const cur = activePost(); if (cur && !cur.card) cur.card = card; });
      syncCardInputs();
      if (status) status.textContent = card.title ? `Loaded from ${card.domain}` : `Couldn't fetch ${card.domain} — fill in manually`;
    }
  }, 900);
}

/* ── poll UI ───────────────────────────────────────────────────────── */

function renderPollOptions() {
  const wrap = $('#poll-options');
  const p = activePost();
  if (!wrap) return;
  if (!p || !p.poll) { wrap.innerHTML = '<p class="hint">No poll on this post.</p>'; return; }
  wrap.innerHTML = p.poll.options.map((o, i) => `
    <div class="poll-option-row">
      <input type="text" data-i="${i}" value="${String(o).replace(/"/g, '&quot;')}" placeholder="Choice ${i + 1}" maxlength="25">
      <button type="button" class="btn btn--round btn--danger" data-remove="${i}">−</button>
    </div>`).join('');
}
on($('#poll-options'), 'input', (e) => {
  const i = e.target.dataset.i;
  if (i === undefined) return;
  update((s) => { const p = activePost(); if (p && p.poll) p.poll.options[+i] = e.target.value; });
});
on($('#poll-options'), 'click', (e) => {
  const i = e.target.dataset.remove;
  if (i === undefined) return;
  update((s) => { const p = activePost(); if (p && p.poll) p.poll.options.splice(+i, 1); });
  renderPollOptions();
});
on($('#btn-poll-add'), 'click', () => {
  update((s) => { const p = activePost(); if (p && p.poll && p.poll.options.length < 4) p.poll.options.push(''); });
  renderPollOptions();
});
on($('#btn-clear-poll'), 'click', () => {
  update((s) => { const p = activePost(); if (p) p.poll = null; });
  renderPollOptions();
});

/* ── quote UI ──────────────────────────────────────────────────────── */

const quoteFields = [
  ['#in-q-name', 'name'], ['#in-q-handle', 'handle'], ['#in-q-text', 'text'], ['#in-q-time', 'time'],
];
quoteFields.forEach(([sel, key]) => on($(sel), 'input', (e) => {
  update((s) => { const p = activePost(); if (p && p.quote) p.quote[key] = e.target.value; });
}));
on($('#in-q-verified'), 'change', (e) => update((s) => { const p = activePost(); if (p && p.quote) p.quote.verified = e.target.checked; }));
[['#in-q-avatar', 'avatar'], ['#in-q-image', 'image']].forEach(([sel, key]) => {
  on($(sel), 'change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const src = await readImage(f);
    update((s) => { const p = activePost(); if (p && p.quote) p.quote[key] = src; });
  });
});
on($('#btn-clear-quote'), 'click', () => update((s) => { const p = activePost(); if (p) p.quote = null; }));

function syncQuoteInputs() {
  const q = (activePost() || {}).quote;
  if (!q) return;
  quoteFields.forEach(([sel, key]) => { const el = $(sel); if (el && document.activeElement !== el) el.value = q[key] || ''; });
  if ($('#in-q-verified')) $('#in-q-verified').checked = !!q.verified;
}
function syncCardInputs() {
  const c = (activePost() || {}).card;
  const set = (sel, v) => { const el = $(sel); if (el && document.activeElement !== el) el.value = v || ''; };
  set('#in-card-url', c && c.url);
  set('#in-card-title', c && c.title);
  set('#in-card-desc', c && c.description);
  set('#in-card-image', c && c.image && c.image.startsWith('data:') ? '' : c && c.image);
  set('#in-card-domain', c && c.domain);
}

/* ── export ────────────────────────────────────────────────────────── */

const previewNode = () => $('#preview-root');

on($('#btn-copy-text'), 'click', async () => {
  const text = guard('exportThreadText', () => E.exportThreadText(state)) ?? state.posts.map((p) => p.text).join('\n\n---\n\n');
  try { await navigator.clipboard.writeText(text); flash($('#btn-copy-text'), 'Copied'); }
  catch { flash($('#btn-copy-text'), 'Copy failed'); }
});
on($('#btn-copy-png'), 'click', async () => {
  const ok = await guard('copyPNG', () => E.copyPNG(previewNode()));
  flash($('#btn-copy-png'), ok ? 'Copied' : 'Not supported');
});
on($('#btn-export-png'), 'click', async () => {
  await guard('exportPNG', () => E.exportPNG(previewNode()));
});
on($('#btn-reset'), 'click', () => {
  if (!confirm('Clear the current draft? Saved drafts are kept.')) return;
  reset();
  editor.value = '';
});

function flash(btn, msg) {
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = old; }, 1400);
}

/* ── keyboard shortcuts ────────────────────────────────────────────── */

document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key === 's') { e.preventDefault(); const b = $('#btn-draft-save'); if (b) b.click(); }
  if (meta && e.key === 'Enter') { e.preventDefault(); const b = $('#btn-add-post'); if (b) b.click(); }
});

/* ── module init ───────────────────────────────────────────────────── */

const onChange = () => update();

guard('initMedia', () => M.initMedia({
  dropZone: $('[data-dropzone]'),
  fileInput: $('#in-media'),
  strip: $('#media-strip'),
  getPost: activePost,
  onChange,
}));

guard('initCardUI', () => C.initCardUI({ getPost: activePost, onChange }));

guard('initDraftsUI', () => D.initDraftsUI({
  getState: () => state,
  setState: (next) => {
    update((s) => {
      Object.keys(next).forEach((k) => { s[k] = next[k]; });
      if (!s.posts || !s.posts.length) s.posts = [newPost()];
      if (!s.posts.some((p) => p.id === s.activeId)) s.activeId = s.posts[0].id;
    });
    editor.value = (activePost() || {}).text || '';
    syncInputs();
    renderPollOptions();
  },
  onChange,
}));

/* ── render loop ───────────────────────────────────────────────────── */

function syncInputs() {
  const set = (sel, v) => { const el = $(sel); if (el && document.activeElement !== el) el.value = v ?? ''; };
  set('#in-name', state.author.name);
  set('#in-handle', state.author.handle);
  set('#in-verified', state.author.verified);
  set('#in-time', state.timeLabel);
  set('#in-m-replies', state.metrics.replies);
  set('#in-m-reposts', state.metrics.reposts);
  set('#in-m-likes', state.metrics.likes);
  set('#in-m-views', state.metrics.views);
  if ($('#in-metrics')) $('#in-metrics').checked = !!state.showMetrics;
  syncCardInputs();
  syncQuoteInputs();
}

subscribe((s) => {
  applyTheme();
  renderThreadTabs();
  renderCounter();
  guard('renderPreview', () => renderPreview(s, $('#preview-thread')));
  guard('renderStrip', () => M.renderStrip(activePost(), $('#media-strip')));
});

editor.value = (activePost() || {}).text || '';
syncInputs();
paintToolIcons();
renderPollOptions();
update();

// Expose a little surface for debugging and for the headless smoke test.
window.xDrafter = { state, update, T, D, E, activePost };
