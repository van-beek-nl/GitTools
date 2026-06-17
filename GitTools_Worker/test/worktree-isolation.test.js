// State scoping across git worktrees: mutable state (the export cache, meta, pending refs)
// is per-worktree, while the durable base lineage is shared. Every call passes the SAME
// library path for both worktrees, forcing one shared state key - the stress case for
// cross-worktree isolation.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./helpers');
const { J } = h;

// A linked worktree of `repo` at a fresh temp path on a new branch, cleaned up at exit.
function addWorktree(repo, branch) {
  const wt = h.track(h.tmpName('linked-worktree'));
  h.git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'HEAD');
  return wt;
}

test('mutable state is isolated per worktree while the base lineage is shared', () => {
  const main = h.newRepo(); const lib = path.join(main, 'Lib.lbs'); // same lib for both -> one state key
  h.importLib(main, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  const wt = addWorktree(main, 'wtbranch');
  assert.ok(fs.existsSync(path.join(wt, J)), 'the linked worktree has the source checked out');

  // A marker written in main's state dir must NOT be visible from the worktree's.
  const cacheMain = h.cacheDir(main, J, lib);
  fs.mkdirSync(cacheMain, { recursive: true });
  const sentinel = `iso-${Math.random().toString(16).slice(2)}.marker`;
  fs.writeFileSync(path.join(cacheMain, sentinel), 'x');
  const cacheWt = h.cacheDir(wt, J, lib);
  assert.ok(!fs.existsSync(path.join(cacheWt, sentinel)), "main's state marker is not visible from the worktree");
  assert.notEqual(cacheMain, cacheWt, 'the two state dirs are distinct paths');

  // The base ref main recorded at import is visible from the worktree, and identical.
  const baseMain = h.baseRefTarget(main, J, lib);
  const baseWt = h.baseRefTarget(wt, J, lib);
  assert.ok(baseWt !== '' && baseWt === baseMain, 'the base lineage ref is shared across worktrees');
});

test('a worktree that never imported reconciles through the shared base lineage', () => {
  // The worktree's own meta is empty, but the shared base lets its export find the true
  // common ancestor against its own HEAD, while main's per-worktree meta stays untouched.
  const main = h.newRepo(); const lib = path.join(main, 'Lib.lbs');
  h.importLib(main, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  const wt = addWorktree(main, 'wtbranch');

  const metaMainBefore = h.readMeta(main, J, lib);
  const res = h.exportLib(wt, J, lib, { 'a.json': 'a1', 'b.json': 'b0' });
  assert.equal(res, 'clean', 'the worktree export reconciles against the shared base');
  assert.equal(h.read1(wt, J, 'a.json'), 'a1', "the worktree's live source is updated");
  const metaMainAfter = h.readMeta(main, J, lib);
  assert.ok(
    metaMainAfter.baseTree === metaMainBefore.baseTree && metaMainAfter.sourceTree === metaMainBefore.sourceTree,
    "main's per-worktree meta is unchanged by the worktree's export"
  );
});

test("a conflict raised in a worktree stays in that worktree's index and never main's", () => {
  const main = h.newRepo(); const lib = path.join(main, 'Lib.lbs');
  h.importLib(main, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  const wt = addWorktree(main, 'wtbranch2');

  fs.writeFileSync(path.join(main, 'README.md'), 'staged in main');
  h.git(main, 'add', 'README.md');
  fs.writeFileSync(path.join(wt, J, 'b.json'), 'bC');
  h.git(wt, 'add', '-A'); h.git(wt, 'commit', '-q', '-m', 'worktree colleague edits b');

  const res = h.exportLib(wt, J, lib, { 'a.json': 'a0', 'b.json': 'bD' });
  assert.equal(res, 'conflict', 'the worktree export conflicts (b edited on both sides)');
  assert.equal(h.stat(wt, `${J}/b.json`), 'UU', "the conflict lives in the worktree's index");

  const mainPorcelain = h.gitTry(main, 'status', '--porcelain').stdout.split(/\r?\n/);
  assert.ok(mainPorcelain.includes('A  README.md'), "main's staged README is untouched");
  assert.ok(!mainPorcelain.some((l) => /^(U.|.U|DD|AA)/.test(l)), "no unmerged entries leaked into main's index");
});

test("a routine export from one worktree leaves another worktree's pending conflict intact", () => {
  // Regression for the shared-state bug: main holds an in-progress export conflict; a routine
  // export from another worktree (same shared library) must leave main's pending state intact.
  const main = h.newRepo(); const lib = path.join(main, 'Lib.lbs');
  h.importLib(main, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  h.commitSource(main, J, { 'a.json': 'a0', 'b.json': 'bC' }, 'colleague edits b');
  const res = h.exportLib(main, J, lib, { 'a.json': 'a0', 'b.json': 'bD' }); // main conflicts on b
  assert.ok(
    res === 'conflict' && h.readMeta(main, J, lib).status === 'pendingExportConflict' && h.pendingExists(main, J, lib),
    'main is left in a pending export-conflict'
  );

  const wt = addWorktree(main, 'wtbranch3');
  const resWt = h.exportLib(wt, J, lib, { 'a.json': 'aX', 'b.json': 'bC' }); // unrelated export from the worktree
  assert.equal(resWt, 'clean', 'the worktree export completes');
  assert.equal(h.readMeta(main, J, lib).status, 'pendingExportConflict', "main's pending conflict survives");
  assert.ok(h.pendingExists(main, J, lib), "main's pending durability refs survive");
  assert.equal(h.stat(main, `${J}/b.json`), 'UU', "main's working-tree conflict is still present");
});
