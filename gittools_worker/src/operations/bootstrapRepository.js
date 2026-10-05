const fs = require('fs');
const path = require('path');

// The repo-root files GitTools maintains, expressed as the rules that must be present and the
// stale rules left by older versions that must be removed. Order within `require` is the order
// missing rules are appended in.
const GITIGNORE = {
  file: '.gitignore',
  require: ['.DS_Store', '*.lbs.import', '*.lbs.bak', '*.lbs'],
  remove: ['*.gittools.meta'],
};
const GITATTRIBUTES = {
  file: '.gitattributes',
  require: ['*.tsv diff=cr', '*.df1 binary', '*.omh -text'],
  remove: [],
};

/**
 * Reconciles a repository to the current desired GitTools state, idempotently: the CR-compatible
 * diff driver, the required .gitignore / .gitattributes rules, and removal of the artifacts older
 * (pre-worker) versions left behind — the *.gittools.meta ignore rule, the <lib>.gittools.meta
 * file beside the library, the .git/gittools-mapping.meta file, and the post-commit.d/gittools hook.
 *
 * The repository-config writes (git config + the tracked .gitignore / .gitattributes) only run when
 * request.updateRepositoryConfig is set, and are skipped entirely when repoRoot is a submodule (so
 * an external/un-migrated submodule library is never dirtied); the legacy cleanup always runs. A
 * repository already in the desired state is left untouched. The post-commit dispatcher (if any) is
 * deliberately left alone: once our hook file is gone it is a harmless no-op.
 *
 * The operation runs through createContext, which fails with BAD_REQUEST when jsonPath is not inside
 * a git repository — so a repository root that cannot be determined is already a structured error.
 *
 * @param {import('../context.js').Context} ctx
 * @param {object} request  carries { updateRepositoryConfig?: boolean }
 */
function bootstrapRepository(ctx, request) {
  const { git, repoRoot, libraryPath, log } = ctx;

  // Repository-config writes touch the user's git config and the repository-tracked .gitignore /
  // .gitattributes, so they only run when Omnis opts in. They are also skipped when repoRoot is a
  // submodule: there the export path resolves into the submodule's own work tree (git resolves the
  // submodule indirection in resolveRepoRoot), and writing these tracked files would dirty a
  // submodule the user did not intend to modify — e.g. an external library pulled in as a submodule
  // that has not migrated to the current GitTools setup. The legacy cleanup below runs regardless
  // (it only removes ignored or .git/-internal artifacts), so an upgrading user is always tidied up.
  if (request.updateRepositoryConfig) {
    if (git.isSubmodule()) {
      log.debug(`Repository ${repoRoot} is a submodule; skipping .gitignore/.gitattributes/config writes.`);
    } else {
      reconcileRules(path.join(repoRoot, GITIGNORE.file), GITIGNORE.require, GITIGNORE.remove, log);
      reconcileRules(path.join(repoRoot, GITATTRIBUTES.file), GITATTRIBUTES.require, GITATTRIBUTES.remove, log);

      // CR-compatible diff driver. Omnis exports StringTables with old-school Macintosh (CR) line
      // endings, which git otherwise sees as one giant line; this textconv lets it diff them. Set it
      // only when missing so a repeated bootstrap is a true no-op.
      if (git.invokeRaw(['config', '--local', '--get', 'diff.cr.textconv']).status !== 0) {
        git.invoke(['config', '--local', 'diff.cr.textconv', "tr '\\r' '\\n' <"]);
        log.info(`Added CR-compatible diffing to git config for repository ${repoRoot}`);
      }
    }
  }

  // Legacy: the old per-library meta file lived next to the library as <libraryBaseName>.gittools.meta.
  if (libraryPath) {
    const legacyMeta = path.join(path.dirname(libraryPath), path.basename(libraryPath, path.extname(libraryPath)) + '.gittools.meta');
    if (fs.existsSync(legacyMeta)) {
      fs.rmSync(legacyMeta, { force: true });
      log.info(`Removed legacy meta file ${legacyMeta}`);
    }
  }

  // Legacy: the old library->path mapping file lived directly in the (common) git dir.
  const legacyMapping = git.resolveCommonPath('gittools-mapping.meta');
  if (fs.existsSync(legacyMapping)) {
    fs.rmSync(legacyMapping, { force: true });
    log.info(`Removed legacy mapping file ${legacyMapping}`);
  }

  // Legacy: the old post-commit hook. Remove just our hook file; if that leaves post-commit.d
  // empty, drop the directory too. The dispatcher is left for the user (see method note).
  const gitPathHooks = git.invoke(['rev-parse', '--git-path', 'hooks']);
  const hooksDir = path.isAbsolute(gitPathHooks) ? gitPathHooks : path.join(repoRoot, gitPathHooks);
  const hookDir = path.join(hooksDir, 'post-commit.d');
  const hookFile = path.join(hookDir, 'gittools');
  if (fs.existsSync(hookFile)) {
    fs.rmSync(hookFile, { force: true });
    log.info(`Removed legacy post-commit hook ${hookFile}`);
    if (fs.readdirSync(hookDir).length === 0) {
      fs.rmdirSync(hookDir);
    }
  }

  return {};
}

/**
 * Ensures `requireRules` are present and `removeRules` are absent in the line-oriented file at
 * `filePath`, preserving every other line and its order. Required rules that are missing are
 * appended at the end. Writes back (with a trailing newline) only when something changed.
 */
function reconcileRules(filePath, requireRules, removeRules, log) {
  const existed = fs.existsSync(filePath);
  const original = existed ? fs.readFileSync(filePath, 'utf8') : '';
  const removeSet = new Set(removeRules);

  const kept = original.split('\n').filter((line, i, all) => {
    // Drop the rules we strip; also drop a trailing empty line so the rebuild controls spacing.
    if (removeSet.has(line.trim())) { return false; }
    if (line === '' && i === all.length - 1) { return false; }
    return true;
  });

  const present = new Set(kept.map((line) => line.trim()));
  const missing = requireRules.filter((rule) => !present.has(rule));
  const rebuilt = kept.concat(missing);

  const next = rebuilt.length > 0 ? rebuilt.join('\n') + '\n' : '';
  if (next !== original) {
    fs.writeFileSync(filePath, next, 'utf8');
    log.info(`Updated ${path.basename(filePath)} for repository ${path.dirname(filePath)}`);
  }
}

module.exports = { bootstrapRepository };
