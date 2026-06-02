# Shared helpers for the GitTools import/export procedure scripts.
#
# This file defines functions only; it has no top-level side effects and is
# meant to be dot-sourced by the four phase entry scripts:
#   pre-export.ps1 / post-export.ps1 / pre-import.ps1 / post-import.ps1
#
# Output discipline (the Omnis contract): all human-readable progress goes to
# stderr via Write-Step / Write-Note, so stdout carries ONLY machine-readable
# values - the temp path printed by a pre-script and the RESULT line printed by
# a post-script. Callers (Omnis) read stdout for the value and stderr for logs.

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
        # on-disk files in the temp export directory (checkout-index, diff-files,
        # ls-files), which are how the incremental tree build finds what changed.
        [string] $WorkTree
    )

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

function Get-AttrPath {
    param(
        [string] $RelativePath,
        [string] $RepoRelativePrefix = $script:JsonPath
    )

    # The repo-relative path a file's content represents, so `hash-object --path`
    # applies the same .gitattributes / autocrlf normalization Git used for the
    # committed blob. Identical content then always hashes to the identical blob.
    if ([string]::IsNullOrEmpty($RepoRelativePrefix) -or ($RepoRelativePrefix -eq ".")) {
        return $RelativePath
    }
    return "$RepoRelativePrefix/$RelativePath"
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

function New-LiveSourceTree {
    # Hash the live JSON path into a tree, using the repository's own index as the
    # stat and blob source. Files whose working-tree stat matches the index are
    # taken straight from the index with no hashing; only files that differ
    # (modified, deleted, or new) are read from disk. The result is identical to a
    # full directory walk, but the cost is proportional to local edits, not to the
    # library size. Everything is scoped to the JSON path, so unrelated repository
    # state (including conflicts in other files) never affects the result.
    param([string] $RepoRelativePrefix = $script:JsonPath)

    $prefix = if ([string]::IsNullOrEmpty($RepoRelativePrefix) -or ($RepoRelativePrefix -eq ".")) { "" } else { "$RepoRelativePrefix/" }

    $index = New-TempIndexPath
    try {
        Invoke-Git @("read-tree", "--empty") -IndexFile $index | Out-Null

        $records = New-Object System.Collections.Generic.List[string]
        $handled = New-Object 'System.Collections.Generic.HashSet[string]'

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
            $file = Join-Path $script:RepoRoot ($repoPath -replace "/", [System.IO.Path]::DirectorySeparatorChar)
            $oid = Invoke-Git @("hash-object", "-w", "--path", (Get-AttrPath -RelativePath $rel -RepoRelativePrefix $RepoRelativePrefix), $file)
            $records.Add("100644 $oid`t$rel") | Out-Null
        }

        # New untracked files. No --exclude-standard, so .gitignore'd files in the
        # export are still captured (the export is authoritative for its own path).
        $others = Invoke-Git @("ls-files", "--others", "--", $script:JsonPath)
        foreach ($line in ($others -split "\r?\n")) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $repoPath = ConvertTo-GitPath $line
            $rel = if ($prefix -and $repoPath.StartsWith($prefix)) { $repoPath.Substring($prefix.Length) } else { $repoPath }
            $handled.Add($rel) | Out-Null
            $file = Join-Path $script:RepoRoot ($repoPath -replace "/", [System.IO.Path]::DirectorySeparatorChar)
            $oid = Invoke-Git @("hash-object", "-w", "--path", (Get-AttrPath -RelativePath $rel -RepoRelativePrefix $RepoRelativePrefix), $file)
            $records.Add("100644 $oid`t$rel") | Out-Null
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
        return Invoke-Git @("write-tree") -IndexFile $index
    }
    finally {
        Remove-Item $index -Force -ErrorAction SilentlyContinue
    }
}

