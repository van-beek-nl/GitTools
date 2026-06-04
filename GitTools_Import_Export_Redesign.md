# GitTools Import/Export Design

GitTools turns an Omnis binary library (`.lbs`) into a folder of text source
(`.json` / `.omh`) that Git can version, review, and merge, and turns that source
back into a binary library. This document describes how the **export** and
**import** procedures reconcile three drifting versions of the source — the
binary library, the local committed/working source, and what teammates have
pushed — without ever silently overwriting anyone's work.

The procedures are demonstrated by four PowerShell scripts under `scripts/`. In
production the same logic runs inside Omnis (`$execute`); the scripts are the
reference implementation and test surface. The plain-language companion is
[How_GitTools_Works.md](How_GitTools_Works.md); the superseded design is kept as
`GitTools_Import_Export_Redesign.old.md`.

---

## 1. Design goals and the approach chosen

The reconciliation is fundamentally a **three-way merge**: a common base (the
last point the library and the source agreed), the current Git source, and the
fresh Omnis export. Three ways to perform that merge were considered:

1. **v1 — detach `HEAD`, soft-reset to the last-import commit, commit the
   dangling export, merge back.** This mutates `HEAD`, leaves the repo detached
   if interrupted, and fires the post-commit hook (which corrupted the old
   commit-hash `.meta` files). It drove the merge through the repository's live
   `HEAD` and index — the source of its fragility.
2. **A real linked worktree per export.** Avoids touching the primary `HEAD`, but
   still performs a full checkout and a real merge on disk, needs a temporary
   worktree created and cleaned under `.git/worktrees/`, and shares the ref store
   anyway — filesystem and lifecycle overhead with no isolation benefit.
3. **Chosen — `git merge-tree --write-tree` plus a private `commit-tree`
   lineage.** The merge runs entirely in memory against three tree objects and
   returns a result tree (or conflict stages) without ever creating a worktree,
   moving `HEAD`, or touching the real index. Durability comes from refs under
   `refs/gittools/<state-key>/` built with `commit-tree` / `update-ref`, which
   never fire the post-commit hook. This removes both v1 failure modes by
   construction.

**Requirements.** Git ≥ 2.38 (for `merge-tree --write-tree`; the design also uses
`restore --pathspec-from-file`, `rev-list --no-commit-header`, and
`update-index --index-info`). No external dependencies beyond Git and the host
shell, so the same logic ports to bash, PowerShell, and Omnis. Git output is
parsed newline-delimited, never `-z`/NUL.

---

## 2. The four phases and the Omnis contract

Each Omnis operation is split into a **pre** and **post** script around the point
where Omnis itself reads or writes files. The split exists because the export's
transient state (which source tree we are reconciling against) must be decided
*before* Omnis overwrites the export directory, and consumed *after*.

| Script | Runs | Responsibility |
|--------|------|----------------|
| `pre-export.ps1`  | before Omnis exports | preflight; resolve any pending conflict; decide the current source tree **and** the merge base; ensure the export cache exists; write the handoff |
| `post-export.ps1` | after Omnis exports  | build the export tree from the cache; apply or three-way-merge it into the live source; update metadata + refs; clear the handoff |
| `pre-import.ps1`  | before Omnis imports | preflight (refuse to import unresolved conflicts); print the path to import from |
| `post-import.ps1` | after Omnis imports  | record the imported source as the new base |

**Output discipline (the contract with Omnis).** All human-readable progress
goes to **stderr** (`Write-Step` / `Write-Note`, plus opt-in `GITTOOLS_TIMING`
diagnostics). **stdout** carries only machine-readable values:

- `pre-export.ps1` prints **nothing** — Omnis derives the export directory itself
  from the git dir + state key (`git rev-parse --git-path
  gittools/<state-key>/export-cache`), so no path needs returning.
- `pre-import.ps1` prints the single absolute path Omnis imports from.
- `post-export.ps1` / `post-import.ps1` print `RESULT=clean` or `RESULT=conflict`.

