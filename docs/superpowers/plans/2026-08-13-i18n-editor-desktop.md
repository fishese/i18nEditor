# i18n Editor Desktop Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Virtualize the existing HTML grid so large translation tables stay responsive, fix save column-order, and wrap the same `i18n-editor.html` in a Tauri 2 shell that can pick folders natively and save in place.

**Architecture:** Parser, edits, and the grid stay in JavaScript inside `i18n-editor.html`. New pure helpers (`commitFileSave`, `listGridRows`, `computeVisibleWindow`) live in the existing `I18nApp` script block so Node tests can load them the same way they already load the parser. Tauri 2 only exposes `pick_files`, `pick_folder`, and `write_file`. The HTML feature-detects `window.__TAURI__`; without it, today’s file inputs and downloads remain.

**Tech Stack:** Existing vanilla HTML/JS, Node `node:test`, Tauri 2, Rust, `rfd` for native dialogs, `serde` for IPC.

## Global Constraints

- One UI file: `i18n-editor.html` (standalone `file://` and Tauri frontend). Do not add a bundler or a second copy of the UI.
- Feature-detect Tauri via `window.__TAURI__`. No Tauri APIs → file `<input>` + download flow unchanged.
- IPC is only pick/read/write. Typing, search, scrolling, and cell edits never call Rust.
- Virtualized grid: overscan 8 rows, unmeasured row height 48px, search debounce 80ms.
- Collapsed groups are omitted from the row list, not built as `display: none`.
- Closing the save overlay must not call `renderGrid()` unless a save happened.
- Shell skip dirs (at walk time): `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.turbo`, `out`. Files: only `.ts/.tsx/.js/.jsx`, never `.d.ts`.
- Platforms: Windows and Linux. No macOS packaging.
- Do not change parser/save-verification semantics. Do not load JSON i18n files.
- Conventional commits (`feat`, `fix`, `test`, `chore`). Do not skip git hooks.

## File structure

- `i18n-editor.html` — parser script, `I18nApp` script, UI script, CSS. Keep this layout; tests scrape `<script>` blocks by order.
- `i18n-editor.test.js` — Node tests; `loadModules()` already binds script[0]=parser, script[1]=I18nApp.
- `src-tauri/src/files.rs` — skip rules, folder walk, UTF-8 read, write result (unit-tested without GUI).
- `src-tauri/src/main.rs` — rfd dialogs + Tauri command wrappers.
- `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json`
- `package.json` — only `@tauri-apps/cli` for `npx tauri dev/build`.
- `.gitignore` — `node_modules/`, `src-tauri/target/`, `src-tauri/gen/`

---

### Task 1: Preserve language columns on save

**Files:**
- Modify: `i18n-editor.html` (I18nApp script: `ingestFile`, add `commitFileSave`, export both)
- Modify: `i18n-editor.html` (UI script: delete local `commitFileSave`, call `App.commitFileSave(state, ...)`)
- Test: `i18n-editor.test.js`

**Interfaces:**
- Consumes: existing `ingestFile`, `deriveUnitsForFile`, `setCell`, `computeFileOutput`
- Produces: `ingestFile(filename, text, absolutePath?)` → `{ file, roots, error }` where `file` is `{ id, name, text, absolutePath }` (`absolutePath` is `null` when omitted). `commitFileSave(state, fileId, newText)` mutates `state.files`, `state.units`, `state.edits`; splices new units at the first index that had that `fileId`.

- [ ] **Step 1: Write the failing tests**

Append to `i18n-editor.test.js`:

```javascript
test('ingestFile stores optional absolutePath', () => {
  const parsed = App.ingestFile('en.ts', 'export default { greeting: "Hello" };', 'D:/proj/en.ts');
  assert.equal(parsed.file.absolutePath, 'D:/proj/en.ts');
  const browser = App.ingestFile('en.ts', 'export default { greeting: "Hello" };');
  assert.equal(browser.file.absolutePath, null);
});

test('commitFileSave keeps a middle file’s units in place', () => {
  const a = App.ingestFile('en.ts', 'export default { greeting: "Hi" };');
  const b = App.ingestFile('fr.ts', 'export default { greeting: "Bonjour" };');
  const c = App.ingestFile('de.ts', 'export default { greeting: "Hallo" };');
  const unitsA = App.deriveUnitsForFile(a.file, a.roots, 3);
  const unitsB = App.deriveUnitsForFile(b.file, b.roots, 3);
  const unitsC = App.deriveUnitsForFile(c.file, c.roots, 3);
  const state = {
    files: [a.file, b.file, c.file],
    units: [...unitsA, ...unitsB, ...unitsC],
    edits: {},
  };
  App.setCell(state, unitsB[0].id, 'greeting', 'Salut');
  const out = App.computeFileOutput(state, b.file);
  assert.equal(out.valid, true, out.error);
  App.commitFileSave(state, b.file.id, out.newText);
  assert.deepEqual(state.units.map(u => u.fileName), ['en.ts', 'fr.ts', 'de.ts']);
  const cell = App.getCell(state, state.units[1], 'greeting');
  assert.equal(cell.value, 'Salut');
  assert.equal(cell.dirty, false);
});

test('commitFileSave preserves a renamed language label', () => {
  const parsed = App.ingestFile('translations.ts', `export const messages = {
    en: { greeting: "Hello" },
    fr: { greeting: "Bonjour" },
  };`);
  const units = App.deriveUnitsForFile(parsed.file, parsed.roots, 1);
  units[0].lang = 'English';
  const state = { files: [parsed.file], units, edits: {} };
  App.setCell(state, units[0].id, 'greeting', 'Hi');
  const out = App.computeFileOutput(state, parsed.file);
  App.commitFileSave(state, parsed.file.id, out.newText);
  assert.equal(state.units[0].lang, 'English');
  assert.match(state.files[0].text, /greeting: "Hi"/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test i18n-editor.test.js`

