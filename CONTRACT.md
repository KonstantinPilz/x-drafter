# x-drafter — module contract (read before editing any file)

Static site, **no build step, no npm, no framework**. Plain ES modules loaded by
`docs/index.html` with `<script type="module" src="./js/app.js">`. Must work when
served from `https://konstantinpilz.github.io/x-drafter/` and from `file://`-ish
local `python3 -m http.server`.

Vanilla JS only. No CDN dependencies at runtime except the optional link-preview
CORS proxies. Any third-party lib must be vendored into `docs/vendor/`.

## Files and owners (do NOT edit a file you don't own)

| File | Purpose |
|---|---|
| `docs/index.html` | Shell markup + element ids (owner: integrator) |
| `docs/js/state.js` | Single source of truth, persistence, pub/sub (owner: integrator) |
| `docs/js/text.js` | Weighted char count, entity parsing, thread auto-split |
| `docs/js/icons.js` | Inline SVG strings for X icons |
| `docs/js/render.js` | Renders the preview post card(s) |
| `docs/js/media.js` | Image/GIF/video attach, alt text, drag-drop-paste, grid geometry |
| `docs/js/card.js` | Link-preview (Open Graph) fetch + manual override |
| `docs/js/export.js` | PNG/copy-to-clipboard export of the preview |
| `docs/js/app.js` | Wiring, composer UI, toolbar (owner: integrator) |
| `docs/css/x.css` | X post-card design system, 3 themes |
| `docs/css/app.css` | App chrome around the preview (composer, toolbar) |

## State shape (`state.js`)

```js
{
  author: { name, handle, avatar, verified: 'none'|'blue'|'gold'|'grey', affiliation },
  theme: 'light' | 'dim' | 'lightsout',
  showMetrics: boolean,
  timeLabel: string,              // e.g. "2h" or "Aug 17"
  activeId: string,               // id of post being edited
  posts: [ Post ]                 // >1 post = thread
}

Post = {
  id: string,
  text: string,
  media: [ { id, src, alt, w, h, kind: 'image'|'gif'|'video' } ],   // max 4
  card: null | { url, title, description, image, domain, loading },
  poll: null | { options: [string], days, hours, minutes },
  quote: null | { name, handle, avatar, verified, text, time, image }
}
```

## `state.js` API (already written — import, don't rewrite)

```js
import { state, subscribe, update, activePost, newPost, save, load, uid } from './state.js';
update(s => { s.theme = 'dim'; });   // mutate, then all subscribers re-run
subscribe(fn);                        // fn(state) on every update; called once immediately
```

## Required exports per module

```js
// text.js
export function weightedLength(text): number          // X rules: URLs=23, CJK/emoji=2, else 1
export function remaining(text): number               // 280 - weightedLength
export function parseEntities(text): Array<{type:'text'|'mention'|'hashtag'|'cashtag'|'url', value, display, href}>
export function renderTextHTML(text): string          // escaped HTML with <span class="x-link"> entities
export function extractFirstUrl(text): string|null
export function splitThread(text, opts): string[]     // sentence-aware split into <=280w chunks, optional "1/n"
export const MAX_WEIGHTED = 280

// icons.js
export const icons = { reply, repost, like, views, bookmark, share, verifiedBlue, verifiedGold, verifiedGrey, more, globe, image, gif, poll, emoji, schedule, location, plus, close, alt }
// each value is an SVG string sized 1.25em, currentColor fill, viewBox "0 0 24 24"

// render.js
export function renderPreview(state, root): void      // root = #preview-thread element; full re-render is fine
export function postCardHTML(post, state, opts): string

// media.js
export function initMedia({ getDropZone, onChange }): void
export async function filesToMedia(FileList): Promise<Media[]>
export function mediaGridClass(n): string             // 'x-media-1' .. 'x-media-4'
export function attachAltEditors(root): void

// card.js
export async function fetchCard(url): Promise<Card>   // tries CORS proxies, falls back to {domain} skeleton
export function initCardUI(): void                    // manual title/desc/image override fields

// export.js
export async function exportPNG(node, filename): Promise<void>
export async function copyPNG(node): Promise<boolean>
export function exportThreadText(state): string
```

## Design constraints

- Match X's current (2026) web design as closely as possible: Chirp-ish font stack,
  15px/20px post text, 3px-radius avatars? no — avatars are circles, 20px gutters,
  16px-radius media, action-bar icon row with hover pills.
- Three themes exactly as X ships them: Light (`#fff`), Dim (`#15202b`), Lights out (`#000`).
- Accent blue `#1d9bf0`. All colors go through CSS custom properties defined in `x.css`
  under `[data-theme="light|dim|lightsout"]` so the whole app re-themes at once.
- Preview card must be pixel-plausible screenshotted at 598px content width (X's timeline width).

## CANONICAL POST MARKUP (render.js emits it, x.css styles it — both must match exactly)

```html
<article class="x-post" data-connector="none|top|bottom|both">
  <div class="x-post__gutter">
    <div class="x-line x-line--top"></div>
    <img class="x-avatar" src="..." alt="">
    <div class="x-line x-line--bottom"></div>
  </div>
  <div class="x-post__body">
    <div class="x-post__head">
      <span class="x-name">Name</span>
      <span class="x-badge x-badge--blue"><!-- svg --></span>
      <span class="x-handle">@handle</span>
      <span class="x-dot">·</span>
      <span class="x-time">2h</span>
      <button class="x-more"><!-- svg --></button>
    </div>

    <div class="x-text">Text with <span class="x-link">@mentions</span> …</div>

    <div class="x-media x-media--2">          <!-- --1 .. --4 -->
      <figure class="x-media__item"><img src="..." alt=""><span class="x-alt">ALT</span></figure>
    </div>

    <a class="x-card x-card--large" href="#">  <!-- or x-card--small -->
      <div class="x-card__img"><img src="..." alt=""></div>
      <div class="x-card__meta">
        <span class="x-card__domain">example.com</span>
        <span class="x-card__title">Title</span>
        <span class="x-card__desc">Description</span>
      </div>
    </a>

    <div class="x-poll">
      <div class="x-poll__opt"><span class="x-poll__label">Option</span></div>
      <div class="x-poll__foot">4 votes · 1 day left</div>
    </div>

    <blockquote class="x-quote">
      <div class="x-quote__head">
        <img class="x-quote__avatar" src=""><span class="x-name">Name</span>
        <span class="x-handle">@h</span><span class="x-dot">·</span><span class="x-time">Aug 14</span>
      </div>
      <div class="x-quote__text">…</div>
      <div class="x-quote__media"><img src=""></div>
    </blockquote>

    <div class="x-actions">
      <button class="x-action x-action--reply"><span class="x-action__icon"><!--svg--></span><span class="x-action__count">12</span></button>
      <button class="x-action x-action--repost">…</button>
      <button class="x-action x-action--like">…</button>
      <button class="x-action x-action--views">…</button>
      <div class="x-actions__end">
        <button class="x-action x-action--bookmark">…</button>
        <button class="x-action x-action--share">…</button>
      </div>
    </div>
  </div>
</article>
```

Empty sections are simply omitted from the output (no empty divs).

