// Helpers for interacting with a GitTools handoff file.

const fs = require('fs');
const path = require('path');

/**
 * Creates a helper bound to one library's handoff file (pending-op.json in its per-worktree
 * state dir). The handoff carries the state pre-export computes (the operation plus its source
 * and base trees) across to post-export, which consumes and clears it.
 *
 * @param {string} stateRoot  the library's per-worktree state directory
 * @returns {{read:Function, write:Function, clear:Function}}
 */
function createHandoff(stateRoot) {
  const handoffPath = path.join(stateRoot, 'pending-op.json');

  /** Reads the pending handoff, or null when none is waiting. */
  function read() {
    if (!fs.existsSync(handoffPath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(handoffPath, 'utf-8'));
  }

  /** Writes the handoff atomically (temp file + rename) so a crash never leaves it half-written. */
  function write(handoff) {
    fs.mkdirSync(stateRoot, { recursive: true });
    const tempPath = `${handoffPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(handoff), 'utf-8');
    fs.renameSync(tempPath, handoffPath);
  }

  /** Removes the handoff (idempotent; safe when none exists). */
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