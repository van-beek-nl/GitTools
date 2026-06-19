// A tiny level-aware logger. The level is user-configurable in the Omnis library
// (debug | info | warning | error) and arrives via request.config.logLevel.

const LEVELS = Object.freeze({ debug: 1, info: 2, warning: 3, error: 4 });
const DEFAULT_LEVEL = 'info';

function defaultSink(level, message) {
  process.stderr.write('[' + level + '] ' + message + '\n');
}

/**
 * @param {object} [options]
 * @param {string} [options.level]  one of "debug"|"info"|"warning"|"error" (default "info")
 * @param {function(string, string):void} [options.sink]  (level, message) => void
 * @returns {{level:string, debug:Function, info:Function, warning:Function, error:Function, records:Function}}
 */
function createLogger(options) {
  options = options || {};
  const level = LEVELS[options.level] ? options.level : DEFAULT_LEVEL;
  const threshold = LEVELS[level];
  const sink = options.sink || defaultSink;
  const records = [];

  // Every record is buffered regardless of level so the worker can hand the complete set back
  // to Omnis in its response (Omnis filters when re-emitting to its IDE trace log). The sink
  // stays gated by the configured level, so stderr verbosity is still controlled by logLevel.
  function emit(level, message) {
    records.push({ level: level, message: message });
    if (LEVELS[level] >= threshold) { sink(level, message); }
  }

  return {
    level: level,
    debug: function (m) { emit('debug', m); },
    info: function (m) { emit('info', m); },
    warning: function (m) { emit('warning', m); },
    error: function (m) { emit('error', m); },
    records: function () { return records.slice(); },
    // True when `lvl` is at or above the configured threshold — i.e. it would reach the sink.
    // Lets callers skip work that is only worth doing when that level is actually active (e.g.
    // per-command timing under debug).
    isLevelEnabled: function (lvl) { return LEVELS[lvl] !== undefined && LEVELS[lvl] >= threshold; },
  };
}

module.exports = { createLogger, LEVELS, DEFAULT_LEVEL };
