const fs = require('fs');
const path = require('path');

const { GitToolsError, ErrorCodes } = require('../constants.js');

// OS bookkeeping files that carry no meaning for the import. A directory holding only these
// is treated as empty: they are deleted along with it. Matched case-insensitively, since the
// Windows/macOS filesystems these come from are case-insensitive.
const JUNK_FILES = new Set(['.ds_store', 'thumbs.db', 'ehthumbs.db', 'desktop.ini']);

/**
 * Guards against importing unresolved conflicts (which would bake conflict markers into the
 * binary), prunes empty directories left under the JSON path, and returns the path Omnis
 * should import from.
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

  // Omnis Studio errors on directories missing the files it expects, and Git leaves empty
  // folders behind when discarding work. Sweep them away before the import sees them.
  pruneEmptyDirectories(ctx);

  return { source: jsonAbsolutePath };
}

/**
 * Remove every empty directory under the JSON export root (the root itself is always kept).
 * Symlinks are treated as content and never followed, so the walk cannot escape the export
 * root.
 *
 * @param {import('../context.js').Context} ctx
 */
function pruneEmptyDirectories(ctx) {
  const { jsonAbsolutePath, log } = ctx;

  if (!fs.existsSync(jsonAbsolutePath)) {
    return;
  }

  let removed = 0;

  // Returns true when `dir` was removed (so the caller stops counting it as live content).
  function prune(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      log.debug(`Could not read '${dir}' while pruning empty directories: ${e.message}`);
      return false;
    }

    let liveEntries = 0;       // entries that keep this directory alive
    const junkFiles = [];      // removable junk to delete if the directory goes
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!prune(path.join(dir, entry.name))) {
          liveEntries++;
        }
      } else if (JUNK_FILES.has(entry.name.toLowerCase())) {
        junkFiles.push(entry.name);
      } else {
        // A real file, or a symlink (Dirent.isDirectory() is false for one): content we keep.
        liveEntries++;
      }
    }

    if (liveEntries > 0) {
      return false;
    }

    try {
      for (const junk of junkFiles) {
        fs.rmSync(path.join(dir, junk), { force: true });
      }
      fs.rmdirSync(dir);
    } catch (e) {
      log.debug(`Could not remove empty directory '${dir}': ${e.message}`);
      return false;
    }

    removed++;
    return true;
  }

  // Walk the root's children but never remove the root itself.
  let rootEntries;
  try {
    rootEntries = fs.readdirSync(jsonAbsolutePath, { withFileTypes: true });
  } catch (e) {
    log.debug(`Could not read the JSON path '${jsonAbsolutePath}' while pruning: ${e.message}`);
    return;
  }
  for (const entry of rootEntries) {
    if (entry.isDirectory()) {
      prune(path.join(jsonAbsolutePath, entry.name));
    }
  }

  if (removed > 0) {
    log.info(`Pruned ${removed} empty director${removed === 1 ? 'y' : 'ies'} from the JSON path.`);
  }
}

module.exports = { preImport };
