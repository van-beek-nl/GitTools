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

    # Mirror of pre-export's switch: set on a confirmed re-run to acknowledge a missing
    # reconciliation base and force the overwrite. Acts as a backstop here - post-export
    # refuses to overwrite committed source without it, even if reached directly.
    [switch] $AllowMissingBase
)

# Post-export phase of the GitTools export procedure.
#
# Runs after Omnis has exported into the persistent export cache (whose location
# both phases derive from the git dir + state key) and cleaned irrelevant
# properties. It builds the export tree incrementally from that cache, then
# applies or three-way merges it into the live JSON path, and updates the
# durability refs and metadata. The cache is deliberately KEPT as the warm copy
# for the next export; only the handoff is cleared. Prints RESULT=clean or
# RESULT=conflict on stdout; exits non-zero only on a genuine error (a conflict
# is an acceptable, successful outcome).

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"

Start-Timing

Initialize-GitToolsState -RepoRoot $RepoRoot -JsonPath $JsonPath -LibraryId $LibraryId -LibraryPath $LibraryPath -MetaPath $MetaPath
Write-Timing "initialize state"

$handoff = Read-Handoff
if (($null -eq $handoff) -or ($handoff.op -ne "export")) {
    throw "No pending export to finalize. Run pre-export.ps1 first."
}

# The current source tree AND the merge base were both decided by the pre-script
# (they depend on the live path and HEAD as they stood before Omnis exported, and
# the pre-script already resolved + persisted meta.json), so they are taken from the
# handoff rather than recomputed. The cache dir/index are persistent at the
# state-key location. The fresh metadata written below is built from the export
# result, so the prior meta.json is not re-read here.
$currentSourceTree = $handoff.currentSourceTree
$mergeBase = $handoff.mergeBase
$cacheDir = Get-ExportCacheDir
$cacheIndex = Get-ExportCacheIndex
Write-Timing "read handoff"

try {
    Write-Step "Build export tree"
    # Build incrementally: hash only the files Omnis changed since the cache index
    # was last in step with the directory, not the whole export.
    $exportTree = New-IncrementalExportTree -IndexFile $cacheIndex -WorkTree $cacheDir
    Write-Note "Export tree: $exportTree"
    Write-Timing "build export tree (incremental)"

    Write-Step "Apply or merge export result"
    if (-not $mergeBase) {
        # No reconciliation base (first export, brand-new path, unrecoverable old
        # metadata, or the source moved with no recorded common ancestor reachable
        # from HEAD), so the export is applied directly. The only hazard is
        # overwriting committed source whose change direction we cannot know without
        # a base. Uncommitted live JSON is disposable by policy, so this is scoped to
        # a committed HEAD source that differs from the export.
        $overwritesCommitted = (Test-PathInHead -Path $script:JsonPath) -and ((Invoke-Git @("rev-parse", "HEAD:$script:JsonPath")) -ne $exportTree)

        if ($overwritesCommitted -and (-not $AllowMissingBase)) {
            # Backstop for pre-export's missing-base gate: never overwrite committed
            # source without acknowledgement, even if this script is reached directly
            # (the pre-export signal having been bypassed or ignored). Report
            # RESULT=missing-base and apply nothing; the finally block clears the
            # handoff, so a confirmed retry runs the full procedure with
            # -AllowMissingBase. The live JSON path is left exactly as it was.
            Write-Step "No reconciliation base"
            Write-Note "No base to merge against and the committed source at '$script:JsonPath' differs from this export."
            Write-Note "Refusing to overwrite it. Re-run the export with -AllowMissingBase to force the overwrite."
            Write-Output "RESULT=missing-base"
            return
        }

        if ($overwritesCommitted) {
            Write-Note "WARNING: No reconciliation base exists; forcing overwrite of the committed source at '$script:JsonPath' (-AllowMissingBase set)."
            Write-Note "If colleagues advanced this source, review the diff before committing."
        }
        else {
            Write-Note "No base tree exists yet. Applying export directly."
        }

        Apply-TreeToLiveJsonPath -Tree $exportTree
        Write-Timing "apply export to live path"
        $finalSourceTree = Get-LiveJsonTree
        Write-Timing "hash final source"
        Update-BaseRef -Tree $exportTree
        Write-GitToolsMeta -Meta (New-CleanMeta -BaseTree $exportTree -SourceTree $finalSourceTree)
        Write-Timing "update base ref + write metadata"
        Write-Output "RESULT=clean"
        return
    }

    if ($currentSourceTree -eq $mergeBase) {
        # Source did not move relative to the merge base, so no merge is needed.
        Write-Note "Current source equals base tree. Applying export directly."
        Apply-TreeToLiveJsonPath -Tree $exportTree
        Write-Timing "apply export to live path"
        $finalSourceTree = Get-LiveJsonTree
        Write-Timing "hash final source"
        Update-BaseRef -Tree $exportTree
        Write-GitToolsMeta -Meta (New-CleanMeta -BaseTree $exportTree -SourceTree $finalSourceTree)
        Write-Timing "update base ref + write metadata"
        Write-Output "RESULT=clean"
        return
    }

    Write-Note "Current source differs from base tree. Running tree merge."
    $merge = Invoke-MergeTree -BaseTree $mergeBase -CurrentSourceTree $currentSourceTree -ExportTree $exportTree
    Write-Timing "merge-tree (three-way)"
    if ($merge.ExitCode -eq 0) {
        # Clean merge: the live source receives the merged source tree, while
        # baseTree advances to the raw Omnis export tree.
        Write-Note "Merge succeeded."
        Apply-TreeToLiveJsonPath -Tree $merge.ResultTree
        Write-Timing "apply merged result to live path"
        $finalSourceTree = Get-LiveJsonTree
        Write-Timing "hash final source"
        Update-BaseRef -Tree $exportTree
        Write-GitToolsMeta -Meta (New-CleanMeta -BaseTree $exportTree -SourceTree $finalSourceTree)
        Write-Timing "update base ref + write metadata"
        Write-Output "RESULT=clean"
        return
    }

    # Invoke-MergeTree throws on any exit code other than 0 or 1, so reaching here
    # means exit code 1: a genuine merge conflict, which is an acceptable outcome.
    Write-Note "Merge completed with conflicts. Applying conflicted result to live JSON path."
    # Leave the live JSON path in a real Git conflict state and remember enough
    # metadata to classify resolution later.
    Apply-ConflictedMergeToLiveJsonPath -MergeResult $merge
    Write-Timing "apply conflicted result to live path"
    Set-PendingRefs -SourceTree $currentSourceTree -ExportTree $exportTree
    Write-GitToolsMeta -Meta (New-PendingMeta -BaseTree $mergeBase -CurrentSourceTree $currentSourceTree -ExportTree $exportTree)
    Write-Timing "set pending refs + write metadata"
    Write-Note ""
    Write-Note $merge.Output
    Write-Note ""
    Write-Note "Export completed with conflicts. Resolve the JSON path with your Git client."
    Write-Output "RESULT=conflict"
}
finally {
    # Clear the handoff on every exit path - including the conflict path (a conflict
    # is a completed export) and a thrown error. The export cache is deliberately
    # KEPT: it is the warm copy the next export reuses, and its index now matches the
    # directory so the next build stays incremental.
    Clear-Handoff
    Write-Timing "clear handoff"
    Write-TimingSummary
}
