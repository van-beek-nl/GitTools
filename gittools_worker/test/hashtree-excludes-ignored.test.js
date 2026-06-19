// hashTree must mirror git's own view of the source: a gitignored file on disk (a macOS
// .DS_Store is the canonical case) is invisible to git, so it must not change the tree hash.
// When it did, the computed live tree drifted out of sync with the recorded source tree, and
// pre-export silently fell onto its expensive "live path changed; live changes disposable" path.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const h = require('../test-support/helpers');
const { run } = require('../src/core.js');
const { J } = h;

test('hashTree ignores gitignored files under the JSON path', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  fs.writeFileSync(path.join(r, '.gitignore'), '.DS_Store\n');
  h.importLib(r, J, lib, { 'C/class.json': '{}' });

  const ctx = h.ctxFor(r, J, lib);
  const before = ctx.git.hashTree(J);

  // macOS drops an ignored .DS_Store into a source folder.
  fs.writeFileSync(path.join(r, J, 'C', '.DS_Store'), 'finder-junk');
  const after = ctx.git.hashTree(J);

  assert.equal(after, before, 'an ignored file must not change the computed tree');
});

test('a gitignored file under the JSON path does not trip pre-export onto the disposable-source fallback', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  fs.writeFileSync(path.join(r, '.gitignore'), '.DS_Store\n');
  h.importLib(r, J, lib, { 'C/class.json': '{}' });

  fs.writeFileSync(path.join(r, J, 'C', '.DS_Store'), 'finder-junk');

  const res = run(Object.assign(h.request('preExport', r, J, lib), { config: { logLevel: 'info' } }));

  assert.equal(res.ok, true);
  assert.ok(
    !res.log.some(rec => /Live JSON path has changed since last export/.test(rec.message)),
    'an ignored file must not be seen as a source change'
  );
});