function Initialize-ExportSeed {
    # Materialize the temp export directory from the base tree AND populate a
    # persistent scratch index with each file's stat info (size/mtime). After
    # Omnis runs its incremental export over this directory, the stat info lets
    # the tree build below find what changed without re-reading every file.
    param(
        [string] $BaseTree,
        [string] $IndexFile,
        [string] $WorkTree
    )

    New-Item -ItemType Directory -Force -Path $WorkTree | Out-Null

    if ($BaseTree) {
        Invoke-Git @("read-tree", $BaseTree) -IndexFile $IndexFile | Out-Null
        # -u records the stat info of the checked-out files into the index; without
        # it, read-tree leaves stat empty and every file would later look changed.
        Invoke-Git @("checkout-index", "-a", "-f", "-u") -IndexFile $IndexFile -WorkTree $WorkTree | Out-Null
    }
    else {
        # No base: start empty, so every exported file is detected as new.
        Invoke-Git @("read-tree", "--empty") -IndexFile $IndexFile | Out-Null
    }
}

function New-IncrementalExportTree {
    # Build the export tree from a base-seeded index by hashing ONLY the files
    # Omnis actually changed, instead of re-hashing the whole export. The result
    # is identical to a full rebuild (verified): unchanged files keep the base's
    # blob hashes, so the cost scales with the change set, not the library size.
    param(
        [string] $IndexFile,
        [string] $WorkTree,
        [string] $RepoRelativePrefix = $script:JsonPath
    )

    # Refresh the cached stat info against what is now on disk. A non-zero exit
    # just means some entries differ, which is expected, so ignore it.
    Invoke-GitRaw @("update-index", "-q", "--refresh") -IndexFile $IndexFile -WorkTree $WorkTree | Out-Null

    $records = New-Object System.Collections.Generic.List[string]

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
            $file = Join-Path $WorkTree ($rel -replace "/", [System.IO.Path]::DirectorySeparatorChar)
            $oid = Invoke-Git @("hash-object", "-w", "--path", (Get-AttrPath -RelativePath $rel -RepoRelativePrefix $RepoRelativePrefix), $file)
            $records.Add("100644 $oid`t$rel") | Out-Null
        }
    }

    # Untracked files are new classes Omnis exported. No --exclude-standard, so
    # files matching .gitignore are still hashed (the export is authoritative for
    # its own path; silently dropping them would surface as phantom deletions).
    $others = Invoke-Git @("ls-files", "--others") -IndexFile $IndexFile -WorkTree $WorkTree
    foreach ($line in ($others -split "\r?\n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $rel = ConvertTo-GitPath $line
        $file = Join-Path $WorkTree ($rel -replace "/", [System.IO.Path]::DirectorySeparatorChar)
        $oid = Invoke-Git @("hash-object", "-w", "--path", (Get-AttrPath -RelativePath $rel -RepoRelativePrefix $RepoRelativePrefix), $file)
        $records.Add("100644 $oid`t$rel") | Out-Null
    }

    if ($records.Count -gt 0) {
        Invoke-GitWithInput -Arguments @("update-index", "--index-info") -InputLines $records.ToArray() -IndexFile $IndexFile
    }

    return Invoke-Git @("write-tree") -IndexFile $IndexFile
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
# state) and the temp dir / scratch index (real files) survive on their own; only
# their paths and the computed currentSourceTree do not. Those are written here.
# The mere PRESENCE of this file means "an export started but its post-script
# never finished" - distinct from meta.status = pendingExportConflict, which is a
# COMPLETED export awaiting user resolution (its handoff is already deleted).

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
    # Auto-clean recovery: if a handoff exists at the start of a new export, the
    # previous export's post-script never completed. Remove its leaked temp
    # artifacts (tolerant of already-deleted paths) and the handoff, then proceed
    # with a fresh export. This is the cross-process equivalent of the in-process
    # try/finally cleanup.
    $handoff = Read-Handoff
    if ($null -eq $handoff) {
        return
    }

    Write-Step "Cleaning up an incomplete previous export"
    if ($handoff.tempRoot -and (Test-Path $handoff.tempRoot)) {
        Remove-Item -Recurse -Force $handoff.tempRoot -ErrorAction SilentlyContinue
    }
    if ($handoff.exportIndex -and (Test-Path $handoff.exportIndex)) {
        Remove-Item -Force $handoff.exportIndex -ErrorAction SilentlyContinue
    }
    Clear-Handoff
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

function Apply-TreeToLiveJsonPath {
    # Make the live JSON path equal $Tree by applying ONLY the delta between what
    # is on disk now and $Tree - never by wiping and rewriting the whole directory,
    # which is prohibitively slow on large libraries. `git checkout-index` only
    # ever writes the entries it is given and never removes anything, so removed
    # paths are deleted explicitly (and emptied folders pruned), while changed and
    # new paths are written in a single batched checkout. Cost is proportional to
    # what the export actually changed, not to the library size.
    param([string] $Tree)

    # liveTree reconstructs the true on-disk content (cheaply, via the index stat
    # cache). If it already equals the target, there is nothing to apply.
    $liveTree = Get-LiveJsonTree
    if ($liveTree -eq $Tree) {
        Write-Note "Live JSON path already matches the result; nothing to apply."
        return
    }

    # Normalize the index for the export path to HEAD - index only, no working-tree
    # rewrite - so the applied result shows up as ordinary unstaged changes the
    # user can review and commit (matching the prior flow's end state).
    if (Test-HeadExists) {
        if (Test-PathInHead -Path $script:JsonPath) {
            Invoke-Git @("restore", "--source=HEAD", "--staged", "--", $script:JsonPath) | Out-Null
        }
        else {
            Invoke-Git @("rm", "-r", "--cached", "--ignore-unmatch", "--", $script:JsonPath) | Out-Null
        }
    }

    $sep = [System.IO.Path]::DirectorySeparatorChar

    # The delta between the on-disk content and the target tree. Both trees are
    # rooted at the export path, so the reported paths are relative to it. Process
    # deletions first so a path that changes type (file -> directory or vice versa,
    # which diff-tree reports as a delete plus an add) does not collide on write.
    $nameStatus = Invoke-Git @("diff-tree", "-r", "--no-commit-id", "--name-status", $liveTree, $Tree)

    $writes = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($nameStatus -split "\r?\n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line -split "\t", 2
        $rel = ConvertTo-GitPath $parts[1]
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

    # Backwards compatibility: v1 metadata was only a commit hash. When seen,
    # derive the path tree at that commit and immediately switch to v2 shape.
    Write-Step "Migrating old commit-only metadata"
    $oldCommit = $text
    $baseTree = ""
    if ($oldCommit) {
        $result = Invoke-GitRaw @("rev-parse", "$oldCommit`:$script:JsonPath")
        if ($result.ExitCode -eq 0) {
            $baseTree = $result.Output.Trim()
            Update-BaseRef -Tree $baseTree
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
        # The live source is back at the pre-export source tree. The previous
        # export side was not accepted, so keep the old merge base.
        Write-Note "Pending conflict appears to have been discarded. Keeping previous base tree."
        Clear-PendingRefs
        return New-CleanMeta -BaseTree $Meta.pending.baseTree -SourceTree $currentTree
    }

    # The source tree changed after the conflicted export and no conflicts
    # remain. Treat that as the user having resolved/accepted the export side.
    Write-Note "Pending conflict appears to have been resolved or accepted. Advancing base tree to pending export."
    Update-BaseRef -Tree $Meta.pending.exportTree
    Clear-PendingRefs
    return New-CleanMeta -BaseTree $Meta.pending.exportTree -SourceTree $currentTree
}

function Get-CurrentSourceTree {
    param([object] $Meta)

    $liveTree = Get-LiveJsonTree
    if ($Meta.sourceTree -and ($liveTree -eq $Meta.sourceTree)) {
        # GitTools recognizes the live path as its own last known output. This
        # is what makes export-before-commit and repeated export work.
        Write-Note "Using live JSON path as current source."
        return $liveTree
    }

    if (Test-HeadExists) {
        # The live JSON path differs from GitTools' last known source. Treat
        # it as disposable and use HEAD as the source side of the merge.
        Write-Note "Using HEAD JSON path as current source; live JSON path changes are disposable."
        return Get-HeadJsonTreeOrEmpty
    }

    Write-Note "Repository has no commits. Using live JSON path as current source."
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
    $script:StateRoot = Resolve-GitPrivatePath "gittools/$script:StateKey"

    if ($MetaPath) {
        $script:MetaPath = $MetaPath
    }
    else {
        $script:MetaPath = Join-Path $script:StateRoot "meta.json"
    }

    New-Item -ItemType Directory -Force -Path $script:StateRoot | Out-Null
}
