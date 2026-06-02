# GitTools Import/Export Redesign

## Summary

This design replaces the current detach/reset/commit export merge with a tree-based flow that does not move `HEAD`, does not create visible branches or commits, and does not need a post-commit hook. GitTools stores one reconciled base tree per registered library and uses that tree both as the Omnis export cache seed and as the merge base for source/export reconciliation.

The implementation should continue to touch only the registered Omnis JSON export path. Other repository files remain normal Git-managed files and are not changed by GitTools import/export logic.

## Approach And Alternatives

The reconciliation is a three-way merge: a common base (the last accepted export), the current Git source, and the fresh Omnis export. Three ways to perform that merge were considered.

1. **v1 — detach `HEAD`, soft-reset to the last-import commit, commit the dangling export, merge back.** This is the approach being replaced. It mutates `HEAD`, leaves the repository in a detached state if interrupted, and the dangling commit fires the post-commit hook — which is what corrupted the library's commit-hash `.meta` files. It is fragile precisely because it drives the merge through the repository's live `HEAD` and index.

2. **A real linked worktree per export** (the working name this branch carried). Add a throwaway `git worktree`, check the base out into it, merge there, then copy the result back. It avoids touching the primary `HEAD`, but it still performs a full checkout and a real merge on disk, needs a temporary worktree created and cleaned up under `.git/worktrees/`, and shares the same ref store (so it offers no isolation advantage over the chosen approach while adding filesystem and lifecycle overhead).

3. **Chosen — `git merge-tree --write-tree` plus a private `commit-tree` lineage.** The merge runs entirely in memory against three tree objects and returns a result tree (or conflict stages) without ever creating a worktree, moving `HEAD`, or touching the real index. Durability comes from refs under `refs/gittools/<state-key>/` built with `git commit-tree`/`git update-ref`, which never fire the post-commit hook. This removes both v1 failure modes by construction (no `HEAD` mutation, no hook), needs no temporary worktree, and keeps a debuggable private history. Its one requirement is Git ≥ 2.38 for `merge-tree --write-tree`, checked in Preflight.

The "worktree" naming on this branch refers to the general goal (reconcile without disturbing the working tree), not to alternative 2 specifically; the design realizes that goal with `merge-tree`.

## Metadata Model

Use structured v2 metadata stored at `.git/gittools/<state-key>/meta.json`, plus durability refs under `refs/gittools/<state-key>/` (see Durability below). The `<state-key>` identifies one library file, not one export path — see State Key below.

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

### State Key

The relationship between a JSON export and a binary library is **1:N**, not 1:1. A user may build several `.lbs` files from one export and work in them independently — each importing and exporting at different moments, so each carries its own last-reconciled tree. The reconciliation state therefore belongs to the **individual library file**, not to the shared export path. (This is why v1 stored its `.meta` beside each `.lbs`.) Keying state by `jsonPath` would collapse all N copies into one slot and corrupt exactly that per-copy divergence.

The state key is derived from the library file's own identity:

```
<state-key> = <libraryFilename>-<hash8(canonicalLibraryPath)>
```

- The `<libraryFilename>` prefix keeps keys human-readable when inspecting `.git/gittools/` or `refs/gittools/`; the hash suffix guarantees distinct paths never alias (a naive character-substitution of the path could map `libs/a` and `libs-a` to the same key).
- The library file may live **outside** the version-controlled directory — users sometimes keep `.lbs` files out of the repo rather than gitignoring them. Keying by the library path (rather than a repo-relative path) handles that: state still lives in the export repo's `.git` (the repo is unambiguous — it is the one containing `jsonPath`), but the key is independent of repo layout.
- `canonicalLibraryPath` **must** be canonicalized before hashing, or the same file reached two ways produces two keys: resolve symlinks/aliases to a real path (macOS `/Users` vs `/System/Volumes/Data/Users`, symlinked project dirs, Windows UNC vs mapped drives), and case-fold **only on case-insensitive filesystems** (macOS/Windows — the same `core.ignorecase` distinction as the case-collision note under Assumptions). The canonical key must be computed by one authority (in production, Omnis) so it is stable across invocations.

