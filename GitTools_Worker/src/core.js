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
  'pre-export': preExport,
  'post-export': postExport,
  'pre-import': preImport,
  'post-import': postImport,
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
 *   success: { ok: true,  operation, result?: 'clean'|'conflict'|'missing-base', source?: string }
 *   failure: { ok: false, operation, error: { code, message } }
 */
function run(request) {
  const operation = request && request.operation;
  const handler = operations[operation];
  if (!handler) {
    return fail(operation, ErrorCodes.BAD_REQUEST, 'Unknown operation: ' + String(operation));
  }

  try {
    const ctx = createContext(request);
    const outcome = handler(ctx, request) || {};
    return Object.assign({ ok: true, operation: operation }, outcome);
  } catch (err) {
    if (err instanceof GitToolsError) {
      return fail(operation, err.code, err.message);
    }

    return fail(operation, 'UNHANDLED', err && err.message ? err.message : String(err));
  }
}

function fail(operation, code, message) {
  return { ok: false, operation: operation || null, error: { code: code, message: message } };
}

module.exports = { run, operations };
