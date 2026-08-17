// drafts.js — saved drafts for the X drafter.
// Zero dependencies, one localStorage key, no DOM work at module top level
// (so it imports cleanly under node for tests).
//
//   store = { version: 1, drafts: [ { id, name, savedAt, state } ] }   // newest first
//
// The realistic failure mode is quota: drafts embed base64 images, so every
// write is size-checked and try/caught, and the whole store is serialized
// before anything is written (never a half-written store).

export const DRAFTS_KEY = 'x-drafter:drafts:v1';

export const VERSION = 1;

/** Refuse payloads bigger than this rather than corrupting the store. */
export const MAX_BYTES = 4 * 1024 * 1024;

const QUOTA_MESSAGE = 'Storage full — delete an old draft or remove images';

/** Structured error the UI can show verbatim. */
export class DraftsError extends Error {
  constructor(message, code = 'ERROR', cause) {
    super(message);
    this.name = 'DraftsError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/* ------------------------------------------------------------------ utils */

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (e) {
    return null; // blocked by privacy settings
  }
}

export function uid() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (e) {
    /* fall through */
  }
  const rnd = () => Math.random().toString(16).slice(2, 10);
  return `${rnd()}-${rnd()}-${rnd()}-${rnd()}`;
}

function clone(value) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch (e) {
    /* DOM nodes / functions in state — fall back to JSON */
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return null;
  }
}

function byteLength(str) {
  try {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(str).length;
  } catch (e) {
    /* fall through */
  }
  return str.length * 2;
}

function isQuotaError(e) {
  if (!e) return false;
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    e.code === 1014 ||
    /quota/i.test(e.message || '')
  );
}

function isoNow() {
  return new Date().toISOString();
}

function validIso(value) {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/* ---------------------------------------------------------------- storage */

function normalizeDraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.state || typeof raw.state !== 'object') return null;
  if (!Array.isArray(raw.state.posts)) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Untitled draft',
    savedAt: validIso(raw.savedAt) || isoNow(),
    state: raw.state,
  };
}

function sortDrafts(drafts) {
  return drafts.slice().sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
}

function readStore() {
  const ls = storage();
  if (!ls) return { version: VERSION, drafts: [] };
  let raw = null;
  try {
    raw = ls.getItem(DRAFTS_KEY);
  } catch (e) {
    return { version: VERSION, drafts: [] };
  }
  if (!raw) return { version: VERSION, drafts: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { version: VERSION, drafts: [] }; // corrupt — start clean, don't throw
  }
  const list = parsed && Array.isArray(parsed.drafts) ? parsed.drafts : [];
  const drafts = list.map(normalizeDraft).filter(Boolean);
  return { version: VERSION, drafts: sortDrafts(drafts) };
}

// Serialize everything first, size-check, then write exactly once.
function writeStore(store) {
  const ls = storage();
  const payload = { version: VERSION, drafts: sortDrafts(store.drafts) };
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch (e) {
    throw new DraftsError('Could not save — this draft contains data that cannot be stored', 'SERIALIZE', e);
  }
  if (byteLength(serialized) > MAX_BYTES) {
    throw new DraftsError(QUOTA_MESSAGE, 'QUOTA');
  }
  if (!ls) {
    throw new DraftsError('Storage unavailable — drafts cannot be saved in this browser', 'NO_STORAGE');
  }
  try {
    ls.setItem(DRAFTS_KEY, serialized);
  } catch (e) {
    if (isQuotaError(e)) throw new DraftsError(QUOTA_MESSAGE, 'QUOTA', e);
    throw new DraftsError(`Could not save drafts: ${e && e.message ? e.message : e}`, 'WRITE', e);
  }
  return payload;
}

/* ------------------------------------------------------------------ names */

