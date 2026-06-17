// Helpers for interacting with a GitTools meta file.

const fs = require('fs');
const path = require('path');

function createMeta(metaPath, jsonPath) {
  function read() {
    if (!fs.existsSync(metaPath)) {
      return getClean('', '');
    }

    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  }

  function write(meta) {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    const tempMetaFile = `${metaPath}.tmp`;
    const metaJson = JSON.stringify(meta);
    fs.writeFileSync(tempMetaFile, metaJson, 'utf-8');
    fs.renameSync(tempMetaFile, metaPath);
  }

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