Pre-scripts signal **abort with a non-zero exit code**; Omnis must not run its
import/export step when a pre-script aborts. A conflict is **not** an error — it
is a successful, expected outcome that exits zero with `RESULT=conflict`.

---

## 3. Per-library state

### 3.1 The state key (why per-library, not per-path)

The export-to-library relationship is **1:N**: several `.lbs` files may be built
from one shared source folder and worked on independently, each importing and
exporting at different moments. Reconciliation state therefore belongs to an
individual **library file**, not the shared export path. Keying by the export
path would collapse all N copies into one slot and destroy exactly that per-copy
divergence.

The **state key** is `<sanitized-filename>-<hash8>`, where `hash8` is the first 8
hex chars of the SHA-1 of the library's canonical absolute path (lowercased on
case-insensitive filesystems, left as-is on Linux). The filename prefix keeps
`.git/gittools/` and `refs/gittools/` readable; the hash suffix stops two
same-named libraries in different folders from aliasing onto one key. Omnis
computes the identical key; `Get-StateKey` mirrors it.

Keying by library path has one accepted cost: **moving the `.lbs` changes its
key**, so the moved library re-baselines on its next export (it applies directly
or merges against the recomputed base rather than continuing the old lineage).
This is never destructive — the no-base path is backstopped by the
overwrite-warning guard (§6).

### 3.2 Metadata (`meta.json`)

Stored at `.git/gittools/<state-key>/meta.json`:

```json
{
  "version": 2,
  "jsonPath": "<repo-relative export path>",
  "baseTree": "<tree id>",
  "sourceTree": "<tree id>",
  "status": "clean | pendingExportConflict",
  "pending": null
}
```

- `baseTree` — the latest accepted export/import tree. It advances on every clean
  apply, clean merge, and import, and is the merge base on the **continuation
  path** (§5). No commit hash is stored; comparisons, seeding, and merges all
  operate on tree objects.
- `sourceTree` — the source tree GitTools last produced or observed. This is what
  lets GitTools recognise the live working source as *its own* previous output
  (so export-before-commit and repeated exports work) versus a source that has
  moved underneath it.
- `pending` — populated only while an export merge has left unresolved conflicts
  in the live tree:

  ```json
  "pending": { "baseTree": "...", "sourceTree": "...", "exportTree": "..." }
  ```

  `baseTree` here is the base the conflicting merge actually ran against (the
  resolved ancestor, not necessarily the old `meta.baseTree`), so a later
  discard-vs-accept can be classified correctly (§7).

If `meta.jsonPath` no longer matches the configured export path, the export
location was repointed: the stored trees describe the old location, so `baseTree`,
`sourceTree`, and `pending` are reset and the durability refs dropped — the next
export starts from a clean first-export state.

### 3.3 Durability refs

Trees named only by `meta.json` are invisible to Git and would be garbage-
collected. Each state key therefore keeps refs under `refs/gittools/<state-key>/`:

- **`base`** — a **commit lineage**. Each accepted export/import wraps the new
  base tree in a `commit-tree` whose parent is the previous base commit, then
  advances the ref. This keeps the base tree (and its blobs) reachable, yields a
  debuggable history (`git log refs/gittools/<state-key>/base`), and — critically
  — provides the set of trees the fallback base resolution searches (§5.2). The
  committer identity and `commit.gpgsign` are pinned so these commits never
  depend on, or get attributed to, the user's Git config.
- **`pending-source`, `pending-export`** — pin the two transient trees of a
  conflicted export; deleted as soon as the pending state resolves or is
  discarded.

`commit-tree` and `update-ref` never move `HEAD`, create no branch, and never
fire the post-commit hook. These refs are **local** (not pushed), so each clone's
lineage reflects that clone's own imports and exports — which is exactly what the
fallback base resolution needs.

---

## 4. Trees: hashing, normalization, and the export cache