/** First ~40 chars of the first post, or "Untitled draft". */
export function suggestName(state) {
  const posts = state && Array.isArray(state.posts) ? state.posts : [];
  const first = posts.find((p) => p && typeof p.text === 'string' && p.text.trim());
  const text = first ? first.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) return 'Untitled draft';
  return text.length <= 40 ? text : `${text.slice(0, 40).trimEnd()}…`;
}

/** "Name", "Name (2)", "Name (3)" … against the names already in `taken`. */
function uniqueName(name, taken) {
  const base = (name || '').trim() || 'Untitled draft';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${base} (${n})`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

function namesExcept(drafts, id) {
  return drafts.filter((d) => d.id !== id).map((d) => d.name);
}

/* -------------------------------------------------------------------- API */

export function listDrafts() {
  return readStore().drafts;
}

/**
 * Create a draft, or overwrite the one with `id` when given.
 * Throws DraftsError (code 'QUOTA') when the store would not fit.
 */
export function saveDraft(name, state, id) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.posts)) {
    throw new DraftsError('Nothing to save — the draft has no posts', 'INVALID_STATE');
  }
  const store = readStore();
  const snapshot = clone(state);
  if (!snapshot) throw new DraftsError('Could not copy the current draft', 'SERIALIZE');

  const existing = id ? store.drafts.find((d) => d.id === id) : null;
  const wanted = typeof name === 'string' && name.trim() ? name.trim() : null;

  let record;
  if (existing) {
    record = {
      id: existing.id,
      name: wanted || existing.name,
      savedAt: isoNow(),
      state: snapshot,
    };
    store.drafts = store.drafts.map((d) => (d.id === existing.id ? record : d));
  } else {
    record = {
      id: id && typeof id === 'string' ? id : uid(),
      name: uniqueName(wanted || suggestName(state), namesExcept(store.drafts, null)),
      savedAt: isoNow(),
      state: snapshot,
    };
    store.drafts = store.drafts.concat([record]);
  }
  writeStore(store);
  return clone(record);
}

export function loadDraft(id) {
  const found = readStore().drafts.find((d) => d.id === id);
  return found ? clone(found) : null;
}

export function deleteDraft(id) {
  const store = readStore();
  const next = store.drafts.filter((d) => d.id !== id);
  if (next.length === store.drafts.length) return false;
  store.drafts = next;
  writeStore(store);
  return true;
}

export function renameDraft(id, name) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) return false;
  const store = readStore();
  const found = store.drafts.find((d) => d.id === id);
  if (!found) return false;
  found.name = uniqueName(clean, namesExcept(store.drafts, id));
  writeStore(store);
  return true;
}

export function duplicateDraft(id) {
  const store = readStore();
  const found = store.drafts.find((d) => d.id === id);
  if (!found) return null;
  const copy = {
    id: uid(),
    name: uniqueName(found.name, store.drafts.map((d) => d.name)),
    savedAt: isoNow(),
    state: clone(found.state),
  };
  store.drafts = store.drafts.concat([copy]);
  writeStore(store);
  return clone(copy);
}

/** Pretty JSON of all drafts, or only `ids` when given. */
export function exportDrafts(ids) {
  const all = readStore().drafts;
  const drafts = Array.isArray(ids) && ids.length
    ? all.filter((d) => ids.indexOf(d.id) !== -1)
    : all;
  return JSON.stringify({ version: VERSION, drafts }, null, 2);
}

/** Never throws. Bad entries are skipped and explained in `errors`. */
export function importDrafts(json) {
  const result = { added: 0, skipped: 0, errors: [] };

  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (e) {
    result.errors.push(`Not valid JSON: ${e && e.message ? e.message : e}`);
    return result;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    result.errors.push('File does not look like a drafts export (expected an object).');
    return result;
  }
  if (data.version !== VERSION) {
    result.errors.push(`Unsupported file version: ${JSON.stringify(data.version)} (expected ${VERSION}).`);
    return result;
  }
  if (!Array.isArray(data.drafts)) {
    result.errors.push('File has no "drafts" array.');
    return result;
  }

  const store = readStore();
  const taken = store.drafts.map((d) => d.name);
  const incoming = [];

  data.drafts.forEach((entry, i) => {
    const label = `Draft ${i + 1}`;
    if (!entry || typeof entry !== 'object') {
      result.skipped += 1;
      result.errors.push(`${label}: not an object.`);
      return;
    }
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      result.skipped += 1;
      result.errors.push(`${label}: missing a name.`);
      return;
    }
    if (!entry.state || typeof entry.state !== 'object' || Array.isArray(entry.state)) {
      result.skipped += 1;
      result.errors.push(`${label} ("${entry.name}"): missing state.`);
      return;
    }
    if (!Array.isArray(entry.state.posts)) {
      result.skipped += 1;
      result.errors.push(`${label} ("${entry.name}"): state.posts is not an array.`);
      return;
    }
    const state = clone(entry.state);
    if (!state) {
      result.skipped += 1;
      result.errors.push(`${label} ("${entry.name}"): state could not be copied.`);
      return;
    }
    const name = uniqueName(entry.name.trim(), taken);
    taken.push(name);
    incoming.push({
      id: uid(), // always fresh, so imports never clobber existing drafts
      name,
      savedAt: validIso(entry.savedAt) || isoNow(),
      state,
    });
  });

  if (!incoming.length) return result;

  store.drafts = store.drafts.concat(incoming);
  try {
    writeStore(store);
  } catch (e) {
    result.errors.push(e && e.message ? e.message : String(e));
    return result; // added stays 0 — nothing was written
  }
  result.added = incoming.length;
  return result;
}

/* --------------------------------------------------------------- relative */

export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min === 1) return '1 min ago';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr === 1 ? '1 hr ago' : `${hr} hr ago`;

  const then = new Date(t);
  const today = new Date(now);
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()) -
      new Date(then.getFullYear(), then.getMonth(), then.getDate())) / 86400000,
  );
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  try {
    return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch (e) {
    return then.toISOString().slice(0, 10);
  }
}

/* ------------------------------------------------------------------- UI */

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function hhmm() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function initDraftsUI({ getState, setState, onChange } = {}) {
  if (typeof document === 'undefined') return;

  const $ = (id) => document.getElementById(id);
  const sel = $('draft-select');
  const statusEl = $('draft-status');
  const btnSave = $('btn-draft-save');
  const btnSaveAs = $('btn-draft-saveas');
  const btnRename = $('btn-draft-rename');
  const btnDelete = $('btn-draft-delete');
  const btnExport = $('btn-draft-export');
  const btnImport = $('btn-draft-import');
  const fileInput = $('in-draft-import');

  if (!sel) return; // drafts bar not on this page

  const change = typeof onChange === 'function' ? onChange : () => {};
  const readState = typeof getState === 'function' ? getState : () => null;
  const writeState = typeof setState === 'function' ? setState : () => {};

  let currentId = null;
  let statusTimer = null;

  function status(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', !!isError);
    if (statusTimer) clearTimeout(statusTimer);
    if (msg) {
      statusTimer = setTimeout(() => {
        statusTimer = null;
        statusEl.textContent = '';
        statusEl.classList.remove('is-error');
      }, 4000);
    }
  }

  function fail(e) {
    status(e && e.message ? e.message : 'Something went wrong', true);
  }

  function refreshSelect() {
    const drafts = listDrafts();
    if (currentId && !drafts.some((d) => d.id === currentId)) currentId = null;
    sel.textContent = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = drafts.length ? `Saved drafts (${drafts.length})` : 'No saved drafts';
    sel.appendChild(placeholder);

    drafts.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.name} — ${relativeTime(d.savedAt)}`;
      sel.appendChild(opt);
    });

    sel.value = currentId || '';
    const none = !currentId;
    [btnRename, btnDelete].forEach((b) => {
      if (b) b.disabled = none;
    });
    if (btnExport) btnExport.disabled = !drafts.length;
  }

  function currentName() {
    const d = currentId ? loadDraft(currentId) : null;
    return d ? d.name : null;
  }

  sel.addEventListener('change', () => {
    const id = sel.value;
    if (!id) {
      currentId = null;
      refreshSelect();
      return;
    }
    const draft = loadDraft(id);
    if (!draft) {
      status('That draft no longer exists', true);
      refreshSelect();
      return;
    }
    currentId = draft.id;
    writeState(draft.state);
    change();
    refreshSelect();
    status(`Loaded “${draft.name}”`);
  });

  if (btnSave) {
    btnSave.addEventListener('click', () => {
      try {
        const rec = saveDraft(currentName(), readState(), currentId || undefined);
        currentId = rec.id;
        refreshSelect();
        status(`Saved ${hhmm()}`);
      } catch (e) {
        fail(e);
      }
    });
  }

  if (btnSaveAs) {
    btnSaveAs.addEventListener('click', () => {
      const state = readState();
      const suggested = suggestName(state);
      const name = typeof prompt === 'function' ? prompt('Name this draft', suggested) : suggested;
      if (name === null) return;
      try {
        const rec = saveDraft(name, state);
        currentId = rec.id;
        refreshSelect();
        status(`Saved “${rec.name}” ${hhmm()}`);
      } catch (e) {
        fail(e);
      }
    });
  }

  if (btnRename) {
    btnRename.addEventListener('click', () => {
      if (!currentId) {
        status('Select a draft first', true);
        return;
      }
      const old = currentName() || '';
      const name = typeof prompt === 'function' ? prompt('Rename draft', old) : null;
      if (name === null) return;
      try {
        if (renameDraft(currentId, name)) {
          refreshSelect();
          status('Renamed');
        } else {
          status('Name cannot be empty', true);
        }
      } catch (e) {
        fail(e);
      }
    });
  }

  if (btnDelete) {
    btnDelete.addEventListener('click', () => {
      if (!currentId) {
        status('Select a draft first', true);
        return;
      }
      const name = currentName() || 'this draft';
      const ok = typeof confirm === 'function' ? confirm(`Delete “${name}”? This cannot be undone.`) : false;
      if (!ok) return;
      try {
        if (deleteDraft(currentId)) {
          currentId = null;
          refreshSelect();
          status(`Deleted “${name}”`);
        } else {
          status('Draft not found', true);
        }
      } catch (e) {
        fail(e);
      }
    });
  }

  if (btnExport) {
    btnExport.addEventListener('click', () => {
      const drafts = listDrafts();
      if (!drafts.length) {
        status('Nothing to export', true);
        return;
      }
      let url = null;
      try {
        const blob = new Blob([exportDrafts()], { type: 'application/json' });
        url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `x-drafter-drafts-${todayStamp()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        status(`Exported ${drafts.length} draft${drafts.length === 1 ? '' : 's'}`);
      } catch (e) {
        fail(e);
      } finally {
        if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    });
  }

  if (btnImport && fileInput) {
    btnImport.addEventListener('click', () => {
      fileInput.value = '';
      fileInput.click();
    });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      let text = '';
      try {
        text = typeof file.text === 'function'
          ? await file.text()
          : await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.onerror = () => rej(fr.error);
            fr.readAsText(file);
          });
      } catch (e) {
        status('Could not read that file', true);
        return;
      }
      const res = importDrafts(text);
      refreshSelect();
      if (!res.added) {
        status(res.errors[0] || 'Nothing imported', true);
      } else {
        const extra = res.skipped ? `, ${res.skipped} skipped` : '';
        status(`Imported ${res.added} draft${res.added === 1 ? '' : 's'}${extra}`, !!res.skipped);
      }
      if (res.errors.length) console.warn('[drafts] import issues:', res.errors);
    });
  }

  refreshSelect();
}
