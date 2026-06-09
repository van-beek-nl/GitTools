Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scripts = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts"
. "$scripts/common.ps1"
Start-Timing
$pass = 0; $fail = 0
function Check($label, $cond) {
    if ($cond) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}
function New-Repo {
    $r = Join-Path ([System.IO.Path]::GetTempPath()) "e2efi-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $r | Out-Null
    git -C $r init -q; git -C $r config user.email t@t.t; git -C $r config user.name t
    Set-Content -Path (Join-Path $r "Lib.lbs") -Value "bin" -NoNewline
    return $r
}
function CacheDir($repo, $json, $lib) {
    $o = pwsh -NoProfile -Command ". '$scripts/common.ps1'; Initialize-GitToolsState -RepoRoot '$repo' -JsonPath '$json' -LibraryId 'LIB' -LibraryPath '$lib'; Write-Output (Get-ExportCacheDir)" 2>$null
    return ($o | Select-Object -Last 1).Trim()
}
function Export($repo, $json, $lib, $files, [ref]$PreErr) {
    $c = CacheDir $repo $json $lib
    if (Test-Path $c) { Get-ChildItem -Force $c | Remove-Item -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $c | Out-Null
    foreach ($k in $files.Keys) {
        $p = Join-Path $c $k; New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null
        Set-Content -Path $p -Value $files[$k] -NoNewline
    }
    $errFile = [System.IO.Path]::GetTempFileName()
    pwsh -NoProfile -File "$scripts/pre-export.ps1" -RepoRoot $repo -JsonPath $json -LibraryId LIB -LibraryPath $lib 2> $errFile | Out-Null
    if ($PreErr) { $PreErr.Value = Get-Content -Raw $errFile }
    Remove-Item $errFile -Force -ErrorAction SilentlyContinue
    $out = pwsh -NoProfile -File "$scripts/post-export.ps1" -RepoRoot $repo -JsonPath $json -LibraryId LIB -LibraryPath $lib 2>$null
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
$J = "Source/Lib"

Write-Host "`n=== 22. CRASHED PRE-EXPORT: a leftover handoff is swept and the next export still succeeds ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Import $r $J $lib @{ "a.json"="a0"; "b.json"="b0" }
# Simulate a pre-export that wrote its handoff and then died before post-export: plant a
# stale handoff with bogus trees directly in the state dir.
pwsh -NoProfile -Command ". '$scripts/common.ps1'; Start-Timing; Initialize-GitToolsState -RepoRoot '$r' -JsonPath '$J' -LibraryId LIB -LibraryPath '$lib'; Write-Handoff ([pscustomobject]@{ op='export'; currentSourceTree='deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'; mergeBase='deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })" 2>$null | Out-Null
$preErr = ""
$res = Export $r $J $lib @{ "a.json"="a1"; "b.json"="b1" } ([ref]$preErr)
Check "22 stale handoff was swept (logged)" ($preErr -match "Clearing an incomplete previous export")
Check "22 export still succeeds (RESULT=clean)" ($res -eq "RESULT=clean")
Check "22 result correct despite the bogus handoff (a==a1, b==b1)" ((Read1 $r $J "a.json") -eq "a1" -and (Read1 $r $J "b.json") -eq "b1")

Write-Host "`n=== 23. CRASHED POST-EXPORT: incremental build self-heals from a stale-but-valid cache index ===" -ForegroundColor Yellow
# A crash can leave the persistent cache index describing an OLDER directory state than
# what is now on disk. The next New-IncrementalExportTree must still produce the exact
# tree a full rebuild would, by diffing the stale index against the current files.
$r2 = New-Repo
Initialize-GitToolsState -RepoRoot $r2 -JsonPath $J -LibraryId LIB -LibraryPath (Join-Path $r2 "Lib.lbs")
$cache = Join-Path ([System.IO.Path]::GetTempPath()) "fi-cache-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $cache | Out-Null
Set-Content (Join-Path $cache "a.json") "v1" -NoNewline
Set-Content (Join-Path $cache "b.json") "v2" -NoNewline
Set-Content (Join-Path $cache "c.json") "v3" -NoNewline
$idx = New-TempIndexPath
Invoke-Git @("read-tree", "--empty") -IndexFile $idx | Out-Null
New-IncrementalExportTree -IndexFile $idx -WorkTree $cache | Out-Null   # index now in step with the dir
# "Crash" mutates the directory; the index is NOT updated (it reflects the prior state).
Set-Content (Join-Path $cache "a.json") "v1-changed" -NoNewline   # modify
Remove-Item (Join-Path $cache "b.json")                            # delete
Set-Content (Join-Path $cache "d.json") "v4" -NoNewline           # add
$incremental = New-IncrementalExportTree -IndexFile $idx -WorkTree $cache
# Ground truth: a full rebuild over the current directory (incremental from an empty index).
$idxFull = New-TempIndexPath
Invoke-Git @("read-tree", "--empty") -IndexFile $idxFull | Out-Null
$fullRebuild = New-IncrementalExportTree -IndexFile $idxFull -WorkTree $cache
Remove-Item $idx, $idxFull -Force -ErrorAction SilentlyContinue
Check "23 incremental tree from a stale index equals a full rebuild" ($incremental -eq $fullRebuild)

Write-Host "`n=== 24. INTERRUPTED ATOMIC WRITE: stray .tmp residue does not corrupt state ===" -ForegroundColor Yellow
# meta.json and the handoff are written to a sibling .tmp then atomically renamed, so an
# interrupted write leaves a stray .tmp but never a half-written target. Plant garbage
# .tmp files and confirm the next export reads the real files and completes correctly.
$r3 = New-Repo; $lib3 = Join-Path $r3 "Lib.lbs"
Import $r3 $J $lib3 @{ "a.json"="a0" }
$state = pwsh -NoProfile -Command ". '$scripts/common.ps1'; Initialize-GitToolsState -RepoRoot '$r3' -JsonPath '$J' -LibraryId LIB -LibraryPath '$lib3'; Write-Output `$script:StateRoot" 2>$null | Select-Object -Last 1
Set-Content -Path (Join-Path $state "meta.json.tmp") -Value "{ this is not valid json" -NoNewline
Set-Content -Path (Join-Path $state "pending-op.json.tmp") -Value "garbage" -NoNewline
$res = Export $r3 $J $lib3 @{ "a.json"="a1" } ([ref]$null)
Check "24 export completes despite stray .tmp files (RESULT=clean)" ($res -eq "RESULT=clean")
Check "24 result correct (a == a1)" ((Read1 $r3 $J "a.json") -eq "a1")
$metaText = Get-Content -Raw (Join-Path $state "meta.json")
$metaOk = $false; try { $metaText | ConvertFrom-Json | Out-Null; $metaOk = $true } catch { $metaOk = $false }
Check "24 meta.json is valid (never half-written)" $metaOk

Write-Host "`n=== RESULT: $pass passed, $fail failed ===" -ForegroundColor Yellow
if ($fail -gt 0) { exit 1 }
