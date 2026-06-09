# Shared helpers for the GitTools import/export procedure scripts.
#
# This file defines functions only; it has no top-level side effects and is
# meant to be dot-sourced by the four phase entry scripts:
#   pre-export.ps1 / post-export.ps1 / pre-import.ps1 / post-import.ps1
#
# Output discipline (the Omnis contract): all human-readable progress goes to
# stderr via Write-Step / Write-Note, so stdout carries ONLY machine-readable
# values - the path printed by pre-import and the RESULT line printed by a
# post-script. (pre-export prints nothing: Omnis derives the export directory
# itself from the git dir + state key.) Callers (Omnis) read stdout for the
# value and stderr for logs.

# --- Output helpers --------------------------------------------------------

function Write-Step {
    param([string] $Message)
    [Console]::Error.WriteLine("")
    [Console]::Error.WriteLine("==> $Message")
}

function Write-Note {
    param([string] $Message)
    [Console]::Error.WriteLine($Message)
}

# --- Timing / benchmarking (opt-in via GITTOOLS_TIMING) --------------------
# When the GITTOOLS_TIMING environment variable is set to a non-empty value, the
# scripts emit per-step timings, file counts, and a total git-invocation count to
# stderr. Off by default, so the stdout/stderr contract and normal output are
# unchanged. Start-Timing must run before the first git call so invocations are
# counted; every entry script calls it right after dot-sourcing this file.

function Start-Timing {
    $script:TimingEnabled = -not [string]::IsNullOrEmpty($env:GITTOOLS_TIMING)
    $script:GitInvocations = 0
    if ($script:TimingEnabled) {
        $script:TimingStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        $script:TimingLast = [TimeSpan]::Zero
    }
}

function Write-Timing {
    # Log the elapsed time of the step that just finished (the lap since the last
    # checkpoint) alongside the running total.
    param([string] $Label)
    if (-not $script:TimingEnabled) { return }
    $now = $script:TimingStopwatch.Elapsed
    $lap = $now - $script:TimingLast
    $script:TimingLast = $now
    [Console]::Error.WriteLine([string]::Format([System.Globalization.CultureInfo]::InvariantCulture, "[timing] {0,9:N1} ms step | {1,9:N1} ms total | {2}", $lap.TotalMilliseconds, $now.TotalMilliseconds, $Label))
}

function Write-TimingNote {
    # Annotate the current step with detail (e.g. how many files were hashed).
    param([string] $Message)
    if (-not $script:TimingEnabled) { return }
    [Console]::Error.WriteLine("[timing]           detail | $Message")
}

function Write-TimingSummary {
    if (-not $script:TimingEnabled) { return }
    $total = $script:TimingStopwatch.Elapsed
    [Console]::Error.WriteLine([string]::Format([System.Globalization.CultureInfo]::InvariantCulture, "[timing] ===== total {0:N1} ms over {1} git invocations =====", $total.TotalMilliseconds, $script:GitInvocations))
}

# --- General Git helpers ---------------------------------------------------

function ConvertTo-GitPath {
    param([string] $Path)
    return ($Path -replace "\\", "/").Trim("/")
}

function Get-StateKey {
    param(
        [string] $LibraryPath,
        [string] $LibraryId
    )

    # The export-to-library relationship is 1:N, so reconciliation state belongs to
    # an individual library FILE. The key is derived from the library's own path
    # (which may live outside the repo), never from the export path. Production
    # (Omnis) computes the same key; this mirrors it.
    if ($LibraryPath) {
        # Canonicalize so the same file reached two ways yields one key. A full
        # implementation should also resolve symlinks/real-path; this prototype at
        # least normalizes to an absolute, separator-consistent form.
        $canonical = [System.IO.Path]::GetFullPath($LibraryPath)
        $name = [System.IO.Path]::GetFileNameWithoutExtension($LibraryPath)
    }
    else {
        # Demonstration fallback when only an id is supplied.
        $canonical = $LibraryId
        $name = $LibraryId
    }

    # Case-fold only on case-insensitive filesystems (macOS/Windows), never on
    # case-sensitive Linux where two differently-cased paths are distinct files.
    $caseInsensitive = if ($PSVersionTable.PSVersion.Major -ge 6) { -not $IsLinux } else { $true }
    if ($caseInsensitive) {
        $canonical = $canonical.ToLowerInvariant()
    }

    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($canonical)
        $hash = -join ($sha1.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") })
    }
    finally {
        $sha1.Dispose()
    }

    # Readable prefix for inspecting .git/gittools and refs/gittools; hash suffix
    # makes distinct paths unable to alias onto one key.
    $safeName = ($name -replace "[^A-Za-z0-9_.-]", "_")
    return "$safeName-$($hash.Substring(0, 8))"
}

function Invoke-GitRaw {
    param(
        [Parameter(Mandatory = $true)]
        [string[]] $Arguments,

        [string] $IndexFile,

        # When set, point Git at this directory as the working tree (via
        # GIT_WORK_TREE). Needed for operations that compare the index against
        # on-disk files in the export cache directory (checkout-index, diff-files,
        # ls-files), which are how the incremental tree build finds what changed.
        [string] $WorkTree
    )

    if ($script:TimingEnabled) { $script:GitInvocations++ }

    $oldIndex = $env:GIT_INDEX_FILE
    if ($IndexFile) {
        # Several operations must build or inspect trees without touching the
        # repository's real index. GIT_INDEX_FILE gives those operations a
        # private scratch index.
        $env:GIT_INDEX_FILE = $IndexFile
    }

    $oldWorkTree = $env:GIT_WORK_TREE
    if ($WorkTree) {
        $env:GIT_WORK_TREE = $WorkTree
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
        if ($null -eq $oldWorkTree) {
            Remove-Item Env:GIT_WORK_TREE -ErrorAction SilentlyContinue
        }
        else {
            $env:GIT_WORK_TREE = $oldWorkTree
        }
    }
}

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]] $Arguments,

        [string] $IndexFile,

        [string] $WorkTree
    )

    $result = Invoke-GitRaw -Arguments $Arguments -IndexFile $IndexFile -WorkTree $WorkTree
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

    if ($script:TimingEnabled) { $script:GitInvocations++ }

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

