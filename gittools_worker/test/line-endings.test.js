// GitTools applies exports to the live JSON path via git, so its result must match what a normal
// git checkout would produce there — honoring the repository's .gitattributes (text/eol/-text) and
// core.autocrlf. Previously the apply ran in a work-tree/index context that could not see the
// repo-root .gitattributes, so `-text` was ignored and core.autocrlf silently rewrote line endings
// (e.g. LF -> CRLF), making git report the whole file as changed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../test-support/helpers');
const { J } = h;

function eols(file) {
  const s = fs.readFileSync(file, 'latin1');
  return {
    crlf: (s.match(/\r\n/g) || []).length,
    lf: (s.match(/(?<!\r)\n/g) || []).length,
    cr: (s.match(/\r(?!\n)/g) || []).length,
  };
}

test('honors `-text`: an exported change keeps the file\'s LF endings under core.autocrlf=true', () => {
  const r = h.newRepo('eol'); const lib = h.libOf(r);
  // The user's setup: declare all files binary-ish (-text, no conversion) but with the Windows
  // default core.autocrlf=true. Normal git checkout here keeps the blob's bytes (LF) unchanged.
  fs.writeFileSync(path.join(r, '.gitattributes'), '* -text\n');
  h.git(r, 'config', 'core.autocrlf', 'true');
  h.git(r, 'add', '.gitattributes');
  h.git(r, '-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'attrs');

  // A committed source with LF line endings.
  h.commitSource(r, J, { 'methods.json': '{\n  "a": "1",\n  "b": "2"\n}\n' }, 'lf source');
  h.runOp('postImport', r, J, lib);

  const file = path.join(r, J, 'methods.json');
  assert.deepEqual(eols(file), { crlf: 0, lf: 4, cr: 0 }, 'precondition: file is LF before export');

  // Omnis exports a one-line change (still LF).
  h.exportLib(r, J, lib, { 'methods.json': '{\n  "a": "CHANGED",\n  "b": "2"\n}\n' });

  assert.deepEqual(eols(file), { crlf: 0, lf: 4, cr: 0 }, 'line endings preserved (not rewritten to CRLF)');

  // And git therefore sees only the single changed line, not the whole file.
  const numstat = h.gitTry(r, 'diff', '--numstat', '--', `${J}/methods.json`).stdout.trim();
  assert.equal(numstat.split('\t').slice(0, 2).join(' '), '1 1', 'only one line added/removed');
});

test('honors core.autocrlf: a repo that wants CRLF in the working tree still gets it', () => {
  const r = h.newRepo('eol'); const lib = h.libOf(r);
  // No .gitattributes, core.autocrlf=true: a normal checkout puts CRLF in the working tree, so
  // GitTools must too (the export result should match native git behavior, whatever it is).
  h.git(r, 'config', 'core.autocrlf', 'true');

  h.exportLib(r, J, lib, { 'methods.json': '{\n  "a": "1"\n}\n' });

  assert.deepEqual(eols(path.join(r, J, 'methods.json')), { crlf: 3, lf: 0, cr: 0 }, 'working tree is CRLF');
});
