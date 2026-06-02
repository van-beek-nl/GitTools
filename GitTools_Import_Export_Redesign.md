# GitTools Import/Export Redesign

## Summary

This design replaces the current detach/reset/commit export merge with a tree-based flow that does not move `HEAD`, does not create visible branches or commits, and does not need a post-commit hook. GitTools stores one reconciled base tree per registered library and uses that tree both as the Omnis export cache seed and as the merge base for source/export reconciliation.

The implementation should continue to touch only the registered Omnis JSON export path. Other repository files remain normal Git-managed files and are not changed by GitTools import/export logic.

## Metadata Model

Use structured v2 metadata stored at `.git/gittools/<library-id>/meta.json`, plus durability refs under `refs/gittools/<library-id>/` (see Durability below).

```json
{
  "version": 2,
  "jsonPath": "relative/path/to/export",
  "baseTree": "<tree hash>",
  "sourceTree": "<tree hash>",
  "status": "clean",
  "pending": null
}
```

Fields:

- `baseTree`: the latest binary-equivalent export tree accepted as the merge base.
- `sourceTree`: the latest clean live source tree GitTools intentionally produced or imported.
- `status`: either `clean` or `pendingExportConflict`.
- `pending`: only populated after an export merge leaves conflicts in the live tree.

For a conflicted export:

```json
{
  "status": "pendingExportConflict",
  "pending": {
    "baseTree": "<previous baseTree>",
    "sourceTree": "<source tree before export merge>",
    "exportTree": "<temp Omnis export tree>"
  }
}
```

`baseCommit` is intentionally omitted from the metadata: comparisons, seeding, and merges all operate on tree objects, so no commit hash is needed to drive them.

### Durability

A tree named only by `meta.json` is invisible to Git and would eventually be removed by `git gc`. To keep the trees GitTools depends on, it pins them with refs under `refs/gittools/<library-id>/`:

- `base`: a commit lineage. Each accepted export or import creates a commit with `git commit-tree` (parent = the previous base commit) whose tree is the new `baseTree`, then advances the ref. This keeps `baseTree` and its blobs reachable and yields a debuggable history viewable with `git log refs/gittools/<library-id>/base`.
- `pending-source` and `pending-export`: refs that pin the two transient trees of a conflicted export. They are deleted as soon as the pending state is resolved or discarded. (`pending.baseTree` needs no ref of its own; on a conflict `baseTree` is unchanged and is still pinned by the `base` ref.)

`git commit-tree` and `git update-ref` never move `HEAD`, create no visible branch, and never fire the post-commit hook. That is what lets GitTools keep a private commit lineage without the fragility of the old detach/commit approach, and is what removes the need for the post-commit hook entirely. The committer identity and `commit.gpgsign` should be pinned for these commits so they never depend on, or get attributed to, the user's Git config.

No file copies of trees are kept. The refs alone provide durability, and the temp export seed is materialized on demand from the pinned `baseTree`.

## Tree Hashing

Every tree GitTools compares or merges (`baseTree`, `sourceTree`, the current source tree, and the temp `exportTree`) must be hashed in the same normalization space as the committed source. `.gitattributes` rules and `core.autocrlf` can normalize content (most commonly CRLF to LF) when Git stores it. If one tree is hashed with that normalization applied and another without, identical content hashes to different blobs and the merge reports spurious conflicts on files no one changed.

Two rules keep the trees consistent:

1. **Hash content as if it lived at its real repository path.** For content that physically lives outside its tracked location (the temp Omnis export and the private base cache), hash each file with `git hash-object --path "<jsonPath>/<relativePath>"`. The `--path` argument makes Git apply the exact attribute/filter rules of the real path, even though the file is elsewhere on disk. Do **not** build these trees with `git add --work-tree=<external directory>`: that relocates `.gitattributes` lookup and silently skips normalization.

2. **Enumerate files explicitly; never snapshot a directory with `git add`.** `git add` honors `.gitignore`, which would silently drop matching files from the tree and surface them as phantom deletions in the merge. Walk the directory, hash every regular file, and assemble the tree with `git update-index --index-info` into a scratch index followed by `git write-tree`.

Trees stay rooted at the export directory (entries keyed relative to `<jsonPath>`), matching `HEAD:<jsonPath>`. `--path` only affects attribute resolution; it does not change the entry key.

## Export Procedure

### 1. Preflight

- Require a Git version that supports `git merge-tree --write-tree`.
- If unresolved Git conflicts already exist under the JSON path, abort the export and tell the user to resolve them first.
- If metadata has `status = pendingExportConflict` and no unresolved conflicts remain:
  - If the JSON path has uncommitted changes, discard them first, restoring from `HEAD` when available or from the pending source cache otherwise.
  - Recompute the clean source tree.
  - If the clean source tree equals `pending.sourceTree`, treat the prior conflict as discarded. Keep `baseTree` unchanged and clear `pending`.
  - If the clean source tree differs from `pending.sourceTree`, treat the prior conflict as resolved or accepted. Set `baseTree = pending.exportTree`, set `sourceTree = currentSourceTree`, update the base cache, and clear `pending`.

### 2. Determine Current Source

- If the live JSON path tree equals `sourceTree`, use the live tree. This lets GitTools recognize its own previous uncommitted export output.
- Else if `HEAD` exists, use `HEAD:<jsonPath>` and treat dirty live JSON changes as disposable.
- Else use the live JSON path tree. This supports repositories with no commits yet.

### 3. Temp Omnis Export

- Seed a temp repo-shaped export root from `baseTree`, materialized on demand from the pinned tree.
- If no base exists, start with an empty temp export path.
- Run the Omnis JSON export into the temp path.
- Clean irrelevant properties in the temp path.
- Build `exportTree` from the temp path.

