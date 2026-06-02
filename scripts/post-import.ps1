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

# Post-import phase of the GitTools import procedure.
#
# Runs after Omnis has imported the JSON and replaced the binary library. The
# live JSON source it just imported becomes both the binary-equivalent base and
# the known source tree. Prints RESULT=clean on stdout.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"

Initialize-GitToolsState -RepoRoot $RepoRoot -JsonPath $JsonPath -LibraryId $LibraryId -LibraryPath $LibraryPath -MetaPath $MetaPath

Write-Step "Record imported source"
# The live JSON path is unchanged by the import (Omnis reads it to rebuild the
# binary), so recomputing the source tree here matches what it was pre-import.
$currentSourceTree = New-LiveSourceTree
Write-Note "Imported source tree: $currentSourceTree"

Write-Step "Update metadata and durability refs"
# Pin the new base tree behind refs/gittools/<state-key>/base so later exports can
# seed Omnis from it even after `git gc`, and clear any leftover pending-conflict
# refs from a previous export.
Update-BaseRef -Tree $currentSourceTree
Clear-PendingRefs
Write-GitToolsMeta -Meta (New-CleanMeta -BaseTree $currentSourceTree -SourceTree $currentSourceTree)

Write-Note "Import metadata updated."
Write-Output "RESULT=clean"
