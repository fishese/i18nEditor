# i18n Editor desktop shell + virtualized grid

Date: 2026-08-13

## Goal

Keep the existing side-by-side i18n editor’s behavior, make the grid fast to appear/scroll/search/filter/type, and ship a Windows/Linux desktop app that can save in place. Keep a single standalone HTML file that still works on the go without the shell.

## Why not a native rewrite

C (grid appearing/scrolling after load) and D (typing/search/filter lag) come from `renderGrid()` building a `<textarea>` for every key × language, then auto-growing all of them. Search, filters, and group collapse rebuild that table. A Tauri/Electron wrapper would not fix that by itself.

A thin Tauri 2 shell does not slow C and D if the grid, search, and edits stay in JavaScript. IPC is only for pick/read/write. Electron is rejected (extra Chromium, more RAM, slower startup). A Qt/WPF rewrite is out of scope.

## Decision

- One UI file: `i18n-editor.html` (standalone and the Tauri frontend).
- Virtualize the grid in that HTML so both the browser and the shell get the C/D fix.
- Tauri 2 shell for native file/folder pickers, directory walk with skip list, and save-in-place.
- Feature-detect Tauri (`window.__TAURI__`). No Tauri APIs → today’s file `<input>` + download flow.

## Architecture

```text
Load folder
  browser → directory <input> (webkitdirectory) → existing skip-after-enumerate
  Tauri   → native dialog → walk disk, skip junk dirs while walking, read .ts/.js

Edit grid
  always JS, virtualized (viewport + overscan only)

Save
  browser → validate → download → “Mark downloads as saved”
  Tauri   → validate → review → Write files to original paths → clear dirty
```

Parser, flatten, language-map detection, edits, missing-key insertion, and post-save re-parse verification stay in the existing JS pipeline. Rust does not parse translations.

Each loaded file in the shell stores `absolutePath` so save can overwrite that path. Browser mode has no `absolutePath` and never writes disk.

Tauri window URL is `i18n-editor.html` (not a second copy of the UI). `frontendDist` is the project root.

### Suggested layout

```text
i18n-editor.html              # the one UI
i18n-editor.test.js           # existing + new tests
src-tauri/                    # Tauri 2 host
  Cargo.toml
  tauri.conf.json
  src/main.rs
  capabilities/
docs/superpowers/specs/       # this spec
```

### Rust commands (IPC)

- `pick_files` → `{ relativePath, absolutePath, text }[]` for user-selected `.ts/.tsx/.js/.jsx` (skip `.d.ts`). `relativePath` is the file’s name (same as today’s non-folder load).
- `pick_folder` → same shape, after a recursive walk that skips `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.turbo`, `out` at directory-entry time, then the same extension filters. `relativePath` is the path relative to the picked folder (same as today’s `webkitRelativePath`).
- `write_file(absolutePath, text)` → `{ ok, error? }`.

Typing, search, scrolling, and cell edits never call Rust.

Load still feeds `ingestFile` / `deriveUnitsForFile` / `renderAll` as today. Loading more files still appends.

## Virtualized grid

Keep the full ordered list of paths that should be shown (union paths → renderable → search → filter → omit collapsed groups). Mount only rows in the viewport plus a small overscan buffer.

- Typing edits that cell in place; it does not rebuild the table.
- Search/filter/collapse update the path list, then paint the window. Debounce search input by 80ms; filter and collapse apply immediately.
- Overscan is 8 rows above and below the viewport.
- Collapsed groups are omitted from the list, not built as `display: none` rows.
- Row heights stay auto-grown. Cache measured height per path so the scrollbar stays accurate; unmeasured rows use 48px until laid out.
- Sticky key column, group headers, completeness dots, missing/opaque/array/empty-object cells stay.
- Closing the save overlay does not call `renderGrid()` unless a save actually happened.

Language column order is the `state.units` order. Do not reshuffle on save (see bugs).

## Save flow

**Check all files** only validates. It never writes or downloads.

**Shell.** Overlay reviews changes as today. Primary action is **Write files**. Each output with changes is written to that file’s `absolutePath`. On success, `commitFileSave` runs for that file (new baseline, dirty cleared). On failure, that file stays dirty and the overlay shows the error. Other files in the same batch still write (no silent skip of the rest; report per file).

**Standalone HTML.** Unchanged: valid outputs trigger downloads; user clicks “Mark downloads as saved”; then `commitFileSave`. Copy stays about downloads.

If a shell file has no `absolutePath` (should not happen after a Tauri pick), treat it as an error for that file, do not download as a fallback inside the shell.

## Errors and loading

- Unreadable or unparsable files: red load banner; other files still load (same as today).
- Files that parse but have no translation object: same banner message as today.
- Write permission denied, missing path, or other disk error: per-file error in the overlay; that file stays dirty.
- No detection of external on-disk edits (out of scope).

Skip list for the shell walk matches `shouldSkipPath` plus skipping those directories before reading them.

## Bugs to fix

Confirming a save currently does `otherUnits.concat(newUnits)`, which moves that file’s language columns to the end. After save, splice the new units into `state.units` at the first index that had that `fileId`, replacing the old run in place. If the new unit count matches the old count, copy manual language labels by index, as today.

## Tests

Keep the existing 10 Node tests (parser, language-map heuristics, insertion, download names).

Add:

- Column order after `commitFileSave` for a middle file.
- Visible-window math: given path list, row heights, scrollTop, viewport height, overscan → which paths mount.
- `downloadFileName` behavior unchanged (HTML path).

Run with `node --test i18n-editor.test.js`.

## Platforms

Windows and Linux desktop builds via Tauri 2. macOS packaging is out of scope unless requested later.

## Out of scope

- Electron
- Native UI rewrite
- Disk conflict/mtime checks
- Changing parser/save-verification semantics
- JSON i18n files (still not loaded)
- Splitting the HTML into a bundler project

## Success

- Standalone `i18n-editor.html` still opens via `file://` with load/download.
- Shell opens the same file, picks folders natively, and writes original paths after a valid review.
- Grid with thousands of keys remains responsive for scroll, search, filter, collapse, and typing.
- Existing features and the 10 current tests still pass, plus the new tests above.
