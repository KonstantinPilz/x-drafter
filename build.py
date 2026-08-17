#!/usr/bin/env python3
"""Bundle the plaintext x-drafter app into one password-encrypted HTML file.

    python3 build.py --password '<pw>' [--in docs] [--out dist/index.html]

Reads whatever exists in the source tree at run time (index.html, css/*.css,
js/**/*.js, vendor/*.js), packs it into a JSON payload, encrypts it with
AES-256-GCM under a PBKDF2-HMAC-SHA256 key, and writes a single standalone page
built from gate_template.html.  The output contains no plaintext of the app.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
from pathlib import Path

PBKDF2_ITERATIONS = 310_000
SALT_BYTES = 16
IV_BYTES = 12

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "gate_template.html"


# --------------------------------------------------------------------------- #
# crypto
# --------------------------------------------------------------------------- #

def _aesgcm_encrypt(key: bytes, iv: bytes, plaintext: bytes) -> bytes:
    """AES-256-GCM encrypt; ciphertext has the 16-byte tag appended (WebCrypto layout)."""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        pass
    else:
        return AESGCM(key).encrypt(iv, plaintext, None)

    try:
        from Crypto.Cipher import AES  # pycryptodome
    except ImportError:
        pass
    else:
        cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
        ct, tag = cipher.encrypt_and_digest(plaintext)
        return ct + tag

    sys.exit(
        "ERROR: no AES-GCM implementation available.\n"
        "       Install one and re-run, e.g.:  pip install --user cryptography\n"
        "       Refusing to write an unencrypted bundle."
    )


def _aesgcm_decrypt(key: bytes, iv: bytes, ciphertext: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        from Crypto.Cipher import AES  # pycryptodome

        cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
        return cipher.decrypt_and_verify(ciphertext[:-16], ciphertext[-16:])
    return AESGCM(key).decrypt(iv, ciphertext, None)


def derive_key(password: str, salt: bytes, iterations: int = PBKDF2_ITERATIONS) -> bytes:
    import hashlib

    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)


# --------------------------------------------------------------------------- #
# source collection
# --------------------------------------------------------------------------- #

LINK_CSS_RE = re.compile(r"""<link\b[^>]*?href\s*=\s*["'][^"']*?\.css["'][^>]*>""", re.I)
MODULE_SCRIPT_RE = re.compile(
    r"""<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>.*?</script\s*>""", re.I | re.S
)
LOCAL_SCRIPT_RE = re.compile(
    r"""<script\b[^>]*\bsrc\s*=\s*["']\.{0,2}/?(?:js|vendor)/[^"']*["'][^>]*>\s*</script\s*>""",
    re.I | re.S,
)
BODY_RE = re.compile(r"<body\b([^>]*)>(.*?)</body\s*>", re.I | re.S)
HTML_TAG_RE = re.compile(r"<html\b([^>]*)>", re.I)
TITLE_RE = re.compile(r"<title\b[^>]*>(.*?)</title\s*>", re.I | re.S)
ATTR_RE = re.compile(r"""([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""")
HREF_RE = re.compile(r"""href\s*=\s*["']([^"']+)["']""", re.I)


def parse_attrs(blob: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in ATTR_RE.finditer(blob or ""):
        name = m.group(1)
        value = next((g for g in m.groups()[1:] if g is not None), "")
        out[name] = value
    return out


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def collect_html(src: Path) -> tuple[str, dict, dict, str, list[str]]:
    """Return (body_markup, html_attrs, body_attrs, title, css_hrefs_in_order)."""
    index = src / "index.html"
    if not index.is_file():
        sys.exit(f"ERROR: {index} not found — nothing to bundle.")
    doc = read_text(index)

    css_hrefs = [HREF_RE.search(t).group(1) for t in LINK_CSS_RE.findall(doc) if HREF_RE.search(t)]

    m_html = HTML_TAG_RE.search(doc)
    html_attrs = parse_attrs(m_html.group(1)) if m_html else {}

    m_body = BODY_RE.search(doc)
    if m_body:
        body_attrs = parse_attrs(m_body.group(1))
        body = m_body.group(2)
    else:
        # half-written file: fall back to the whole document
        body_attrs = {}
        body = doc

    m_title = TITLE_RE.search(doc)
    title = m_title.group(1).strip() if m_title else ""

    body = LINK_CSS_RE.sub("", body)
    body = MODULE_SCRIPT_RE.sub("", body)
    body = LOCAL_SCRIPT_RE.sub("", body)
    return body.strip(), html_attrs, body_attrs, title, css_hrefs


def collect_css(src: Path, hrefs: list[str]) -> str:
    css_dir = src / "css"
    found = sorted(css_dir.glob("*.css")) if css_dir.is_dir() else []
    ordered: list[Path] = []

    # Honour the <link> order in index.html; x.css defines the custom properties
    # app.css consumes, so order matters.
    for href in hrefs:
        cand = (src / href.lstrip("./")).resolve()
        for p in found:
            if p.resolve() == cand and p not in ordered:
                ordered.append(p)
    for p in found:
        if p not in ordered:
            ordered.append(p)
    if not hrefs:
        ordered.sort(key=lambda p: (p.name != "x.css", p.name))

    return "\n\n".join(f"/* --- {p.name} --- */\n{read_text(p)}" for p in ordered)


def collect_js(src: Path) -> dict[str, str]:
    """Every .js under js/ and vendor/, keyed by its path relative to js/.

    vendor files come out as '../vendor/foo.js', which is exactly the specifier
    a module in js/ would import them by, so resolution in the browser is a
    plain path join.
    """
    js_dir = src / "js"
    modules: dict[str, str] = {}
    for base in (js_dir, src / "vendor"):
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.js")):
            key = os.path.relpath(path, js_dir).replace(os.sep, "/")
            modules[key] = read_text(path)
    return modules


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def human(n: int) -> str:
    return f"{n / 1024:,.1f} KiB" if n >= 1024 else f"{n} B"


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the encrypted single-file x-drafter page.")
    ap.add_argument("--password", required=True, help="unlock password for the published page")
    ap.add_argument("--in", dest="src", default="docs", help="source directory (default: docs)")
    ap.add_argument("--out", dest="out", default="dist/index.html", help="output file")
    ap.add_argument("--entry", default="app.js", help="entry module, relative to js/ (default: app.js)")
    ap.add_argument("--iterations", type=int, default=PBKDF2_ITERATIONS, help=argparse.SUPPRESS)
    args = ap.parse_args()

    if not args.password:
        sys.exit("ERROR: --password must not be empty.")

    src = Path(args.src).resolve()
    out = Path(args.out).resolve()
    if not src.is_dir():
        sys.exit(f"ERROR: source directory {src} does not exist.")
    if not TEMPLATE.is_file():
        sys.exit(f"ERROR: template {TEMPLATE} is missing.")

    body, html_attrs, body_attrs, title, css_hrefs = collect_html(src)
    css = collect_css(src, css_hrefs)
    js = collect_js(src)

    if args.entry not in js:
        print(f"WARNING: entry module '{args.entry}' not found in {src / 'js'}; "
              f"the page will decrypt but not boot.", file=sys.stderr)
    if not js:
        print(f"WARNING: no JavaScript modules found under {src / 'js'}.", file=sys.stderr)
    if not css:
        print(f"WARNING: no CSS found under {src / 'css'}.", file=sys.stderr)

    payload = {
        "html": body,
        "css": css,
        "js": js,
        "entry": args.entry,
        "title": title,
        "htmlAttrs": html_attrs,
        "bodyAttrs": body_attrs,
    }
    plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    salt = os.urandom(SALT_BYTES)
    iv = os.urandom(IV_BYTES)
    key = derive_key(args.password, salt, args.iterations)
    ciphertext = _aesgcm_encrypt(key, iv, plaintext)

    page = read_text(TEMPLATE)
    for token, value in (
        ("{{SALT_B64}}", base64.b64encode(salt).decode()),
        ("{{IV_B64}}", base64.b64encode(iv).decode()),
        ("{{CT_B64}}", base64.b64encode(ciphertext).decode()),
        ("{{ITERATIONS}}", str(args.iterations)),
    ):
        if token not in page:
            sys.exit(f"ERROR: template is missing the {token} placeholder.")
        page = page.replace(token, value)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")

    print(f"x-drafter build")
    print(f"  source        {src}")
    print(f"  modules       {len(js)} js  ({', '.join(sorted(js)) or 'none'})")
    print(f"  payload       {human(len(plaintext))} JSON  (html {human(len(body.encode()))}, "
          f"css {human(len(css.encode()))}, js {human(sum(len(v.encode()) for v in js.values()))})")
    print(f"  ciphertext    {human(len(ciphertext))}  (AES-256-GCM, PBKDF2-HMAC-SHA256 "
          f"x{args.iterations:,}, {SALT_BYTES}-byte salt, {IV_BYTES}-byte IV)")
    print(f"  output        {out}  ({human(out.stat().st_size)})")
    print()
    print("  Publish dist/index.html only. The plaintext sources in "
          f"{src.name}/ must NOT be committed to the public repo — anyone could read the app.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
