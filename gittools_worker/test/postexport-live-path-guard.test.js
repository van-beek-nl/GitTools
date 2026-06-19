// Post-export reuses the tree pre-export hashed for the live JSON path only while a cheap
// fingerprint proves the path is unchanged. If something modifies the live path mid-export, the
// guard must notice and re-hash — otherwise the apply step would diff against a stale tree and
// leave foreign files behind. The decisive case is a file the export does not contain.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const h = require('../test-support/helpers');
const { run } = require('../src/core.js');
const { J } = h;

test('an external change to the live path between pre- and post-export is not missed', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const v2 = '{"name":"C","body":"v2"}';

  h.importLib(r, J, lib, { 'C/class.json': '{"name":"C","body":"v1"}' });

  // Pre-export hashes the live path and records its fingerprint.
  h.runOp('preExport', r, J, lib);

  // An external actor drops in a file the export will NOT include, after the pre-export snapshot.
  fs.mkdirSync(path.join(r, J, 'Stray'), { recursive: true });
  fs.writeFileSync(path.join(r, J, 'Stray/class.json'), '{"name":"Stray"}');

  // Omnis writes the export snapshot (only C) into the cache; post-export finalizes.
  h.omnisExport(r, J, lib, { 'C/class.json': v2 });
  const res = run(Object.assign(h.request('postExport', r, J, lib), { config: { logLevel: 'info' } }));

  assert.equal(res.ok, true);
  assert.equal(res.result, 'clean');
  // The live path ends up exactly equal to the export: the stray file is gone, not left behind
  // by trusting the stale pre-export tree.
  assert.deepEqual(h.readSrc(r, J), { 'C/class.json': v2 });
  assert.ok(
    res.log.some(rec => /Live JSON path changed since pre-export/.test(rec.message)),
    'the guard detected the change and re-hashed instead of reusing the recorded tree'
  );
});
