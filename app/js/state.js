// Single source of truth for the drafter. Mutate through update(), read via state.
const KEY = 'x-drafter:v1';

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function newPost() {
  return { id: uid(), text: '', media: [], card: null, poll: null, quote: null };
}

const defaults = () => ({
  author: {
    name: 'Your Name',
    handle: 'yourhandle',
    avatar: '',
    verified: 'blue',
    affiliation: '',
  },
  theme: 'dim',
  showMetrics: true,
  timeLabel: '2h',
  metrics: { replies: 12, reposts: 48, likes: 316, views: '24.1K', bookmarks: 9 },
  activeId: null,
  posts: [newPost()],
});

export const state = defaults();

const subs = new Set();

export function subscribe(fn) {
  subs.add(fn);
  fn(state);
  return () => subs.delete(fn);
}

let frame = null;
export function update(mutator) {
  if (typeof mutator === 'function') mutator(state);
  save();
  if (frame) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    frame = null;
    subs.forEach((fn) => fn(state));
  });
}

export function activePost() {
  return state.posts.find((p) => p.id === state.activeId) || state.posts[0];
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    /* quota — drafts with big images just won't persist */
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    Object.assign(state, defaults(), saved);
    if (!Array.isArray(state.posts) || !state.posts.length) state.posts = [newPost()];
    state.posts.forEach((p) => {
      p.media = p.media || [];
      if (!p.id) p.id = uid();
    });
  } catch (e) {
    /* corrupt draft — fall back to defaults */
  }
  if (!state.activeId || !state.posts.some((p) => p.id === state.activeId)) {
    state.activeId = state.posts[0].id;
  }
}

export function reset() {
  Object.assign(state, defaults());
  state.activeId = state.posts[0].id;
  update();
}