Expected: FAIL — `App.commitFileSave is not a function` (or `absolutePath` undefined).

- [ ] **Step 3: Implement ingestFile + commitFileSave in I18nApp**

Replace `ingestFile` in the I18nApp script with:

```javascript
function ingestFile(filename, text, absolutePath) {
  const file = { id: nextId('file-'), name: filename, text, absolutePath: absolutePath || null };
  try {
    const roots = P.findRoots(text);
    return { file, roots, error: null };
  } catch (e) {
    return { file, roots: [], error: e.message || String(e) };
  }
}

function commitFileSave(state, fileId, newText) {
  const idx = state.files.findIndex(f => f.id === fileId);
  if (idx === -1) return;
  const oldFile = state.files[idx];
  const oldUnits = state.units.filter(u => u.fileId === fileId);
  const firstIdx = state.units.findIndex(u => u.fileId === fileId);
  oldUnits.forEach(u => { delete state.edits[u.id]; });
  const { file: newFile, roots, error } = ingestFile(oldFile.name, newText, oldFile.absolutePath);
  if (error) return;
  state.files[idx] = newFile;
  const newUnits = deriveUnitsForFile(newFile, roots, state.files.length);
  if (newUnits.length === oldUnits.length) {
    newUnits.forEach((u, i) => { u.lang = oldUnits[i].lang; });
  }
  const without = state.units.filter(u => u.fileId !== fileId);
  if (firstIdx === -1) state.units = without.concat(newUnits);
  else {
    without.splice(firstIdx, 0, ...newUnits);
    state.units = without;
  }
}
```

Add `commitFileSave` to the `I18nApp` export object.

In the UI script, delete the local `commitFileSave` function. Change the confirm-downloads handler to:

```javascript
pendingDownloadedOutputs.forEach(out => App.commitFileSave(state, out.fileId, out.newText));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test i18n-editor.test.js`

Expected: all tests PASS, including the original 10 plus the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add i18n-editor.html i18n-editor.test.js
git commit -m "fix: keep language column order after save"
```

---

### Task 2: Grid window math

**Files:**
- Modify: `i18n-editor.html` (I18nApp script)
- Test: `i18n-editor.test.js`

**Interfaces:**
- Consumes: `P.splitPath`
- Produces:
  - `GRID_OVERSCAN = 8`
  - `DEFAULT_ROW_HEIGHT = 48`
  - `groupOf(path)` → `string | null` (first path segment when there is more than one)
  - `listGridRows(paths, collapsedGroups)` → `Array<{ type: 'group', group: string } | { type: 'key', path: string }>`
  - `computeVisibleWindow(heights, scrollTop, viewportHeight, overscan)` → `{ startIndex, endIndex, padTop, padBottom }` with `endIndex` exclusive

- [ ] **Step 1: Write the failing tests**

Append to `i18n-editor.test.js`:

```javascript
test('listGridRows inserts group headers and omits collapsed keys', () => {
  const paths = ['nav.home', 'nav.about', 'title', 'footer.copy'];
  const all = App.listGridRows(paths, new Set());
  assert.deepEqual(all.map(r => r.type === 'group' ? r.group : r.path), [
    'nav', 'nav.home', 'nav.about', 'title', 'footer', 'footer.copy',
  ]);
  const collapsed = App.listGridRows(paths, new Set(['nav']));
  assert.deepEqual(collapsed.map(r => r.type === 'group' ? r.group : r.path), [
    'nav', 'title', 'footer', 'footer.copy',
  ]);
});

test('computeVisibleWindow mounts overscan around the viewport', () => {
  const heights = Array(100).fill(50);
  const win = App.computeVisibleWindow(heights, 1000, 200, 2);
  assert.equal(win.startIndex, 18);
  assert.equal(win.endIndex, 26);
  assert.equal(win.padTop, 900);
  assert.equal(win.padBottom, 3700);
});

test('computeVisibleWindow at top uses overscan below only', () => {
  const heights = Array(10).fill(40);
  const win = App.computeVisibleWindow(heights, 0, 80, 8);
  assert.equal(win.startIndex, 0);
  assert.equal(win.endIndex, 10);
  assert.equal(win.padTop, 0);
  assert.equal(win.padBottom, 0);
});

