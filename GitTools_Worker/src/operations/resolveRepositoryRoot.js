const { createGit } = require('../git.js');
const { GitToolsError, ErrorCodes } = require('../constants.js');

/**
 * Resolves the repository root that owns request.jsonPath, the way registration needs it.
 * Not being inside a repository is a normal answer ({ repositoryRoot: '' }), not a failure, so
 * Omnis can skip registering the library with a friendly warning.
 *
 * Unlike the export/import scripts, this has no library context (it produces the very
 * repositoryRoot a context presupposes), so it receives (request, log) rather than (ctx, request).
 *
 * @param {object} request
 * @param {object} log  logger (see ../log.js)
 * @returns {{repositoryRoot: string}}
 */
function resolveRepositoryRoot(request, log) {
  const config = request.config || {};
  if (!request.path) {
    throw new GitToolsError(ErrorCodes.BAD_REQUEST, 'resolveRepositoryRoot requires a path');
  }

  return {
    repositoryRoot: createGit({ gitPath: config.gitPath, log: log }).resolveRepoRoot(request.path),
  };
}

module.exports = { resolveRepositoryRoot };