Every version of the source is reduced to a single **tree** rooted at `<jsonPath>`
(entries keyed relative to it, matching `HEAD:<jsonPath>`), so comparing two
versions is comparing two hashes.

### 4.1 Normalization

Every tree GitTools compares or merges must be hashed in the **same normalization
space** as the committed source. `.gitattributes` / `core.autocrlf` can normalize
content (e.g. CRLF→LF) when Git stores it; if one tree is hashed with that
normalization and another without, identical content hashes differently and the
merge reports phantom conflicts on files nobody changed. Files are therefore
hashed via `git hash-object` (which applies the repo's attributes), and the
working-tree blobs reused from the real index are already normalized.

### 4.2 Batched hashing

Changed/new files are hashed in **one** `git hash-object -w --stdin-paths`
process (newline-framed, per the no-NUL rule) rather than one process per file —
measured ~267× faster on large change sets, and byte-identical to per-file
hashing including attribute normalization (`Invoke-GitHashObjectBatch`).

### 4.3 Enumerate files explicitly; never `git add` a directory

`git add` honors `.gitignore`, which would silently drop matching files from the
tree and surface them as phantom deletions. Trees are assembled by enumerating
files (`diff-files`, `ls-files --others` **without** `--exclude-standard`,
`ls-files --stage`) into a scratch index via `update-index --index-info`, then
`write-tree`. The export is authoritative for its own path.

### 4.4 The persistent export cache

Omnis exports into a per-library directory at
`.git/gittools/<state-key>/export-cache/`, paired with a persistent scratch index
`export-cache.index`. The cache exists **purely to make Omnis's own incremental
export fast** — Omnis is its sole writer and always produces a complete, correct
export over whatever is there (pruning files for deleted classes), so GitTools
**never seeds it from `baseTree` and never reconciles it**. A stale cache (after
an import, a conflict, or a crash) costs Omnis some incremental speed, never
correctness: the authoritative export is the directory *as Omnis leaves it*, and
the merge base comes from the refs/metadata — neither depends on the cache.

`Initialize-ExportCache` only ensures the directory and an empty stat-index exist;
on the very first export both are empty, so Omnis does a full export and
post-export hashes everything once. Because Omnis overwrites the directory
wholesale, a nested `.gitattributes` can never appear inside it.

### 4.5 Building the export tree incrementally

`New-IncrementalExportTree` builds the export tree by hashing **only the files
Omnis changed** since the cache index was last in step with the directory:

1. `update-index --refresh` the cache index against the directory's current stats.
2. `diff-files --name-status` → tracked files whose stat changed: modified
   (re-hash) or deleted (drop with a mode-0 record).
3. `ls-files --others` → new files (hash).
4. Batch-hash the modified+new set; feed all records to `update-index
   --index-info`; `write-tree`.
5. `update-index --refresh` once more so the just-written entries record their
   stat and stay "unchanged" next run.

The result is byte-identical to a full rebuild, but the cost scales with the
change set, not the library size. The index only needs to be a consistent prior
snapshot of the directory — which the persistent cache index always is, even
after a crashed export — so the build is self-healing.

### 4.6 Hashing the live source

`New-LiveSourceTree` reduces the **live working source** to a tree the same way,
fast path first: copy the real repository index (it already holds every tracked
blob), apply the small working-tree delta (`diff-files` modified/deleted,
`ls-files --others` new — all batch-hashed), and let Git assemble the subtree in
C with `write-tree --prefix=<jsonPath>/`. `write-tree` aborts if **any** index
entry is unmerged (even outside `<jsonPath>`), and there may be no index file
yet, so those cases fall back to `New-LiveSourceTreeScoped`, which builds from an
empty scratch index touching only `<jsonPath>` and is therefore unaffected by
unrelated conflicts. Both reuse unchanged blobs straight from the index and force
mode `100644` (true for Omnis `.json`/`.omh` output).

---

## 5. The reconciliation model (the heart of the design)

On export, the pre-script decides two things that depend on the live path and
`HEAD` as they stand **before** Omnis overwrites the export directory: the
**current source tree** (the `ours` side of the merge) and the **merge base**.
Both are carried to the post-script in the handoff. `Resolve-CurrentSourceAndBase`
distinguishes two regimes.

### 5.1 Continuation path

If the live source tree **equals `meta.sourceTree`**, the live source is still
GitTools' own last output — the user is iterating (export-before-commit, repeated
export). The current source is the live tree and the merge base is the advanced
`meta.baseTree`. This is the common fast path and is what lets iterative exports
combine cleanly without false conflicts.

