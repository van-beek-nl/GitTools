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

# Demonstration script for the proposed GitTools import redesign.
#
# This script intentionally does not call Omnis. It pauses where the Omnis JSON
# import and binary-library replacement should happen. The Git part computes the
# current source tree and records it as the new reconciled base.

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
        # Use a scratch index for tree hashing/restoring so import metadata work
        # does not disturb the repository's real index.
        $env:GIT_INDEX_FILE = $IndexFile
    }

    try {
        # Keep stdout clean for machine-readable values such as tree ids.
        $errorFile = [System.IO.Path]::GetTempFileName()
        try {
            $output = & git -C $script:RepoRoot @Arguments 2> $errorFile
            $stdout = (($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)
            $stderr = if (Test-Path $errorFile) { Get-Content -Raw -Path $errorFile } else { "" }
            return [pscustomObject]@{
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
        [string[]] $InputLines,

        [string] $IndexFile
    )

    $oldIndex = $env:GIT_INDEX_FILE
    if ($IndexFile) {
        $env:GIT_INDEX_FILE = $IndexFile
    }

    try {
        # update-index --index-info expects one record per input line. Piping a
        # single multi-line string can be parsed differently by PowerShell/Git.
        $output = $InputLines | & git -C $script:RepoRoot @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "git $($Arguments -join ' ') failed with exit code ${LASTEXITCODE}:$([Environment]::NewLine)$(($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)"
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

function Resolve-GitPrivatePath {
    param([string] $RelativeGitPath)

    $path = Invoke-Git @("rev-parse", "--git-path", $RelativeGitPath)
    if ([System.IO.Path]::IsPathRooted($path)) {
        return $path
    }

    return Join-Path $script:RepoRoot $path
}

# --- Tree and cache helpers ------------------------------------------------

function New-TempIndexPath {
    $name = "gittools-index-$([System.Guid]::NewGuid().ToString('N'))"
    return Join-Path ([System.IO.Path]::GetTempPath()) $name
}

function New-TreeFromDirectory {
    param(
        [string] $Directory,

        # Repo-relative location the directory's contents represent. Used only
        # for attribute resolution so hashing matches HEAD's normalization.
        [string] $RepoRelativePrefix = $script:JsonPath
    )

    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $index = New-TempIndexPath
    try {
        Invoke-Git @("read-tree", "--empty") -IndexFile $index | Out-Null

        # Enumerate files ourselves instead of using `git add`. `git add` honors
        # .gitignore and would silently drop matching files, which would surface
        # as phantom deletions. Walking the directory captures exactly what is on
        # disk.
        $entries = New-Object System.Collections.Generic.List[string]
        foreach ($file in (Get-ChildItem -LiteralPath $Directory -Recurse -File -Force)) {
            $rel = ConvertTo-GitPath ([System.IO.Path]::GetRelativePath($Directory, $file.FullName))

            # Hash each file as if it lived at its real repository path. --path
            # makes Git apply the same .gitattributes / autocrlf normalization it
            # used for the committed blobs, so identical content always hashes to
            # the identical blob across base, source and export trees. Mode is
            # fixed at 100644; Omnis export artifacts are never executable.
            $attrPath = if ([string]::IsNullOrEmpty($RepoRelativePrefix) -or ($RepoRelativePrefix -eq ".")) { $rel } else { "$RepoRelativePrefix/$rel" }
            $oid = Invoke-Git @("hash-object", "-w", "--path", $attrPath, $file.FullName)
            $entries.Add("100644 $oid`t$rel") | Out-Null
        }

        if ($entries.Count -gt 0) {
            Invoke-GitWithInput -Arguments @("update-index", "--index-info") -InputLines $entries.ToArray() -IndexFile $index
        }

        # Entries are keyed relative to the JSON directory, so the resulting tree
        # is rooted at <jsonPath> and matches HEAD:<jsonPath>.
        return Invoke-Git @("write-tree") -IndexFile $index
    }
    finally {
        Remove-Item $index -Force -ErrorAction SilentlyContinue
    }
}

# --- Durability refs -------------------------------------------------------
# The imported source tree is pinned behind refs/gittools/<id>/base so later
# exports can seed Omnis from it even after `git gc`. commit-tree and update-ref
# never move HEAD and never fire the post-commit hook.

function Get-GitToolsRef {
    param([string] $Name)
    return "refs/gittools/$script:SafeLibraryId/$Name"
}

function Get-RefTarget {
    param([string] $Ref)
    $result = Invoke-GitRaw @("rev-parse", "--verify", "--quiet", $Ref)
    if ($result.ExitCode -ne 0) {
        return ""
    }
    return $result.Output.Trim()
}

function Update-BaseRef {
    param([string] $Tree)

    # Wrap the base tree in a commit whose parent is the previous base commit, so
    # refs/gittools/<id>/base reads as a history of accepted imports/exports.
    # Identity and signing are pinned so the private commit never depends on (or
    # is attributed to) the user's Git config.
    $ref = Get-GitToolsRef "base"
    $commitArgs = @(
        "-c", "user.name=GitTools",
        "-c", "user.email=gittools@localhost",
        "-c", "commit.gpgsign=false",
        "commit-tree", $Tree
    )

    $parent = Get-RefTarget $ref
    if ($parent) {
        $commitArgs += @("-p", $parent)
    }
    $commitArgs += @("-m", "GitTools base")

    $commit = Invoke-Git $commitArgs
    Invoke-Git @("update-ref", $ref, $commit) | Out-Null
}

function Clear-PendingRefs {
    foreach ($name in @("pending-source", "pending-export")) {
        $ref = Get-GitToolsRef $name
        if (Get-RefTarget $ref) {
            Invoke-Git @("update-ref", "-d", $ref) | Out-Null
        }
    }
}

function Test-UnresolvedJsonConflicts {
    $result = Invoke-Git @("diff", "--name-only", "--diff-filter=U", "--", $script:JsonPath)
    return (-not [string]::IsNullOrWhiteSpace($result))
}

# --- Metadata helpers ------------------------------------------------------

function Write-GitToolsMeta {
    param([object] $Meta)

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $script:MetaPath) | Out-Null

    # meta.json is the commit point of a state transition: the durability refs
    # are updated first, and this write is what makes the new state official.
    # Write to a sibling temp file then atomically rename it over the target, so
    # an interrupted write can never leave a truncated meta.json.
    $tempMetaPath = "$script:MetaPath.tmp"
    $Meta | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 -NoNewline -Path $tempMetaPath
    if (Test-Path $script:MetaPath) {
        # [NullString]::Value passes a real null for the (optional) backup-file
        # argument; PowerShell would otherwise marshal $null as an empty string.
        [System.IO.File]::Replace($tempMetaPath, $script:MetaPath, [NullString]::Value)
    }
    else {
        [System.IO.File]::Move($tempMetaPath, $script:MetaPath)
    }
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

function Wait-ForOmnisStep {
    param([string] $Message)

    Write-Host $Message
    if (-not $NoPause) {
        Write-Host -NoNewline "Press Enter when this step is complete: "
        [Console]::ReadLine() | Out-Null
    }
}

# --- Main procedure --------------------------------------------------------

$script:RepoRoot = (Resolve-Path $RepoRoot).Path
$script:JsonPath = ConvertTo-GitPath $JsonPath
$script:SafeLibraryId = ($LibraryId -replace "[^A-Za-z0-9_.-]", "_")
$script:JsonAbsolutePath = Join-Path $script:RepoRoot ($script:JsonPath -replace "/", [System.IO.Path]::DirectorySeparatorChar)
$script:StateRoot = Resolve-GitPrivatePath "gittools/$script:SafeLibraryId"

if (-not $MetaPath) {
    $script:MetaPath = Join-Path $script:StateRoot "meta.json"
}
else {
    $script:MetaPath = $MetaPath
}

New-Item -ItemType Directory -Force -Path $script:StateRoot | Out-Null

Write-Step "Preflight"
if (Test-UnresolvedJsonConflicts) {
    # Importing unresolved JSON would bake conflict markers into the binary
    # library, so require the user to resolve source conflicts first.
    throw "The JSON path contains unresolved conflicts. Resolve them before importing."
}

# The current live JSON source becomes both the binary-equivalent base and the
# known source tree once the Omnis import succeeds.
$currentSourceTree = New-TreeFromDirectory -Directory $script:JsonAbsolutePath
Write-Host "Current source tree: $currentSourceTree"

Write-Step "Omnis import placeholder"
Wait-ForOmnisStep "TODO: Run the Omnis JSON import from: $script:JsonAbsolutePath"
Wait-ForOmnisStep "TODO: Replace the binary library with the imported build artifact."

Write-Step "Update metadata and durability refs"
# Pin the new base tree behind refs/gittools/<id>/base so later exports can seed
# Omnis from it even after `git gc`, and clear any leftover pending-conflict refs
# from a previous export.
Update-BaseRef -Tree $currentSourceTree
Clear-PendingRefs
Write-GitToolsMeta -Meta (New-CleanMeta -BaseTree $currentSourceTree -SourceTree $currentSourceTree)

Write-Host "Import metadata updated."
