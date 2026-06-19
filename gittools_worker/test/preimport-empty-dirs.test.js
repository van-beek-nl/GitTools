// Pre-import prunes empty directories under the JSON path before Omnis imports. Omnis Studio
// chokes on directories that lack the files it expects, and Git readily leaves empty folders
// behind when discarding work, so pre-import sweeps them away. A directory holding only OS junk
// (.DS_Store, Thumbs.db, ...) counts as empty: the junk is deleted along with it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const h = require('../test-support/helpers');
const { run } = require('../src/core.js');
const { J } = h;

// Absolute path of `rel` under the JSON export root.
function jp(repo, rel) { return path.join(repo, J, rel || ''); }
function mkdirs(repo, rel) { fs.mkdirSync(jp(repo, rel), { recursive: true }); }
function exists(repo, rel) { return fs.existsSync(jp(repo, rel)); }
function writeFile(repo, rel, content) {
  const p = jp(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// Run pre-import in-process and return the import source path it reports.
function preImport(repo, lib) {
  const res = run(h.request('preImport', repo, J, lib));
  if (!res.ok) { throw new Error(`preImport failed: ${res.error.code}: ${res.error.message}`); }
  return res.source;
}

test('removes a chain of nested empty directories bottom-up', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  mkdirs(r, 'A/B/C');

  preImport(r, lib);

  assert.ok(!exists(r, 'A'), 'the whole empty chain is gone');
  assert.ok(exists(r, ''), 'the export root itself remains');
});

test('removes a directory that holds only junk, deleting the junk with it', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  writeFile(r, 'D/.DS_Store', 'junk');

  preImport(r, lib);

  assert.ok(!exists(r, 'D'), 'a junk-only directory is removed');
});

test('keeps a directory that contains a real file', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  writeFile(r, 'E/class.json', '{}');

  preImport(r, lib);

  assert.ok(exists(r, 'E/class.json'), 'a directory with real content is left intact');
});

test('keeps a parent with real content but prunes its empty child', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  writeFile(r, 'F/class.json', '{}');
  mkdirs(r, 'F/empty');

  preImport(r, lib);

  assert.ok(exists(r, 'F/class.json'), 'the parent is kept for its real content');
  assert.ok(!exists(r, 'F/empty'), 'the empty child is pruned');
});

test('never removes the export root, even when it is empty', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  fs.mkdirSync(jp(r), { recursive: true });

  preImport(r, lib);

  assert.ok(exists(r, ''), 'the export root survives an otherwise-empty tree');
});

test('does not follow or remove a directory whose only entry is a symlink', (t) => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const target = path.join(r, 'target');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'f'), 'x');
  mkdirs(r, 'H');
  try {
    fs.symlinkSync(target, jp(r, 'H/link'), 'dir');
  } catch (e) {
    t.skip('symlinks unsupported on this platform');
    return;
  }

  preImport(r, lib);

  assert.ok(exists(r, 'H'), 'a directory holding only a symlink is treated as non-empty');
  assert.ok(fs.lstatSync(jp(r, 'H/link')).isSymbolicLink(), 'the symlink itself is left in place');
});

test('returns the JSON path as the import source', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  writeFile(r, 'C/class.json', '{}');

  const source = preImport(r, lib);

  assert.equal(source, path.join(fs.realpathSync(r), J), 'pre-import reports the JSON path to import from');
});
