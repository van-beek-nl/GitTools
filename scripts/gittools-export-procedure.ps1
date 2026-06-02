[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $RepoRoot,

    [Parameter(Mandatory = $true)]
    [string] $JsonPath,

    [Parameter(Mandatory = $true)]
    [string] $LibraryId,

    [string] $MetaPath,

    [switch] $NoPause
)

# Demonstration script for the proposed GitTools export redesign.
#
# This script intentionally does not call Omnis. Instead, it pauses where the
# Omnis JSON export and cleanup should happen. The rest of the script exercises
# the Git procedure:
# - read or migrate GitTools v2 metadata
# - seed a temp export directory from the private base cache
# - hash the temp export as a Git tree
# - apply it directly or merge it with the current source tree
# - leave real Git conflicts in the live JSON path when a merge conflicts

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- General Git helpers ---------------------------------------------------

function Write-Step {
    param([string] $Message)
    Write-Host ""
    Write-Host "==> $Message"
}

function ConvertTo-GitPath {
    param([string] $Path)
    return ($Path -replace "\\", "/").Trim("/")
}

function Invoke-GitRaw {
    param(
        [Parameter(Mandatory = $true)]
        [string[]] $Arguments,

        [string] $IndexFile
    )

    $oldIndex = $env:GIT_INDEX_FILE
    if ($IndexFile) {
        # Several operations must build or inspect trees without touching the
        # repository's real index. GIT_INDEX_FILE gives those operations a
        # private scratch index.
        $env:GIT_INDEX_FILE = $IndexFile
    }

    try {
        # Keep stdout and stderr separate. Some Git installations print
        # environmental warnings on stderr; those warnings must not pollute
        # machine-readable stdout such as tree ids and git-path results.
        $errorFile = [System.IO.Path]::GetTempFileName()
        try {
            $output = & git -C $script:RepoRoot @Arguments 2> $errorFile
            $stdout = (($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)
            $stderr = if (Test-Path $errorFile) { Get-Content -Raw -Path $errorFile } else { "" }
            return [pscustomobject]@{
                ExitCode = $LASTEXITCODE
                Output = $stdout
                Error = $stderr
                Combined = (($stdout, $stderr | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine)
            }
        }
        finally {
            Remove-Item $errorFile -Force -ErrorAction SilentlyContinue
        }
    }
    finally {
        if ($null -eq $oldIndex) {
            Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
        }
        else {
            $env:GIT_INDEX_FILE = $oldIndex
        }
    }
}

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]] $Arguments,

        [string] $IndexFile
    )

    $result = Invoke-GitRaw -Arguments $Arguments -IndexFile $IndexFile
    if ($result.ExitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $($result.ExitCode):$([Environment]::NewLine)$($result.Combined)"
    }

    return $result.Output.Trim()
}

function Invoke-GitWithInput {
    param(
        [Parameter(Mandatory = $true)]
        [string[]] $Arguments,

        [Parameter(Mandatory = $true)]
        [string[]] $InputLines
    )

    # update-index --index-info expects one record per input line. Piping a
    # single multi-line string can be parsed differently by PowerShell/Git.
    $output = $InputLines | & git -C $script:RepoRoot @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code ${LASTEXITCODE}:$([Environment]::NewLine)$(($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)"
    }
}

function Resolve-GitPrivatePath {
    param([string] $RelativeGitPath)

    $path = Invoke-Git @("rev-parse", "--git-path", $RelativeGitPath)
    if ([System.IO.Path]::IsPathRooted($path)) {
        return $path
    }

    return Join-Path $script:RepoRoot $path
}

function Test-HeadExists {
    $result = Invoke-GitRaw @("rev-parse", "--verify", "HEAD")
    return ($result.ExitCode -eq 0)
}

function Test-PathInHead {
    param([string] $Path)

    if (-not (Test-HeadExists)) {
        return $false
    }

    $result = Invoke-GitRaw @("rev-parse", "--verify", "HEAD:$Path")
    return ($result.ExitCode -eq 0)
}

function Test-MergeTreeWriteTree {
    $result = Invoke-GitRaw @("merge-tree", "-h")
    return ($result.Combined -match "--write-tree")
}

# --- Tree and cache helpers ------------------------------------------------

