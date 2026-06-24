// hashTree falls back to its from-scratch builder whenever the index has unmerged entries
// (anywhere). That builder seeds the tree from `ls-files --stage`, which must take only stage-0
// (merged) entries — an unrelated conflict elsewhere in the index must not corrupt or drop the
// clean export subtree. Guards the stage-0 restriction in that path.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../test-support/helpers');
const { J } = h;

test('the from-scratch hashTree path hashes a clean export subtree to its committed tree despite an unrelated conflict in the index', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.commitSource(r, J, { 'a.json': 'A', 'sub/b.json': 'B' }, 'baseline source');
  const main = h.git(r, 'branch', '--show-current');

  // Force an unrelated merge conflict so the index carries unmerged entries (-> from-scratch path).
  fs.writeFileSync(path.join(r, 'OTHER.txt'), 'base'); h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'other base');
  h.git(r, 'checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(r, 'OTHER.txt'), 'theirs'); h.git(r, 'commit', '-q', '-am', 'other theirs');
  h.git(r, 'checkout', '-q', main);
  fs.writeFileSync(path.join(r, 'OTHER.txt'), 'mine'); h.git(r, 'commit', '-q', '-am', 'other mine');
  h.gitTry(r, 'merge', 'side'); // conflicts on OTHER.txt; the export subtree stays clean

  const git = h.ctxFor(r, J, lib).git;
  assert.ok(git.indexHasUnmergedEntries(), 'precondition: index has unmerged entries, forcing the from-scratch path');
  assert.equal(git.hashTree(J), h.git(r, 'rev-parse', `HEAD:${J}`), 'the clean export subtree hashes to its committed tree');
});
