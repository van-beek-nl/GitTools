// Helpers for interacting with a GitTools handoff file.

const fs = require('fs');
const path = require('path');

function createHandoff(stateRoot) {
  const handoffPath = path.join(stateRoot, 'pending-op.json');

  function read() {
    if (!fs.existsSync(handoffPath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(handoffPath, 'utf-8'));
  }

  function write(handoff) {
    fs.mkdirSync(stateRoot, { recursive: true });
    const tempPath = `${handoffPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(handoff), 'utf-8');
    fs.renameSync(tempPath, handoffPath);
  }

  function clear() {
    fs.rmSync(handoffPath, { force: true });
  }

  return {
    read: read,
    write: write,
    clear: clear
  };
}

module.exports = { createHandoff };