function Invoke-GitHashObjectBatch {
    # Hash many files in ONE git process via --stdin-paths (newline-framed),
    # instead of spawning one `hash-object` per file - the dominant cost on a
    # cold or large export (a 7k-file first export went from ~230s of per-file
    # process spawns to ~1s). git writes one object id per input path, in input
    # order, to stdout.
    #
    # Attribute normalization (.gitattributes / autocrlf) still applies, resolved
    # from each path as given - identical to the old `hash-object --path` form for
    # the root and global rules these exports use. The export directory is
    # overwritten wholesale by Omnis and so can never contain a nested
    # .gitattributes, which is the only case where per-path resolution would have
    # differed.
    param([string[]] $Files)

    if ((-not $Files) -or ($Files.Count -eq 0)) { return ,@() }
    if ($script:TimingEnabled) { $script:GitInvocations++ }

    $errorFile = [System.IO.Path]::GetTempFileName()
    try {
        $out = $Files | & git -C $script:RepoRoot hash-object -w --stdin-paths 2> $errorFile
        if ($LASTEXITCODE -ne 0) {
            $err = if (Test-Path $errorFile) { Get-Content -Raw -Path $errorFile } else { "" }
            throw "git hash-object --stdin-paths failed with exit code ${LASTEXITCODE}:$([Environment]::NewLine)$err"
        }
        # Leading comma: keep this a single array even when one path was hashed, so
        # PowerShell does not unwrap a 1-element result to a scalar string (which
        # would make the caller's $oids[$i] index into the oid's characters).
        return ,@($out | ForEach-Object { $_.ToString().Trim() })
    }
    finally {
        Remove-Item $errorFile -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-GitCatFileBatchCheck {
    # Resolve many revisions to object metadata in ONE git process via cat-file
    # --batch-check (newline-framed in and out), instead of spawning a rev-parse per
    # revision - the dominant cost when walking a large library's history (a 1900-commit
    # path history went from ~60s of per-commit process spawns to well under 1s). Each
    # input line is a rev such as "<commit>:<path>"; git prints "<oid> <type> <size>"
    # for one that resolves and "<rev> missing" for one that does not, one line per
    # input, in input order.
    param([string[]] $Revisions)

    if ((-not $Revisions) -or ($Revisions.Count -eq 0)) { return ,@() }
    if ($script:TimingEnabled) { $script:GitInvocations++ }

    $errorFile = [System.IO.Path]::GetTempFileName()
    try {
        $out = $Revisions | & git -C $script:RepoRoot cat-file --batch-check 2> $errorFile
        if ($LASTEXITCODE -ne 0) {
            $err = if (Test-Path $errorFile) { Get-Content -Raw -Path $errorFile } else { "" }
            throw "git cat-file --batch-check failed with exit code ${LASTEXITCODE}:$([Environment]::NewLine)$err"
        }
        # Leading comma: keep this a single array even for a one-line result, so the
        # caller does not get a scalar string unwrapped from a 1-element array.
        return ,@($out | ForEach-Object { $_.ToString() })
    }
    finally {
        Remove-Item $errorFile -Force -ErrorAction SilentlyContinue
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

function Resolve-GitCommonPath {
    param([string] $RelativeGitPath)

    $commonDir = Invoke-Git @("rev-parse", "--git-common-dir")
    if (-not [System.IO.Path]::IsPathRooted($commonDir)) {
        $commonDir = Join-Path $script:RepoRoot $commonDir
    }

    return Join-Path $commonDir $RelativeGitPath
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

function Test-IndexHasUnmerged {
    # write-tree (used by the New-LiveSourceTree fast path) aborts if ANY index
    # entry is unmerged, even one outside the export path. Detect that cheaply so
    # the caller can fall back to the path-scoped builder, which is unaffected by
    # unrelated conflicts.
    $result = Invoke-Git @("ls-files", "--unmerged")
    return (-not [string]::IsNullOrWhiteSpace($result))
}

function New-LiveSourceTree {
    # Build a tree of the live JSON path. Fast path: start from a COPY of the
    # repository index - which already holds every tracked file's blob, so the tens
    # of thousands of unchanged entries never pass through PowerShell - apply only
    # the small working-tree delta (modified re-hashed, deleted dropped, new
    # hashed), and let git assemble the subtree in C with `write-tree --prefix`.
    # Cost is proportional to local edits, not library size (measured ~48x faster
    # than rebuilding from an empty index on a 20k-file library).
    #
    # `write-tree` refuses to run while ANY index entry is unmerged (even outside
    # the export path), so when the index carries conflicts - or has no index file
    # yet - we fall back to New-LiveSourceTreeScoped, which only ever touches
    # <jsonPath> and is therefore isolation-safe. The fast path assumes the export
    # holds only regular (non-executable) files, true for Omnis .json/.omh output,
    # so the copied index modes are uniformly 100644 and match the forced-100644
    # trees the rest of the design builds.
    param([string] $RepoRelativePrefix = $script:JsonPath)

    $indexPath = Resolve-GitPrivatePath "index"
    if ((-not (Test-Path -LiteralPath $indexPath)) -or (Test-IndexHasUnmerged)) {
        return (New-LiveSourceTreeScoped -RepoRelativePrefix $RepoRelativePrefix)
    }

    $scratch = New-TempIndexPath
    try {
        # Snapshot the real index; the copy already contains every tracked blob.
        # Entries are keyed by their FULL repo path here (not stripped to the export
        # root); write-tree --prefix re-roots the result at the export path.
        Copy-Item -LiteralPath $indexPath -Destination $scratch -Force

        $records = New-Object System.Collections.Generic.List[string]
        # Changed/new files to hash in a single batched call (see New-IncrementalExportTree).
        $hashPaths = New-Object System.Collections.Generic.List[string]
        $hashFiles = New-Object System.Collections.Generic.List[string]

        # Modified / deleted tracked files under the export path, by stat.
        $nameStatus = Invoke-Git @("diff-files", "--name-status", "--", $script:JsonPath)
        foreach ($line in ($nameStatus -split "\r?\n")) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $parts = $line -split "\t", 2
            $repoPath = ConvertTo-GitPath $parts[1]
            if ($parts[0] -like "D*") {
                # Mode 0 removes the entry from the (copied) index.
                $records.Add("0 0000000000000000000000000000000000000000`t$repoPath") | Out-Null
                continue
            }
            $hashPaths.Add($repoPath) | Out-Null
            $hashFiles.Add((Join-Path $script:RepoRoot ($repoPath -replace "/", [System.IO.Path]::DirectorySeparatorChar))) | Out-Null
        }

        # New untracked files. No --exclude-standard, so .gitignore'd files in the
        # export are still captured (the export is authoritative for its own path).
        $others = Invoke-Git @("ls-files", "--others", "--", $script:JsonPath)
        foreach ($line in ($others -split "\r?\n")) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $repoPath = ConvertTo-GitPath $line
            $hashPaths.Add($repoPath) | Out-Null
            $hashFiles.Add((Join-Path $script:RepoRoot ($repoPath -replace "/", [System.IO.Path]::DirectorySeparatorChar))) | Out-Null
        }

        if ($hashFiles.Count -gt 0) {
            $oids = Invoke-GitHashObjectBatch -Files $hashFiles.ToArray()
            for ($i = 0; $i -lt $hashPaths.Count; $i++) {
                $records.Add("100644 $($oids[$i])`t$($hashPaths[$i])") | Out-Null
            }
        }

        if ($records.Count -gt 0) {
            Invoke-GitWithInput -Arguments @("update-index", "--index-info") -InputLines $records.ToArray() -IndexFile $scratch
        }

        if ($script:TimingEnabled) {
            $mod = @($nameStatus -split "\r?\n" | Where-Object { $_ -and ($_ -notmatch "^D") }).Count
            $del = @($nameStatus -split "\r?\n" | Where-Object { $_ -match "^D" }).Count
            $new = @($others -split "\r?\n" | Where-Object { $_ }).Count
            Write-TimingNote "live source (fast): hashed $($mod + $new) ($mod modified, $new new), $del deleted, rest reused from copied index"
        }

        $prefix = if ([string]::IsNullOrEmpty($RepoRelativePrefix) -or ($RepoRelativePrefix -eq ".")) { "" } else { "$RepoRelativePrefix/" }
        if ($prefix) {
            # write-tree --prefix fails with "prefix ... not found" when nothing
            # under the export path is tracked yet (e.g. the very first export,
            # before the path exists). That just means the live source is empty, so
            # fall back to the scoped builder, which yields the empty tree correctly.
            $result = Invoke-GitRaw @("write-tree", "--prefix=$prefix") -IndexFile $scratch
            if ($result.ExitCode -eq 0) {
                return $result.Output.Trim()
            }
            return (New-LiveSourceTreeScoped -RepoRelativePrefix $RepoRelativePrefix)
        }
        return Invoke-Git @("write-tree") -IndexFile $scratch
    }
    finally {
        Remove-Item $scratch -Force -ErrorAction SilentlyContinue
    }
}

function New-LiveSourceTreeScoped {
    # Isolation-safe fallback for New-LiveSourceTree: build the tree from an EMPTY
    # scratch index containing ONLY <jsonPath> entries, so unrelated unmerged
    # entries elsewhere in the real index cannot affect or break it. Slower on large
    # libraries (every unchanged entry is re-listed through PowerShell), but only
    # reached when the index carries conflicts or there is no index file yet.
    param([string] $RepoRelativePrefix = $script:JsonPath)

    $prefix = if ([string]::IsNullOrEmpty($RepoRelativePrefix) -or ($RepoRelativePrefix -eq ".")) { "" } else { "$RepoRelativePrefix/" }

    $index = New-TempIndexPath
    try {
        Invoke-Git @("read-tree", "--empty") -IndexFile $index | Out-Null

        $records = New-Object System.Collections.Generic.List[string]
        $handled = New-Object 'System.Collections.Generic.HashSet[string]'
        # Changed/new files to hash in a single batched call (see New-IncrementalExportTree).
        $hashRels = New-Object System.Collections.Generic.List[string]
        $hashFiles = New-Object System.Collections.Generic.List[string]

        # Modified / deleted tracked files, detected by stat against the REAL index
        # (no -IndexFile here, so the repository's cached stat is used). No file
        # content is read for unchanged entries. Strip the JSON-path prefix so the
        # resulting tree is rooted at <jsonPath> and matches HEAD:<jsonPath>.
        $nameStatus = Invoke-Git @("diff-files", "--name-status", "--", $script:JsonPath)
        foreach ($line in ($nameStatus -split "\r?\n")) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $parts = $line -split "\t", 2
            $repoPath = ConvertTo-GitPath $parts[1]
            $rel = if ($prefix -and $repoPath.StartsWith($prefix)) { $repoPath.Substring($prefix.Length) } else { $repoPath }
            $handled.Add($rel) | Out-Null
            if ($parts[0] -like "D*") { continue }
            $hashRels.Add($rel) | Out-Null
            $hashFiles.Add((Join-Path $script:RepoRoot ($repoPath -replace "/", [System.IO.Path]::DirectorySeparatorChar))) | Out-Null
        }

        # New untracked files. No --exclude-standard, so .gitignore'd files in the
        # export are still captured (the export is authoritative for its own path).
        $others = Invoke-Git @("ls-files", "--others", "--", $script:JsonPath)
        foreach ($line in ($others -split "\r?\n")) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $repoPath = ConvertTo-GitPath $line
            $rel = if ($prefix -and $repoPath.StartsWith($prefix)) { $repoPath.Substring($prefix.Length) } else { $repoPath }
            $handled.Add($rel) | Out-Null
            $hashRels.Add($rel) | Out-Null
            $hashFiles.Add((Join-Path $script:RepoRoot ($repoPath -replace "/", [System.IO.Path]::DirectorySeparatorChar))) | Out-Null
        }

        if ($hashFiles.Count -gt 0) {
            $oids = Invoke-GitHashObjectBatch -Files $hashFiles.ToArray()
            for ($i = 0; $i -lt $hashRels.Count; $i++) {
                $records.Add("100644 $($oids[$i])`t$($hashRels[$i])") | Out-Null
            }
        }

        # Unchanged tracked files: reuse the blob already recorded in the index, no
        # hashing. Mode is forced to 100644 to match the rest of the design.
        $staged = Invoke-Git @("ls-files", "--stage", "--", $script:JsonPath)
        foreach ($line in ($staged -split "\r?\n")) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            if ($line -match "^(\d{6}) ([0-9a-fA-F]{40,64}) [0-9]\t(.+)$") {
                $repoPath = ConvertTo-GitPath $Matches[3]
                $rel = if ($prefix -and $repoPath.StartsWith($prefix)) { $repoPath.Substring($prefix.Length) } else { $repoPath }
                if ($handled.Contains($rel)) { continue }
                $records.Add("100644 $($Matches[2])`t$rel") | Out-Null
            }
        }

        if ($records.Count -gt 0) {
            Invoke-GitWithInput -Arguments @("update-index", "--index-info") -InputLines $records.ToArray() -IndexFile $index
        }

        if ($script:TimingEnabled) {
            $mod = @($nameStatus -split "\r?\n" | Where-Object { $_ -and ($_ -notmatch "^D") }).Count
            $del = @($nameStatus -split "\r?\n" | Where-Object { $_ -match "^D" }).Count
            $new = @($others -split "\r?\n" | Where-Object { $_ }).Count
            Write-TimingNote "live source (scoped): hashed $($mod + $new) ($mod modified, $new new), reused $($records.Count - $mod - $new) from index, $del deleted"
        }

        return Invoke-Git @("write-tree") -IndexFile $index
    }
    finally {
        Remove-Item $index -Force -ErrorAction SilentlyContinue
    }
}

