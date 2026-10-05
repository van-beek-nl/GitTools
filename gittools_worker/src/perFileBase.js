const { LINEAGE_IMPORT_SUBJECT } = require('./constants.js');
const { splitLines } = require('./text.js');

const NULL_OBJECT_ID = /^0+$/;
const FILE_MODE_REGULAR = '100644';
// Cap on trial merges for the absorption check; past it the oldest candidates are skipped, which
// leaves their files on the older (conflict-prone) base.
const MAX_ABSORPTION_TRIALS = 5000;

/**
 * Builds the merge base for `sourceTree` vs `exportTree` file by file.
 *
 * A file's base starts as the newest version git has held (the source, then HEAD's history) that
 * the library produced byte for byte since its latest import. An import replaces the whole
 * library, so earlier output is no ancestor of it; the import's own ancestry is the commit it was
 * read from. Lineages without an import marker (older GitTools) or whose imported commit is gone
 * are searched in full. A newer library output still counts when some later git version already
 * contains all of its changes, which is how a cleanly merged export that was committed shows up
 * in git ("absorbed"). Without any match, a file present in the source falls back to
 * `fallbackTree`'s version (the last library output); otherwise it is absent from the base.
 *
 * Files both sides agree on keep `fallbackTree`'s version (or the source's when there is none).
 *
 * @param {import('./context.js').Context} ctx
 * @param {string} sourceTree
 * @param {string} exportTree
 * @param {string} fallbackTree  '' when there is none
 * @returns {string} base tree SHA
 */
function buildPerFileBase(ctx, sourceTree, exportTree, fallbackTree) {
  const { git, log, jsonPath } = ctx;

  const paths = splitLines(git.invoke(['-c', 'core.quotePath=false', 'diff-tree', '-r', '--no-renames', '--name-only', sourceTree, exportTree]));
  if (paths.length === 0) {
    return sourceTree;
  }
  const wanted = new Set(paths);

  const source = listTree(git, sourceTree, wanted);
  const fallback = fallbackTree ? listTree(git, fallbackTree, wanted) : new Map();
  const timelines = libraryTimelines(ctx, wanted);
  for (const [file, entry] of fallback) {
    if (!timelines.has(file)) {
      timelines.set(file, [entry.oid]);
    }
  }

  // Path-limiting `git log` to many files is far slower than walking the whole JSON path once.
  const history = new Map();
  const prefix = `${jsonPath}/`;
  for (const line of splitLines(git.invoke(['-c', 'core.quotePath=false', 'log', '--full-history', '--cc', '--no-renames', '--raw', '--no-abbrev', '--format=%H', 'HEAD', '--', jsonPath]))) {
    const entry = rawEntry(line);
    const file = entry && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : null;
    if (file !== null && wanted.has(file)) {
      if (!history.has(file)) {
        history.set(file, []);
      }
      history.get(file).push(entry);
    }
  }

  // Newest exact match per file, plus the absorption trials that could supersede it.
  const bases = new Map();
  const trials = [];
  for (const file of paths) {
    const timeline = timelines.get(file) || [];
    const produced = new Set(timeline);
    const versions = (source.has(file) ? [source.get(file)] : []).concat(history.get(file) || []);
    const matchIndex = versions.findIndex((version) => produced.has(version.oid));
    if (matchIndex === -1) {
      continue;
    }

    const match = versions[matchIndex];
    bases.set(file, match);

    // Library output newer than the match, newest first; git versions newer than the match.
    const newerOutput = unique(timeline.slice(0, timeline.indexOf(match.oid)));
    const newerGit = unique(versions.slice(0, matchIndex).map((version) => version.oid));
    newerOutput.forEach((output, rank) => {
      for (const gitVersion of newerGit) {
        trials.push({ file, rank, base: match.oid, ours: gitVersion, theirs: output });
      }
    });
  }

  let absorbed = 0;
  for (const [file, oid] of absorbedOutputs(ctx, trials)) {
    bases.set(file, { mode: bases.get(file).mode, oid: oid });
    absorbed++;
  }

  const records = [];
  const removed = [];
  let fellBack = 0;
  for (const file of paths) {
    let base = bases.get(file);
    if (!base && source.has(file) && fallback.has(file)) {
      base = fallback.get(file);
      fellBack++;
    }

    if (base) {
      records.push(`${base.mode} ${base.oid}\t${file}`);
    } else {
      removed.push(file);
    }
  }
  log.debug(`Per-file base for ${paths.length} file(s): ${bases.size - absorbed} matched, ${absorbed} absorbed, ${fellBack} from the last export, ${removed.length} absent.`);

  // Starting from the last library output keeps files both sides deleted or renamed visible to
  // merge-tree's rename detection; content of files both sides agree on does not affect the merge.
  return git.withScratchIndex((scratch) => {
    scratch.invoke(['read-tree', fallbackTree || sourceTree]);
    if (removed.length > 0) {
      scratch.invoke(['update-index', '--force-remove', '--stdin'], { input: removed.join('\n') + '\n' });
    }
    if (records.length > 0) {
      scratch.invoke(['update-index', '--index-info'], { input: records.join('\n') + '\n' });
    }
    return scratch.invoke(['write-tree']);
  });
}

