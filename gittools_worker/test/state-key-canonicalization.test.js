// The state key is derived from the library path, and must be STABLE no matter which path form
// Omnis hands in. If a symlinked (or otherwise non-canonical) path produced a different key, the
// library would silently get a fresh meta + base lineage — another way to "lose the base". The key
// is canonicalized (realpath) so equivalent paths collapse to one key.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../test-support/helpers');
const { J } = h;

test('a symlinked library path yields the same state key as the real path', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  // A second path to the SAME .lbs, reached through a directory symlink.
  const linkDir = h.track(h.tmpName('lib-symlink'));
  fs.symlinkSync(r, linkDir, 'dir');
  const libViaSymlink = path.join(linkDir, 'Lib.lbs');

  assert.equal(
    h.stateKey(r, J, libViaSymlink),
    h.stateKey(r, J, lib),
    'the state key must be stable across symlinked library paths'
  );
});