function New-TempIndexPath {
    $name = "gittools-index-$([System.Guid]::NewGuid().ToString('N'))"
    return Join-Path ([System.IO.Path]::GetTempPath()) $name
}

function New-EmptyTree {
    $index = New-TempIndexPath
    try {
        Invoke-Git @("read-tree", "--empty") -IndexFile $index | Out-Null
        return Invoke-Git @("write-tree") -IndexFile $index
    }
    finally {
        Remove-Item $index -Force -ErrorAction SilentlyContinue
    }
}

function New-TreeFromDirectory {
    param([string] $Directory)

    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $index = New-TempIndexPath
    try {
        # Hash a plain directory as a root tree. The directory can be outside
        # the repository; only Git object storage and a scratch index are used.
        Invoke-Git @("read-tree", "--empty") -IndexFile $index | Out-Null
        Invoke-Git @("--work-tree=$Directory", "add", "-A", "--", ".") -IndexFile $index | Out-Null
        return Invoke-Git @("write-tree") -IndexFile $index
    }
    finally {
        Remove-Item $index -Force -ErrorAction SilentlyContinue
    }
}

function Restore-TreeToDirectory {
    param(
        [string] $Tree,
        [string] $Directory
    )

    if (Test-Path $Directory) {
        Remove-Item -Recurse -Force $Directory
    }

    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $index = New-TempIndexPath
    try {
        # Do not use the real index here. This helper is also called after an
        # export merge has created unmerged index entries in the real repo.
        Invoke-Git @("read-tree", $Tree) -IndexFile $index | Out-Null
        Invoke-Git @("--work-tree=$Directory", "checkout-index", "-a", "-f") -IndexFile $index | Out-Null
    }
    finally {
        Remove-Item $index -Force -ErrorAction SilentlyContinue
    }
}

function Update-BaseCache {
    param([string] $Tree)
    Restore-TreeToDirectory -Tree $Tree -Directory $script:BaseCachePath
}

function Update-PendingExportCache {
    param([string] $Tree)
    Restore-TreeToDirectory -Tree $Tree -Directory $script:PendingExportCachePath
}

function Update-PendingSourceCache {
    param([string] $Tree)
    Restore-TreeToDirectory -Tree $Tree -Directory $script:PendingSourceCachePath
}

function Get-LiveJsonTree {
    return New-TreeFromDirectory -Directory $script:JsonAbsolutePath
}

function Get-HeadJsonTreeOrEmpty {
    if (Test-PathInHead -Path $script:JsonPath) {
        return Invoke-Git @("rev-parse", "HEAD:$script:JsonPath")
    }

    return New-EmptyTree
}

function Test-UnresolvedJsonConflicts {
    $result = Invoke-Git @("diff", "--name-only", "--diff-filter=U", "--", $script:JsonPath)
    return (-not [string]::IsNullOrWhiteSpace($result))
}

function Test-JsonPathDirty {
    $result = Invoke-Git @("status", "--porcelain", "--", $script:JsonPath)
    return (-not [string]::IsNullOrWhiteSpace($result))
}

# --- Live JSON path manipulation ------------------------------------------

function Clear-LiveJsonPath {
    if (Test-HeadExists) {
        if (Test-PathInHead -Path $script:JsonPath) {
            # Restore tracked files to HEAD and clear any staged state under
            # the JSON path. This intentionally discards stale live JSON edits.
            Invoke-Git @("restore", "--source=HEAD", "--staged", "--worktree", "--", $script:JsonPath) | Out-Null
        }
        else {
            # HEAD exists, but this export path is not tracked in HEAD yet.
            # Remove any staged entries and delete the live path manually.
            Invoke-Git @("rm", "-r", "--cached", "--ignore-unmatch", "--", $script:JsonPath) | Out-Null
            if (Test-Path $script:JsonAbsolutePath) {
                Remove-Item -Recurse -Force $script:JsonAbsolutePath
            }
        }

        Invoke-Git @("clean", "-fd", "--", $script:JsonPath) | Out-Null
    }
    elseif (Test-Path $script:JsonAbsolutePath) {
        Remove-Item -Recurse -Force $script:JsonAbsolutePath
    }
}

