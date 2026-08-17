# X Drafter

Draft X posts and threads against a live preview that matches X's current web design. Type on the left, see the real thing on the right, then copy the text or export the card as a PNG.

**Live:** https://konstantinpilz.github.io/x-drafter/ (password-protected — see below)

Everything runs in the browser. There is no server and no account: drafts live in your own `localStorage`, images never leave your machine.

## What it does

- **Live preview** in all three X themes — Light, Dim, Lights out — at X's real timeline width (598 px).
- **Images**: drag-and-drop, file picker, or paste a screenshot straight in. 1–4 images lay out in X's real grids (single, side-by-side pair, left-tall trio, 2×2), with alt text and drag-to-reorder. Large images are downscaled to 1600 px before they're stored so drafts don't blow the storage budget.
- **Link previews**: paste a URL and the card is fetched automatically, or fill the title, description, image and domain in by hand. See [Link previews](#link-previews) for the caveat.
- **Threads**: numbered tabs per post, connector lines in the preview, `Auto-split into thread` for long text (splits on sentence boundaries, never mid-word or mid-URL), and `Number posts 1/n`.
- **Quote posts and polls**, rendered the way X renders them.
- **X's real character counting** — URLs always count 23, CJK and emoji count 2, emoji ZWJ sequences count as one grapheme. The ring and counter go amber at 20 left and red past the limit.
- **Premium long posts**: past 280 characters the preview collapses to ten lines with a blue "Show more" that expands in place, the way X shows long posts in the timeline. The limit becomes 25,000. Switch it off in the Profile panel to draft against the plain 280 limit instead.
- **Saved drafts** — name them, reload them, rename, duplicate, delete, and export/import the whole set as JSON.
- **Export**: download the preview as a 2× PNG, copy it to the clipboard, or copy the thread as plain text.

Keyboard: `Ctrl/Cmd+S` saves the draft, `Ctrl/Cmd+Enter` adds another post to the thread.

## Password

The published page is encrypted, not merely hidden: the whole app is an AES-256-GCM ciphertext with the key derived from the password by PBKDF2-HMAC-SHA256 at 310,000 iterations. A visitor without the password gets a page with nothing in it, and the page carries `noindex, nofollow` so search engines stay out.

Unlocking is remembered for the browser session, so a reload doesn't cost a re-type.

**Scope of the protection:** the plaintext source also lives in this repository (`app/`), so the gate stops casual and drive-by access to the hosted tool — it is not a secrecy boundary against someone who reads the repo. Nothing private is in the source: your drafts, images and profile never leave your browser. To make it a real boundary, remove `app/` from the repo (`git rm -r --cached app`) and keep the source locally only.

The composer opens as Konstantin Pilz ([@KonstantinPilz](https://x.com/KonstantinPilz)) with the real profile picture and blue badge; change any of it in the Profile panel.

## Local development

```bash
cd app && python3 -m http.server 8899 --bind 127.0.0.1
```

Then open http://127.0.0.1:8899/ — the unencrypted app, no password. `localhost` counts as a secure context, which the crypto and clipboard APIs need; opening the files over `file://` will not work.

## Rebuilding the published page

```bash
python3 build.py --password '<password>' --in app --out docs/index.html
```

The build inlines the CSS, the ES modules and the vendored library into one JSON payload, encrypts it, and writes a single self-contained HTML file. On unlock, the page rebuilds the module graph as blob URLs — rewriting each module's import specifiers to the blob URLs of its dependencies in topological order — and imports the entry module. GitHub Pages serves `docs/` from `main`.

## Layout

| Path | What |
|---|---|
| `app/index.html` | Composer shell and element ids |
| `app/js/state.js` | State, persistence, pub/sub |
| `app/js/text.js` | Weighted character counting, entity parsing, thread splitting |
| `app/js/render.js` | Preview renderer |
| `app/js/icons.js` | Inline SVG icon set |
| `app/js/media.js` | Attach, downscale, alt text, reorder |
| `app/js/card.js` | Open Graph fetch and manual card entry |
| `app/js/drafts.js` | Named drafts, import/export |
| `app/js/export.js` | PNG and clipboard export |
| `app/js/app.js` | Wiring |
| `app/css/x.css` | X design system and post card |
| `app/css/app.css` | App chrome |
| `build.py`, `gate_template.html` | Encrypted single-file build |
| `CONTRACT.md` | Module contract and the canonical post markup |

## Link previews

A static page has no server to fetch Open Graph tags with, so the card fetch goes through public CORS proxies (`allorigins`, `corsproxy.io`, `r.jina.ai`) in order, with a 6-second timeout each. **Those proxies see the URL you're previewing.** If they all fail, the card degrades to manual entry — title, description, image and domain fields — and nothing is lost. If you'd rather no third party saw the URLs, skip the Fetch button and fill the fields in yourself.

## Fidelity notes

The preview is built from X's public design, not from X's code. Colours, spacing, type scale, media geometry and the action bar are matched to the current web app. Three icons are clean redraws rather than exact copies: the gold organisation badge, the schedule glyph and the globe. Engagement counts are decorative — set them to whatever you want, or switch them off.

## Credits

[html-to-image](https://github.com/bubkoo/html-to-image) (MIT), vendored at `app/vendor/html-to-image.js`, does the PNG rendering. Everything else is dependency-free vanilla JS — no build step, no framework, no npm.

Built by a team of Konstantin's Claudes.
