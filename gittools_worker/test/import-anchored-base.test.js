// Acceptance: an import replaces the whole library, so only library output since the latest import
// (and the commit it was imported from) can be a common ancestor with git. Content the library
// produced before that import must not be taken as the base, or an export silently reverts work
// that reached git later. Changes made in the library must still always be exported.

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

const L = (...a) => a.join('\n') + '\n';
const A0 = L('l1', 'l2', 'l3', 'l4', 'l5');
const X = L('l1', 'l2-feature', 'l3', 'l4', 'l5');
const A = L('l1', 'l2', 'l3', 'l4-main', 'l5');
const AX = L('l1', 'l2-feature', 'l3', 'l4-main', 'l5');

const branchOf = (r) => h.git(r, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

// Pins git's clock so history order does not depend on how fast the test runs.
function at(seconds) {
  const date = `${1900000000 + seconds} +0000`;
  process.env.GIT_AUTHOR_DATE = date;
  process.env.GIT_COMMITTER_DATE = date;
}
function clearClock() {
  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;
}

// Changes made in the library are exported, whatever git did with them before.

test('a change a peer reverted is re-exported while the library still holds it', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'f.json': A0 });
  h.exportLib(r, J, lib, { 'f.json': X });
  h.git(r, 'commit', '-qam', 'X');
  h.commitSource(r, J, { 'f.json': A0 }, 'peer reverts X');

  h.exportLib(r, J, lib, { 'f.json': X });
  assert.equal(h.read1(r, J, 'f.json'), X);
});

test('a change redone in the library after importing a peer revert is exported', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'f.json': A0 });
  h.exportLib(r, J, lib, { 'f.json': X });
  h.git(r, 'commit', '-qam', 'X');
  h.commitSource(r, J, { 'f.json': A0 }, 'peer reverts X');
  h.runOp('postImport', r, J, lib);

  h.exportLib(r, J, lib, { 'f.json': X });
  assert.equal(h.read1(r, J, 'f.json'), X);
});

test('undoing an exported change in the library reaches git', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'f.json': A0 });
  h.exportLib(r, J, lib, { 'f.json': X });
  h.git(r, 'commit', '-qam', 'X');

  h.exportLib(r, J, lib, { 'f.json': A0 });
  assert.equal(h.read1(r, J, 'f.json'), A0);
});

test('undoing a change after importing it back reaches git', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'f.json': A0 });
  h.exportLib(r, J, lib, { 'f.json': X });
  h.git(r, 'commit', '-qam', 'X');
  h.runOp('postImport', r, J, lib);

  h.exportLib(r, J, lib, { 'f.json': A0 });
  assert.equal(h.read1(r, J, 'f.json'), A0);
});

// Files left untouched since the latest import keep what git did after it.

test('a feature merged in git after importing main is not reverted by the next export', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'f.json': A0, 'g.json': 'g0' });
  const main = branchOf(r);
  h.git(r, 'checkout', '-q', '-b', 'feature');
  h.exportLib(r, J, lib, { 'f.json': X, 'g.json': 'g0' });
  h.git(r, 'commit', '-qam', 'feature X');
  h.git(r, 'checkout', '-q', main);
  h.commitSource(r, J, { 'f.json': A0, 'g.json': 'g-main' }, 'main changes g');
  h.runOp('postImport', r, J, lib);
  h.git(r, 'merge', '-q', '--no-edit', 'feature');

  h.exportLib(r, J, lib, { 'f.json': A0, 'g.json': 'g-main' });
  assert.equal(h.read1(r, J, 'f.json'), X);
});

for (const featureLast of [true, false]) {
  test(`a merged feature survives when both branches edited the file (${featureLast ? 'feature' : 'main'} committed last)`, () => {
    const r = h.newRepo(); const lib = h.libOf(r);
    try {
      at(0);
      h.importLib(r, J, lib, { 'f.json': A0 });
      const main = branchOf(r);
      h.git(r, 'branch', 'feature');
      const onFeature = () => {
        h.git(r, 'checkout', '-q', 'feature');
        h.exportLib(r, J, lib, { 'f.json': X });
        h.git(r, 'commit', '-qam', 'feature X');
        h.git(r, 'checkout', '-q', main);
      };
      const onMain = () => h.commitSource(r, J, { 'f.json': A }, 'main A');
      at(10);
      (featureLast ? onMain : onFeature)();
      at(20);
      (featureLast ? onFeature : onMain)();
      at(30);
      h.runOp('postImport', r, J, lib);
      h.git(r, 'merge', '-q', '--no-edit', 'feature');

      h.exportLib(r, J, lib, { 'f.json': A });
      assert.equal(h.read1(r, J, 'f.json'), AX);
    } finally {
      clearClock();
    }
  });
}

