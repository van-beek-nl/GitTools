const { GitToolsError, ErrorCodes } = require('../constants.js');

/**
 * Only guards against importing unresolved conflicts
 * (which would bake conflict markers into the binary) and returns the
 * path Omnis should import from.
 *
 * @param {import('../context.js').Context} ctx
 * @param {object} request
 * @returns {{source: string}}  absolute path Omnis should import from (the JSON path)
 */
function preImport(ctx, request) {
  const { git, jsonPath, jsonAbsolutePath } = ctx;

  // Importing a source with unresolved conflicts can cause issues (and is quite nonsensical),
  // so we block it.
  if (git.hasUnresolvedConflicts(jsonPath)) {
    throw new GitToolsError(
      ErrorCodes.UNRESOLVED_CONFLICTS,
      'The JSON path contains unresolved conflicts. Resolve them before importing.'
    );
  }

  return { source: jsonAbsolutePath };
}

module.exports = { preImport };
