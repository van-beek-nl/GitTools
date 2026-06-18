// Every response carries the log records the operation produced, so Omnis can re-emit them to
// its IDE trace log. The records are threshold-independent (Omnis filters), and they survive a
// controlled failure, since they accumulate as the operation runs.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const h = require('../test-support/helpers');
const { run } = require('../src/core.js');
const { J } = h;

test('a successful operation returns its log records, including info lines below the stderr threshold', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  // An empty directory under the JSON path makes preImport log an info "Pruned ..." line.
  fs.mkdirSync(path.join(r, J, 'Empty'), { recursive: true });

  // The helper config runs at logLevel 'error', so this info line never reaches stderr —
  // it must still be captured in the response.
  const res = run(h.request('preImport', r, J, lib));

  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.log), 'the response carries a log array');
  assert.ok(
    res.log.some(rec => rec.level === 'info' && /Pruned/.test(rec.message)),
    'the info line is captured despite the error-level stderr threshold'
  );
});

test('a controlled failure still returns the logs accumulated before the error', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  // Manufacture a real unresolved merge conflict under the JSON path so preImport refuses
  // the import (UNRESOLVED_CONFLICTS) — after it has already logged the git command it ran.
  const abs = path.join(r, J);
  h.writeFiles(abs, { 'C/class.json': 'base\n' });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'base');
  const main = h.git(r, 'rev-parse', '--abbrev-ref', 'HEAD');
  h.git(r, 'checkout', '-q', '-b', 'feature');
  h.writeFiles(abs, { 'C/class.json': 'feature\n' });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'feature');
  h.git(r, 'checkout', '-q', main);
  h.writeFiles(abs, { 'C/class.json': 'mainline\n' });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'mainline');
  h.gitTry(r, 'merge', 'feature'); // conflicts; leaves C/class.json unmerged

  const res = run(h.request('preImport', r, J, lib));

  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'UNRESOLVED_CONFLICTS');
  assert.ok(Array.isArray(res.log) && res.log.length > 0,
    'the failure response still carries the logs accumulated before the throw');
});