Keying by library path has one accepted cost: **moving the `.lbs` changes its key**, so the moved library re-baselines (its next export applies directly or merges against `HEAD` rather than continuing the old lineage). This is never destructive — the no-base path is backstopped by the "warn before overwriting committed source" guard (see Merge Or Apply) — and copies (which must stay distinct) matter more than moves (which are rare). A post-implementation enhancement can recover the cost on demand: when a new library path registers, look for a **stale** entry (matching filename, whose absolute path no longer exists) and offer to re-wire it; if several stale entries share the filename, let the user pick.

Because the key is the library path and `jsonPath` is independent of it, repointing a library's export location leaves the key unchanged while `baseTree` still describes the old location. The Metadata Update and read steps therefore reset the base when `meta.jsonPath` no longer matches the configured path (see Export Procedure).

### Durability

A tree named only by `meta.json` is invisible to Git and would eventually be removed by `git gc`. To keep the trees GitTools depends on, it pins them with refs under `refs/gittools/<state-key>/`:

- `base`: a commit lineage. Each accepted export or import creates a commit with `git commit-tree` (parent = the previous base commit) whose tree is the new `baseTree`, then advances the ref. This keeps `baseTree` and its blobs reachable and yields a debuggable history viewable with `git log refs/gittools/<state-key>/base`.
- `pending-source` and `pending-export`: refs that pin the two transient trees of a conflicted export. They are deleted as soon as the pending state is resolved or discarded. (`pending.baseTree` needs no ref of its own; on a conflict `baseTree` is unchanged and is still pinned by the `base` ref.)

`git commit-tree` and `git update-ref` never move `HEAD`, create no visible branch, and never fire the post-commit hook. That is what lets GitTools keep a private commit lineage without the fragility of the old detach/commit approach, and is what removes the need for the post-commit hook entirely. The committer identity and `commit.gpgsign` should be pinned for these commits so they never depend on, or get attributed to, the user's Git config.

No file copies of trees are kept. The refs alone provide durability, and the temp export seed is materialized on demand from the pinned `baseTree`.

## Tree Hashing

Every tree GitTools compares or merges (`baseTree`, `sourceTree`, the current source tree, and the temp `exportTree`) must be hashed in the same normalization space as the committed source. `.gitattributes` rules and `core.autocrlf` can normalize content (most commonly CRLF to LF) when Git stores it. If one tree is hashed with that normalization applied and another without, identical content hashes to different blobs and the merge reports spurious conflicts on files no one changed.

Two rules keep the trees consistent:

1. **Hash content as if it lived at its real repository path.** For content that physically lives outside its tracked location (the temp Omnis export and the private base cache), hash each file with `git hash-object --path "<jsonPath>/<relativePath>"`. The `--path` argument makes Git apply the exact attribute/filter rules of the real path, even though the file is elsewhere on disk. Do **not** build these trees with `git add --work-tree=<external directory>`: that relocates `.gitattributes` lookup and silently skips normalization.

2. **Enumerate files explicitly; never snapshot a directory with `git add`.** `git add` honors `.gitignore`, which would silently drop matching files from the tree and surface them as phantom deletions in the merge. Walk the directory, hash every regular file, and assemble the tree with `git update-index --index-info` into a scratch index followed by `git write-tree`.

Trees stay rooted at the export directory (entries keyed relative to `<jsonPath>`), matching `HEAD:<jsonPath>`. `--path` only affects attribute resolution; it does not change the entry key.

### Building The Export Tree Incrementally

Re-hashing every file on every export does not scale: large libraries export thousands of files, and hashing all of them (worse, one `hash-object` process per file) makes each export pay for the whole library even when one method changed. Omnis already exports **incrementally** — it seeds from a previous export and rewrites only what changed — so the tree build should cost the same: proportional to the change set, not the library size.

This is done with Git's index **stat cache**, which is how `git status` stays fast on large repositories: the index records each file's size and mtime, so Git can tell what changed without reading content.

