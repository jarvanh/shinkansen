# Shinkansen Firefox — Build Instructions for AMO Reviewers

This document explains how to rebuild the submitted Firefox extension ZIP
(`shinkansen-firefox-vX.Y.Z-beta.zip`) from the accompanying source ZIP
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
   BUILD.md  (this file)
   ```

2. Run the build script from the extracted root directory:

   ```bash
   chmod +x firefox-build.sh
   ./firefox-build.sh
   ```

3. Output: `shinkansen-firefox-vX.Y.Z-beta.zip` in the current directory,
   matching the submitted Firefox ZIP byte-for-byte (modulo ZIP timestamp
   metadata).

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
    .browser_specific_settings.gecko.strict_min_version = "128.0"' \
    shinkansen/manifest.json > firefox-build/manifest.json
```

This:

1. Replaces `background.service_worker` with `background.scripts`
   (Firefox's required form for MV3 background pages).
2. Adds `browser_specific_settings.gecko.strict_min_version: "128.0"`
   (the extension uses `content_scripts.world: "MAIN"`, supported in
   Firefox 128+ only).

All other files (`background.js`, `content-*.js`, `lib/**/*`, `popup/**/*`,
`options/**/*`, `_locales/**/*`, icons, CSS) are copied unchanged.

---

## Verifying the Build Output

After running `firefox-build.sh`, verify the patched manifest:

```bash
unzip -p shinkansen-firefox-vX.Y.Z-beta.zip manifest.json | jq '{version, background, browser_specific_settings}'
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
      "strict_min_version": "128.0"
    }
  }
}
```

---

## Source Repository

Public repository: https://github.com/jimmysu0309/shinkansen

The Chrome version (`shinkansen/manifest.json` as-is) is the canonical
source of truth. The Firefox build script lives in `.github/workflows/release.yml`
and is mirrored in `firefox-build.sh` for reproducibility outside of CI.

License: Elastic License 2.0 (ELv2). See `LICENSE` in the repo.

---

## AMO Source Submission Questionnaire — Quick Answers

For convenience, the typical AMO source submission form answers:

| Question | Answer |
|---|---|
| Do you use any tools to compile / minify / process source? | Yes — `jq` only, to patch 5 lines of JSON in `manifest.json`. No JS / CSS / HTML transformation. |
| Are there any third-party libraries? | `lib/vendor/chart.min.js` (Chart.js v4.5.1, MIT). Distributed as-is from upstream. |
| Build environment | bash + jq + zip (any Linux / macOS / WSL) |
| How to reproduce | `./firefox-build.sh` (see steps above) |
