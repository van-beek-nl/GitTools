// The logger buffers every record it is given (so the worker can hand the full set back to
// Omnis, which filters on its side), while the stderr sink stays gated by the configured level.

const { test } = require('node:test');
const assert = require('node:assert');

const { createLogger } = require('../src/log.js');

test('isLevelEnabled reflects the configured threshold', () => {
  const log = createLogger({ level: 'info', sink: () => {} });

  assert.equal(log.isLevelEnabled('debug'), false, 'debug is below the info threshold');
  assert.equal(log.isLevelEnabled('info'), true);
  assert.equal(log.isLevelEnabled('error'), true);
});

test('records() captures every level regardless of the stderr threshold', () => {
  const log = createLogger({ level: 'error', sink: () => {} });

  log.debug('d');
  log.info('i');
  log.warning('w');
  log.error('e');

  assert.deepEqual(log.records(), [
    { level: 'debug', message: 'd' },
    { level: 'info', message: 'i' },
    { level: 'warning', message: 'w' },
    { level: 'error', message: 'e' },
  ], 'all four levels are buffered even though the threshold is error');
});

test('the stderr sink still fires only at or above the configured level', () => {
  const emitted = [];
  const log = createLogger({ level: 'warning', sink: (level) => emitted.push(level) });

  log.debug('d');
  log.info('i');
  log.warning('w');
  log.error('e');

  assert.deepEqual(emitted, ['warning', 'error'], 'debug and info are below the warning threshold');
});

test('records() returns a snapshot, not the live buffer', () => {
  const log = createLogger({ level: 'info', sink: () => {} });

  log.info('one');
  const snapshot = log.records();
  log.info('two');

  assert.equal(snapshot.length, 1, 'an earlier snapshot is unaffected by later logging');
});
