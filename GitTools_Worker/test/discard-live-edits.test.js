// The library is the source of truth: discarded or uncommitted working-tree edits never
// mask what the exported library actually contains.

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers');
const { J } = h;

test('a library deletion is reproduced even after the deleted file was restored to the working tree', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.exportLib(r, J, lib, { 'a.json': 'A', 'sub/b.json': 'B' });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'init');
  h.exportLib(r, J, lib, { 'a.json': 'A' });                              // export drops b
  h.git(r, 'checkout', '-q', '--', J); h.git(r, 'clean', '-fdq', '--', J); // discard restores b in the working tree
  const res = h.exportLib(r, J, lib, { 'a.json': 'A' });                  // library still lacks b
  const f = h.readSrc(r, J);
  assert.equal(res, 'clean', 'the re-export reconciles cleanly');
  assert.ok(!('sub/b.json' in f), "b is dropped again to match the library, not the restored working tree");
  assert.ok('a.json' in f, 'a remains');
});

test('uncommitted work-in-progress resurfaces on the next export after a partial discard', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.exportLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'init');
  h.exportLib(r, J, lib, { 'a.json': 'a1', 'b.json': 'b1' });   // a1 finished, b1 still WIP
  h.git(r, 'add', '--', `${J}/a.json`); h.git(r, 'commit', '-q', '-m', 'commit a1 only');
  h.git(r, 'checkout', '-q', '--', `${J}/b.json`);              // discard b back to b0
  const res = h.exportLib(r, J, lib, { 'a.json': 'a1', 'b.json': 'b1' });
  const f = h.readSrc(r, J);
  assert.equal(res, 'clean', 'the re-export reconciles cleanly');
  assert.equal(f['a.json'], 'a1', 'the committed file is unchanged');
  assert.equal(f['b.json'], 'b1', "the library's b reappears, overriding the discarded working-tree copy");
});
