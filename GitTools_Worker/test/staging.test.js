// Index/staging precision: applying an export touches only what genuinely changed, and
// preserves the user's existing staging.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../test-support/helpers');
const { J } = h;

test('a re-export leaves an unchanged file that the user had already staged still staged', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.exportLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'init');
  h.exportLib(r, J, lib, { 'a.json': 'a1', 'b.json': 'b1' }); // uncommitted export
  h.git(r, 'add', '--', `${J}/b.json`);                       // user stages b (b1)
  h.exportLib(r, J, lib, { 'a.json': 'a2', 'b.json': 'b1' }); // re-export: a changes, b unchanged
  const sb = h.stat(r, `${J}/b.json`); const sa = h.stat(r, `${J}/a.json`);
  assert.equal(sb[0], 'M', 'b stays staged (modified in the index column)');
  assert.equal(h.read1(r, J, 'b.json'), 'b1', 'b content is unchanged');
  assert.ok(sa[0] === ' ' && sa[1] === 'M', 'a is modified but unstaged');
  assert.equal(h.read1(r, J, 'a.json'), 'a2', 'a content is updated');
});

test('a conflicting export leaves a clean, non-conflicting change unstaged', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.exportLib(r, J, lib, { 'a.json': 'a0' });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'import');
  h.commitSource(r, J, { 'a.json': 'aC' }, 'colleague edits a');
  const res = h.exportLib(r, J, lib, { 'a.json': 'aM', 'n.json': 'n1' }); // conflict on a, plus a new n
  assert.equal(res, 'conflict', 'a conflicts');
  assert.equal(h.stat(r, `${J}/a.json`), 'UU', 'a is unmerged');
  assert.equal(h.stat(r, `${J}/n.json`), '??', 'the new file is left untracked, not staged');
  assert.equal(h.read1(r, J, 'n.json'), 'n1', 'the new file content is present');
});

test('a conflicting export does not rewrite files whose content did not change', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const big = { 'a.json': 'a0' };
  for (let i = 1; i <= 40; i++) { big[`x/${i}.json`] = `const${i}`; }
  h.exportLib(r, J, lib, big);
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'import');
  h.commitSource(r, J, Object.assign({}, big, { 'a.json': 'aC' }), 'colleague edits a');
  const xfile = path.join(r, J, 'x', '7.json');
  const before = fs.statSync(xfile).mtimeMs;
  const big2 = { 'a.json': 'aM' };
  for (let i = 1; i <= 40; i++) { big2[`x/${i}.json`] = `const${i}`; }
  const res = h.exportLib(r, J, lib, big2); // conflict on a; every x/* file unchanged
  const after = fs.statSync(xfile).mtimeMs;
  assert.equal(res, 'conflict', 'a conflicts');
  assert.equal(before, after, 'an unchanged file is not rewritten (mtime preserved)');
  assert.equal(fs.readFileSync(xfile, 'utf8'), 'const7', 'its content is intact');
});

test('every path of a multi-file conflict is marked unmerged', () => {
  // The conflicted-merge apply force-removes all stage-0 entries in one batched git call
  // before adding the unmerged stage 1/2/3 records. If a path were dropped from that batch,
  // its surviving stage-0 entry would block the unmerged stages and it would not show as UU.
  const r = h.newRepo(); const lib = h.libOf(r);
  const base = {}; for (let i = 1; i <= 12; i++) { base[`f${i}.json`] = `v0-${i}`; }
  h.exportLib(r, J, lib, base);
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'import');
  const colleague = {}; for (let i = 1; i <= 12; i++) { colleague[`f${i}.json`] = `colleague-${i}`; }
  h.commitSource(r, J, colleague, 'colleague edits all 12');
  const mine = {}; for (let i = 1; i <= 12; i++) { mine[`f${i}.json`] = `mine-${i}`; }
  assert.equal(h.exportLib(r, J, lib, mine), 'conflict', 'all 12 files conflict (modify/modify)');
  let uu = 0;
  for (let i = 1; i <= 12; i++) { if (h.stat(r, `${J}/f${i}.json`) === 'UU') { uu++; } }
  assert.equal(uu, 12, 'all 12 conflicting paths are marked unmerged');
});