function Apply-TreeToLiveJsonPath {
    param([string] $Tree)

    Clear-LiveJsonPath
    Restore-TreeToDirectory -Tree $Tree -Directory $script:JsonAbsolutePath
}

# --- Metadata helpers ------------------------------------------------------

function Read-GitToolsMeta {
    if (-not (Test-Path $script:MetaPath)) {
        return [pscustomobject]@{
            version = 2
            jsonPath = $script:JsonPath
            baseTree = ""
            sourceTree = ""
            status = "clean"
            pending = $null
        }
    }

    $text = (Get-Content -Raw -Path $script:MetaPath).Trim()
    if ($text.StartsWith("{")) {
        return $text | ConvertFrom-Json
    }

    # Backwards compatibility: v1 metadata was only a commit hash. When seen,
    # derive the path tree at that commit and immediately switch to v2 shape.
    Write-Step "Migrating old commit-only metadata"
    $oldCommit = $text
    $baseTree = ""
    if ($oldCommit) {
        $result = Invoke-GitRaw @("rev-parse", "$oldCommit`:$script:JsonPath")
        if ($result.ExitCode -eq 0) {
            $baseTree = $result.Output.Trim()
            Update-BaseCache -Tree $baseTree
        }
    }

    return [pscustomobject]@{
        version = 2
        jsonPath = $script:JsonPath
        baseTree = $baseTree
        sourceTree = $baseTree
        status = "clean"
        pending = $null
    }
}

function Write-GitToolsMeta {
    param([object] $Meta)

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $script:MetaPath) | Out-Null
    $Meta | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 -NoNewline -Path $script:MetaPath
}

function New-CleanMeta {
    param(
        [string] $BaseTree,
        [string] $SourceTree
    )

    return [pscustomobject]@{
        version = 2
        jsonPath = $script:JsonPath
        baseTree = $BaseTree
        sourceTree = $SourceTree
        status = "clean"
        pending = $null
    }
}

function New-PendingMeta {
    param(
        [object] $ExistingMeta,
        [string] $CurrentSourceTree,
        [string] $ExportTree
    )

    return [pscustomobject]@{
        version = 2
        jsonPath = $script:JsonPath
        baseTree = $ExistingMeta.baseTree
        sourceTree = $CurrentSourceTree
        status = "pendingExportConflict"
        pending = [pscustomobject]@{
            baseTree = $ExistingMeta.baseTree
            sourceTree = $CurrentSourceTree
            exportTree = $ExportTree
        }
    }
}

function Wait-ForOmnisStep {
    param([string] $Message)

    Write-Host $Message
    if (-not $NoPause) {
        Write-Host -NoNewline "Press Enter when this step is complete: "
        [Console]::ReadLine() | Out-Null
    }
}

# --- Export state resolution -----------------------------------------------

function Resolve-PendingConflictIfNeeded {
    param([object] $Meta)

    if ($Meta.status -ne "pendingExportConflict") {
        return $Meta
    }

    Write-Step "Resolving pending export-conflict metadata"
    if (Test-UnresolvedJsonConflicts) {
        # Existing conflicts are real user-facing merge work. The export flow
        # should not overwrite them or try to infer intent while they remain.
        throw "The JSON path still contains unresolved conflicts. Resolve them before exporting again."
    }

    if (Test-JsonPathDirty) {
        # The agreed policy treats dirty JSON-path edits as disposable during
        # export. For pending state, discard them before deciding whether the
        # previous conflicted export was accepted or discarded.
        Write-Host "JSON path has uncommitted changes. Discarding them before evaluating pending state."
        if (Test-HeadExists) {
            Clear-LiveJsonPath
        }
        else {
            if (Test-Path $script:PendingSourceCachePath) {
                Restore-TreeToDirectory -Tree $Meta.pending.sourceTree -Directory $script:JsonAbsolutePath
            }
            else {
                throw "Pending source cache is missing and the repository has no HEAD to restore from."
            }
        }
    }

    $currentTree = Get-LiveJsonTree
    if ($currentTree -eq $Meta.pending.sourceTree) {
        # The live source is back at the pre-export source tree. The previous
        # export side was not accepted, so keep the old merge base.
        Write-Host "Pending conflict appears to have been discarded. Keeping previous base tree."
        return New-CleanMeta -BaseTree $Meta.pending.baseTree -SourceTree $currentTree
    }

    # The source tree changed after the conflicted export and no conflicts
    # remain. Treat that as the user having resolved/accepted the export side.
    Write-Host "Pending conflict appears to have been resolved or accepted. Advancing base tree to pending export."
    Update-BaseCache -Tree $Meta.pending.exportTree
    return New-CleanMeta -BaseTree $Meta.pending.exportTree -SourceTree $currentTree
}

