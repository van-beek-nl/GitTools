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

Initialize-GitToolsState -RepoRoot $RepoRoot -JsonPath $JsonPath -LibraryId $LibraryId -LibraryPath $LibraryPath -MetaPath $MetaPath

Write-Step "Preflight"
if (-not (Test-MergeTreeWriteTree)) {
    throw "This procedure requires git merge-tree --write-tree."
}

# Clean up after any export whose post-script never ran, before starting a new
# one (auto-clean recovery).
Invoke-StaleHandoffSweep

if (Test-UnresolvedJsonConflicts) {
    throw "The JSON path already contains unresolved conflicts. Resolve them before exporting."
}

$meta = Read-GitToolsMeta
# Pending metadata is resolved before deciding the current source tree, because
# it may advance or preserve the export merge base.
$meta = Resolve-PendingConflictIfNeeded -Meta $meta
Write-GitToolsMeta -Meta $meta

Write-Step "Determine current source"
$currentSourceTree = Get-CurrentSourceTree -Meta $meta

Write-Step "Prepare temp Omnis export cache"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "gittools-export-$([System.Guid]::NewGuid().ToString('N'))"
$tempJsonPath = Join-Path $tempRoot ($script:JsonPath -replace "/", [System.IO.Path]::DirectorySeparatorChar)
# Scratch index seeded from the base. It carries each seeded file's stat info so
# the export tree can later be built by hashing only what Omnis changed.
$exportIndex = New-TempIndexPath

# Seed the temp directory from the last reconciled export tree (keeping the speed
# benefit of exporting over an existing tree) and capture stat info in the
# scratch index. With no base, the directory starts empty.
Initialize-ExportSeed -BaseTree $meta.baseTree -IndexFile $exportIndex -WorkTree $tempJsonPath

# Persist the transient state the post-script needs across the process boundary.
# meta.json already holds the committed state; the scratch index and temp dir are
# real files that survive on their own - only their paths and the current source
# tree must be carried here.
Write-Handoff -Handoff ([pscustomobject]@{
    op = "export"
    tempRoot = $tempRoot
    tempJsonPath = $tempJsonPath
    exportIndex = $exportIndex
    currentSourceTree = $currentSourceTree
})

Write-Note "Export tree base: $($meta.baseTree)"
Write-Note "Current source tree: $currentSourceTree"
Write-Note "Omnis should export into: $tempJsonPath"

# The only stdout line: the directory Omnis exports into. Everything else went to
# stderr so this stays cleanly machine-readable.
Write-Output $tempJsonPath
