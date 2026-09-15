# Shinkansen Firefox — Build Instructions for AMO Reviewers

This document explains how to rebuild the submitted Firefox extension ZIP
(`shinkansen-firefox-vX.Y.Z.zip`) from the accompanying source ZIP
(`shinkansen-firefox-vX.Y.Z-source.zip`).

The build process is **trivial**: a single `jq` invocation patches 5 lines
of JSON in `manifest.json`. There is **no** minification, bundling,
transpilation, or any other code transformation. All `.js` / `.css` / `.html`
files in the submitted ZIP are byte-for-byte identical to the source.

---

## Prerequisites

- bash 3.2+
- [jq](https://jqlang.org/) 1.6+
- `zip` (standard on Linux / macOS; Windows: install via WSL or Git Bash)

Install jq:

```bash
# macOS
brew install jq

# Ubuntu / Debian
sudo apt-get install jq

# Windows (winget)
winget install jqlang.jq
```

---

## Build Steps

1. Extract the source ZIP. After extraction you should see:
   ```
   shinkansen/
     manifest.json
     background.js
     content-*.js
     ...
   firefox-build.sh
   BUILD-FIREFOX.md  (this file)
   ```

2. Run the build script from the extracted root directory:

   ```bash
   chmod +x firefox-build.sh
   ./firefox-build.sh
   ```

3. Output: `shinkansen-firefox-vX.Y.Z.zip` in the current directory,
   matching the submitted Firefox ZIP byte-for-byte (modulo ZIP timestamp
   metadata).

---

## Note on `shinkansen/lib/instapaper-keys.js`

The source ZIP contains `shinkansen/lib/instapaper-keys.js`, a 20-line file
holding the Instapaper Full API **consumer key / consumer secret** for the
optional "Send to Instapaper" feature.

- It is **not** in the public git repository. It is generated at release time
  from CI secrets using `tools/build/instapaper-keys.template.js`, then packaged.
  Keeping it out of the repository (and out of git history) is only meant to
  reduce automated scraping of public code search — the credential is
  inherently distributed inside every published build and is not a secret in
  any strong sense.
- It contains no logic: it assigns two string constants onto
  `globalThis.__SK.INSTAPAPER_KEYS`. `lib/instapaper.js` reads them from there.
- The build script does not transform it. It is copied verbatim, like every
  other file.
- If the file is absent, the extension still builds and runs; only the
  Instapaper integration is disabled (`lib/instapaper.js` returns a
  configuration error). Tests inject the credentials rather than reading
  this file.

---

## What the Build Does

The repository's `shinkansen/manifest.json` is the **Chrome version**
(declares `background.service_worker`). Chrome MV3 rejects the
`background.scripts` key with a warning ("requires manifest version 2 or
lower"). Firefox MV3 does not support `background.service_worker` at all.
The two browsers' rules are mutually incompatible, so a single manifest
cannot serve both.

The build performs exactly one transformation, applied via `jq`:

```bash
jq '.background = {"scripts": ["background.js"], "type": "module"} |
    .browser_specific_settings.gecko.strict_min_version = "128.0" |
    .browser_specific_settings.gecko.data_collection_permissions = {"required": ["none"]}' \
    shinkansen/manifest.json > firefox-build/manifest.json
```

This:

1. Replaces `background.service_worker` with `background.scripts`
   (Firefox's required form for MV3 background pages).
2. Adds `browser_specific_settings.gecko.strict_min_version: "128.0"`
   (the extension uses `content_scripts.world: "MAIN"`, supported in
   Firefox 128+ only).
3. Adds `browser_specific_settings.gecko.data_collection_permissions: {"required": ["none"]}`
   (Mozilla's 2025 built-in data-consent rule. Shinkansen does NOT collect
   any user data — every network request goes directly from the user's
   browser to the third-party endpoint the user chose (Gemini, Google
   Translate, a custom OpenAI-compatible endpoint, Instapaper, GitHub
   release check, exchange rate, on-demand PDF fonts); no
   Shinkansen-controlled server is involved. Full list in the privacy
   policy, section 4.)

### Note on `strict_min_version: 128.0` vs `data_collection_permissions: 140+`

`web-ext lint` will produce two warnings:

```
KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION:
  "strict_min_version" requires Firefox 128, which was released before
  version 140 introduced support for "data_collection_permissions".
KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION:
  Same, for Android (140 desktop / 142 Android).
```

**This is intentional.** The extension genuinely requires Firefox 128 for
`content_scripts.world: "MAIN"` (used by `content-youtube-main.js` to
intercept YouTube's player XHR for caption translation). On Firefox
128–139 the `data_collection_permissions` key is silently ignored,
which is harmless because the extension does not collect any data
anyway. On Firefox 140+ the consent UI will display "no data collected"
correctly. Lowering `strict_min_version` to 140 would lock out two
years of Firefox users from a feature that works fine for them; raising
it would be unnecessarily restrictive.

All other files (`background.js`, `content-*.js`, `lib/**/*`, `popup/**/*`,
`options/**/*`, `translate-doc/**/*`, `_locales/**/*`, icons, CSS,
`THIRD-PARTY-NOTICES.md`, `LICENSE`) are copied unchanged.

---

## Verifying the Build Output

After running `firefox-build.sh`, verify the patched manifest:

```bash
unzip -p shinkansen-firefox-vX.Y.Z.zip manifest.json | jq '{version, background, browser_specific_settings}'
```

Expected output:

```json
{
  "version": "X.Y.Z",
  "background": {
    "scripts": ["background.js"],
    "type": "module"
  },
  "browser_specific_settings": {
    "gecko": {
      "id": "shinkansen@jimmy.zm.su",
      "strict_min_version": "128.0",
      "data_collection_permissions": {
        "required": ["none"]
      }
    }
  }
}
```

---

## innerHTML Usage Rationale (for AMO reviewer)

`web-ext lint` flags `UNSAFE_VAR_ASSIGNMENT` on every `innerHTML`
assignment (about 60 sites across the codebase, `grep -rn "innerHTML ="`).
**None of these accept untrusted remote input.** Roughly 20 sites carry an
inline `// AMO source review: ...` comment; the rest fall into the same
categories and can be verified from the surrounding lines:

| Category | Locations | Source |
|---|---|---|
| **Clear an element** (`el.innerHTML = ''`) | `translate-doc/index.js`, `translate-doc/reader.js` | Empty string literal. |
| **Restore self-saved DOM (translation guard / restore)** | `content-spa.js`, `content.js`, `content-inject.js` | The string was previously read from the same element via `el.innerHTML` and saved to `STATE.translatedHTML` / `STATE.originalHTML`; it is written back to the same element. |
| **Sanitized via `_escapeHtml` / `escapeHtml` / `escapeAttr`** | `content-youtube.js`, `options/options.js`, `popup/popup.js`, `content-toast.js`, `translate-doc/index.js` | Every interpolated value is escaped; tags in the template are developer-controlled literals. |
| **Static template + i18n dictionary strings** | `lib/i18n.js` (`data-i18n-html` applier), `lib/i18n-content.js`, `translate-doc/reader.js`, `content-drive.js`, `content-floating-icon.js` (Shadow DOM markup) | Strings come from the bundled i18n dictionary or hardcoded markup; parameters are escaped by the `t()` helper. |
| **Parse into a detached element** | `content-ns.js`, `translate-doc/block-output.js`, `translate-doc/epub-session-db.js`, `translate-doc/epub-writer.js` | HTML is parsed in a detached `div` (never attached to the page) to serialize / normalize it; the source is the extension's own translation output or the user's own edits made inside the extension UI. |
| **Vendored library** | `lib/readability.js` | Upstream @mozilla/readability code, unchanged (see `THIRD-PARTY-NOTICES.md`). |

User input (translation source text, glossary entries, model names,
domain whitelist entries) is always escaped via `escapeHtml` /
`escapeAttr` before being interpolated. We use `innerHTML` rather than
DOM API construction because the strings being assigned are large
HTML fragments (entire translated paragraphs, table rows with multiple
cells, etc.) and DOM API construction would significantly inflate code
size and cost without a security benefit.

---

## Source Repository

Public repository: https://github.com/jimmysu0309/shinkansen

The Chrome version (`shinkansen/manifest.json` as-is) is the canonical
source of truth. The Firefox build script is `tools/release/firefox-build.sh`
(the copy at the root of this source ZIP); `.github/workflows/release.yml`
calls the same script, so CI and manual rebuilds share one implementation.

License: Elastic License 2.0 (ELv2). See `LICENSE` in the repo.

---

## AMO Source Submission Questionnaire — Quick Answers

For convenience, the typical AMO source submission form answers:

| Question | Answer |
|---|---|
| Do you use any tools to compile / minify / process source? | Yes — `jq` only, to patch 5 lines of JSON in `manifest.json`. No JS / CSS / HTML transformation. |
| Are there any third-party libraries? | Yes, all vendored unmodified under `lib/vendor/` (PDF.js, pdf-lib + fontkit, Chart.js, fflate, opencc-js + OpenCC dictionaries, Noto Sans TC font) plus `lib/readability.js` (@mozilla/readability). Noto Sans SC / JP / KR fonts are downloaded at runtime from the project site, not bundled. Versions and licenses: `shinkansen/THIRD-PARTY-NOTICES.md`. |
| Build environment | bash + jq + zip (any Linux / macOS / WSL) |
| How to reproduce | `./firefox-build.sh` (see steps above) |