### 5.2 Fallback path (source moved beneath us)

If the live source no longer equals `meta.sourceTree` (a pull, a discard, or a
**partial commit** moved it) and `HEAD` exists, the live edits are disposable and
**`HEAD:<jsonPath>` is the source side**. Here the advanced `baseTree` is
unreliable — it can sit *ahead of* the committed source (e.g. a deletion that was
exported then discarded) or *diverged from* it — so using it makes a three-way
merge mis-attribute changes (silently resurrecting deletions, or dropping
committed work).

The correct base is the **true common ancestor**: the most recent commit
reachable from `HEAD` whose `<jsonPath>` subtree GitTools recorded as a base (an
import or a prior export). `Resolve-FallbackMergeBase` finds it by walking
`rev-list --full-history HEAD -- <jsonPath>` newest-first and returning the first
commit whose subtree is in the base-ref lineage (§3.3). This is exactly the point
this library's private lineage and the committed source last agreed — the same
ancestor `git merge-base` would find if the lineage were a branch. Merging
against it:

- **reproduces the library's changes** (including deletions discarded from the
  working source, and work-in-progress that resurfaces after a partial commit);
- **preserves genuine source-side divergence** a teammate committed; and
- **surfaces real `delete/modify` and `modify/modify` conflicts** instead of
  silently resolving them.

The search is purely local (this clone's recorded lineage against this `HEAD`'s
history), so teammates importing at other commits never affect it. It returns
`""` only when no recorded base is reachable from `HEAD` — a fresh clone with no
local lineage, or a rewritten history — which the post-script treats as a no-base
apply (§6).

### 5.3 No commits (no `HEAD`)

With no commits yet, the current source is the live tree and the base is
`meta.baseTree` (empty on a true first export).

---

## 6. Merge or apply (post-export)

The post-script builds the export tree (§4.5), then reconciles using the
handoff's `mergeBase` and `currentSourceTree`:

