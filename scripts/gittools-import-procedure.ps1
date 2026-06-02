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
    param([string] $Directory)

    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $index = New-TempIndexPath
    try {
        # Hash the live JSON directory as a root tree without touching the
        # repository's real index.
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
        # Populate the private base cache from a tree using a scratch index.
        Invoke-Git @("read-tree", $Tree) -IndexFile $index | Out-Null
        Invoke-Git @("--work-tree=$Directory", "checkout-index", "-a", "-f") -IndexFile $index | Out-Null
    }
    finally {
        Remove-Item $index -Force -ErrorAction SilentlyContinue
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
$safeLibraryId = ($LibraryId -replace "[^A-Za-z0-9_.-]", "_")
$script:JsonAbsolutePath = Join-Path $script:RepoRoot ($script:JsonPath -replace "/", [System.IO.Path]::DirectorySeparatorChar)
$script:StateRoot = Resolve-GitPrivatePath "gittools/$safeLibraryId"
$script:BaseCachePath = Join-Path $script:StateRoot "base"

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

Write-Step "Update metadata and private base cache"
# Keep a file cache for the base tree so later exports can seed Omnis quickly
# even if Git eventually prunes unreferenced tree objects.
Restore-TreeToDirectory -Tree $currentSourceTree -Directory $script:BaseCachePath
Write-GitToolsMeta -Meta (New-CleanMeta -BaseTree $currentSourceTree -SourceTree $currentSourceTree)

Write-Host "Import metadata updated."
