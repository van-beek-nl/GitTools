// Helpers for interacting with a GitTools meta file.

const fs = require('fs');
const path = require('path');

/**
 * Creates a helper bound to one library's meta file. The meta records the durable
 * reconciliation state: the recorded base tree, the last known source tree, and whether an
 * export conflict is pending.
 *
 * @param {string} metaPath   absolute path to the library's meta.json
 * @param {string} jsonPath   repo-relative export root, stamped into the meta it writes
 * @returns {{read:Function, write:Function, getClean:Function, getPending:Function}}
 */
function createMeta(metaPath, jsonPath) {
  /** Reads the meta file, or returns a fresh empty-clean meta when it does not exist yet. */
  function read() {
    if (!fs.existsSync(metaPath)) {
      return getClean('', '');
    }

    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  }

  /** Writes the meta atomically (temp file + rename) so a crash never leaves it half-written. */
  function write(meta) {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    const tempMetaFile = `${metaPath}.tmp`;
    const metaJson = JSON.stringify(meta);
    fs.writeFileSync(tempMetaFile, metaJson, 'utf-8');
    fs.renameSync(tempMetaFile, metaPath);
  }

  /** Builds a clean meta object (no pending conflict) for the given base and source. */
  function getClean(baseTree, sourceTree) {
    return {
      version: 2,
      jsonPath,
      baseTree,
      sourceTree,
      status: 'clean',
      pending: null
    };
  }

  /**
   * Builds a meta object recording an in-progress export conflict: the three trees of the
   * conflicting merge, kept so pre-export can later classify the resolution (accept vs discard).
   */
  function getPending(baseTree, sourceTree, exportTree) {
    return {
      version: 2,
      jsonPath,
      baseTree,
      sourceTree,
      status: 'pendingExportConflict',
      pending: {
        baseTree,
        sourceTree,
        exportTree
      }
    };
  }

  return {
    read: read,
    write: write,
    getClean: getClean,
    getPending: getPending
  };
}

module.exports = { createMeta };