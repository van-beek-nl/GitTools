# GitTools Import/Export Redesign

## Summary

This design replaces the current detach/reset/commit export merge with a tree-based flow that does not move `HEAD`, does not create visible branches or commits, and does not need a post-commit hook. GitTools stores one reconciled base tree per registered library and uses that tree both as the Omnis export cache seed and as the merge base for source/export reconciliation.

The implementation should continue to touch only the registered Omnis JSON export path. Other repository files remain normal Git-managed files and are not changed by GitTools import/export logic.

## Metadata Model

Use structured v2 metadata and private cache files under `.git/gittools/<library-id>/`.

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

`baseCommit` is intentionally omitted. Once comparisons, cache seeding, and merges are based on tree objects, the commit containing a tree is not needed. This is also what removes the need for a post-commit hook.

The private cache should contain real files for at least the current `baseTree`. This prevents aggressive Git object cleanup from breaking a later export. Pending export conflicts should also cache the pending source tree and pending export tree until the pending state is cleared.

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

- Seed a temp repo-shaped export root from the private `baseTree` cache.
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
- Update the private base cache from `exportTree`.
- Clear `pending`.
- Set `status = clean`.

On conflicted merge:

- Leave `baseTree` unchanged.
- Store `pending.baseTree`, `pending.sourceTree`, and `pending.exportTree`.
- Cache the pending source tree and pending export tree.
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
- Update the private base cache from the live source.
- Clear any pending export-conflict metadata.
- Set `status = clean`.

## Scenario Handling

### New Repository With No Commits

No commit hash is required. Export starts from an empty base cache and writes a first `baseTree`. Import hashes the live JSON path directly and records that tree.

### Export, Commit, Export Again Without Import

No post-commit hook is needed. `baseTree` advances during the first successful export, before the user commits. The second export therefore uses the correct base and does not create false sibling conflicts.

### Export Twice Before Committing

`sourceTree` lets GitTools recognize that the live uncommitted JSON source is the output of the previous export. The next export uses that live source instead of falling back to `HEAD`.

### Pull Before Export

If the current source differs from `baseTree`, GitTools merges current source with the temp binary export using `baseTree` as the merge base.

### Clean Export Merge

The live JSON source receives the merged result, `baseTree` advances to `exportTree`, and `sourceTree` records the final live source tree.

### Conflicting Export Merge

The live JSON source is left with normal Git conflicts. Metadata records pending state, and the user resolves via their Git client. This is an acceptable export outcome.

### Resolved Conflict Before Next Export

If pending metadata exists and the clean JSON path differs from `pending.sourceTree`, GitTools treats the pending export as accepted. `baseTree` advances to `pending.exportTree`.

### Discarded Conflict Before Next Export

If pending metadata exists and the clean JSON path equals `pending.sourceTree`, GitTools treats the pending export as discarded. `baseTree` remains unchanged, and a later export can reproduce the conflict.

### Dirty Files Outside The JSON Path

Untouched.

### Dirty Files Inside The JSON Path During Export

Discarded only as part of the export flow, after the temp Omnis export has succeeded. This matches the current GitTools behavior.

## Migration And Hook Cleanup

- On first read of old commit-only metadata, derive `baseTree` from `<oldCommit>:<jsonPath>` when possible and populate the private base cache.
- Stop installing the GitTools post-commit hook for new registrations.
- Remove only GitTools' own hook and mapping files during migration.
- Preserve user hooks and any original hooks that were moved into the dispatcher directory.

## Demonstration Scripts

The repository contains two PowerShell demonstration scripts:

- `scripts/gittools-export-procedure.ps1`
- `scripts/gittools-import-procedure.ps1`

They demonstrate the Git procedure and leave Omnis-specific import/export work as prompted manual steps.
