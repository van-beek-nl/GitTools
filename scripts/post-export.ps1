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

# Post-export phase of the GitTools export procedure.
#
# Runs after Omnis has exported into the temp directory recorded by
# pre-export.ps1 and cleaned irrelevant properties. It builds the export tree
# incrementally, then applies or three-way merges it into the live JSON path,
# updates the durability refs and metadata, and tears down the temp artifacts.
# Prints RESULT=clean or RESULT=conflict on stdout; exits non-zero only on a
# genuine error (a conflict is an acceptable, successful outcome).

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"

Initialize-GitToolsState -RepoRoot $RepoRoot -JsonPath $JsonPath -LibraryId $LibraryId -LibraryPath $LibraryPath -MetaPath $MetaPath

$handoff = Read-Handoff
if (($null -eq $handoff) -or ($handoff.op -ne "export")) {
    throw "No pending export to finalize. Run pre-export.ps1 first."
}

# meta.json was resolved and persisted by the pre-script; re-read it for the
# (possibly advanced) base tree. The current source tree and temp paths come
# from the handoff.
$meta = Read-GitToolsMeta
$currentSourceTree = $handoff.currentSourceTree
$tempRoot = $handoff.tempRoot
$tempJsonPath = $handoff.tempJsonPath
$exportIndex = $handoff.exportIndex

try {
    Write-Step "Build export tree"
    # Build incrementally: hash only the files whose stat changed since the seed
    # (plus new files), not the whole export.
    $exportTree = New-IncrementalExportTree -IndexFile $exportIndex -WorkTree $tempJsonPath
    Write-Note "Export tree: $exportTree"

    Write-Step "Apply or merge export result"
    if (-not $meta.baseTree) {
        # No reconciliation base exists (first export, brand-new path, or
        # unrecoverable old metadata), so the export is applied directly. The
        # only hazard is overwriting committed source whose change direction we
        # cannot know without a base. Uncommitted live JSON is disposable by
        # policy, so the warning is scoped to a committed HEAD source that
        # differs from the export.
        if ((Test-PathInHead -Path $script:JsonPath) -and ((Invoke-Git @("rev-parse", "HEAD:$script:JsonPath")) -ne $exportTree)) {
            Write-Note "WARNING: No reconciliation base exists and the committed source at '$script:JsonPath' differs from this export."
            Write-Note "Applying will OVERWRITE the committed source with your library's version. If colleagues advanced this"
            Write-Note "source, review the diff before committing, or import first to take the repository's version instead."
        }
        else {
            Write-Note "No base tree exists yet. Applying export directly."
        }

        Apply-TreeToLiveJsonPath -Tree $exportTree
        $finalSourceTree = Get-LiveJsonTree
        Update-BaseRef -Tree $exportTree
        Write-GitToolsMeta -Meta (New-CleanMeta -BaseTree $exportTree -SourceTree $finalSourceTree)
        Write-Output "RESULT=clean"
        return
    }

    if ($currentSourceTree -eq $meta.baseTree) {
        # Source did not move relative to the binary base, so no merge is needed.
        Write-Note "Current source equals base tree. Applying export directly."
        Apply-TreeToLiveJsonPath -Tree $exportTree
        $finalSourceTree = Get-LiveJsonTree
        Update-BaseRef -Tree $exportTree
        Write-GitToolsMeta -Meta (New-CleanMeta -BaseTree $exportTree -SourceTree $finalSourceTree)
        Write-Output "RESULT=clean"
        return
    }

    Write-Note "Current source differs from base tree. Running tree merge."
    $merge = Invoke-MergeTree -BaseTree $meta.baseTree -CurrentSourceTree $currentSourceTree -ExportTree $exportTree
    if ($merge.ExitCode -eq 0) {
        # Clean merge: the live source receives the merged source tree, while
        # baseTree advances to the raw Omnis export tree.
        Write-Note "Merge succeeded."
        Apply-TreeToLiveJsonPath -Tree $merge.ResultTree
        $finalSourceTree = Get-LiveJsonTree
        Update-BaseRef -Tree $exportTree
        Write-GitToolsMeta -Meta (New-CleanMeta -BaseTree $exportTree -SourceTree $finalSourceTree)
        Write-Output "RESULT=clean"
        return
    }

    # Invoke-MergeTree throws on any exit code other than 0 or 1, so reaching here
    # means exit code 1: a genuine merge conflict, which is an acceptable outcome.
    Write-Note "Merge completed with conflicts. Applying conflicted result to live JSON path."
    # Leave the live JSON path in a real Git conflict state and remember enough
    # metadata to classify resolution later.
    Apply-ConflictedMergeToLiveJsonPath -MergeResult $merge
    Set-PendingRefs -SourceTree $currentSourceTree -ExportTree $exportTree
    Write-GitToolsMeta -Meta (New-PendingMeta -ExistingMeta $meta -CurrentSourceTree $currentSourceTree -ExportTree $exportTree)
    Write-Note ""
    Write-Note $merge.Output
    Write-Note ""
    Write-Note "Export completed with conflicts. Resolve the JSON path with your Git client."
    Write-Output "RESULT=conflict"
}
finally {
    # Always tear down the temp export directory, its scratch index, and the
    # handoff - on every exit path, including the conflict path (a conflict is a
    # completed export) and on a thrown error. The export is reproducible from the
    # binary library, so discarding a partial temp export is safe.
    if ($tempRoot -and (Test-Path $tempRoot)) {
        Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
    }
    if ($exportIndex -and (Test-Path $exportIndex)) {
        Remove-Item -Force $exportIndex -ErrorAction SilentlyContinue
    }
    Clear-Handoff
}