1. **No base** (`mergeBase` empty — first export, repointed path, or fallback
   with no reachable ancestor): apply the export directly. The only hazard is
   overwriting committed source whose change direction is unknowable without a
   base, so if `HEAD:<jsonPath>` exists and differs from the export, GitTools
   **warns loudly** before applying and leaves the result uncommitted for review
   (or the user can import first to take the repository's version). Uncommitted
   live source is disposable by policy and never triggers the warning.
2. **Source equals base** (`currentSourceTree == mergeBase`): no divergence to
   preserve, apply the export directly.
3. **Otherwise merge**:
   `git merge-tree --write-tree --messages --merge-base=<mergeBase>
   <currentSourceTree> <exportTree>`.
   Exit `0` = clean (apply the merged result tree); exit `1` = conflict (an
   acceptable outcome); any other code aborts the export **before the live source
   is touched**, since the command's output is then not a usable tree.

On a **clean apply or merge**: write the result to the live source (§8),
`baseTree` advances to the raw export tree, `sourceTree` records the final live
tree, and the `base` ref advances. → `RESULT=clean`.

On a **conflict**: apply the conflicted result to the live source (§8), record
`pending = { baseTree: mergeBase, sourceTree: currentSourceTree, exportTree }`,
set the pending refs, leave `baseTree` unchanged. → `RESULT=conflict`.

---

## 7. Conflicts and their resolution

### 7.1 Writing the conflict

A conflicted merge is surfaced as an ordinary Git conflict so the user's existing
editor/client tools handle it (`Apply-ConflictedMergeToLiveJsonPath`): the
conflicted result tree (cleanly-merged content plus conflict markers) is written
to the live source as a delta (§8), and the conflicted paths get their stage-0
entry replaced with the unmerged **stage 1/2/3** records from `merge-tree` (which
is what makes clients show `UU`).

**Cleanly-merged changes are left UNSTAGED**, like a clean export — only the
unmerged conflict entries are special. This differs deliberately from a real
`git merge`, which stages cleanly-merged content at stage 0. The consequence is a
known, accepted trade-off around **aborting**: a client's "abort" runs
`git reset --merge`, which keeps unstaged working-tree edits and discards staged
ones. So the non-conflicting changes survive an abort (a convenience), but if the
user stages some and then aborts, exactly those are discarded — standard
`git reset --merge` behaviour, surfaced because GitTools leaves them unstaged.
(Setting a real `MERGE_HEAD` would make abort uniform but is rejected: committing
the resolution would then graft GitTools' private lineage into the user's pushable
history as a merge parent.)

### 7.2 Resolving or discarding (next pre-export)

When the next export starts with `status = pendingExportConflict`
(`Resolve-PendingConflictIfNeeded`):

- If unresolved conflicts remain in the live path, abort (the user must resolve
  them first).
- If the live path is dirty, discard those edits (disposable policy): restore
  from `HEAD` when available, otherwise from the pinned `pending.sourceTree`.
- Then compare the clean live source to `pending.sourceTree`:
  - **Equal → treated as discarded.** Keep the previous `baseTree`; clear pending.
  - **Differs → treated as resolved/accepted.** Advance `baseTree` to
    `pending.exportTree`; clear pending.

This comparison is intentionally resolved toward safety. A genuine discard and a
resolution that takes the incoming side wholesale both leave the clean source
equal to `pending.sourceTree` and cannot be told apart; GitTools always assumes
discard and keeps the base. The cost is that a conflict resolved entirely in
favour of the incoming side may reappear on the next export until the library
changes or the source is imported — a recurring, visible conflict is preferable
to a silently dropped change the library still contains.

---

## 8. Writing results back to the live source

Writing a result tree (clean export, merged source, or conflicted result) into
the live path is **proportional to what changed** — never a wipe-and-rewrite,
which is prohibitively slow on large libraries and repeatedly triggers a
filesystem delete race.

`Write-LiveJsonPathDelta` diffs the on-disk tree against the target
(`diff-tree`), deletes removed paths (pruning emptied folders), and writes the
changed/new paths in a single batched `checkout-index --stdin` from a scratch
index. It touches the **working tree only** and returns the changed paths.

The index is then adjusted minimally so the result shows as ordinary review-able
changes **without disturbing unrelated staged work** (`Reset-StagedChangesToHead`):
only paths that are *both changed by this export and currently staged* are reset
to `HEAD` (resetting an unstaged path is a no-op; a brand-new untracked path is
not in the index). This preserves any content the user had staged that this
export did not touch. For the conflict path, the same reset leaves cleanly-merged
changes unstaged, then the unmerged stage records are layered on (§7.1).

A clean apply early-outs when the live tree already equals the target (nothing to
write, index untouched).

---

## 9. Import

Import carries no transient state across the Omnis step: Omnis reads the JSON to
rebuild the binary and never writes the live path, so the post-script recomputes
the identical source tree itself and there are no temp artifacts to track.

- `pre-import.ps1`: refuse to import while the path has unresolved conflicts
  (they would bake conflict markers into the binary); print the absolute path
  Omnis imports from.
- `post-import.ps1`: hash the live source, set `baseTree = sourceTree = that
  tree`, advance the `base` ref (recording this sync point into the lineage the
  fallback resolver searches), clear any pending refs. → `RESULT=clean`.

A healthy rhythm is **pull → import → work → export → commit**.

---

## 10. Crash safety

`meta.json` is the **commit point** of a state transition. The working tree and
the durability refs are updated first; `meta.json` is written **last**, to a
sibling temp file then atomically renamed over the target, so an interrupted write
can never leave a truncated file.

- **Interrupted before `meta.json` is written:** the new state is simply not
  recorded. The live path may hold an applied-but-unrecorded export, but
  `sourceTree` still names the previous tree, so the next export treats the live
  path as disposable and reproduces the export from the (unchanged) binary
  library. No committed work is lost.
- **Interrupted after a ref update but before `meta.json`:** the ref points at a
  tree `meta.json` does not yet reference. Because `meta.json` is the source of
  truth, the next run re-derives the same result and re-advances the ref; the
  only residue is a harmless duplicate lineage commit.

The **handoff** file (`pending-op.json`) carries the export's transient state
(current source tree + merge base) between the pre- and post-scripts. Its mere
presence means "an export started but its post-script never finished"; a leftover
handoff is swept at the next pre-export (the persistent cache is self-healing, so
there is nothing else to clean). It is distinct from `status =
pendingExportConflict`, which is a *completed* export awaiting user resolution.

---

## 11. Edge cases

- **First export, no committed source:** no base; apply directly; `baseTree`
  advances before the user commits, so the second export uses the correct base
  and creates no false conflict.
- **First export, committed source already exists** (fresh clone exporting before
  importing, or unrecoverable metadata): no base. If the export equals the
  committed source it applies silently; if it differs, GitTools warns before
  overwriting and leaves the result uncommitted.
- **Export before commit, repeated:** recognised via `sourceTree` (continuation
  path); merges against the advanced base, no false conflict.
- **Discarded deletion / partial discard / partial commit:** the fallback base
  resolution re-anchors to the true committed ancestor, so the library's intent
  is reproduced (deletion re-applied, WIP resurfaced) rather than stranded.
- **Teammate's committed change vs your library:** preserved on a clean export;
  surfaced as a conflict when both sides changed the same thing.
- **Submodules:** GitTools operates on the **submodule itself** as the repository
  (its own index, ref store, and `gittools/` git-dir), never the parent — the
  parent tracks the submodule as a gitlink, not a tree of files. v2 installs no
  hook, so the v1 reason for reporting the parent is gone.
- **Linked worktrees:** `refs/gittools/*` and `.git/gittools/<state-key>/` are
  shared across all worktrees of one repo. Registering the **same library file**
  through two linked worktrees would thrash one shared state; assume one worktree
  per registered library.

---

## 12. The reference scripts

All shared logic lives in `scripts/common.ps1` (the `Invoke-Git*` wrappers,
`Get-StateKey`, `ConvertTo-GitPath`, the durability-ref and base-resolution
helpers, `New-LiveSourceTree`, `New-IncrementalExportTree`, `Write-LiveJsonPathDelta`
and the apply/merge helpers, metadata read/write, the pending resolver, and the
handoff helpers), dot-sourced by the four entry scripts:

- **`pre-export.ps1`** — preflight (`merge-tree` capability, no unresolved
  conflicts); sweep a stale handoff; resolve pending; `Resolve-CurrentSourceAndBase`;
  ensure the export cache; write the handoff. Prints nothing.
- **`post-export.ps1`** — build the export tree incrementally; merge-or-apply
  (§6); update metadata + refs; clear the handoff (keeping the cache) on every
  path including conflict and error. Prints `RESULT=...`.
- **`pre-import.ps1`** — refuse unresolved conflicts; print the import path.
- **`post-import.ps1`** — record the imported source as the new base. Prints
  `RESULT=clean`.

Set `GITTOOLS_TIMING=1` to emit per-step timings, file counts, and a total
git-invocation count to stderr (off by default; never affects the stdout
contract).
