// The base lineage ref grows one bookkeeping commit per import/export. Re-recording a base that
// the lineage tip already holds (a repeated import/export of identical content) must NOT append a
// duplicate commit — otherwise the lineage grows unbounded for no information gain.

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

function lineageCount(repo, json, lib) {
  return parseInt(h.git(repo, 'rev-list', '--count', `refs/gittools/${h.stateKey(repo, json, lib)}/base`), 10);
}

test('re-importing identical content does not append a duplicate base commit', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'S0' });
  const before = lineageCount(r, J, lib);
  h.runOp('postImport', r, J, lib); // identical committed content -> same base tree -> no-op
  assert.equal(lineageCount(r, J, lib), before, 'an identical base must not grow the lineage');
});

test('re-exporting identical content does not append a duplicate base commit', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'S0' });
  h.exportLib(r, J, lib, { 'a.json': 'E1' });        // advances the base to E1
  const before = lineageCount(r, J, lib);
  h.exportLib(r, J, lib, { 'a.json': 'E1' });        // identical export -> same base tree -> no-op
  assert.equal(lineageCount(r, J, lib), before, 'an identical export must not grow the lineage');
});

test('a genuinely new base still advances the lineage', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'S0' });
  const before = lineageCount(r, J, lib);
  h.exportLib(r, J, lib, { 'a.json': 'E1' });        // different content -> must record a new base
  assert.equal(lineageCount(r, J, lib), before + 1, 'a new base advances the lineage by exactly one');
});
