// Core script dispatcher. Free of Omnis-related code for testability.

const { ErrorCodes, GitToolsError } = require('./constants.js');
const { createContext } = require('./context.js');
const { preExport } = require('./scripts/preExport.js');
const { postExport } = require('./scripts/postExport.js');
const { preImport } = require('./scripts/preImport.js');
const { postImport } = require('./scripts/postImport.js');

// The operation registry: operation name -> handler (ctx, request) -> outcome. The keys
// are the complete set of operations the worker supports and the strings carried in
// request.operation.
const operations = Object.freeze({
  'preExport': preExport,
  'postExport': postExport,
  'preImport': preImport,
  'postImport': postImport,
});

/**
 * Run one GitTools operation.
 *
 * @param {object} request
 * @param {string} request.operation
 * @param {string} request.repoRoot
 * @param {string} request.jsonPath
 * @param {string} request.libraryId
 * @param {string} request.libraryPath
 * @param {string} [request.metaPath]
 * @param {boolean} [request.allowMissingBase] confirm-and-force after a 'missing-base' result
 * @param {boolean} [request.cleanIrrelevantKeys] revert the import-irrelevant keys on post-export
 *                                             (off unless set; see scripts/postExport.js)
 * @param {object} [request.config]            GitTools config from Omnis: { gitPath?, logLevel? }
 *                                             (gitPath defaults to "git" on PATH; logLevel to "info")
 * @returns {object} response
 *   success: { ok: true,  operation, result?: 'clean'|'conflict'|'missing-base', source?: string, log }
 *   failure: { ok: false, operation, error: { code, message }, log }
 *
 * `log` is always present: the array of { level, message } records the operation produced
 * (every level, unfiltered — Omnis filters when re-emitting them to its IDE trace log). They
 * accumulate as the operation runs, so a controlled failure still returns what it logged.
 */
function run(request) {
  const operation = request && request.operation;
  const handler = operations[operation];
  if (!handler) {
    return Object.assign(fail(operation, ErrorCodes.BAD_REQUEST, 'Unknown operation: ' + String(operation)), { log: [] });
  }

  // createContext builds the logger (and binds ctx.git to it), so read it back rather than
  // owning a separate one here — that keeps git's own log lines in the captured set. The only
  // gap is logging during a createContext failure (log stays null), a tiny pre-git window.
  let log = null;
  try {
    const ctx = createContext(request);
    log = ctx.log;
    const outcome = handler(ctx, request) || {};
    return Object.assign({ ok: true, operation: operation, log: log.records() }, outcome);
  } catch (err) {
    const response = (err instanceof GitToolsError)
      ? fail(operation, err.code, err.message)
      : fail(operation, 'UNHANDLED', err && err.message ? err.message : String(err));
    response.log = log ? log.records() : [];
    return response;
  }
}

function fail(operation, code, message) {
  return { ok: false, operation: operation || null, error: { code: code, message: message } };
}

module.exports = { run, operations };