function Get-ExportCacheDir {
    # The persistent per-library directory Omnis exports into. It is a warm copy of
    # the last export, kept between runs purely to let Omnis export incrementally.
    return Join-Path $script:StateRoot "export-cache"
}

function Get-ExportCacheIndex {
    # The persistent scratch index paired with the cache directory. It records each
    # cached file's blob + stat so the export tree can be built by hashing only what
    # Omnis changed. It must stay in step with the directory between runs (which it
    # does: post-export leaves it matching, and nothing else writes the cache).
    return Join-Path $script:StateRoot "export-cache.index"
}

function Initialize-ExportCache {
    # Ensure the persistent export cache exists, and DO NOT touch its contents.
    #
    # The cache is purely an accelerator for Omnis's own incremental export: Omnis
    # is its sole writer and always produces a complete, correct export over
    # whatever is there (pruning files for deleted classes), so a stale cache only
    # costs Omnis some speed, never correctness. The authoritative export is the
    # directory as it stands AFTER Omnis runs (hashed by New-IncrementalExportTree),
    # and the merge base is the durable baseTree ref - neither depends on the cache.
    # So there is deliberately no seeding from baseTree and no reconciliation here.
    #
    # On the very first export the directory and index are empty, so Omnis does a
    # full export and post-export hashes everything once; every later export is
    # proportional to what Omnis changed.
    param(
        [string] $CacheDir,
        [string] $IndexFile
    )

    New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
    if (-not (Test-Path -LiteralPath $IndexFile)) {
        Invoke-Git @("read-tree", "--empty") -IndexFile $IndexFile | Out-Null
    }
}