test('download names retain relative-path identity without illegal characters', () => {
  assert.equal(App.downloadFileName('en/index.ts'), 'en__index.ts');
  assert.equal(App.downloadFileName('fr\\index.ts'), 'fr__index.ts');
  assert.equal(App.downloadFileName('translations.ts'), 'translations.ts');
});
```

The last test already exists earlier in the file. Do **not** duplicate it; the existing test is the coverage the spec asked for. Only add the three new tests above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test i18n-editor.test.js`

Expected: FAIL — `App.listGridRows is not a function`.

- [ ] **Step 3: Implement window helpers**

Add to the I18nApp script, before the `I18nApp` export object:

```javascript
const GRID_OVERSCAN = 8;
const DEFAULT_ROW_HEIGHT = 48;

function groupOf(path) {
  const segs = P.splitPath(path);
  return segs.length > 1 ? segs[0] : null;
}

function listGridRows(paths, collapsedGroups) {
  const rows = [];
  let lastGroup = undefined;
  for (const path of paths) {
    const group = groupOf(path);
    if (group !== lastGroup) {
      lastGroup = group;
      if (group != null) rows.push({ type: 'group', group });
    }
    if (group != null && collapsedGroups.has(group)) continue;
    rows.push({ type: 'key', path });
  }
  return rows;
}

function computeVisibleWindow(heights, scrollTop, viewportHeight, overscan) {
  const n = heights.length;
  const y0 = Math.max(0, scrollTop);
  const y1 = y0 + Math.max(0, viewportHeight);
  let acc = 0;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const next = acc + heights[i];
    if (next > y0) { start = i; break; }
    acc = next;
    start = i + 1;
  }
  start = Math.max(0, start - overscan);
  let padTop = 0;
  for (let i = 0; i < start; i++) padTop += heights[i];
  let end = start;
  let y = padTop;
  while (end < n && y < y1) {
    y += heights[end];
    end++;
  }
  end = Math.min(n, end + overscan);
  let padBottom = 0;
  for (let i = end; i < n; i++) padBottom += heights[i];
  return { startIndex: start, endIndex: end, padTop, padBottom };
}
```

Export `GRID_OVERSCAN`, `DEFAULT_ROW_HEIGHT`, `groupOf`, `listGridRows`, `computeVisibleWindow` on `I18nApp`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test i18n-editor.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add i18n-editor.html i18n-editor.test.js
git commit -m "feat: add virtualized grid window math"
```

---

### Task 3: Virtualize the HTML grid

**Files:**
- Modify: `i18n-editor.html` (CSS `.grid-wrap`, spacer row, UI script `renderGrid` and wiring)

**Interfaces:**
- Consumes: `App.listGridRows`, `App.computeVisibleWindow`, `App.GRID_OVERSCAN`, `App.DEFAULT_ROW_HEIGHT`, `App.groupOf`, `App.computeUnionPaths`, `App.filterRenderablePaths`, `App.getCell`, `App.setCell`, `App.clearCell`, `App.flatForUnit`
- Produces: UI-only `renderGrid()` that mounts viewport+overscan rows into `#grid-wrap`; search debounced 80ms; overlay close does not rebuild the grid.

- [ ] **Step 1: Add CSS so `#grid-wrap` is the scrollport**

Replace the existing `.grid-wrap` rule with:

```css
.grid-wrap {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  overflow: auto; box-shadow: var(--shadow-sm);
  max-height: calc(100vh - 220px);
}
tr.virt-spacer td {
  padding: 0; border: none; line-height: 0; font-size: 0;
}
```

Thead sticky `top: 0` then sticks inside `#grid-wrap`, which is required for windowing.

- [ ] **Step 2: Replace UI `groupOf` / `renderGrid` with a virtualized renderer**

Delete the UI-local `groupOf` (I18nApp now owns it). Keep UI-local `labelSegments`.

In the UI IIFE, add state next to `collapsedGroups`:

```javascript
const heightCache = new Map();
let searchTimer = null;
let gridScrollBound = false;
```

Replace `renderGrid` with the following. It rebuilds thead only when language units change; on scroll it only replaces tbody window rows.

