// Resilience to operations interrupted mid-flight: a crashed phase, a stale cache index, or
// a half-finished atomic write must not corrupt the next export.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../test-support/helpers');
const { J } = h;

const BOGUS_OID = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'; // a 40-char object id that does not exist

test('a leftover handoff from an interrupted pre-export is swept and the next export succeeds', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  // Simulate a pre-export that wrote its handoff then died before post-export: plant a stale
  // handoff with bogus trees directly in the state dir.
  fs.writeFileSync(h.handoffPath(r, J, lib), JSON.stringify({ op: 'export', currentSourceTree: BOGUS_OID, mergeBase: BOGUS_OID }));
  const res = h.exportLib(r, J, lib, { 'a.json': 'a1', 'b.json': 'b1' });
  assert.equal(res, 'clean', 'the export succeeds despite the stale handoff');
  assert.equal(h.read1(r, J, 'a.json'), 'a1', 'a is correct');
  assert.equal(h.read1(r, J, 'b.json'), 'b1', 'b is correct');
});

test('the incremental export tree rebuilds correctly from a stale cache index', () => {
  // A crash can leave the persistent cache index describing an older directory state than
  // what is now on disk. The next incremental build must still produce the exact tree a full
  // rebuild would, by diffing the stale index against the current files.
  const r = h.newRepo(); const lib = h.libOf(r);
  const git = h.ctxFor(r, J, lib).git;

  const cache = h.track(h.tmpName('cache'));
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'a.json'), 'v1');
  fs.writeFileSync(path.join(cache, 'b.json'), 'v2');
  fs.writeFileSync(path.join(cache, 'c.json'), 'v3');

  const idx = h.track(h.tmpName('index'));
  git.invoke(['read-tree', '--empty'], { indexFile: idx });
  git.hashTree(null, { indexFile: idx, workTree: cache }); // index now in step with the dir

  // "Crash": the directory changes but the index is not updated.
  fs.writeFileSync(path.join(cache, 'a.json'), 'v1-changed'); // modify
  fs.rmSync(path.join(cache, 'b.json'));                      // delete
  fs.writeFileSync(path.join(cache, 'd.json'), 'v4');         // add
  const incremental = git.hashTree(null, { indexFile: idx, workTree: cache });

  // Ground truth: a full rebuild over the current directory (incremental from an empty index).
  const idxFull = h.track(h.tmpName('index-full'));
  git.invoke(['read-tree', '--empty'], { indexFile: idxFull });
  const fullRebuild = git.hashTree(null, { indexFile: idxFull, workTree: cache });

  assert.equal(incremental, fullRebuild, 'the incremental tree from a stale index equals a full rebuild');
});

test('stray .tmp files from an interrupted atomic write do not corrupt the next export', () => {
  // meta.json and the handoff are written to a sibling .tmp then atomically renamed, so an
  // interrupted write leaves a stray .tmp but never a half-written target. Plant garbage .tmp
  // files and confirm the next export reads the real files and completes correctly.
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0' });
  const state = h.stateRoot(r, J, lib);
  fs.writeFileSync(path.join(state, 'meta.json.tmp'), '{ this is not valid json');
  fs.writeFileSync(path.join(state, 'pending-op.json.tmp'), 'garbage');
  const res = h.exportLib(r, J, lib, { 'a.json': 'a1' });
  assert.equal(res, 'clean', 'the export completes despite the stray .tmp files');
  assert.equal(h.read1(r, J, 'a.json'), 'a1', 'a is correct');
  const metaText = fs.readFileSync(path.join(state, 'meta.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(metaText), 'meta.json is valid, never half-written');
});
