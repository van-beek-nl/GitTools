// Small text helper for parsing git's line-oriented stdout.

/** Splits git stdout into lines, dropping empty lines (so trailing newlines don't yield ''). */
function splitLines(string) {
  return string.split(/\r?\n/).filter(line => line !== '');
}

module.exports = { splitLines };
