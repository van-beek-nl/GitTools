Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scripts = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts_proto"
$pass = 0; $fail = 0
function Check($label, $cond) {
    if ($cond) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}
function New-Repo {
    $r = Join-Path ([System.IO.Path]::GetTempPath()) "e2ewt-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $r | Out-Null
    git -C $r init -q -b master; git -C $r config user.email t@t.t; git -C $r config user.name t
    Set-Content -Path (Join-Path $r "Lib.lbs") -Value "bin" -NoNewline
    return $r
}
function CacheDir($repo, $json, $lib) {
    $o = pwsh -NoProfile -Command ". '$scripts/common.ps1'; Initialize-GitToolsState -RepoRoot '$repo' -JsonPath '$json' -LibraryId 'LIB' -LibraryPath '$lib'; Write-Output (Get-ExportCacheDir)" 2>$null
    return ($o | Select-Object -Last 1).Trim()
}
function MetaJson($repo, $json, $lib) {
    $o = pwsh -NoProfile -Command ". '$scripts/common.ps1'; Initialize-GitToolsState -RepoRoot '$repo' -JsonPath '$json' -LibraryId 'LIB' -LibraryPath '$lib'; (Read-GitToolsMeta | ConvertTo-Json -Compress)" 2>$null
    return ($o | Select-Object -Last 1) | ConvertFrom-Json
}
function BaseRefTarget($repo, $json, $lib) {
    $o = pwsh -NoProfile -Command ". '$scripts/common.ps1'; Initialize-GitToolsState -RepoRoot '$repo' -JsonPath '$json' -LibraryId 'LIB' -LibraryPath '$lib'; Write-Output (Get-RefTarget (Get-GitToolsRef 'base'))" 2>$null
    return ($o | Select-Object -Last 1).Trim()
}
function PendingExists($repo, $json, $lib) {
    $o = pwsh -NoProfile -Command ". '$scripts/common.ps1'; Initialize-GitToolsState -RepoRoot '$repo' -JsonPath '$json' -LibraryId 'LIB' -LibraryPath '$lib'; Write-Output ([bool](Get-RefTarget (Get-GitToolsRef 'pending-export')))" 2>$null
    return (($o | Select-Object -Last 1).Trim() -eq "True")
}
# Run an export in $repo (which may be a linked worktree) against the library $lib. The
# same $lib path is passed for every worktree, forcing one shared state key - the stress
# case for cross-worktree isolation.
function Export($repo, $json, $lib, $files) {
    $c = CacheDir $repo $json $lib
    if (Test-Path $c) { Get-ChildItem -Force $c | Remove-Item -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $c | Out-Null
    foreach ($k in $files.Keys) {
        $p = Join-Path $c $k; New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null
        Set-Content -Path $p -Value $files[$k] -NoNewline
    }
    pwsh -NoProfile -File "$scripts/pre-export.ps1"  -RepoRoot $repo -JsonPath $json -LibraryId LIB -LibraryPath $lib 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "pre-export failed" }
    $out = pwsh -NoProfile -File "$scripts/post-export.ps1" -RepoRoot $repo -JsonPath $json -LibraryId LIB -LibraryPath $lib 2>$null
    if ($LASTEXITCODE -ne 0) { throw "post-export failed" }
    return ($out | Where-Object { $_ -match "^RESULT=" }) -join ""
}
function Import($repo, $json, $lib, $files) {
    $abs = Join-Path $repo $json
    New-Item -ItemType Directory -Force -Path $abs | Out-Null
    foreach ($k in $files.Keys) { Set-Content -Path (Join-Path $abs $k) -Value $files[$k] -NoNewline }
    git -C $repo add -A; git -C $repo commit -q -m "import source"
    pwsh -NoProfile -File "$scripts/post-import.ps1" -RepoRoot $repo -JsonPath $json -LibraryId LIB -LibraryPath $lib 2>$null | Out-Null
}
function Read1($repo, $json, $name) {
    $p = Join-Path (Join-Path $repo $json) $name
    if (-not (Test-Path $p)) { return "<missing>" }
    return (Get-Content -Raw $p)
}
function Stat($repo, $path) {
    $s = git -C $repo status --porcelain -- $path
    if ([string]::IsNullOrEmpty($s)) { return "  " } else { return $s.Substring(0,2) }
}
$J = "Source/Lib"

Write-Host "`n=== 25. PER-WORKTREE STATE, SHARED BASE: mutable state is isolated, the base lineage is shared ===" -ForegroundColor Yellow
$main = New-Repo; $lib = Join-Path $main "Lib.lbs"   # same $lib for both worktrees -> one shared state key
Import $main $J $lib @{ "a.json"="a0"; "b.json"="b0" }
$wt = Join-Path ([System.IO.Path]::GetTempPath()) "e2ewt-linked-$(Get-Random)"
git -C $main worktree add -q -b wtbranch $wt HEAD
Check "linked worktree created" (Test-Path (Join-Path $wt $J))
# Mutable state (the export cache / state dir) is now PER-WORKTREE: a marker written in
# main's state dir must NOT appear in the worktree's.
$cacheMain = CacheDir $main $J $lib
New-Item -ItemType Directory -Force -Path $cacheMain | Out-Null
$sentinel = "iso-$(Get-Random).marker"
Set-Content -Path (Join-Path $cacheMain $sentinel) -Value "x" -NoNewline
$cacheWt = CacheDir $wt $J $lib
Check "state dir is per-worktree (main's marker NOT visible from the worktree)" (-not (Test-Path (Join-Path $cacheWt $sentinel)))
Check "state dirs are distinct paths" ($cacheMain -ne $cacheWt)
# The durable base lineage is SHARED: the base ref main recorded at import is visible from
# the worktree, and identical.
$baseMain = BaseRefTarget $main $J $lib
$baseWt   = BaseRefTarget $wt   $J $lib
Check "base ref is shared and visible from the worktree" ($baseWt -ne "" -and $baseWt -eq $baseMain)