test('a feature merged after another worktree imported is not reverted by the next export', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'f.json': A0, 'g.json': 'g0' });
  const wt = h.track(h.tmpName('linked-worktree'));
  h.git(r, 'worktree', 'add', '-q', '-b', 'feature', wt, 'HEAD');
  h.exportLib(wt, J, lib, { 'f.json': X, 'g.json': 'g0' });
  h.git(wt, 'commit', '-qam', 'feature X');

  h.commitSource(r, J, { 'f.json': A0, 'g.json': 'g-main' }, 'main changes g');
  h.runOp('postImport', r, J, lib);
  h.git(wt, 'merge', '-q', '--no-edit', branchOf(r));

  h.exportLib(wt, J, lib, { 'f.json': A0, 'g.json': 'g-main' });
  assert.equal(h.read1(wt, J, 'f.json'), X);
  assert.equal(h.read1(wt, J, 'g.json'), 'g-main');
});

// Content the library only imported from another branch is not exported onto this one; the
// developer's own edits are, whatever older output the lineage happens to hold.

for (const forkImported of [false, true]) {
  test(`switching branches without importing exports only the library's own edits (fork ${forkImported ? '' : 'not '}imported before)`, () => {
    const r = h.newRepo(); const lib = h.libOf(r);
    const fork = { 'f.json': A0, 'g.json': 'g0' };
    if (forkImported) { h.importLib(r, J, lib, fork); } else { h.commitSource(r, J, fork, 'fork point'); }
    h.git(r, 'branch', 'feature');
    h.importLib(r, J, lib, { 'f.json': A, 'g.json': 'g0' });
    h.git(r, 'checkout', '-q', 'feature');

    h.exportLib(r, J, lib, { 'f.json': A, 'g.json': 'g1' });
    assert.equal(h.read1(r, J, 'f.json'), A0, "the other branch's content stays there");
    assert.equal(h.read1(r, J, 'g.json'), 'g1', 'the own edit is exported');
  });
}

// Robustness.

test('an import over uncommitted source still resurfaces that source once git discards it', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'f.json': A0 });
  h.exportLib(r, J, lib, { 'f.json': X });
  h.runOp('postImport', r, J, lib);
  h.commitSource(r, J, { 'f.json': A0, 'g.json': 'peer' }, 'peer adds g');

  h.exportLib(r, J, lib, { 'f.json': X, 'g.json': 'peer' });
  assert.equal(h.read1(r, J, 'f.json'), X);
});

test('an import whose commit no longer exists still merges', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'f.json': A0, 'g.json': 'g0' });
  h.git(r, 'commit', '-q', '--amend', '-m', 'rewritten');
  for (const ref of h.git(r, 'for-each-ref', '--format=%(refname)', 'refs/gittools').split('\n').filter(Boolean)) {
    if (!ref.endsWith('/base')) { h.git(r, 'update-ref', '-d', ref); }
  }
  h.git(r, 'reflog', 'expire', '--expire=now', '--all');
  h.git(r, 'gc', '-q', '--prune=now');
  h.commitSource(r, J, { 'f.json': A, 'g.json': 'g0' }, 'peer edits f');

  assert.equal(h.exportLib(r, J, lib, { 'f.json': A0, 'g.json': 'g1' }), 'clean');
  assert.equal(h.read1(r, J, 'f.json'), A);
  assert.equal(h.read1(r, J, 'g.json'), 'g1');
});

// Lineages written by older GitTools carry no import markers; they keep matching the whole lineage.
test('a lineage without import markers still recognises partly committed exports', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'f.json': A0, 'env.json': 'e0' });
  h.commitSource(r, J, { 'f.json': A0, 'env.json': 'peer' }, 'peer touches env');
  assert.equal(h.exportLib(r, J, lib, { 'f.json': X, 'env.json': 'lib' }), 'conflict');
  h.git(r, 'checkout', 'HEAD', '--', `${J}/env.json`);
  h.git(r, 'add', '--', `${J}/f.json`);
  h.git(r, 'commit', '-q', '-m', 'commit only f');

  // Rewrite the lineage as an older GitTools would have recorded it.
  const ref = `refs/gittools/${h.stateKey(r, J, lib)}/base`;
  let parent = '';
  for (const tree of h.git(r, 'rev-list', '--reverse', '--format=%T', '--no-commit-header', ref).split('\n').filter(Boolean)) {
    parent = h.git(r, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'GitTools base').trim();
  }
  h.git(r, 'update-ref', ref, parent);
  h.commitSource(r, J, { 'f.json': L('l1', 'l2-peer', 'l3', 'l4', 'l5'), 'env.json': 'peer' }, 'peer rewrites the line');

  assert.equal(h.exportLib(r, J, lib, { 'f.json': X, 'env.json': 'lib' }), 'conflict');
  assert.equal(h.stat(r, `${J}/f.json`), '  ', 'f is not conflicted');
  assert.equal(h.read1(r, J, 'f.json'), L('l1', 'l2-peer', 'l3', 'l4', 'l5'));
});
