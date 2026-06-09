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

# Pre-import phase of the GitTools import procedure.
#
# Import carries no transient state across the Omnis step: Omnis reads the JSON
# to rebuild the binary and never writes the live path, so post-import.ps1 can
# recompute the identical source tree itself, and there are no temp artifacts to
# track. This phase therefore only guards against importing unresolved conflicts
# (which would bake conflict markers into the binary) and prints the path Omnis
# should import from as a single machine-readable "SOURCE=<absolute path>" line on
# stdout (the same SOURCE= form pre-export uses). All other progress goes to stderr.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"

Start-Timing

Initialize-GitToolsState -RepoRoot $RepoRoot -JsonPath $JsonPath -LibraryId $LibraryId -LibraryPath $LibraryPath -MetaPath $MetaPath
Write-Timing "initialize state"

Write-Step "Preflight"
if (Test-UnresolvedJsonConflicts) {
    throw "The JSON path contains unresolved conflicts. Resolve them before importing."
}
Write-Timing "preflight: conflict check"

Write-Note "Omnis should import from: $script:JsonAbsolutePath"

Write-TimingSummary

# The only stdout line: the path Omnis imports from, in the standard SOURCE=<path> form.
Write-Output "SOURCE=$script:JsonAbsolutePath"