```javascript
function rowCacheKey(row) {
  return row.type === 'group' ? `g:${row.group}` : `k:${row.path}`;
}

function spacerRow(height, colSpan) {
  const tr = document.createElement('tr');
  tr.className = 'virt-spacer';
  const td = document.createElement('td');
  td.colSpan = colSpan;
  td.style.height = `${height}px`;
  tr.appendChild(td);
  return tr;
}

function renderGroupRow(group, units) {
  const gRow = document.createElement('tr');
  gRow.className = 'group-row' + (collapsedGroups.has(group) ? ' collapsed' : '');
  gRow.dataset.groupHeader = group;
  const gTd = document.createElement('td');
  gTd.colSpan = units.length + 1;
  gTd.appendChild(el('span', 'chev', '▾'));
  gTd.appendChild(document.createTextNode(group));
  gRow.appendChild(gTd);
  gRow.addEventListener('click', () => {
    if (collapsedGroups.has(group)) collapsedGroups.delete(group); else collapsedGroups.add(group);
    renderGrid();
  });
  return gRow;
}

function renderKeyRow(path, units, renderablePaths, growQueue) {
  const tr = document.createElement('tr');
  tr.dataset.path = path;
  const keyTd = document.createElement('td');
  keyTd.className = 'key-cell';
  const keyPath = el('div', 'key-path');
  const segs = labelSegments(path);
  if (segs.length > 1) {
    keyPath.appendChild(el('span', 'seg-muted', segs.slice(0, -1).join('.') + '.'));
  }
  keyPath.appendChild(el('span', 'seg-leaf', segs[segs.length - 1]));
  keyTd.appendChild(keyPath);
  const bar = el('div', 'completeness');
  units.forEach(u => {
    const cell = App.getCell(state, u, path);
    bar.appendChild(el('i', cell.kind === 'missing' ? 'miss' : 'ok'));
  });
  keyTd.appendChild(bar);
  tr.appendChild(keyTd);
  units.forEach(u => {
    const td = document.createElement('td');
    td.className = 'value-cell';
    const cell = App.getCell(state, u, path);
    if (cell.kind === 'string' || cell.kind === 'missing') {
      const ta = document.createElement('textarea');
      ta.className = 'cell-textarea' + (cell.dirty ? ' dirty' : '') + (cell.kind === 'missing' ? ' is-missing' : '');
      ta.rows = 1;
      ta.value = cell.kind === 'string' ? cell.value : '';
      if (cell.kind === 'missing') ta.placeholder = 'Add translation…';
      ta.spellcheck = true;
      ta.addEventListener('input', () => {
        autoGrow(ta);
        const original = App.flatForUnit(u)[path];
        if (original && original.kind === 'string' && ta.value === original.node.value) {
          App.clearCell(state, u.id, path);
          ta.classList.remove('dirty');
        } else {
          App.setCell(state, u.id, path, ta.value);
          ta.classList.add('dirty');
        }
        ta.classList.toggle('is-missing', !ta.value && !App.getCell(state, u, path).existedBefore);
        updateFooter();
        updateGridMetrics(units, renderablePaths, path, tr);
        heightCache.set(rowCacheKey({ type: 'key', path }), tr.getBoundingClientRect().height);
      });
      ta.addEventListener('focus', () => setRowFocus(tr));
      td.appendChild(ta);
      growQueue.push(ta);
    } else if (cell.kind === 'array') {
      const box = el('div', 'cell-readonly');
      box.appendChild(el('span', 'tag', 'Array'));
      box.appendChild(document.createElement('br'));
      box.appendChild(document.createTextNode(cell.raw.raw));
      td.appendChild(box);
    } else if (cell.kind === 'empty-object') {
      const box = el('div', 'cell-readonly');
      box.appendChild(el('span', 'tag', 'Empty group'));
      td.appendChild(box);
    } else {
      const box = el('div', 'cell-readonly');
      box.appendChild(el('span', 'tag', 'Complex value'));
      box.appendChild(document.createElement('br'));
      box.appendChild(document.createTextNode(cell.raw));
      td.appendChild(box);
    }
    tr.appendChild(td);
  });
  tr.addEventListener('click', (ev) => { if (ev.target === tr || ev.target.closest('td.key-cell')) setRowFocus(tr); });
  return tr;
}

function renderGrid(opts) {
  const keepScroll = !!(opts && opts.keepScroll);
  const wrap = document.getElementById('grid-wrap');
  const units = state.units;
  if (!units.length) { wrap.innerHTML = ''; return; }

  const prevScroll = wrap.scrollTop;
  const allPaths = App.computeUnionPaths(units);
  const renderablePaths = App.filterRenderablePaths(units, allPaths);
  const visiblePaths = renderablePaths.filter(p => rowMatchesSearch(p, units) && rowMatchesFilter(p, units));
  const rows = App.listGridRows(visiblePaths, collapsedGroups);
  const heights = rows.map(row => heightCache.get(rowCacheKey(row)) || App.DEFAULT_ROW_HEIGHT);
  const win = App.computeVisibleWindow(heights, keepScroll ? prevScroll : 0, wrap.clientHeight || 600, App.GRID_OVERSCAN);
  const slice = rows.slice(win.startIndex, win.endIndex);
  const growQueue = [];
  const colSpan = units.length + 1;

  wrap.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'i18n-grid';
  const colgroup = document.createElement('colgroup');
  colgroup.appendChild(el('col', 'col-key'));
  units.forEach(() => colgroup.appendChild(el('col', 'col-lang')));
  table.appendChild(colgroup);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(el('th', 'key-col', 'Key'));
  units.forEach(u => {
    const th = document.createElement('th');
    const total = renderablePaths.length;
    const filled = renderablePaths.filter(p => App.getCell(state, u, p).kind !== 'missing').length;
    const wrapDiv = el('div', 'lang-th');
    wrapDiv.appendChild(el('span', 'lang-th-name', u.lang));
    wrapDiv.appendChild(el('span', 'lang-th-count', `${filled}/${total}`));
    th.appendChild(wrapDiv);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (!visiblePaths.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colSpan;
    td.className = 'no-results';
    td.textContent = searchQuery || filterMode !== 'all' ? 'No keys match your search or filter.' : 'No translatable keys found.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    if (win.padTop) tbody.appendChild(spacerRow(win.padTop, colSpan));
    slice.forEach(row => {
      tbody.appendChild(row.type === 'group' ? renderGroupRow(row.group, units) : renderKeyRow(row.path, units, renderablePaths, growQueue));
    });
    if (win.padBottom) tbody.appendChild(spacerRow(win.padBottom, colSpan));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  wrap.scrollTop = keepScroll ? prevScroll : 0;
  growQueue.forEach(autoGrow);
  tbody.querySelectorAll('tr[data-path], tr[data-group-header]').forEach(tr => {
    const key = tr.dataset.path ? `k:${tr.dataset.path}` : `g:${tr.dataset.groupHeader}`;
    heightCache.set(key, tr.getBoundingClientRect().height);
  });
  updateGridMetrics(units, renderablePaths);

  if (!gridScrollBound) {
    gridScrollBound = true;
    wrap.addEventListener('scroll', () => { renderGrid({ keepScroll: true }); }, { passive: true });
  }
}
```

