[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $RepoRoot,

    [Parameter(Mandatory = $true)]
    [string] $JsonPath,

    [Parameter(Mandatory = $true)]
    [string] $LibraryId,

    # Absolute path to the binary library (.lbs). The state key is derived from
    # this, not from the export path, because one export feeds N library files.
    [string] $LibraryPath,

    [string] $MetaPath,

    # Set on a confirmed re-run after this script reported RESULT=missing-base: the user
    # has acknowledged that no reconciliation base exists and chosen to proceed, so the
    # missing-base safety gate is bypassed and the (acknowledged) overwrite goes ahead.
    [switch] $AllowMissingBase
)

# Pre-export phase of the GitTools export procedure.
#
# Runs every Git step that must happen BEFORE Omnis exports the library: it
# resolves metadata, resolves any pending conflict, decides the current source
# tree, and ensures the persistent export cache exists. It then records the one
# piece of transient state (the current source tree) in a handoff file that
# post-export.ps1 consumes afterward.
#
# This phase prints NOTHING on stdout. Omnis derives the export cache directory
# itself from the git dir + state key (the same location Initialize-ExportCache
# ensures here and post-export.ps1 re-derives), so there is no path to return.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"

Start-Timing

Initialize-GitToolsState -RepoRoot $RepoRoot -JsonPath $JsonPath -LibraryId $LibraryId -LibraryPath $LibraryPath -MetaPath $MetaPath
Write-Timing "initialize state"

Write-Step "Preflight"
if (-not (Test-MergeTreeWriteTree)) {
    throw "This procedure requires git merge-tree --write-tree."
}
Write-Timing "preflight: merge-tree capability"

# Clean up after any export whose post-script never ran, before starting a new
# one (auto-clean recovery).
Invoke-StaleHandoffSweep
Write-Timing "stale-handoff sweep"

if (Test-UnresolvedJsonConflicts) {
    throw "The JSON path already contains unresolved conflicts. Resolve them before exporting."
}
Write-Timing "preflight: conflict check"

$meta = Read-GitToolsMeta
Write-Timing "read metadata"
# Pending metadata is resolved before deciding the current source tree, because
# it may advance or preserve the export merge base.
$meta = Resolve-PendingConflictIfNeeded -Meta $meta
Write-GitToolsMeta -Meta $meta
Write-Timing "resolve pending + write metadata"

Write-Step "Determine current source"
# Resolves both the source side of the merge and the base to merge against. On the
# fallback path (the live source was moved by a pull, discard, or partial commit)
# the base is recomputed as the true common ancestor rather than the stale advanced
# baseTree - see Resolve-CurrentSourceAndBase.
$resolved = Resolve-CurrentSourceAndBase -Meta $meta
$currentSourceTree = $resolved.SourceTree
$mergeBase = $resolved.MergeBase
Write-Timing "determine current source (hash live)"

# Missing-base safety gate. With no reconciliation base, applying the export would
# overwrite the committed source outright - no three-way merge, no way to reconcile a
# colleague's changes - so it is the one path that can lose committed work without a
# conflict. Rather than do that on the strength of a stderr warning, stop on this first
# run and report RESULT=missing-base so Omnis can ask the user to proceed or cancel. A
# confirmed re-run passes -AllowMissingBase, which skips this gate. No handoff is written
# here, so the export cannot proceed unacknowledged (post-export has no pending op to
# finalize). The gate is deliberately conservative: it fires whenever committed source
# exists at the path, since without a base there is no way to prove the overwrite is safe.
if ((-not $mergeBase) -and (Test-PathInHead -Path $script:JsonPath) -and (-not $AllowMissingBase)) {
    Write-Step "No reconciliation base"
    Write-Note "GitTools found no base to merge against, but '$script:JsonPath' has committed source."
    Write-Note "Proceeding would OVERWRITE that committed source with the library export and cannot"
    Write-Note "reconcile any changes made since. Re-run with -AllowMissingBase to force the overwrite,"
    Write-Note "or import first to take the repository's version into the library instead."
    Write-TimingSummary
    Write-Output "RESULT=missing-base"
    return
}

Write-Step "Prepare export cache"
# The persistent per-library cache Omnis exports into. It is NOT seeded from base -
# Omnis is its sole writer and produces a complete, correct export over whatever is
# there - so this only ensures the directory and its stat-index exist (empty on the
# first export). See Initialize-ExportCache.
$cacheDir = Get-ExportCacheDir
$cacheIndex = Get-ExportCacheIndex
Initialize-ExportCache -CacheDir $cacheDir -IndexFile $cacheIndex
Write-Timing "prepare export cache"

# The state that must cross the process boundary: the current source tree and the
# resolved merge base. Both depend on the live JSON path and HEAD as they stand
# BEFORE Omnis exports, so they are decided here and handed to the post-script
# rather than recomputed afterward (the cache dir/index are persistent at a
# state-key-derived location the post-script re-derives, and meta.json holds the
# committed state).
Write-Handoff -Handoff ([pscustomobject]@{
    op = "export"
    currentSourceTree = $currentSourceTree
    mergeBase = $mergeBase
})
Write-Timing "write handoff"

Write-Note "Merge base: $(if ($mergeBase) { $mergeBase } else { '<none>' })"
Write-Note "Current source tree: $currentSourceTree"
Write-Note "Export cache: $cacheDir"

Write-TimingSummary
