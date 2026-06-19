const { createGit } = require('../git.js');
const { GitToolsError } = require('../constants.js');

/**
 * Validates the configured git executable by running `git --version`. An unusable path
 * (not found, not executable, or not actually git) is reported as { valid: false } rather
 * than failing the operation, so Omnis gets a clean answer it can act on.
 *
 * This has no library context, so it receives (request, log) rather than (ctx, request).
 *
 * @param {object} request
 * @param {object} log  logger (see ../log.js)
 * @returns {{valid: boolean, version: string}}
 */
function checkGitExecutable(request, log) {
  const config = request.config || {};
  const git = createGit({ gitPath: config.gitPath, log: log });

  try {
    return { valid: true, version: git.version() };
  } catch (err) {
    // A spawn failure or non-zero exit means the path is not a working git; anything else is
    // an unexpected fault and should surface as a real worker error.
    if (err instanceof GitToolsError) {
      return { valid: false, version: '' };
    }
    throw err;
  }
}

module.exports = { checkGitExecutable };
