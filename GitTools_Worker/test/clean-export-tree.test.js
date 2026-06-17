// Post-export reverts the import-irrelevant, churn-prone keys (moddate, internalversion) to the
// source's values before reconciling, so they neither show up as diffs nor drive merge conflicts.

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

const klass = (moddate, internalversion, body) =>
  `{\n  "name": "C",\n  "moddate": ${moddate},\n  "internalversion": ${internalversion},\n  "body": "${body}"\n}\n`;

test('an export that only bumps irrelevant keys reconciles clean and leaves the source untouched', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const imported = klass(100, 1, 'real');
  h.importLib(r, J, lib, { 'C/class.json': imported });

  // Omnis re-exports the same class with only moddate/internalversion bumped.
  const res = h.exportLib(r, J, lib, { 'C/class.json': klass(999, 7, 'real') });

  assert.equal(res, 'clean', 'irrelevant-only churn does not conflict');
  assert.equal(h.readSrc(r, J)['C/class.json'], imported, 'the irrelevant keys are reverted to the source values');
  assert.equal(h.stat(r, J), '  ', 'no working-tree change is left behind');
});

test('an irrelevant-key bump alongside a real change keeps the real change and reverts only the keys', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'C/class.json': klass(100, 1, 'old') });

  const res = h.exportLib(r, J, lib, { 'C/class.json': klass(999, 7, 'new') });

  assert.equal(res, 'clean');
  assert.equal(h.readSrc(r, J)['C/class.json'], klass(100, 1, 'new'),
    'the body change is kept while the irrelevant keys are reverted to the source values');
});

test('irrelevant-key churn does not collide with a colleague who only bumped the same keys', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.exportLib(r, J, lib, { 'C/class.json': klass(100, 1, 'real') });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'import');

  // Colleague commits a different moddate; our export bumps it differently again.
  h.commitSource(r, J, { 'C/class.json': klass(555, 5, 'real') }, 'colleague reopens class');
  const res = h.exportLib(r, J, lib, { 'C/class.json': klass(999, 7, 'real') });

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
  });

  assert.equal(res, 'clean');
  assert.equal(h.readSrc(r, J)['D/class.json'], klass(42, 3, 'fresh'), 'the new file keeps its initial values');
});
