Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scripts = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts_proto"
$pass = 0; $fail = 0
function Check($label, $cond) {
    if ($cond) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}
function New-Repo {
    $r = Join-Path ([System.IO.Path]::GetTempPath()) "e2e5-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $r | Out-Null
    git -C $r init -q; git -C $r config user.email t@t.t; git -C $r config user.name t
    Set-Content -Path (Join-Path $r "Lib.lbs") -Value "bin" -NoNewline
    return $r
}
function CacheDir($repo, $json, $lib) {
    $o = pwsh -NoProfile -Command ". '$scripts/common.ps1'; Initialize-GitToolsState -RepoRoot '$repo' -JsonPath '$json' -LibraryId 'LIB' -LibraryPath '$lib'; Write-Output (Get-ExportCacheDir)" 2>$null
    return ($o | Select-Object -Last 1).Trim()
}
# Simulate Omnis exporting the library: overwrite the export cache with a complete snapshot.
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
    if ($LASTEXITCODE -ne 0) { throw "post-import failed" }
}
function ColleagueCommit($repo, $json, $files, $msg) {
    $abs = Join-Path $repo $json
    foreach ($k in $files.Keys) { Set-Content -Path (Join-Path $abs $k) -Value $files[$k] -NoNewline }
    git -C $repo add -A; git -C $repo commit -q -m $msg
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

# Both scenarios build the SAME tricky precondition: a clean MERGE export leaves
# GitTools' own merged output UNCOMMITTED, then a second export conflicts against
# that uncommitted output (the continuation path). At that point meta.pending.sourceTree
# is the uncommitted merged tree - NOT anything reachable by restoring to HEAD - so the
# discard-vs-accept decision cannot be made by tree equality against HEAD alone.

Write-Host "`n=== 14. CONTINUATION DISCARD: discarding to HEAD must re-surface the conflict, never silently drop library work ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Import $r $J $lib @{ "a.json"="a0"; "b.json"="b0" }                 # base = {a0,b0}
ColleagueCommit $r $J @{ "a.json"="a0"; "b.json"="bC" } "colleague edits b"   # HEAD = {a0,bC}
$res = Export $r $J $lib @{ "a.json"="aX"; "b.json"="b0" }          # clean merge -> live {aX,bC}, UNCOMMITTED
Check "14.3 clean merge" ($res -eq "RESULT=clean")
$res = Export $r $J $lib @{ "a.json"="aX"; "b.json"="bY" }          # continuation conflict (bC vs bY)
Check "14.4 continuation conflict" ($res -eq "RESULT=conflict")
# Discard the documented way: restore the JSON path to HEAD ({a0,bC}); the uncommitted
# merged output is gone, so this is a genuine discard that lands off the continuation lineage.
git -C $r restore --source=HEAD --staged --worktree -- $J 2>$null
git -C $r clean -fdq -- $J 2>$null
Check "14.5 discard restored a to a0" ((Read1 $r $J "a.json") -eq "a0")
# Re-export the SAME library {aX,bY}. Developer genuinely changed a (a0->aX) and b; colleague
# changed b (b0->bC). Correct three-way (true base {a0,b0}) keeps a=aX and conflicts on b.
$res = Export $r $J $lib @{ "a.json"="aX"; "b.json"="bY" }
Check "14.6 RESULT=conflict (re-surfaced, not swallowed)" ($res -eq "RESULT=conflict")
Check "14.6 developer's library change to a SURVIVES (a == aX)" ((Read1 $r $J "a.json") -eq "aX")
Check "14.6 b is UU (the real modify/modify conflict is shown)" ((Stat $r "$J/b.json") -eq 'UU')

Write-Host "`n=== 15. CONTINUATION ACCEPT: resolving+committing a continuation conflict advances the base (no spurious re-conflict) ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Import $r $J $lib @{ "a.json"="a0"; "b.json"="b0" }
ColleagueCommit $r $J @{ "a.json"="a0"; "b.json"="bC" } "colleague edits b"
Export $r $J $lib @{ "a.json"="aX"; "b.json"="b0" } | Out-Null      # clean merge -> live {aX,bC}, UNCOMMITTED
$res = Export $r $J $lib @{ "a.json"="aX"; "b.json"="bY" }          # continuation conflict
Check "15.4 continuation conflict" ($res -eq "RESULT=conflict")
# Genuinely resolve by accepting the export side, then COMMIT it.
Set-Content -Path (Join-Path $r "$J/a.json") -Value "aX" -NoNewline
Set-Content -Path (Join-Path $r "$J/b.json") -Value "bY" -NoNewline
git -C $r add -A; git -C $r commit -q -m "resolve: accept export"
# Re-export the same library: the export is now absorbed, so this must be clean (the base
# advanced to the export tree) - NOT a spurious re-conflict.
$res = Export $r $J $lib @{ "a.json"="aX"; "b.json"="bY" }
Check "15.6 RESULT=clean (accepted export does not re-conflict)" ($res -eq "RESULT=clean")
Check "15.6 a == aX" ((Read1 $r $J "a.json") -eq "aX")
Check "15.6 b == bY" ((Read1 $r $J "b.json") -eq "bY")

Write-Host "`n=== RESULT: $pass passed, $fail failed ===" -ForegroundColor Yellow
if ($fail -gt 0) { exit 1 }
