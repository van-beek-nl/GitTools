// The source tree recorded by an export must equal what the NEXT pre-export will hash from the
// live path — otherwise the fast path ("this is GitTools' own last output") fails forever and
// every export falls onto the expensive HEAD-history recovery.
//
// The trap: the applied tree is built from the export cache, but writing it to the live path and
// re-hashing does not always reproduce it (content filters like autocrlf/eol on Windows, or — as
// reproduced here — a file the repo .gitignore excludes from the live path but not from the
// cache). So the recorded source tree must be the live path's actual hash, not the cache tree.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const h = require('../test-support/helpers');
const { run } = require('../src/core.js');
const { J } = h;

test('a no-change re-export stays on the fast path when the applied tree does not round-trip to itself', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  fs.writeFileSync(path.join(r, '.gitignore'), 'ignoreme.txt\n');
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'gitignore');
  h.importLib(r, J, lib, { 'C/class.json': '{}' });

  // The export cache carries a file the repo .gitignore excludes from the live path, so the
  // applied tree (which includes it) re-hashes on the live side to a different tree (without it)
  // — the same divergence Windows line-ending normalization produces.
  const cache = { 'C/class.json': '{}', 'C/ignoreme.txt': 'junk' };
  h.exportLib(r, J, lib, cache); // export #1

  // export #2, no changes: must recognize the live path as its own last output (fast path), not
  // fall onto the "live path changed; live changes disposable" recovery.
  h.omnisExport(r, J, lib, cache);
  const pre = run(Object.assign(h.request('preExport', r, J, lib), { config: { logLevel: 'info' } }));

  assert.equal(pre.ok, true);
  assert.ok(
    !pre.log.some(rec => /Live JSON path has changed since last export/.test(rec.message)),
    'the recorded source tree must equal what pre-export re-hashes, keeping the fast path'
  );
});