/**
 * Decides, for every trial (base, ours = git version, theirs = library output), whether `ours`
 * already contains all of the output's changes, batched over synthetic flat trees (path = trial
 * index). Two checks must agree:
 *   - merging the output into `ours`, clashes resolved to `ours`, leaves `ours` unchanged;
 *   - line-wise, every line the output added survives in `ours` and every line it removed is gone.
 * The merge alone misses changes inside a clash; git reports clashes for merely adjacent edits,
 * so it cannot be used without -X ours. The line check alone can be fooled by duplicate lines.
 * Returns the newest absorbed output per file.
 */
function absorbedOutputs(ctx, trials) {
  const { git, log } = ctx;
  const result = new Map();
  if (trials.length === 0) {
    return result;
  }

  if (trials.length > MAX_ABSORPTION_TRIALS) {
    log.info(`Absorption check limited to ${MAX_ABSORPTION_TRIALS} of ${trials.length} trial merges; older library output is not considered.`);
    trials = trials.slice().sort((a, b) => a.rank - b.rank).slice(0, MAX_ABSORPTION_TRIALS);
  }

  const buildTree = (side) => git.withScratchIndex((scratch) => {
    const records = trials.map((trial, i) => `${FILE_MODE_REGULAR} ${trial[side]}\t${i}`);
    scratch.invoke(['update-index', '--add', '--index-info'], { input: records.join('\n') + '\n' });
    return scratch.invoke(['write-tree']);
  });
  const base = buildTree('base');
  const ours = buildTree('ours');
  const theirs = buildTree('theirs');

  const merge = git.invokeRaw(['merge-tree', '--write-tree', '-X', 'ours', `--merge-base=${base}`, ours, theirs]);
  if (merge.status !== 0 && merge.status !== 1) {
    log.warning('Absorption check merge failed; treating all library output as not absorbed.');
    return result;
  }
  const merged = listTree(git, splitLines(merge.stdout)[0], null);

  const outputChanges = lineChanges(git, base, theirs);
  const oursVsOutput = lineChanges(git, theirs, ours);
  const oursVsBase = lineChanges(git, base, ours);

  trials.forEach((trial, i) => {
    const key = String(i);
    const entry = merged.get(key);
    if (!entry || entry.oid !== trial.ours) {
      return;
    }

    const output = outputChanges.get(key);
    const survived = oursVsOutput.get(key) || EMPTY_CHANGES;
    const removed = oursVsBase.get(key) || EMPTY_CHANGES;
    if (!output || output.binary || survived.binary || removed.binary
      || [...output.added].some((line) => survived.removed.has(line))
      || [...output.removed].some((line) => !removed.removed.has(line))) {
      return;
    }

    const best = result.get(trial.file);
    if (best === undefined || trial.rank < best.rank) {
      result.set(trial.file, { rank: trial.rank, oid: trial.theirs });
    }
  });

  return new Map([...result].map(([file, best]) => [file, best.oid]));
}

const EMPTY_CHANGES = { removed: new Set(), added: new Set(), binary: false };

/**
 * Per path, the line numbers `diff -U0 from to` removes (from-side) and adds (to-side). Paths with
 * no textual difference are absent.
 */