1. **Seed a scratch index from `baseTree` and record stat info.** Materialize the temp export directory from `baseTree` with `git checkout-index -a -u` (the `-u` writes the checked-out files' stat info into the scratch index). The index now mirrors the base, with stat that matches the files on disk.
2. **Let Omnis export over that directory.** It rewrites only changed files and deletes removed ones.
3. **Find the change set by stat, not by hashing.** `git diff-files --name-status` reports tracked files whose stat changed (modified) or that vanished (deleted); `git ls-files --others` reports new files. Neither reads the content of unchanged files. (`ls-files --others` is used **without** `--exclude-standard`, so `.gitignore`d files in the export are still captured, consistent with rule 2 above.)
4. **Hash only the change set, then `write-tree`.** Re-hash each modified and new file with `hash-object --path` (rule 1), record deletions, and leave every unchanged entry on its existing base blob. `git write-tree` produces a tree **byte-identical** to a full rebuild — only the changed files were read.

Because no base exists on a first export, the scratch index starts empty and every exported file is reported as new, which naturally degrades to a full hash — correct, just not cheaper. The scratch index may also be persisted under `.git/gittools/<state-key>/` so even the seed step is avoided on the next export. (This optimization applies to the **export** tree, which is seeded from the base. The current-source and import trees are hashed from the live working tree, where the same stat-cache technique could be applied against the repository's own index but is out of scope here.)

## Export Procedure

### 1. Preflight

- Require a Git version that supports `git merge-tree --write-tree`.
- Read the metadata for this library's state key. If `meta.jsonPath` differs from the currently configured export path, the export location was repointed and the stored trees describe the old location: discard `baseTree`, `sourceTree`, and `pending`, delete the durability refs, and continue as a first export. (The state key is the library path, which is unchanged by repointing, so this reset is what keeps a moved export path from merging against an unrelated base.)
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

- Seed a temp repo-shaped export root from `baseTree`, materialized on demand from the pinned tree, recording stat info into a scratch index (see Building The Export Tree Incrementally).
- If no base exists, start with an empty temp export path and an empty scratch index.
- Run the Omnis JSON export into the temp path.
- Clean irrelevant properties in the temp path.
- Build `exportTree` incrementally from the scratch index, hashing only the files Omnis changed.

The live JSON path is not touched until the temp export has succeeded.

### 4. Merge Or Apply

If there is no base yet, apply `exportTree` directly to the live JSON path. There is no safe three-way base in this case, so no merge is possible. The only hazard is overwriting committed source whose change direction is unknowable without a base: if `HEAD:<jsonPath>` exists and differs from `exportTree`, GitTools warns loudly that the export will overwrite the committed source before applying, and leaves the result uncommitted so the user can review the diff (or import first to take the repository's version instead). When `HEAD` has no source at the path, or the export already equals `HEAD:<jsonPath>`, it applies silently. Uncommitted live JSON is disposable by policy and never triggers the warning.

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

### First Export With No Base But Committed Source Exists

If no base exists yet but `HEAD:<jsonPath>` already has committed source (for example a fresh clone where the user exports before importing, or unrecoverable old metadata), the change direction cannot be known. If the export equals the committed source, it applies silently. If it differs, GitTools warns that applying will overwrite the committed source and proceeds, leaving the result uncommitted for review. The user can instead import first to adopt the repository's source as the base.

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

This comparison is intentionally ambiguous and resolved toward safety. Two different user actions leave the clean source equal to `pending.sourceTree` and cannot be told apart: a genuine discard (reverting the export), and resolving the conflict by taking the incoming/source side wholesale when the export had no cleanly-merged side changes. GitTools always assumes discard and keeps `baseTree`. The cost is a known, accepted limitation: a conflict resolved entirely in favour of the incoming side may reappear on the next export, until the user changes the library or imports the resolved source. The alternative — assuming the export was accepted and advancing `baseTree` to `pending.exportTree` — is rejected because, on a genuine discard, it would treat the library's still-present change as already reconciled and silently strand it, never offering it for export again. A recurring, visible conflict is preferable to a silently dropped change.

### Dirty Files Outside The JSON Path

Untouched.

### Dirty Files Inside The JSON Path During Export

Discarded only as part of the export flow, after the temp Omnis export has succeeded. This matches the current GitTools behavior.

## Migration And Hook Cleanup

- On first read of old commit-only metadata, derive `baseTree` from `<oldCommit>:<jsonPath>` when possible and pin it behind the `base` ref.
- Stop installing the GitTools post-commit hook for new registrations.
- Remove only GitTools' own hook and mapping files during migration.
- Preserve user hooks and any original hooks that were moved into the dispatcher directory.

## Assumptions And Constraints

These hold for the environments GitTools targets and bound the design. Each should appear in the test matrix.

### Submodules

When the JSON export lives inside a Git submodule, GitTools operates on the **submodule itself** as the repository, not its parent. v1 reported the parent as the repository root specifically so it could install a post-commit hook (a submodule's `.git` is a file, not a directory, which made hook installation awkward). v2 installs no hook, so that reason is gone — and operating on the parent would actively break the tree model, because the parent tracks the submodule as a gitlink, not as a tree of files (`HEAD:<jsonPath>` would not resolve and `git add` of paths inside the submodule would be refused). A submodule is a complete repository with its own index and ref store; `git rev-parse --git-path gittools/<state-key>` resolves correctly into its `modules/<name>/` git dir, and `refs/gittools/*` land in its own ref store. The repository-root lookup used for v2 path resolution must therefore **not** ascend to the parent for submodules (the v1 "check for parent" behavior).

### One Worktree Per Library

GitTools state is keyed per `(repository, state-key)`, and a linked worktree (`git worktree add`) shares the common `refs/` store and git dir with its main worktree — so `refs/gittools/<state-key>/*` and `.git/gittools/<state-key>/meta.json` are shared across all worktrees of one repository, while the on-disk source is not. Registering the **same library file** through two linked worktrees would make them share one base/source/pending state and thrash it. This is unsupported: assume one worktree per registered library. No content-derived key fixes this (two worktrees see the same library path), and per-worktree ref storage (`refs/worktree/*`) is version-sensitive and awkward to drive from the shell layer, so it is not used.

### Case-Insensitive Filesystems

Git trees are case-sensitive; macOS and Windows filesystems are not. Two export files differing only in case would collide on disk when the result tree is written out (one would clobber the other, surfacing as a phantom deletion on the next hash). This cannot arise in practice because Omnis matches class and method names case-insensitively, so a library cannot contain two classes or two methods differing only in case, and the export filenames derive from those names. GitTools relies on this Omnis guarantee rather than adding its own collision handling. (The same `core.ignorecase` distinction governs canonical key case-folding under State Key.)

### No Git LFS In The Export

The JSON export subtree is expected to be text (`.json` and `.omh`) and is never placed under Git LFS. GitTools therefore does no LFS handling. If a repository ever did put the export path under LFS, the shell environment GitTools spawns would need git-lfs configured for `hash-object` to produce pointer blobs consistent with the committed source — but this is out of scope.

### Disjoint, Non-Nested Export Paths

`exportAll` processes registered libraries serially. Tree construction uses scratch indexes (`GIT_INDEX_FILE`), so it never touches the real index; only the conflict-application path mutates the real index, and every operation there is scoped to `-- <jsonPath>`. Two libraries with disjoint export paths therefore stay independent even when both conflict in one pass. Nested export paths (one library's `jsonPath` inside another's) would break this scoping — but they are already impossible, because the Omnis import treats a whole export directory as a single library, so each library must have its own non-nested export path.

### Library File Location

The `.lbs` may live inside or outside the version-controlled directory (see State Key). The design assumes it is reachable by a stable canonical path so the state key is stable; moving it re-baselines, which the optional register-time recovery can mend.

## Demonstration Scripts

The repository contains two PowerShell demonstration scripts:

- `scripts/gittools-export-procedure.ps1`
- `scripts/gittools-import-procedure.ps1`

They demonstrate the Git procedure and leave Omnis-specific import/export work as prompted manual steps.
