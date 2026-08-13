const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadModules() {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.ok(scripts.length >= 2, 'expected parser and app script blocks');

  const parserModule = { exports: {} };
  vm.runInNewContext(scripts[0], { module: parserModule, exports: parserModule.exports, console });
  const Parser = parserModule.exports;

  const appModule = { exports: {} };
  const loadApp = new Function(
    'module', 'exports', 'require', 'global',
    `${scripts[1]}\n//# sourceURL=i18n-app.js`,
  );
  loadApp(appModule, appModule.exports, (specifier) => {
    if (specifier === './parser') return Parser;
    throw new Error(`Unexpected require: ${specifier}`);
  }, global);
  return { Parser, App: appModule.exports };
}

const { Parser, App } = loadModules();

test('array nodes retain their original source text', () => {
  const root = Parser.findRoots('export default { choices: ["one", "two"] };')[0].node;
  const flat = Parser.flatten(root, '');
  assert.equal(flat.choices.kind, 'array');
  assert.equal(flat.choices.node.raw, '["one", "two"]');
});

test('locale-like section names in en.ts remain one language tree', () => {
  const source = `export default {
    nav: { home: "Home" },
    app: { title: "My app" },
  };`;
  const parsed = App.ingestFile('en.ts', source);
  assert.equal(parsed.error, null);
  const units = App.deriveUnitsForFile(parsed.file, parsed.roots, 1);
  assert.deepEqual(Array.from(units, unit => unit.lang), ['en']);
  assert.deepEqual(Object.keys(App.flatForUnit(units[0])), ['nav.home', 'app.title']);
});

test('combined two-letter language maps are still detected', () => {
  const source = `export const messages = {
    en: { greeting: "Hello" },
    fr: { greeting: "Bonjour" },
  };`;
  const parsed = App.ingestFile('translations.ts', source);
  const units = App.deriveUnitsForFile(parsed.file, parsed.roots, 1);
  assert.deepEqual(Array.from(units, unit => unit.lang), ['en', 'fr']);
  assert.deepEqual(Array.from(units, unit => unit.sourceLang), ['en', 'fr']);
});

test('overlapping three-letter language maps remain supported', () => {
  const root = Parser.findRoots(`export default {
    eng: { greeting: "Hello" },
    fra: { greeting: "Bonjour" },
  };`)[0].node;
  assert.equal(Parser.looksLikeLanguageMap(root), true);
});

test('renaming a combined-file display label does not break validation', () => {
  const source = `export const messages = {
    en: { greeting: "Hello" },
    fr: { greeting: "Bonjour" },
  };`;
  const parsed = App.ingestFile('translations.ts', source);
  const units = App.deriveUnitsForFile(parsed.file, parsed.roots, 1);
  units[0].lang = 'English';
  const state = { files: [parsed.file], units, edits: {} };
  App.setCell(state, units[0].id, 'greeting', 'Hi');
  const output = App.computeFileOutput(state, parsed.file);
  assert.equal(output.valid, true, output.error);
  assert.equal(output.changes[0].lang, 'English');
  assert.match(output.newText, /en: \{ greeting: "Hi" \}/);
});

test('empty edits for absent keys remain visibly missing', () => {
  const parsed = App.ingestFile('en.ts', 'export default { greeting: "Hello" };');
  const unit = App.deriveUnitsForFile(parsed.file, parsed.roots, 1)[0];
  const state = { files: [parsed.file], units: [unit], edits: {} };
  App.setCell(state, unit.id, 'missing', '');
  const cell = App.getCell(state, unit, 'missing');
  assert.equal(cell.kind, 'missing');
  assert.equal(cell.dirty, true);
});

test('missing-key insertion preserves CRLF, indentation, comments, and trailing commas', () => {
  const source = 'export default {\r\n\tgroup: {\r\n\t\talpha: "A", // explains alpha\r\n\t},\r\n}\r\n';
  const root = Parser.findRoots(source)[0].node;
  const edits = Parser.planBatchInsertions(source, root, [{ path: 'group.beta', value: 'B', quote: '"' }]);
  const output = Parser.applyEdits(source, edits);
  assert.equal(/(?<!\r)\n/.test(output), false, 'output introduced bare LF line endings');
  assert.match(output, /alpha: "A", \/\/ explains alpha\r\n\t\tbeta: "B",\r\n\t\}/);
  assert.equal(Parser.findRoots(output).length, 1);
});

test('missing-key insertion keeps a trailing comment attached to its original property', () => {
  const source = 'export default {\n  alpha: "A" // explains alpha\n}\n';
  const root = Parser.findRoots(source)[0].node;
  const edits = Parser.planBatchInsertions(source, root, [{ path: 'beta', value: 'B', quote: '"' }]);
  const output = Parser.applyEdits(source, edits);
  assert.match(output, /alpha: "A", \/\/ explains alpha\n  beta: "B"\n\}/);
  assert.equal(Parser.findRoots(output).length, 1);
});

test('batched missing keys merge new shared branches', () => {
  const source = 'export default { existing: "value" };';
  const root = Parser.findRoots(source)[0].node;
  const edits = Parser.planBatchInsertions(source, root, [
    { path: 'account.title', value: 'Account', quote: '"' },
    { path: 'account.description', value: 'Description', quote: '"' },
  ]);
  const output = Parser.applyEdits(source, edits);
  const flat = Parser.flatten(Parser.findRoots(output)[0].node, '');
  assert.equal(flat['account.title'].node.value, 'Account');
  assert.equal(flat['account.description'].node.value, 'Description');
  assert.equal((output.match(/account:/g) || []).length, 1);
});

test('download names retain relative-path identity without illegal characters', () => {
  assert.equal(App.downloadFileName('en/index.ts'), 'en__index.ts');
  assert.equal(App.downloadFileName('fr\\index.ts'), 'fr__index.ts');
  assert.equal(App.downloadFileName('translations.ts'), 'translations.ts');
});

test('ingestFile stores optional absolutePath', () => {
  const parsed = App.ingestFile('en.ts', 'export default { greeting: "Hello" };', 'D:/proj/en.ts');
  assert.equal(parsed.file.absolutePath, 'D:/proj/en.ts');
  const browser = App.ingestFile('en.ts', 'export default { greeting: "Hello" };');
  assert.equal(browser.file.absolutePath, null);
});

test("commitFileSave keeps a middle file's units in place", () => {
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