- [ ] **Step 3: Debounce search; stop rebuilding on overlay close**

Replace the search input listener with:

```javascript
document.getElementById('search-input').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderGrid(), 80);
});
```

In `closeValidationOverlay`, **delete** the `renderGrid();` call. Confirm-save already calls `renderAll()`.

When `renderAll` runs after load/save/remove-language, call `heightCache.clear()` at the start of `renderAll` so column-count changes do not reuse stale heights. Do **not** clear the cache inside `renderGrid` (search/filter/scroll must reuse it).

```javascript
function renderAll() {
  heightCache.clear();
  renderSummary();
  renderGrid();
  updateFooter();
}
```

- [ ] **Step 4: Run Node tests (logic unchanged) and smoke-check the HTML**

Run: `node --test i18n-editor.test.js`

Expected: PASS.

Open `i18n-editor.html` in a browser, load a small fixture (two tiny `.ts` files). Confirm: search, Missing/Edited filters, group collapse, typing (dirty + footer count), Check all files, Escape closes overlay without wiping the grid.

- [ ] **Step 5: Commit**

```bash
git add i18n-editor.html
git commit -m "feat: virtualize translation grid rendering"
```

---

### Task 4: Folder walk and write helpers in Rust

**Files:**
- Create: `src-tauri/src/files.rs`
- Create: `src-tauri/Cargo.toml` (library target so `cargo test` works; Task 5 adds the binary)
- Test: `src-tauri/src/files.rs` (`#[cfg(test)]` module)

**Interfaces:**
- Consumes: none
- Produces:
  - `LoadedFile { relative_path, absolute_path, text }` (serde `camelCase`)
  - `PickResult { files: Vec<LoadedFile>, errors: Vec<String> }`
  - `WriteResult { ok: bool, error: Option<String> }`
  - `should_skip_dir(name: &str) -> bool`
  - `should_skip_file(path: &Path) -> bool`
  - `read_files(paths: &[(PathBuf, String)]) -> PickResult` where the `String` is the `relativePath` to report
  - `walk_folder(root: &Path) -> PickResult`
  - `write_text(absolute_path: &Path, text: &str) -> WriteResult`

`errors` entries use the existing banner shape: `"path: could not read file ({message})"`.

- [ ] **Step 1: Scaffold crate + failing tests**

Create `src-tauri/Cargo.toml`:

```toml
[package]
name = "i18n-editor"
version = "0.1.0"
edition = "2021"

[lib]
name = "i18n_editor"
path = "src/files.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }

[dev-dependencies]
tempfile = "3"
```

Create `src-tauri/src/files.rs` with empty stubs plus tests at the bottom:

```rust
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadedFile {
    pub relative_path: String,
    pub absolute_path: String,
    pub text: String,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct PickResult {
    pub files: Vec<LoadedFile>,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct WriteResult {
    pub ok: bool,
    pub error: Option<String>,
}

pub fn should_skip_dir(name: &str) -> bool {
    false
}

pub fn should_skip_file(path: &Path) -> bool {
    true
}

pub fn read_files(_paths: &[(PathBuf, String)]) -> PickResult {
    PickResult::default()
}

pub fn walk_folder(_root: &Path) -> PickResult {
    PickResult::default()
}

pub fn write_text(_absolute_path: &Path, _text: &str) -> WriteResult {
    WriteResult { ok: false, error: Some("not implemented".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;

    #[test]
    fn skip_junk_directories() {
        for name in ["node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo", "out"] {
            assert!(should_skip_dir(name), "{name}");
        }
        assert!(!should_skip_dir("locales"));
        assert!(!should_skip_dir("src"));
    }

    #[test]
    fn skip_non_translation_files() {
        assert!(should_skip_file(Path::new("foo.d.ts")));
        assert!(should_skip_file(Path::new("readme.md")));
        assert!(should_skip_file(Path::new("en.json")));
        assert!(!should_skip_file(Path::new("en.ts")));
        assert!(!should_skip_file(Path::new("en.tsx")));
        assert!(!should_skip_file(Path::new("fr.js")));
        assert!(!should_skip_file(Path::new("de.jsx")));
    }

    #[test]
    fn walk_skips_node_modules_and_reads_ts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("locales")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("locales/en.ts"), "export default { a: \"A\" };").unwrap();
        fs::write(root.join("node_modules/pkg/en.ts"), "export default { skip: true };").unwrap();
        fs::write(root.join("notes.md"), "nope").unwrap();
        let result = walk_folder(root);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let names: Vec<_> = result.files.iter().map(|f| f.relative_path.replace('\\', "/")).collect();
        assert_eq!(names, vec!["locales/en.ts"]);
        assert!(result.files[0].text.contains("A"));
        assert!(result.files[0].absolute_path.contains("en.ts"));
    }

    #[test]
    fn write_text_overwrites_and_reports_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("en.ts");
        fs::write(&path, "old").unwrap();
        let ok = write_text(&path, "new");
        assert!(ok.ok, "{:?}", ok.error);
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        let missing = write_text(&dir.path().join("nope").join("en.ts"), "x");
        assert!(!missing.ok);
        assert!(missing.error.is_some());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: FAIL on `skip_junk_directories` / `walk_skips_node_modules_and_reads_ts`.

- [ ] **Step 3: Implement files.rs**

Replace the stub functions with:

```rust
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo", "out",
];

pub fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.iter().any(|d| name.eq_ignore_ascii_case(d))
}

pub fn should_skip_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if name.to_ascii_lowercase().ends_with(".d.ts") {
        return true;
    }
    match path.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()) {
        Some(ext) if matches!(ext.as_str(), "ts" | "tsx" | "js" | "jsx") => false,
        _ => true,
    }
}

pub fn read_files(paths: &[(PathBuf, String)]) -> PickResult {
    let mut out = PickResult::default();
    for (path, relative) in paths {
        if should_skip_file(path) {
            continue;
        }
        match fs::read_to_string(path) {
            Ok(text) => out.files.push(LoadedFile {
                relative_path: relative.clone(),
                absolute_path: path.to_string_lossy().into_owned(),
                text,
            }),
            Err(err) => out.errors.push(format!("{relative}: could not read file ({err})")),
        }
    }
    out
}

pub fn walk_folder(root: &Path) -> PickResult {
    let mut out = PickResult::default();
    walk_inner(root, root, &mut out);
    out
}

fn walk_inner(root: &Path, dir: &Path, out: &mut PickResult) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(err) => {
            out.errors.push(format!("{}: could not read file ({err})", display_rel(root, dir)));
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            walk_inner(root, &path, out);
            continue;
        }
        if should_skip_file(&path) {
            continue;
        }
        let relative = display_rel(root, &path);
        match fs::read_to_string(&path) {
            Ok(text) => out.files.push(LoadedFile {
                relative_path: relative,
                absolute_path: path.to_string_lossy().into_owned(),
                text,
            }),
            Err(err) => out.errors.push(format!("{relative}: could not read file ({err})")),
        }
    }
}

fn display_rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn write_text(absolute_path: &Path, text: &str) -> WriteResult {
    match fs::write(absolute_path, text) {
        Ok(()) => WriteResult { ok: true, error: None },
        Err(err) => WriteResult { ok: false, error: Some(err.to_string()) },
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/files.rs
git commit -m "feat: add native folder walk and save helpers"
```

---

### Task 5: Tauri shell + HTML dual-mode I/O

**Files:**
- Create: `src-tauri/src/lib.rs` (re-export files + Tauri `run`)
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `package.json`, `.gitignore`
- Modify: `src-tauri/Cargo.toml` (add tauri deps, `[[bin]]`, `[lib] crate-type`)
- Modify: `i18n-editor.html` (load/save buttons, overlay copy)

**Interfaces:**
- Consumes: `i18n_editor::walk_folder`, `read_files`, `write_text`, `PickResult`, `WriteResult`; JS `App.ingestFile(name, text, absolutePath)`, `App.commitFileSave`
- Produces: commands `pick_files`, `pick_folder`, `write_file`. JS `window.__TAURI__.core.invoke`. Browser path unchanged when `__TAURI__` is missing.

- [ ] **Step 1: Add gitignore and package.json**

`.gitignore`:

```
node_modules/
src-tauri/target/
src-tauri/gen/
```

`package.json`:

```json
{
  "name": "i18n-editor",
  "private": true,
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  }
}
```

- [ ] **Step 2: Expand Cargo.toml for Tauri 2**

One crate only. `files.rs` stays a module; `lib.rs` is the crate root. Replace `src-tauri/Cargo.toml` with:

```toml
[package]
name = "i18n-editor"
version = "0.1.0"
edition = "2021"

[lib]
name = "i18n_editor_lib"
crate-type = ["lib", "cdylib", "staticlib"]
path = "src/lib.rs"

[[bin]]
name = "i18n-editor"
path = "src/main.rs"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
serde = { version = "1", features = ["derive"] }
tauri = { version = "2", features = [] }
rfd = "0.15"

[dev-dependencies]
tempfile = "3"
```

Create `src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build();
}
```

Create `src-tauri/src/lib.rs`:

```rust
mod files;
pub use files::{
    read_files, walk_folder, write_text, LoadedFile, PickResult, WriteResult,
};