function Get-CurrentSourceTree {
    param([object] $Meta)

    $liveTree = Get-LiveJsonTree
    if ($Meta.sourceTree -and ($liveTree -eq $Meta.sourceTree)) {
        # GitTools recognizes the live path as its own last known output. This
        # is what makes export-before-commit and repeated export work.
        Write-Host "Using live JSON path as current source."
        return $liveTree
    }

    if (Test-HeadExists) {
        # The live JSON path differs from GitTools' last known source. Treat
        # it as disposable and use HEAD as the source side of the merge.
        Write-Host "Using HEAD JSON path as current source; live JSON path changes are disposable."
        return Get-HeadJsonTreeOrEmpty
    }

    Write-Host "Repository has no commits. Using live JSON path as current source."
    return $liveTree
}

# --- Merge helpers ---------------------------------------------------------

function Invoke-MergeTree {
    param(
        [string] $BaseTree,
        [string] $CurrentSourceTree,
        [string] $ExportTree
    )

    $result = Invoke-GitRaw @(
        "merge-tree",
        "--write-tree",
        "--messages",
        "--merge-base=$BaseTree",
        $CurrentSourceTree,
        $ExportTree
    )

    # merge-tree --write-tree prints the result tree on the first line. On
    # conflicts it still returns a tree containing conflict markers, followed
    # by stage 1/2/3 records and human-readable conflict messages.
    $lines = @()
    if ($result.Output) {
        $lines = $result.Output -split "\r?\n"
    }

    return [pscustomobject]@{
        ExitCode = $result.ExitCode
        ResultTree = if ($lines.Count -gt 0) { $lines[0].Trim() } else { "" }
        Lines = $lines
        Output = $result.Output
    }
}

function Apply-ConflictedMergeToLiveJsonPath {
    param([object] $MergeResult)

    if (-not $MergeResult.ResultTree) {
        throw "merge-tree did not return a result tree."
    }

    Clear-LiveJsonPath
    # First write the conflict-marker files returned by merge-tree.
    Restore-TreeToDirectory -Tree $MergeResult.ResultTree -Directory $script:JsonAbsolutePath

    # Stage the full result so cleanly merged files are in stage 0.
    Invoke-Git @("add", "-A", "--", $script:JsonPath) | Out-Null

    $stageLines = New-Object System.Collections.Generic.List[string]
    $conflictPaths = New-Object System.Collections.Generic.HashSet[string]
    foreach ($line in $MergeResult.Lines) {
        if ($line -match "^(\d{6}) ([0-9a-fA-F]{40,64}) ([123])\t(.+)$") {
            $mode = $Matches[1]
            $objectId = $Matches[2]
            $stage = $Matches[3]
            $relativeConflictPath = ConvertTo-GitPath $Matches[4]
            $prefixedPath = if ($script:JsonPath -eq ".") { $relativeConflictPath } else { "$script:JsonPath/$relativeConflictPath" }
            $conflictPaths.Add($prefixedPath) | Out-Null
            $stageLines.Add("$mode $objectId $stage`t$prefixedPath") | Out-Null
        }
    }

    # Replace stage-0 entries for conflicted paths with the actual unmerged
    # stage records. This is the step that makes Git clients show "UU".
    foreach ($path in $conflictPaths) {
        Invoke-Git @("update-index", "--force-remove", "--", $path) | Out-Null
    }

    if ($stageLines.Count -gt 0) {
        Invoke-GitWithInput -Arguments @("update-index", "--index-info") -InputLines $stageLines.ToArray()
    }
}

# --- Main procedure --------------------------------------------------------

