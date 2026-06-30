// Shared constants and the worker's response/error contract: the error codes, and the one
// error type the rest of the code throws on a controlled, reportable failure.

/** Codes carried by GitToolsError and surfaced in the failure response. */
const ErrorCodes = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  GIT_SPAWN_FAILED: 'GIT_SPAWN_FAILED',
  GIT_FAILED: 'GIT_FAILED',
  UNRESOLVED_CONFLICTS: 'UNRESOLVED_CONFLICTS',
  NO_PENDING_EXPORT: 'NO_PENDING_EXPORT',
  MERGE_TREE_UNSUPPORTED: 'MERGE_TREE_UNSUPPORTED',
  NO_MERGE_TREE: 'NO_MERGE_TREE'
});

/**
 * A controlled, expected failure that should be reported to Omnis as a structured
 * error rather than crashing the worker. Anything else thrown is treated as an
 * unhandled error by run().
 */
class GitToolsError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'GitToolsError';
    this.code = code;
  }
}

module.exports = { ErrorCodes, GitToolsError };