use std::path::PathBuf;
use tauri::command;

#[command]
async fn pick_files() -> PickResult {
    tauri::async_runtime::spawn_blocking(|| {
        let picked = rfd::FileDialog::new()
            .add_filter("i18n", &["ts", "tsx", "js", "jsx"])
            .pick_files()
            .unwrap_or_default();
        let pairs: Vec<(PathBuf, String)> = picked
            .into_iter()
            .map(|path| {
                let name = path
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "translations.ts".into());
                (path, name)
            })
            .collect();
        read_files(&pairs)
    })
    .await
    .unwrap_or_default()
}

#[command]
async fn pick_folder() -> PickResult {
    tauri::async_runtime::spawn_blocking(|| {
        match rfd::FileDialog::new().pick_folder() {
            Some(path) => walk_folder(&path),
            None => PickResult::default(),
        }
    })
    .await
    .unwrap_or_default()
}

#[command]
fn write_file(absolute_path: String, text: String) -> WriteResult {
    write_text(PathBuf::from(absolute_path).as_path(), &text)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![pick_files, pick_folder, write_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`rfd` 0.15 `FileHandle` uses `.path()`. If the compiler errors on `f.path()`, switch to `PathBuf::from(f)`.

Create `src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    i18n_editor_lib::run();
}
```

Create `src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "i18n Editor",
  "version": "0.1.0",
  "identifier": "com.i18neditor.app",
  "build": {
    "frontendDist": ["../i18n-editor.html"]
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "label": "main",
        "title": "i18n Editor",
        "width": 1280,
        "height": 860,
        "url": "i18n-editor.html"
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis", "deb", "appimage"]
  }
}
```

Create `src-tauri/capabilities/default.json`:

```json
{
  "identifier": "default",
  "description": "Main window",
  "windows": ["main"],
  "permissions": ["core:default"]
}
```

If `cargo test` fails because `lib.rs` is the crate root, keep `mod files;` in `lib.rs` and move the `#[cfg(test)]` module to stay in `files.rs` (it remains compiled as a submodule). Re-run:

`cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 3: Wire HTML load/save to Tauri when present**

At the top of the UI IIFE, after `const P = window.I18nParser;`:

```javascript
const tauri = typeof window !== 'undefined' ? window.__TAURI__ : null;
function invoke(cmd, args) {
  return tauri.core.invoke(cmd, args);
}
```

Add `ingestLoadedBatch(batch)` that appends files the same way `readFiles` does, using `absolutePath`:

```javascript
function ingestLoadedBatch(batch) {
  const loadErrors = (batch.errors || []).slice();
  const before = state.units.length;
  const items = batch.files || [];
  items.forEach(item => {
    const { file, roots, error } = App.ingestFile(item.relativePath, item.text, item.absolutePath);
    state.files.push(file);
    if (error) { loadErrors.push(`${item.relativePath}: ${error}`); return; }
    const units = App.deriveUnitsForFile(file, roots, items.length);
    if (units.length === 0) {
      loadErrors.push(`${item.relativePath}: parsed fine, but no exported object literal was found (no translations detected)`);
    }
    state.units.push(...units);
  });
  renderLoadErrors(loadErrors);
  if (state.units.length > before) {
    document.getElementById('empty-state').hidden = true;
    document.getElementById('loaded-view').hidden = false;
    document.getElementById('footer-bar').hidden = false;
  }
  renderAll();
}
```

Keep `readFiles` for the browser path (it continues to call `ingestFile(relPath, text)` with no absolute path).

Replace load-button wiring:

```javascript
async function loadViaTauri(cmd) {
  const batch = await invoke(cmd);
  ingestLoadedBatch(batch || { files: [], errors: [] });
}

if (tauri) {
  document.getElementById('load-files-btn').addEventListener('click', () => loadViaTauri('pick_files'));
  document.getElementById('empty-load-files').addEventListener('click', () => loadViaTauri('pick_files'));
  document.getElementById('load-folder-btn').addEventListener('click', () => loadViaTauri('pick_folder'));
  document.getElementById('empty-load-folder').addEventListener('click', () => loadViaTauri('pick_folder'));
} else {
  document.getElementById('load-files-btn').addEventListener('click', () => document.getElementById('file-input').click());
  document.getElementById('empty-load-files').addEventListener('click', () => document.getElementById('file-input').click());
  document.getElementById('load-folder-btn').addEventListener('click', () => document.getElementById('folder-input').click());
  document.getElementById('empty-load-folder').addEventListener('click', () => document.getElementById('folder-input').click());
  document.getElementById('file-input').addEventListener('change', (e) => { readFiles(e.target.files, false); e.target.value = ''; });
  document.getElementById('folder-input').addEventListener('change', (e) => { readFiles(e.target.files, true); e.target.value = ''; });
}
```

In `renderDownloadList`, if `tauri`, the multi-file button text is `Save all changed` instead of `Download all changed`. Per-file buttons still show the file name.

In `openValidationOverlay`, when `tauri` is present, **do not** call `downloadText`. Still set `pendingDownloadedOutputs` and show `#validation-actions` when `downloadIfValid` and every output is valid.

Change `#validation-actions` copy at runtime:

```javascript
const actionsCopy = document.querySelector('#validation-actions p');
const confirmBtn = document.getElementById('confirm-downloads-btn');
if (tauri) {
  actionsCopy.textContent = 'Review looks good. Write files overwrites the original paths on disk.';
  confirmBtn.textContent = 'Write files';
} else {
  actionsCopy.textContent = 'Downloads were started. Confirm only after your browser shows that the files were saved.';
  confirmBtn.textContent = 'Mark downloads as saved';
}
```

Replace the confirm button handler with an async function:

```javascript
document.getElementById('confirm-downloads-btn').addEventListener('click', async () => {
  if (!tauri) {
    pendingDownloadedOutputs.forEach(out => App.commitFileSave(state, out.fileId, out.newText));
    pendingDownloadedOutputs = [];
    document.getElementById('validation-overlay').hidden = true;
    validationReturnFocus = null;
    renderAll();
    return;
  }
  const body = document.getElementById('validation-body');
  for (const out of pendingDownloadedOutputs) {
    const file = state.files.find(f => f.id === out.fileId);
    if (!file || !file.absolutePath) {
      const box = el('div', 'v-file v-bad');
      box.appendChild(el('div', 'v-error-detail', `${displayFileName(out.fileName)}: no original path to write`));
      body.appendChild(box);
      continue;
    }
    const result = await invoke('write_file', { absolutePath: file.absolutePath, text: out.newText });
    if (result && result.ok) {
      App.commitFileSave(state, out.fileId, out.newText);
    } else {
      const box = el('div', 'v-file v-bad');
      box.appendChild(el('div', 'v-error-detail', `${displayFileName(out.fileName)}: ${result && result.error ? result.error : 'write failed'}`));
      body.appendChild(box);
    }
  }
  pendingDownloadedOutputs = [];
  document.getElementById('validation-overlay').hidden = true;
  validationReturnFocus = null;
  renderAll();
});
```

Failed writes must stay dirty: only call `commitFileSave` when `result.ok`. Continue the loop so later files still write.

- [ ] **Step 4: Verify both modes**

Run: `node --test i18n-editor.test.js`

Expected: PASS.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

Install CLI if needed: `npm install`

Run: `npx tauri dev`

Expected: window opens the same editor. Load folder skips `node_modules`. Edit a string, save, **Write files** overwrites the original path. Close overlay with Escape does not rebuild unless you wrote. Open `i18n-editor.html` via `file://` and confirm Load files still uses the file picker and download flow (`window.__TAURI__` undefined).

`frontendDist` must be the file array `["../i18n-editor.html"]` so the binary does not embed `docs/` or `src-tauri/`. The window `url` is `i18n-editor.html`. Do not add a second editor HTML.

- [ ] **Step 5: Commit**

```bash
git add i18n-editor.html package.json .gitignore src-tauri
git commit -m "feat: add Tauri shell with save-in-place"
```

---

## Self-review vs spec

| Spec item | Task |
|---|---|
| One `i18n-editor.html` for browser + shell | 3, 5 |
| Feature-detect `__TAURI__` | 5 |
| Virtualized grid, overscan 8, default 48px, search 80ms | 2, 3 |
| Collapse omits rows | 2 `listGridRows` |
| Overlay close does not `renderGrid` | 3 |
| `absolutePath` on files; ingest optional arg | 1, 5 |
| pick_files / pick_folder / write_file | 4, 5 |
| Skip dirs while walking | 4 |
| Browser download flow unchanged | 5 `else` branch |
| Shell Write files; per-file write errors stay dirty | 5 |
| Check all never writes | unchanged `downloadIfValid=false` |
| Column order bug | 1 |
| Tests: save order, window math, download names | 1, 2 (existing download test) |
| Windows/Linux bundle targets | 5 `nsis`, `deb`, `appimage` |
| No Electron, no JSON, no bundler | constraints |