Write-Host "`n=== 26. SHARED BASE IN USE: a worktree that never imported reconciles via the shared base ===" -ForegroundColor Yellow
# The worktree's own meta is empty, but the shared base lineage lets its export find the
# true common ancestor against its OWN HEAD - while main's per-worktree meta is untouched.
$metaMainBefore = MetaJson $main $J $lib
$res = Export $wt $J $lib @{ "a.json"="a1"; "b.json"="b0" }
Check "26 worktree export RESULT=clean (reconciled against the shared base)" ($res -eq "RESULT=clean")
Check "26 worktree live source updated (a == a1)" ((Read1 $wt $J "a.json") -eq "a1")
$metaMainAfter = MetaJson $main $J $lib
Check "26 main's per-worktree meta is unchanged by the worktree's export" (($metaMainAfter.baseTree -eq $metaMainBefore.baseTree) -and ($metaMainAfter.sourceTree -eq $metaMainBefore.sourceTree))

Write-Host "`n=== 27. INDEX ISOLATION: a conflict resolved in the worktree never touches main's index ===" -ForegroundColor Yellow
$main2 = New-Repo; $lib2 = Join-Path $main2 "Lib.lbs"
Import $main2 $J $lib2 @{ "a.json"="a0"; "b.json"="b0" }
$wt2 = Join-Path ([System.IO.Path]::GetTempPath()) "e2ewt-linked2-$(Get-Random)"
git -C $main2 worktree add -q -b wtbranch2 $wt2 HEAD
Set-Content -Path (Join-Path $main2 "README.md") "staged in main" -NoNewline
git -C $main2 add README.md
Set-Content -Path (Join-Path $wt2 "$J/b.json") "bC" -NoNewline
git -C $wt2 add -A; git -C $wt2 commit -q -m "worktree colleague edits b"
$res = Export $wt2 $J $lib2 @{ "a.json"="a0"; "b.json"="bD" }
Check "27 worktree export conflicts (b edited both sides)" ($res -eq "RESULT=conflict")
$wtStat = (git -C $wt2 status --porcelain -- "$J/b.json")
Check "27 conflict lives in the worktree index (b.json is UU)" ($wtStat -and $wtStat.Substring(0,2) -eq "UU")
$mainPorcelain = @(git -C $main2 status --porcelain)
Check "27 main's staged README is untouched" ($mainPorcelain -contains "A  README.md")
Check "27 main's index has NO unmerged entries leaked from the worktree" (-not ($mainPorcelain | Where-Object { $_ -match "^(U.|.U|DD|AA)" }))

Write-Host "`n=== 28. NO CROSS-WORKTREE CORRUPTION: a worktree export must not clear main's pending conflict ===" -ForegroundColor Yellow
# Regression for the shared-state bug: main holds an in-progress export conflict; a routine
# export from another worktree (same shared library) must leave main's pending state intact.
$main3 = New-Repo; $lib3 = Join-Path $main3 "Lib.lbs"
Import $main3 $J $lib3 @{ "a.json"="a0"; "b.json"="b0" }
Set-Content -Path (Join-Path $main3 "$J/b.json") "bC" -NoNewline
git -C $main3 add -A; git -C $main3 commit -q -m "colleague edits b"
$res = Export $main3 $J $lib3 @{ "a.json"="a0"; "b.json"="bD" }   # main conflicts on b
Check "28 main is in a pending export-conflict" (($res -eq "RESULT=conflict") -and ((MetaJson $main3 $J $lib3).status -eq "pendingExportConflict") -and (PendingExists $main3 $J $lib3))
$wt3 = Join-Path ([System.IO.Path]::GetTempPath()) "e2ewt-linked3-$(Get-Random)"
git -C $main3 worktree add -q -b wtbranch3 $wt3 HEAD
$resWt = Export $wt3 $J $lib3 @{ "a.json"="aX"; "b.json"="bC" }   # unrelated export from the worktree
Check "28 worktree export completes (RESULT=clean)" ($resWt -eq "RESULT=clean")
Check "28 main's pending conflict SURVIVES (meta.status still pendingExportConflict)" ((MetaJson $main3 $J $lib3).status -eq "pendingExportConflict")
Check "28 main's pending durability refs SURVIVE" (PendingExists $main3 $J $lib3)
Check "28 main's working-tree conflict is still present (b.json UU)" ((Stat $main3 "$J/b.json") -eq "UU")

Write-Host "`n=== RESULT: $pass passed, $fail failed ===" -ForegroundColor Yellow
if ($fail -gt 0) { exit 1 }
