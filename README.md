# i18n Editor

Side-by-side editor for TypeScript/JavaScript translation files. Load one combined i18n file or a folder of per-language files, edit keys across languages, and save without rewriting the rest of the source.

**Live (browser):** [fishese.github.io/i18nEditor](https://fishese.github.io/i18nEditor/)

Nothing is uploaded. The page runs entirely in your browser (or in the desktop app).

## Browser

Open [the live page](https://fishese.github.io/i18nEditor/) or `index.html` locally. Use **Load files** / **Load folder**, edit, then download changed files.

## Windows desktop

- [Portable `.exe`](https://github.com/fishese/i18nEditor/releases/latest/download/i18n-editor.exe) — double-click to run (needs [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/), already on Windows 11 and most Windows 10 installs).
- [Installer](https://github.com/fishese/i18nEditor/releases/latest/download/i18nEditor-0.1.0-x64-setup.exe)

The desktop app can pick folders natively (skipping `node_modules` and similar) and write back to the original files after a save check.

## Linux

<a id="linux"></a>

There is no pre-built Linux binary in this repo. Build the desktop shell on the machine that will run it.

### Prerequisites

- [Rust](https://rustup.rs/) (`rustup`)
- [Node.js](https://nodejs.org/) 18+
- Tauri 2 system libraries ([Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux))

On Debian/Ubuntu:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### Build

```bash
git clone https://github.com/fishese/i18nEditor.git
cd i18nEditor
npm install
npx tauri build --bundles appimage,deb
```

Outputs:

- AppImage: `src-tauri/target/release/bundle/appimage/`
- `.deb`: `src-tauri/target/release/bundle/deb/`
- Raw binary: `src-tauri/target/release/i18n-editor`

Dev window (no installer):

```bash
npm install
npx tauri dev
```

## Tests

```bash
node --test i18n-editor.test.js
cargo test --manifest-path src-tauri/Cargo.toml
```