$script:RepoRoot = (Resolve-Path $RepoRoot).Path
$script:JsonPath = ConvertTo-GitPath $JsonPath
$safeLibraryId = ($LibraryId -replace "[^A-Za-z0-9_.-]", "_")
$script:JsonAbsolutePath = Join-Path $script:RepoRoot ($script:JsonPath -replace "/", [System.IO.Path]::DirectorySeparatorChar)
$script:StateRoot = Resolve-GitPrivatePath "gittools/$safeLibraryId"
$script:BaseCachePath = Join-Path $script:StateRoot "base"
$script:PendingExportCachePath = Join-Path $script:StateRoot "pending-export"
$script:PendingSourceCachePath = Join-Path $script:StateRoot "pending-source"

if (-not $MetaPath) {
    $script:MetaPath = Join-Path $script:StateRoot "meta.json"
}
else {
    $script:MetaPath = $MetaPath
}

New-Item -ItemType Directory -Force -Path $script:StateRoot | Out-Null

Write-Step "Preflight"
if (-not (Test-MergeTreeWriteTree)) {
    throw "This procedure requires git merge-tree --write-tree."
}

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
New-Item -ItemType Directory -Force -Path $tempJsonPath | Out-Null

if ($meta.baseTree) {
    # Seed Omnis with the last reconciled export tree. This keeps the speed
    # benefit of exporting over an existing tree without touching live source.
    Restore-TreeToDirectory -Tree $meta.baseTree -Directory $tempJsonPath
}

Wait-ForOmnisStep "TODO: Run the Omnis JSON export into: $tempJsonPath"
Wait-ForOmnisStep "TODO: Run irrelevant-property cleanup against: $tempJsonPath"

$exportTree = New-TreeFromDirectory -Directory $tempJsonPath
Write-Host "Export tree: $exportTree"

Write-Step "Apply or merge export result"
if (-not $meta.baseTree) {
    # First export or unrecoverable old metadata: there is no safe three-way
    # base, so the temp export becomes the new live source directly.
    Write-Host "No base tree exists yet. Applying export directly."
    Apply-TreeToLiveJsonPath -Tree $exportTree
    $finalSourceTree = Get-LiveJsonTree
    Update-BaseCache -Tree $exportTree
    Write-GitToolsMeta -Meta (New-CleanMeta -BaseTree $exportTree -SourceTree $finalSourceTree)
    return
}

if ($currentSourceTree -eq $meta.baseTree) {
    # Source did not move relative to the binary base, so no merge is needed.
    Write-Host "Current source equals base tree. Applying export directly."
    Apply-TreeToLiveJsonPath -Tree $exportTree
    $finalSourceTree = Get-LiveJsonTree
    Update-BaseCache -Tree $exportTree
    Write-GitToolsMeta -Meta (New-CleanMeta -BaseTree $exportTree -SourceTree $finalSourceTree)
    return
}

Write-Host "Current source differs from base tree. Running tree merge."
$merge = Invoke-MergeTree -BaseTree $meta.baseTree -CurrentSourceTree $currentSourceTree -ExportTree $exportTree
if ($merge.ExitCode -eq 0) {
    # Clean merge: the live source receives the merged source tree, while
    # baseTree advances to the raw Omnis export tree.
    Write-Host "Merge succeeded."
    Apply-TreeToLiveJsonPath -Tree $merge.ResultTree
    $finalSourceTree = Get-LiveJsonTree
    Update-BaseCache -Tree $exportTree
    Write-GitToolsMeta -Meta (New-CleanMeta -BaseTree $exportTree -SourceTree $finalSourceTree)
    return
}

Write-Host "Merge completed with conflicts. Applying conflicted result to live JSON path."
# Conflict is an acceptable export outcome. Leave the live JSON path in a real
# Git conflict state and remember enough metadata to classify resolution later.
Apply-ConflictedMergeToLiveJsonPath -MergeResult $merge
Update-PendingSourceCache -Tree $currentSourceTree
Update-PendingExportCache -Tree $exportTree
Write-GitToolsMeta -Meta (New-PendingMeta -ExistingMeta $meta -CurrentSourceTree $currentSourceTree -ExportTree $exportTree)
Write-Host ""
Write-Host $merge.Output
Write-Host ""
Write-Host "Export completed with conflicts. Resolve the JSON path with your Git client."
