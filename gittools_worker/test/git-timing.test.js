// Per-git-command timing is a debug aid: it should only run (and only land in the log records)
// when debug logging is enabled, so production exports pay neither the measurement nor the
// buffer noise.

const { test } = require('node:test');
const assert = require('node:assert');

const { createGit } = require('../src/git.js');
const { createLogger } = require('../src/log.js');

test('git invocations are timed and logged when debug is enabled', () => {
  const log = createLogger({ level: 'debug', sink: () => {} });
  createGit({ log }).version();

  assert.ok(
    log.records().some(r => /^git --version \(\d/.test(r.message)),
    'debug logs the command with its wall-clock timing'
  );
});

test('git invocations are not logged when debug is disabled', () => {
  const log = createLogger({ level: 'info', sink: () => {} });
  createGit({ log }).version();

  assert.ok(
    !log.records().some(r => /^git --version/.test(r.message)),
    'no git command lines are produced (or buffered) below the debug threshold'
  );
});