function lineChanges(git, from, to) {
  const changes = new Map();
  let current = null;
  const output = git.invoke(['diff-tree', '-r', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', from, to]);
  for (const line of splitLines(output)) {
    const header = /^diff --git a\/(\S+) b\//.exec(line);
    if (header) {
      current = { removed: new Set(), added: new Set(), binary: false };
      changes.set(header[1], current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('Binary files ')) {
      current.binary = true;
      continue;
    }

    // "@@ -start[,count] +start[,count] @@"; an omitted count is 1.
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      addRange(current.removed, Number(hunk[1]), hunk[2] === undefined ? 1 : Number(hunk[2]));
      addRange(current.added, Number(hunk[3]), hunk[4] === undefined ? 1 : Number(hunk[4]));
    }
  }
  return changes;
}

function addRange(set, start, count) {
  for (let line = start; line < start + count; line++) {
    set.add(line);
  }
}

/**
 * Each wanted path's blobs the library held since its latest import, newest first: lineage output,
 * then the imported tree and the commit it was read from.
 */
function libraryTimelines(ctx, wanted) {
  const { git, log, jsonPath, stateKey } = ctx;
  const ref = `refs/gittools/${stateKey}/base`;

  const lineage = lineageTimelines(git, ref, wanted, true);
  if (!lineage.imported) {
    return lineage.timelines;
  }

  const ancestry = [`${lineage.imported.commit}^{tree}`];
  const head = lineage.imported.head;
  if (head) {
    if (git.invokeRaw(['cat-file', '-e', `${head}^{commit}`]).status !== 0) {
      log.info('The commit the library was last imported from is gone; matching against the whole base lineage.');
      return lineageTimelines(git, ref, wanted, false).timelines;
    }
    ancestry.push(`${head}:${jsonPath}`);
  }

  const timelines = lineage.timelines;
  for (const treeish of ancestry) {
    for (const [file, entry] of listTree(git, treeish, wanted)) {
      if (!timelines.has(file)) {
        timelines.set(file, []);
      }
      timelines.get(file).push(entry.oid);
    }
  }
  return timelines;
}

/**
 * Each wanted path's blobs across the base lineage, newest first, and the latest import entry.
 * With `stopAtImport`, entries from that import on are left out. A missing ref yields none.
 */
function lineageTimelines(git, ref, wanted, stopAtImport) {
  const timelines = new Map();
  let imported = null;
  if (!git.resolveRef(ref)) {
    return { timelines, imported };
  }

  const importHeader = new RegExp(`^@([0-9a-fA-F]+) ${LINEAGE_IMPORT_SUBJECT}(?: ([0-9a-fA-F]+))?$`);
  const output = git.invoke(['-c', 'core.quotePath=false', 'log', '--root', '--no-renames', '--raw', '--no-abbrev', '--format=@%H %s', ref]);
  for (const line of splitLines(output)) {
    if (line.startsWith('@')) {
      const match = imported ? null : importHeader.exec(line);
      if (match) {
        imported = { commit: match[1], head: match[2] || '' };
        if (stopAtImport) {
          break;
        }
      }
      continue;
    }

    const entry = rawEntry(line);
    if (entry && wanted.has(entry.path)) {
      if (!timelines.has(entry.path)) {
        timelines.set(entry.path, []);
      }
      timelines.get(entry.path).push(entry.oid);
    }
  }
  return { timelines, imported };
}

/** Blob entries of `treeish`, limited to `wanted` paths unless it is null; none if it is absent. */
function listTree(git, treeish, wanted) {
  const entries = new Map();
  const result = git.invokeRaw(['-c', 'core.quotePath=false', 'ls-tree', '-r', treeish]);
  if (result.status !== 0) {
    return entries;
  }
  for (const line of splitLines(result.stdout)) {
    const match = /^(\d{6}) blob ([0-9a-fA-F]+)\t(.+)$/.exec(line);
    if (match && (wanted === null || wanted.has(match[3]))) {
      entries.set(match[3], { mode: match[1], oid: match[2] });
    }
  }
  return entries;
}

/**
 * Post-image of a `--raw` record (plain or `--cc` combined), or null for any other line and for
 * deletions: an absent file never counts as a version.
 */
function rawEntry(line) {
  const tab = line.indexOf('\t');
  if (!line.startsWith(':') || tab === -1) {
    return null;
  }

  // ":<modes...> <oids...> <status>", with one leading colon per parent.
  const fields = line.slice(0, tab).split(' ');
  const parents = /^:+/.exec(fields[0])[0].length;
  const oid = fields[2 * parents + 1];
  return oid && !NULL_OBJECT_ID.test(oid) ? { path: line.slice(tab + 1), mode: fields[parents], oid: oid } : null;
}

function unique(values) {
  return [...new Set(values)];
}

module.exports = { buildPerFileBase };