The live JSON path is not touched until the temp export has succeeded.

### 4. Merge Or Apply

If there is no base yet, apply `exportTree` directly to the live JSON path.

If `currentSourceTree == baseTree`, apply `exportTree` directly to the live JSON path.

Otherwise run a tree merge:

```text
git merge-tree --write-tree --messages --merge-base=<baseTree> <currentSourceTree> <exportTree>
```

`git merge-tree` exits `0` on a clean merge, `1` on conflicts, and any other code on a fatal error. Only exit code `1` is treated as a conflict. Any other non-zero code must abort the export with the live JSON path left untouched, because on error the command's output is not a usable result tree and applying it would corrupt the live source and record a bogus pending conflict.

If the merge succeeds:

- Apply the returned result tree to the live JSON path.
- Update metadata and cache as a successful export.

If the merge conflicts:

- Apply the returned conflict-marker tree to the live JSON path.
- Update the real Git index with the conflict stage entries from `merge-tree`, prefixed with the JSON path, so Git clients show normal unresolved conflicts.
- Report the conflict output.
- Treat the export procedure as completed with conflicts, not as a fatal failed export.

### 5. Metadata Update

On direct apply or clean merge:

- Set `baseTree = exportTree`.
- Set `sourceTree = final live source tree`.
- Advance the `base` ref to a commit wrapping `exportTree`.
- Clear `pending` and delete the pending refs.
- Set `status = clean`.

On conflicted merge:

- Leave `baseTree` unchanged (the `base` ref still pins it).
- Store `pending.baseTree`, `pending.sourceTree`, and `pending.exportTree`.
- Pin the pending source and pending export trees with the pending refs.
- Set `status = pendingExportConflict`.
- Leave the conflict markers and unmerged index entries in the live JSON path for the user to resolve with their Git client.

## Import Procedure

### 1. Preflight

- If unresolved Git conflicts exist under the JSON path, abort import.
- Build `currentSourceTree` from the live JSON path.

### 2. Omnis Import

Run the Omnis import from the live JSON path and perform the current binary library replacement behavior.

### 3. Metadata Update

On successful import:

- Set `baseTree = currentSourceTree`.
- Set `sourceTree = currentSourceTree`.
- Advance the `base` ref to a commit wrapping `currentSourceTree`.
- Clear any pending export-conflict metadata and delete the pending refs.
- Set `status = clean`.

## Atomicity And Cleanup

`meta.json` is the commit point of every state transition. Within a single export or import, GitTools applies the working tree and updates the durability refs first, then writes `meta.json` last. The write itself goes to a sibling temp file followed by an atomic rename over the target, so an interrupted write can never leave a truncated or corrupt `meta.json`.

This ordering makes interruptions safe:

- Interrupted before `meta.json` is written: the new state is simply not recorded. The live JSON path may hold an applied-but-unrecorded export, but `sourceTree` still names the previous tree, so the next export treats the live path as disposable and reproduces the export from the (unchanged) binary library. No committed work is lost.
- Interrupted after a ref update but before `meta.json`: the ref points at a tree that `meta.json` does not yet reference. Because `meta.json` is the source of truth, the next run re-derives the same result and re-advances the ref; the only residue is a duplicate lineage commit, which is harmless.

Temporary export directories are removed even when the export fails or throws (a `try`/`finally` in the prototype; equivalent cleanup in the implementation). Scratch index files are likewise always removed.

## Scenario Handling

### New Repository With No Commits

No commit hash is required. Export starts with no base and writes a first `baseTree`. Import hashes the live JSON path directly and records that tree.

### Export, Commit, Export Again Without Import

No post-commit hook is needed. `baseTree` advances during the first successful export, before the user commits. The second export therefore uses the correct base and does not create false sibling conflicts.

### Export Twice Before Committing

`sourceTree` lets GitTools recognize that the live uncommitted JSON source is the output of the previous export. The next export uses that live source instead of falling back to `HEAD`.

### Pull Before Export

If the current source differs from `baseTree`, GitTools merges current source with the temp binary export using `baseTree` as the merge base.

### Clean Export Merge

The live JSON source receives the merged result, `baseTree` advances to `exportTree`, and `sourceTree` records the final live source tree.

### Conflicting Export Merge

The live JSON source is left with normal Git conflicts. Metadata records pending state, the pending refs pin the conflict trees, and the user resolves via their Git client. This is an acceptable export outcome.

### Resolved Conflict Before Next Export

If pending metadata exists and the clean JSON path differs from `pending.sourceTree`, GitTools treats the pending export as accepted. `baseTree` advances to `pending.exportTree`.

### Discarded Conflict Before Next Export

If pending metadata exists and the clean JSON path equals `pending.sourceTree`, GitTools treats the pending export as discarded. `baseTree` remains unchanged, and a later export can reproduce the conflict.

### Dirty Files Outside The JSON Path

Untouched.

### Dirty Files Inside The JSON Path During Export

Discarded only as part of the export flow, after the temp Omnis export has succeeded. This matches the current GitTools behavior.

## Migration And Hook Cleanup

- On first read of old commit-only metadata, derive `baseTree` from `<oldCommit>:<jsonPath>` when possible and pin it behind the `base` ref.
- Stop installing the GitTools post-commit hook for new registrations.
- Remove only GitTools' own hook and mapping files during migration.
- Preserve user hooks and any original hooks that were moved into the dispatcher directory.

## Demonstration Scripts

The repository contains two PowerShell demonstration scripts:

- `scripts/gittools-export-procedure.ps1`
- `scripts/gittools-import-procedure.ps1`

They demonstrate the Git procedure and leave Omnis-specific import/export work as prompted manual steps.
