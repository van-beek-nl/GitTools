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

    [string] $MetaPath
)

# Pre-export phase of the GitTools export procedure.
#
# Runs every Git step that must happen BEFORE Omnis exports the library: it
# resolves metadata, decides the current source tree, and seeds a temp export
# directory (plus a stat-carrying scratch index) from the reconciliation base.
# It then records the transient state in a handoff file and prints the temp
# directory Omnis should export into as the only line on stdout. post-export.ps1
# consumes that directory afterward.

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
$currentSourceTree = Get-CurrentSourceTree -Meta $meta
Write-Timing "determine current source (hash live)"

Write-Step "Prepare export cache"
# The persistent per-library cache Omnis exports into. It is NOT seeded from base -
# Omnis is its sole writer and produces a complete, correct export over whatever is
# there - so this only ensures the directory and its stat-index exist (empty on the
# first export). See Initialize-ExportCache.
$cacheDir = Get-ExportCacheDir
$cacheIndex = Get-ExportCacheIndex
Initialize-ExportCache -CacheDir $cacheDir -IndexFile $cacheIndex
Write-Timing "prepare export cache"

# The only state that must cross the process boundary: the current source tree. The
# cache dir/index are persistent at a state-key-derived location the post-script
# re-derives, and meta.json already holds the committed state.
Write-Handoff -Handoff ([pscustomobject]@{
    op = "export"
    currentSourceTree = $currentSourceTree
})
Write-Timing "write handoff"

Write-Note "Export tree base: $($meta.baseTree)"
Write-Note "Current source tree: $currentSourceTree"
Write-Note "Omnis should export into: $cacheDir"

Write-TimingSummary

# The only stdout line: the directory Omnis exports into. Everything else went to
# stderr so this stays cleanly machine-readable.
Write-Output $cacheDir