function New-IncrementalExportTree {
    # Build the export tree by hashing ONLY the files Omnis actually changed since
    # the persistent cache index was last in step with the directory, instead of
    # re-hashing the whole export. The result is identical to a full rebuild
    # (verified): unchanged files keep their existing blob hashes, so the cost
    # scales with the change set, not the library size. The index just needs to be
    # a consistent prior snapshot of the directory (which the persistent cache
    # index always is - even after a crashed export - so this is self-healing).
    param(
        [string] $IndexFile,
        [string] $WorkTree
    )

    # Refresh the cached stat info against what is now on disk. A non-zero exit
    # just means some entries differ, which is expected, so ignore it.
    Invoke-GitRaw @("update-index", "-q", "--refresh") -IndexFile $IndexFile -WorkTree $WorkTree | Out-Null

    $records = New-Object System.Collections.Generic.List[string]
    # Files needing a fresh blob, collected for a single batched hash (one git
    # process for all of them) rather than one hash-object per file. $hashRels and
    # $hashFiles stay index-aligned: the i-th returned oid is for $hashRels[i].
    $hashRels = New-Object System.Collections.Generic.List[string]
    $hashFiles = New-Object System.Collections.Generic.List[string]

    # Tracked files whose stat changed: modified (re-hash) or deleted (drop). This
    # comparison is stat-based and never reads the content of unchanged files.
    $nameStatus = Invoke-Git @("diff-files", "--name-status") -IndexFile $IndexFile -WorkTree $WorkTree
    foreach ($line in ($nameStatus -split "\r?\n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line -split "\t", 2
        $status = $parts[0]
        $rel = ConvertTo-GitPath $parts[1]
        if ($status -like "D*") {
            $records.Add("0 0000000000000000000000000000000000000000`t$rel") | Out-Null
        }
        else {
            $hashRels.Add($rel) | Out-Null
            $hashFiles.Add((Join-Path $WorkTree ($rel -replace "/", [System.IO.Path]::DirectorySeparatorChar))) | Out-Null
        }
    }

    # Untracked files are new classes Omnis exported. No --exclude-standard, so
    # files matching .gitignore are still hashed (the export is authoritative for
    # its own path; silently dropping them would surface as phantom deletions).
    $others = Invoke-Git @("ls-files", "--others") -IndexFile $IndexFile -WorkTree $WorkTree
    foreach ($line in ($others -split "\r?\n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $rel = ConvertTo-GitPath $line
        $hashRels.Add($rel) | Out-Null
        $hashFiles.Add((Join-Path $WorkTree ($rel -replace "/", [System.IO.Path]::DirectorySeparatorChar))) | Out-Null
    }

    if ($hashFiles.Count -gt 0) {
        $oids = Invoke-GitHashObjectBatch -Files $hashFiles.ToArray()
        for ($i = 0; $i -lt $hashRels.Count; $i++) {
            $records.Add("100644 $($oids[$i])`t$($hashRels[$i])") | Out-Null
        }
    }

    if ($records.Count -gt 0) {
        Invoke-GitWithInput -Arguments @("update-index", "--index-info") -InputLines $records.ToArray() -IndexFile $IndexFile
    }

    if ($script:TimingEnabled) {
        $mod = @($nameStatus -split "\r?\n" | Where-Object { $_ -and ($_ -notmatch "^D") }).Count
        $del = @($nameStatus -split "\r?\n" | Where-Object { $_ -match "^D" }).Count
        $new = @($others -split "\r?\n" | Where-Object { $_ }).Count
        Write-TimingNote "export tree: hashed $($mod + $new) changed files ($mod modified, $new new), $del deleted"
    }

    $tree = Invoke-Git @("write-tree") -IndexFile $IndexFile

    # update-index --index-info records blobs without stat info, so the entries we
    # just changed would look dirty next run and be re-read. Refresh once to record
    # their stat against the now-current files, keeping the next export proportional
    # (it reads only this export's change set; on the first export, that is the
    # whole library - the one-time full-hash cost).
    Invoke-GitRaw @("update-index", "-q", "--refresh") -IndexFile $IndexFile -WorkTree $WorkTree | Out-Null

    return $tree
}

function Remove-DirectoryRobust {
    # Remove-Item -Recurse -Force intermittently fails on macOS/APFS with
    # "Directory not empty": it races its own child deletions against the parent
    # removal, and a transient open handle (e.g. an editor file watcher) can make
    # a single attempt fail. [IO.Directory]::Delete($p, $true) is a single
    # recursive delete that avoids the ordering problem; a short retry absorbs a
    # transient busy handle.
    param([string] $Path)

    if (-not (Test-Path $Path)) {
        return
    }

    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            [System.IO.Directory]::Delete($Path, $true)
            return
        }
        catch [System.IO.IOException] {
            if ($attempt -eq 5) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
}

function Restore-TreeToDirectory {
    param(
        [string] $Tree,
        [string] $Directory
    )

    Remove-DirectoryRobust -Path $Directory

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

# --- Durability refs -------------------------------------------------------
# baseTree and the transient pending trees are kept reachable by refs under
# refs/gittools/<state-key>/ so `git gc` cannot prune them (a tree named only by
# meta.json is invisible to Git and would be collected). The base ref is a
# commit lineage - one commit per accepted export/import - giving a debuggable
# history; pending refs pin the conflict trees directly and are deleted when the
# pending state clears. commit-tree and update-ref never move HEAD and never
# fire the post-commit hook.

function Get-GitToolsRef {
    param([string] $Name)
    return "refs/gittools/$script:StateKey/$Name"
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
    # refs/gittools/<id>/base reads as a history of accepted exports/imports.
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

function Set-PendingRefs {
    param(
        [string] $SourceTree,
        [string] $ExportTree
    )

    Invoke-Git @("update-ref", (Get-GitToolsRef "pending-source"), $SourceTree) | Out-Null
    Invoke-Git @("update-ref", (Get-GitToolsRef "pending-export"), $ExportTree) | Out-Null
}

function Clear-PendingRefs {
    foreach ($name in @("pending-source", "pending-export")) {
        $ref = Get-GitToolsRef $name
        if (Get-RefTarget $ref) {
            Invoke-Git @("update-ref", "-d", $ref) | Out-Null
        }
    }
}

# --- Handoff file (export only) --------------------------------------------
# Splitting the export across two processes means the in-memory state at the
# Omnis-export boundary is gone when the post-script starts. meta.json (committed
# state) survives on its own, and the export cache + its index are persistent at a
# location both phases derive from the state key - so the only thing that must be
# carried across is the computed currentSourceTree. The mere PRESENCE of this file
# means "an export started but its post-script never finished" - distinct from
# meta.status = pendingExportConflict, which is a COMPLETED export awaiting user
# resolution (its handoff is already deleted).

function Get-HandoffPath {
    return Join-Path $script:StateRoot "pending-op.json"
}

function Write-Handoff {
    param([object] $Handoff)

    New-Item -ItemType Directory -Force -Path $script:StateRoot | Out-Null
    $path = Get-HandoffPath
    $tempPath = "$path.tmp"
    $Handoff | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 -NoNewline -Path $tempPath
    if (Test-Path $path) {
        [System.IO.File]::Replace($tempPath, $path, [NullString]::Value)
    }
    else {
        [System.IO.File]::Move($tempPath, $path)
    }
}

function Read-Handoff {
    $path = Get-HandoffPath
    if (-not (Test-Path $path)) {
        return $null
    }
    return (Get-Content -Raw -Path $path) | ConvertFrom-Json
}

function Clear-Handoff {
    $path = Get-HandoffPath
    if (Test-Path $path) {
        Remove-Item $path -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-StaleHandoffSweep {
    # A leftover handoff means a previous export's post-script never completed.
    # There is nothing transient to clean up now: the export cache is persistent
    # and self-healing (its index stays a valid prior snapshot of the directory, so
    # the next New-IncrementalExportTree still reconstructs the correct tree). Just
    # clear the stale handoff so this export can proceed.
    if (Read-Handoff) {
        Write-Step "Clearing an incomplete previous export"
        Clear-Handoff
    }
}

# --- Live JSON path queries ------------------------------------------------

function Get-LiveJsonTree {
    return New-LiveSourceTree
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
            Remove-DirectoryRobust -Path $script:JsonAbsolutePath
        }

        Invoke-Git @("clean", "-fd", "--", $script:JsonPath) | Out-Null
    }
    else {
        Remove-DirectoryRobust -Path $script:JsonAbsolutePath
    }
}

function Remove-EmptyParents {
    # After deleting a file, prune any directories the deletion emptied, walking
    # upward - but never removing the export root itself and never ascending above
    # it. git does not track empty directories, so leftover empty folders would
    # otherwise linger in the export.
    param(
        [string] $Leaf,
        [string] $Root
    )

    $root = [System.IO.Path]::GetFullPath($Root)
    $dir = Split-Path -Parent $Leaf
    while ($dir) {
        $full = [System.IO.Path]::GetFullPath($dir)
        if (($full -eq $root) -or (-not $full.StartsWith($root))) { break }
        if (Test-Path -LiteralPath $full) {
            if (@(Get-ChildItem -LiteralPath $full -Force).Count -ne 0) { break }
            Remove-Item -Force -LiteralPath $full -ErrorAction SilentlyContinue
        }
        $dir = Split-Path -Parent $dir
    }
}

function ConvertTo-PrefixedJsonPath {
    # Turn a path reported relative to the export tree (rooted at <jsonPath>) into a
    # repository-relative pathspec matching HEAD:<jsonPath> and `-- <path>`.
    param([string] $Relative)
    if ($script:JsonPath -eq ".") { return $Relative }
    return "$script:JsonPath/$Relative"
}

function Write-LiveJsonPathDelta {
    # Make the live JSON path's CONTENT equal $Tree by applying ONLY the delta
    # between what is on disk now ($LiveTree) and $Tree - never by wiping and
    # rewriting the whole directory, which is prohibitively slow on large libraries.
    # `git checkout-index` only ever writes the entries it is given and never removes
    # anything, so removed paths are deleted explicitly (and emptied folders pruned),
    # while changed and new paths are written in a single batched checkout. This
    # touches the WORKING TREE only - never the real index. Returns the changed paths
    # (repo-relative, prefixed) so callers can adjust the index for just those.
    param([string] $Tree, [string] $LiveTree)

    $sep = [System.IO.Path]::DirectorySeparatorChar

    # The delta between the on-disk content and the target tree. Both trees are
    # rooted at the export path, so the reported paths are relative to it. Deletions
    # are handled before writes so a path that changes type (file <-> directory,
    # which diff-tree reports as a delete plus an add) does not collide on write.
    $nameStatus = Invoke-Git @("diff-tree", "-r", "--no-commit-id", "--name-status", $LiveTree, $Tree)

    $writes = New-Object System.Collections.Generic.List[string]
    $changed = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($nameStatus -split "\r?\n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line -split "\t", 2
        $rel = ConvertTo-GitPath $parts[1]
        $changed.Add((ConvertTo-PrefixedJsonPath $rel)) | Out-Null
        if ($parts[0] -like "D*") {
            $abs = Join-Path $script:JsonAbsolutePath ($rel -replace "/", $sep)
            if (Test-Path -LiteralPath $abs) {
                Remove-Item -Force -LiteralPath $abs -ErrorAction SilentlyContinue
            }
            Remove-EmptyParents -Leaf $abs -Root $script:JsonAbsolutePath
        }
        else {
            # Added / modified / type-changed: write the target version.
            $writes.Add($rel) | Out-Null
        }
    }

    if ($writes.Count -gt 0) {
        New-Item -ItemType Directory -Force -Path $script:JsonAbsolutePath | Out-Null
        $index = New-TempIndexPath
        try {
            # A scratch index of the target tree, checked out into the live path.
            # --stdin feeds the changed paths (avoiding any command-line length
            # limit when many files changed, e.g. a first export); checkout-index
            # creates leading directories as needed.
            Invoke-Git @("read-tree", $Tree) -IndexFile $index | Out-Null
            Invoke-GitWithInput -Arguments @("--work-tree=$script:JsonAbsolutePath", "checkout-index", "-f", "--stdin") -InputLines $writes.ToArray() -IndexFile $index
        }
        finally {
            Remove-Item $index -Force -ErrorAction SilentlyContinue
        }
    }

    if ($script:TimingEnabled) {
        $del = @($nameStatus -split "\r?\n" | Where-Object { $_ -match "^D" }).Count
        Write-TimingNote "apply delta: wrote $($writes.Count) files, deleted $del"
    }

    return ,@($changed.ToArray())
}

function Reset-StagedChangesToHead {
    # Unstage just the changed paths that the user (or a prior export) had STAGED,
    # so this export's changes surface as ordinary unstaged edits - WITHOUT disturbing
    # anything the user staged that this export did not touch. Resetting a path whose
    # index already equals HEAD is a no-op, and a brand-new untracked path is not in
    # the index at all (so `restore --staged` would error on it), so the reset is
    # scoped to the intersection of "currently staged vs HEAD" and "changed here".
    param([string[]] $ChangedPaths)

    if ((-not $ChangedPaths) -or ($ChangedPaths.Count -eq 0)) { return }
    if (-not (Test-HeadExists)) { return }

    $staged = Invoke-Git @("diff", "--cached", "--name-only", "--", $script:JsonPath)
    if ([string]::IsNullOrWhiteSpace($staged)) { return }
    $stagedSet = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($p in ($staged -split "\r?\n")) {
        $t = (ConvertTo-GitPath $p).Trim()
        if ($t) { [void]$stagedSet.Add($t) }
    }

    $toReset = @($ChangedPaths | Where-Object { $stagedSet.Contains($_) })
    if ($toReset.Count -eq 0) { return }
    Invoke-GitWithInput -Arguments @("restore", "--staged", "--source=HEAD", "--pathspec-from-file=-", "--") -InputLines $toReset
}

function Apply-TreeToLiveJsonPath {
    # Apply $Tree to the live JSON path as a content delta (see Write-LiveJsonPathDelta),
    # then unstage just the changed-and-staged paths so the result shows as ordinary
    # unstaged edits - leaving any unrelated content the user already staged intact.
    param([string] $Tree)

    # liveTree reconstructs the true on-disk content (cheaply, via the index stat
    # cache). If it already equals the target, there is nothing to apply - and the
    # index is deliberately left untouched (any staging the user did is preserved).
    $liveTree = Get-LiveJsonTree
    if ($liveTree -eq $Tree) {
        Write-Note "Live JSON path already matches the result; nothing to apply."
        return
    }

    $changed = Write-LiveJsonPathDelta -Tree $Tree -LiveTree $liveTree
    Reset-StagedChangesToHead -ChangedPaths $changed
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
    $meta = $text | ConvertFrom-Json

    if ($meta.jsonPath -ne $script:JsonPath) {
        # The export location was repointed. The state key is the library path,
        # so it is unchanged, but the stored trees describe the OLD export path
        # and would merge against an unrelated base. Reset to a first-export
        # state and drop the now-meaningless durability refs.
        Write-Step "Export path moved ('$($meta.jsonPath)' -> '$script:JsonPath'); resetting stale base"
        $baseRef = Get-GitToolsRef "base"
        if (Get-RefTarget $baseRef) {
            Invoke-Git @("update-ref", "-d", $baseRef) | Out-Null
        }
        Clear-PendingRefs
        return [pscustomobject]@{
            version = 2
            jsonPath = $script:JsonPath
            baseTree = ""
            sourceTree = ""
            status = "clean"
            pending = $null
        }
    }

    return $meta
}

function Write-GitToolsMeta {
    param([object] $Meta)

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $script:MetaPath) | Out-Null

    # meta.json is the commit point of a state transition: the working tree and
    # the durability refs are updated first, and this write is what makes the new
    # state official. Write to a sibling temp file then atomically rename it over
    # the target, so an interrupted write can never leave a truncated meta.json.
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

function New-PendingMeta {
    # BaseTree is the base the conflicting merge actually ran against (the resolved
    # common ancestor on the fallback path, or the advanced baseTree on the
    # continuation path) - NOT necessarily the old meta.baseTree. Recording the
    # real base is what lets Resolve-PendingConflictIfNeeded classify a later
    # discard-vs-accept correctly.
    param(
        [string] $BaseTree,
        [string] $CurrentSourceTree,
        [string] $ExportTree
    )

    return [pscustomobject]@{
        version = 2
        jsonPath = $script:JsonPath
        baseTree = $BaseTree
        sourceTree = $CurrentSourceTree
        status = "pendingExportConflict"
        pending = [pscustomobject]@{
            baseTree = $BaseTree
            sourceTree = $CurrentSourceTree
            exportTree = $ExportTree
        }
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
        Write-Note "JSON path has uncommitted changes. Discarding them before evaluating pending state."
        if (Test-HeadExists) {
            Clear-LiveJsonPath
        }
        else {
            # No HEAD to restore from. The pre-export source tree is pinned by
            # the pending-source ref, so restore directly from that tree.
            Restore-TreeToDirectory -Tree $Meta.pending.sourceTree -Directory $script:JsonAbsolutePath
        }
    }

    $currentTree = Get-LiveJsonTree
    if ($currentTree -eq $Meta.pending.sourceTree) {
        # The live source is back at the exact pre-export source tree, so the
        # continuation lineage is intact and the export was simply discarded. Keep
        # the previous merge base.
        Write-Note "Pending conflict was discarded (source restored to its pre-export state). Keeping previous base tree."
        Clear-PendingRefs
        return New-CleanMeta -BaseTree $Meta.pending.baseTree -SourceTree $currentTree
    }

    # The source moved and no conflict markers remain, but "moved" alone does not
    # mean the export was accepted: a discard can land somewhere OTHER than the
    # pinned pre-export source (e.g. a continuation conflict whose pre-export source
    # was GitTools' own uncommitted merged output - restoring to HEAD moves off it
    # without accepting anything). Distinguish the two by REPLAYING the same
    # three-way merge that conflicted, now against the current source:
    #   - clean  => the source genuinely absorbed the export (a real resolve/accept),
    #               so advance the base to the export tree and the next export will
    #               not re-conflict.
    #   - still conflicts => the export was NOT absorbed; the source has moved off the
    #               continuation lineage. Advancing the base to the export tree here
    #               is exactly what makes a later continuation merge see base == theirs
    #               and SILENTLY drop the developer's library work. So drop the now-
    #               untrustworthy continuation base entirely (empty meta) and let the
    #               export's fallback resolver recompute the true common ancestor from
    #               HEAD - which re-surfaces the conflict instead of swallowing it.
    $replay = Invoke-MergeTree -BaseTree $Meta.pending.baseTree -CurrentSourceTree $currentTree -ExportTree $Meta.pending.exportTree
    Clear-PendingRefs
    if ($replay.ExitCode -eq 0) {
        Write-Note "Pending conflict was resolved/accepted (the export merges cleanly into the current source). Advancing base tree to pending export."
        Update-BaseRef -Tree $Meta.pending.exportTree
        return New-CleanMeta -BaseTree $Meta.pending.exportTree -SourceTree $currentTree
    }

    Write-Note "Pending conflict was not absorbed by the current source (the export still conflicts against it). Dropping the continuation base; the next export will recompute the base from HEAD and re-surface the conflict."
    return New-CleanMeta -BaseTree "" -SourceTree ""
}

function Get-BaseLineageTrees {
    # The set of tree ids GitTools has recorded as a reconciliation base - one per
    # import or accepted export, newest first - read from the base ref's commit
    # lineage (each base commit wraps its base tree directly, so the commit trees
    # ARE the recorded base trees). These are what the committed source is matched
    # against to find the true common ancestor on the fallback path. Empty when no
    # base ref exists yet (a fresh clone that has never imported or exported here:
    # gittools refs are local and are not pushed).
    $ref = Get-GitToolsRef "base"
    if (-not (Get-RefTarget $ref)) {
        return ,@()
    }
    $result = Invoke-GitRaw @("rev-list", "--format=%T", "--no-commit-header", $ref)
    if ($result.ExitCode -ne 0) {
        return ,@()
    }
    # Leading comma: keep this an array even with a single base commit, so callers
    # can use .Count and index it (PowerShell would otherwise unwrap a 1-element
    # array to a scalar on return).
    return ,@($result.Output -split "\r?\n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Get-HeadJsonTreeHistory {
    # The <jsonPath> subtree ids carried by commits reachable from HEAD, newest
    # first. The caller decides how to match them (last produced source first, then
    # the older base lineage fallback) and always passes an explicit cap; the default
    # only bounds an accidental capless call.
    param([int] $MaxCommits = 1000)

    if (-not (Test-HeadExists)) {
        return ,@()
    }

    $result = Invoke-GitRaw @("rev-list", "--full-history", "--max-count=$MaxCommits", "HEAD", "--", $script:JsonPath)
    if ($result.ExitCode -ne 0) {
        return ,@()
    }

    $commits = @($result.Output -split "\r?\n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($commits.Count -eq 0) {
        return ,@()
    }

    # Resolve every commit's <jsonPath> subtree id in ONE git process rather than a
    # rev-parse per commit (which spawned ~one process per commit and made this the
    # dominant cost on a large history - see Invoke-GitCatFileBatchCheck). Each query
    # is "<commit>:<jsonPath>"; cat-file --batch-check echoes one line per query in
    # order, "<oid> tree <size>" for a hit or "<rev> missing" for a commit that lacks
    # the path (the latter skipped, matching the old rev-parse --verify --quiet guard).
    $queries = $commits | ForEach-Object { "${_}:$script:JsonPath" }
    $lines = Invoke-GitCatFileBatchCheck -Revisions $queries

    $trees = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $fields = $line.Trim() -split " "
        if (($fields.Count -ge 2) -and ($fields[1] -eq "tree")) {
            $trees.Add($fields[0]) | Out-Null
        }
    }

    return ,@($trees.ToArray())
}

function Find-RecordedBaseInHistory {
    # Match HEAD's <jsonPath> subtree history (newest first, up to $MaxCommits commits)
    # against the bases GitTools has recorded, returning the base tree to merge against
    # or "" if none is found within that window. Two records can match, in priority order:
    #   1. The clean-merge handoff case: GitTools' last produced source (meta.sourceTree)
    #      is reachable from HEAD even though the recorded baseTree is the raw export tree,
    #      not the merged source tree. baseTree is still the correct library-side base.
    #   2. Otherwise the true common ancestor: the most recent commit whose subtree
    #      GitTools recorded as a base (an import or accepted export). That is where this
    #      library's lineage and the committed source last agreed - the same point
    #      `git merge-base` would find if the library's private lineage were a branch.
    #      --full-history (in Get-HeadJsonTreeHistory) keeps commits that history
    #      simplification would prune on the side of a merge, so a base recorded only on a
    #      merged-in branch is still found; the match is by SUBTREE id, so it is unaffected
    #      by which commit last carried that subtree.
    param(
        [object] $Meta,
        [object] $LineageSet,
        [int] $MaxCommits
    )

    $headTrees = Get-HeadJsonTreeHistory -MaxCommits $MaxCommits

    if (($null -ne $Meta) -and $Meta.sourceTree -and $Meta.baseTree) {
        foreach ($subTree in $headTrees) {
            if ($subTree -eq $Meta.sourceTree) {
                Write-Note "Last GitTools-produced source is reachable from HEAD; using its recorded base tree."
                return $Meta.baseTree
            }
        }
    }

    foreach ($subTree in $headTrees) {
        if ($LineageSet.Contains($subTree)) {
            return $subTree
        }
    }
    return ""
}

function Resolve-FallbackMergeBase {
    # The merge base to use when the live source is NOT GitTools' own last output -
    # a pull, a discard, or a partial commit has moved it. In that case the advanced
    # baseTree is stale: it can sit AHEAD of the committed source (e.g. a deletion
    # exported then discarded) or diverged from it, and using it makes a three-way
    # merge mis-attribute changes (silently resurrecting deletions, or dropping a
    # colleague's committed work). The true base is found by matching HEAD's history
    # against GitTools' recorded bases (see Find-RecordedBaseInHistory) - a purely
    # local match, so colleagues importing at other commits never affect it. It
    # reproduces the library's changes, preserves genuine source-side divergence, and
    # surfaces real delete/modify and modify/modify conflicts.
    #
    # Returns "" only when NO recorded base is reachable from HEAD - a fresh clone or a
    # rewritten history - which the caller treats as a no-base apply (overwrite). That
    # is safe only when a base genuinely does not exist, so the search must never report
    # "" merely because it did not look far enough: a fast pass scans the most recent
    # $MaxCommits commits, and ONLY if that misses while a base is known to exist does it
    # escalate to a full-history walk before giving up.
    param(
        [object] $Meta,
        [int] $MaxCommits = 1000
    )

    if (-not (Test-HeadExists)) {
        return ""
    }

    $lineage = Get-BaseLineageTrees
    $lineageSet = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($t in $lineage) { [void]$lineageSet.Add($t) }

    # Fast pass: the most recent $MaxCommits commits that touched the export path. This
    # is the common fallback (a recent pull/discard) and stays cheap.
    $base = Find-RecordedBaseInHistory -Meta $Meta -LineageSet $lineageSet -MaxCommits $MaxCommits
    if ($base) {
        return $base
    }

    # The fast pass found nothing. If GitTools has never recorded a base, none exists -
    # report "" and let the caller apply as a first export. But if a base WAS recorded,
    # one exists to be found and the window simply was not deep enough; returning ""
    # here would degrade a real three-way merge into a blind overwrite of committed
    # work. So walk the FULL path history before concluding there is no base. This deep
    # pass runs only on the fallback path AND only when a recorded base sits beyond
    # $MaxCommits commits, so it never touches the fast path; batched cat-file keeps even
    # the full walk inexpensive (see Get-HeadJsonTreeHistory / Invoke-GitCatFileBatchCheck).
    if ($lineage.Count -eq 0) {
        return ""
    }
    Write-Note "No recorded base within the last $MaxCommits commits; searching the full path history."
    return Find-RecordedBaseInHistory -Meta $Meta -LineageSet $lineageSet -MaxCommits ([int]::MaxValue)
}

function Resolve-CurrentSourceAndBase {
    # Decide the source side of the export merge AND the base to merge it against.
    #
    # Continuation path - the live JSON path is still GitTools' own last output
    # (export-before-commit, repeated export before committing): use it as the
    # source and the advanced baseTree as the base. This is the common fast path and
    # is what makes iterative export work without false conflicts.
    #
    # Fallback path - the live source is no longer GitTools' last output, so a pull,
    # discard, or partial commit moved it. The live edits are disposable; HEAD is the
    # source side. The advanced baseTree is now unreliable, so the base is recomputed
    # as the true common ancestor from HEAD's history (see Resolve-FallbackMergeBase).
    # A "" base there means no recorded ancestor is reachable; the export then applies
    # as if it had no base, with the overwrite warning.
    param([object] $Meta)

    $liveTree = Get-LiveJsonTree
    if ($Meta.sourceTree -and ($liveTree -eq $Meta.sourceTree)) {
        Write-Note "Using live JSON path as current source."
        return [pscustomobject]@{ SourceTree = $liveTree; MergeBase = $Meta.baseTree }
    }

    if (Test-HeadExists) {
        Write-Note "Using HEAD JSON path as current source; live JSON path changes are disposable."
        $base = Resolve-FallbackMergeBase -Meta $Meta
        Write-Note "Resolved merge base (true common ancestor): $(if ($base) { $base } else { '<none - applying as first export>' })"
        return [pscustomobject]@{ SourceTree = (Get-HeadJsonTreeOrEmpty); MergeBase = $base }
    }

    Write-Note "Repository has no commits. Using live JSON path as current source."
    return [pscustomobject]@{ SourceTree = $liveTree; MergeBase = $Meta.baseTree }
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

    # merge-tree exit codes: 0 = clean, 1 = conflicts (an acceptable export
    # outcome), anything else = fatal error. A fatal error must abort before the
    # live JSON path is touched; otherwise its error output would be applied as
    # if it were a result tree and recorded as a bogus pending conflict.
    if (($result.ExitCode -ne 0) -and ($result.ExitCode -ne 1)) {
        throw "git merge-tree failed with exit code $($result.ExitCode):$([Environment]::NewLine)$($result.Combined)"
    }

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

    # Materialize the conflicted result tree (cleanly merged content plus conflict
    # markers) as a content delta against what is on disk now - the same proportional
    # write the clean path uses, instead of wiping and re-checking-out the whole
    # directory. On a large library with a small conflict this writes only the few
    # files that actually differ.
    $liveTree = Get-LiveJsonTree
    $changed = Write-LiveJsonPathDelta -Tree $MergeResult.ResultTree -LiveTree $liveTree

    # Leave the cleanly-merged changes UNSTAGED, exactly like a clean export, so the
    # user reviews and stages them deliberately (only the unmerged conflict entries
    # below are special). This unstages just changed-and-staged paths; conflicted
    # paths get their stage-0 entry replaced wholesale next.
    Reset-StagedChangesToHead -ChangedPaths $changed

    $stageLines = New-Object System.Collections.Generic.List[string]
    $conflictPaths = New-Object System.Collections.Generic.HashSet[string]
    foreach ($line in $MergeResult.Lines) {
        if ($line -match "^(\d{6}) ([0-9a-fA-F]{40,64}) ([123])\t(.+)$") {
            $mode = $Matches[1]
            $objectId = $Matches[2]
            $stage = $Matches[3]
            $prefixedPath = ConvertTo-PrefixedJsonPath (ConvertTo-GitPath $Matches[4])
            $conflictPaths.Add($prefixedPath) | Out-Null
            $stageLines.Add("$mode $objectId $stage`t$prefixedPath") | Out-Null
        }
    }

    # Replace each conflicted path's stage-0 entry with the actual unmerged stage
    # 1/2/3 records. This is the step that makes Git clients show "UU" (the working
    # tree already holds the marker content written by the delta above). The
    # force-removes are batched into ONE git process (newline-framed via --stdin)
    # rather than spawning update-index per path - a large modify/modify divergence
    # can conflict on many files, and per-path spawns would make the conflict path
    # scale with the conflict size (same batching rationale as Invoke-GitHashObjectBatch
    # / Invoke-GitCatFileBatchCheck). All removes still complete before the index-info
    # adds below, preserving the original ordering.
    if ($conflictPaths.Count -gt 0) {
        Invoke-GitWithInput -Arguments @("update-index", "--force-remove", "--stdin") -InputLines (@($conflictPaths))
    }

    if ($stageLines.Count -gt 0) {
        Invoke-GitWithInput -Arguments @("update-index", "--index-info") -InputLines $stageLines.ToArray()
    }
}

# --- Shared state init -----------------------------------------------------

function Initialize-GitToolsState {
    # Derive the per-invocation script state every entry script needs. Dot-sourced
    # into the entry script's scope, so these $script: assignments land there and
    # are visible to every helper above (verified: $script: is shared across the
    # dot-source boundary).
    param(
        [Parameter(Mandatory = $true)]
        [string] $RepoRoot,

        [Parameter(Mandatory = $true)]
        [string] $JsonPath,

        [Parameter(Mandatory = $true)]
        [string] $LibraryId,

        [string] $LibraryPath,

        [string] $MetaPath
    )

    $script:RepoRoot = (Resolve-Path $RepoRoot).Path

    # JsonPath is used throughout as a repository-relative Git pathspec - it must
    # match HEAD:<jsonPath> and `-- <jsonPath>`. Accept an absolute path too (Omnis
    # has absolute paths on hand) and rebase it onto RepoRoot rather than letting it
    # be double-joined. A relative path is taken as already repo-relative.
    if ([System.IO.Path]::IsPathRooted($JsonPath)) {
        $absJson = if (Test-Path $JsonPath) { (Resolve-Path $JsonPath).Path } else { [System.IO.Path]::GetFullPath($JsonPath) }
        $relJson = [System.IO.Path]::GetRelativePath($script:RepoRoot, $absJson)
        $firstSegment = ($relJson -split "[\\/]", 2)[0]
        if (($relJson -eq ".") -or ($firstSegment -eq "..")) {
            throw "JsonPath '$JsonPath' is not inside RepoRoot '$script:RepoRoot'."
        }
        $script:JsonPath = ConvertTo-GitPath $relJson
    }
    else {
        $script:JsonPath = ConvertTo-GitPath $JsonPath
    }

    $script:StateKey = Get-StateKey -LibraryPath $LibraryPath -LibraryId $LibraryId
    $script:JsonAbsolutePath = Join-Path $script:RepoRoot ($script:JsonPath -replace "/", [System.IO.Path]::DirectorySeparatorChar)
    # Metadata/cache state should live beside refs/gittools in the common git dir,
    # so linked worktrees see one shared state for the same registered library. The
    # real index remains worktree-local via Resolve-GitPrivatePath "index".
    $script:StateRoot = Resolve-GitCommonPath "gittools/$script:StateKey"

    if ($MetaPath) {
        $script:MetaPath = $MetaPath
    }
    else {
        $script:MetaPath = Join-Path $script:StateRoot "meta.json"
    }

    New-Item -ItemType Directory -Force -Path $script:StateRoot | Out-Null
}
