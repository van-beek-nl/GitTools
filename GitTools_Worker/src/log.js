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
 * @returns {{level:string, debug:Function, info:Function, warning:Function, error:Function}}
 */
function createLogger(options) {
  options = options || {};
  const level = LEVELS[options.level] ? options.level : DEFAULT_LEVEL;
  const threshold = LEVELS[level];
  const sink = options.sink || defaultSink;

  function emit(level, message) {
    if (LEVELS[level] >= threshold) { sink(level, message); }
  }

  return {
    level: level,
    debug: function (m) { emit('debug', m); },
    info: function (m) { emit('info', m); },
    warning: function (m) { emit('warning', m); },
    error: function (m) { emit('error', m); },
  };
}

module.exports = { createLogger, LEVELS, DEFAULT_LEVEL };
