// The cleanIrrelevantKeys option: when set, post-export reverts the import-irrelevant, churn-prone
// keys (moddate, internalversion) to the source's values before reconciling, so they neither show
// up as diffs nor drive merge conflicts. Off by default, the export is applied verbatim.

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

const ON = { cleanIrrelevantKeys: true };

const klass = (moddate, internalversion, body) =>
  `{\n  "name": "C",\n  "moddate": ${moddate},\n  "internalversion": ${internalversion},\n  "body": "${body}"\n}\n`;

test('an export that only bumps irrelevant keys reconciles clean and leaves the source untouched', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const imported = klass(100, 1, 'real');
  h.importLib(r, J, lib, { 'C/class.json': imported });

  // Omnis re-exports the same class with only moddate/internalversion bumped.
  const res = h.exportLib(r, J, lib, { 'C/class.json': klass(999, 7, 'real') }, ON);

  assert.equal(res, 'clean', 'irrelevant-only churn does not conflict');
  assert.equal(h.readSrc(r, J)['C/class.json'], imported, 'the irrelevant keys are reverted to the source values');
  assert.equal(h.stat(r, J), '  ', 'no working-tree change is left behind');
});

test('an irrelevant-key bump alongside a real change keeps the real change and reverts only the keys', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'C/class.json': klass(100, 1, 'old') });

  const res = h.exportLib(r, J, lib, { 'C/class.json': klass(999, 7, 'new') }, ON);

  assert.equal(res, 'clean');
  assert.equal(h.readSrc(r, J)['C/class.json'], klass(100, 1, 'new'),
    'the body change is kept while the irrelevant keys are reverted to the source values');
});

test('irrelevant-key churn does not collide with a colleague who only bumped the same keys', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.exportLib(r, J, lib, { 'C/class.json': klass(100, 1, 'real') }, ON);
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'import');

  // Colleague commits a different moddate; our export bumps it differently again.
  h.commitSource(r, J, { 'C/class.json': klass(555, 5, 'real') }, 'colleague reopens class');
  const res = h.exportLib(r, J, lib, { 'C/class.json': klass(999, 7, 'real') }, ON);

  assert.equal(res, 'clean', 'diverging irrelevant keys do not produce a conflict');
  assert.ok(!h.hasConflict(r, J), 'nothing is left unresolved');
  assert.equal(h.readSrc(r, J)['C/class.json'], klass(555, 5, 'real'), "the source's irrelevant-key values stand");
});

test('a brand-new exported class keeps its own irrelevant-key values', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'C/class.json': klass(100, 1, 'real') });

  // D is new in this export, so there is no source counterpart to revert to.
  const res = h.exportLib(r, J, lib, {
    'C/class.json': klass(100, 1, 'real'),
    'D/class.json': klass(42, 3, 'fresh'),
  }, ON);

  assert.equal(res, 'clean');
  assert.equal(h.readSrc(r, J)['D/class.json'], klass(42, 3, 'fresh'), 'the new file keeps its initial values');
});

test('without the option, an irrelevant-key bump is applied verbatim', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'C/class.json': klass(100, 1, 'real') });

  // No cleanIrrelevantKeys flag: the export is reconciled as-is, keys included.
  const res = h.exportLib(r, J, lib, { 'C/class.json': klass(999, 7, 'real') });

  assert.equal(res, 'clean');
  assert.equal(h.readSrc(r, J)['C/class.json'], klass(999, 7, 'real'), 'the bumped keys are left in place');
});

// The scrub must never write back into the export cache. Omnis' export is incremental: it
// re-exports a class when the copy in the JSON tree no longer matches what it last wrote there
// ($comparejson calls that a "conflict", and GitTools runs with exportoverwritesconflicts=kTrue).
// Rewriting class.json in the cache therefore made every scrubbed class permanently conflicted, so
// Omnis re-exported the same set forever -- measured in the field as 32 of 1201 class directories
// rewritten on every run, exactly the set GitTools had doctored, while the other 1169 went two days
// untouched. Keeping the cache byte-identical is what lets the cache do its job.
test('scrubbing leaves the export cache byte-identical to what Omnis wrote', () => {
  const fs = require('fs');
  const path = require('path');

  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'C/class.json': klass(100, 1, 'real') });

  const exported = klass(999, 7, 'real');
  const cacheFile = path.join(h.cacheDir(r, J, lib), 'C', 'class.json');

  const res = h.exportLib(r, J, lib, { 'C/class.json': exported }, ON);

  assert.equal(res, 'clean');
  // The scrub still happened where it matters: the working tree carries the source's key values.
  assert.equal(h.readSrc(r, J)['C/class.json'], klass(100, 1, 'real'), 'the tree still gets scrubbed values');
  // ...but Omnis' own bytes are still sitting in the cache, so it will not see a conflict next run.
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), exported, 'the cache still holds exactly what Omnis wrote');
  // And no scratch staging is left lying around next to the cache.
  assert.equal(fs.existsSync(path.join(path.dirname(h.cacheDir(r, J, lib)), 'scrub-staging')), false,
    'the staging directory is cleaned up');
});
