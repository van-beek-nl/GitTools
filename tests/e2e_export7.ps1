Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scripts = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts_proto"
$pass = 0; $fail = 0
function Check($label, $cond) {
    if ($cond) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}
function New-Repo {
    $r = Join-Path ([System.IO.Path]::GetTempPath()) "e2e7-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $r | Out-Null
    git -C $r init -q; git -C $r config user.email t@t.t; git -C $r config user.name t
    Set-Content -Path (Join-Path $r "Lib.lbs") -Value "bin" -NoNewline
    return $r
}
function CacheDir($repo, $json, $lib) {
    $o = pwsh -NoProfile -Command ". '$scripts/common.ps1'; Initialize-GitToolsState -RepoRoot '$repo' -JsonPath '$json' -LibraryId 'LIB' -LibraryPath '$lib'; Write-Output (Get-ExportCacheDir)" 2>$null
    return ($o | Select-Object -Last 1).Trim()
}
function HandoffPath($repo, $json, $lib) {
    $o = pwsh -NoProfile -Command ". '$scripts/common.ps1'; Initialize-GitToolsState -RepoRoot '$repo' -JsonPath '$json' -LibraryId 'LIB' -LibraryPath '$lib'; Write-Output (Get-HandoffPath)" 2>$null
    return ($o | Select-Object -Last 1).Trim()
}
function WriteCache($repo, $json, $lib, $files) {
    $c = CacheDir $repo $json $lib
    if (Test-Path $c) { Get-ChildItem -Force $c | Remove-Item -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $c | Out-Null
    foreach ($k in $files.Keys) {
        $p = Join-Path $c $k; New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null
        Set-Content -Path $p -Value $files[$k] -NoNewline
    }
}
function RunPre($repo, $json, $lib, [switch]$Allow) {
    $a = @("-RepoRoot", $repo, "-JsonPath", $json, "-LibraryId", "LIB", "-LibraryPath", $lib)
    if ($Allow) { $a += "-AllowMissingBase" }
    $out = pwsh -NoProfile -File "$scripts/pre-export.ps1" @a 2>$null
    return ($out | Where-Object { $_ -match "^RESULT=" }) -join ""
}
function RunPost($repo, $json, $lib, [switch]$Allow) {
    $a = @("-RepoRoot", $repo, "-JsonPath", $json, "-LibraryId", "LIB", "-LibraryPath", $lib)
    if ($Allow) { $a += "-AllowMissingBase" }
    $out = pwsh -NoProfile -File "$scripts/post-export.ps1" @a 2>$null
    return ($out | Where-Object { $_ -match "^RESULT=" }) -join ""
}
function Read1($repo, $json, $name) {
    $p = Join-Path (Join-Path $repo $json) $name
    if (-not (Test-Path $p)) { return "<missing>" }
    return (Get-Content -Raw $p)
}
$J = "Source/Lib"

Write-Host "`n=== 19. MISSING BASE: pre-export gate stops, then -AllowMissingBase forces the overwrite ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
$abs = Join-Path $r $J; New-Item -ItemType Directory -Force -Path $abs | Out-Null
Set-Content (Join-Path $abs "a.json") "a0" -NoNewline
git -C $r add -A; git -C $r commit -q -m "committed source, but GitTools never imported/exported -> no base"
WriteCache $r $J $lib @{ "a.json"="a1" }
$res = RunPre $r $J $lib
Check "19 pre-export reports RESULT=missing-base" ($res -eq "RESULT=missing-base")
Check "19 no handoff written (export cannot proceed unacknowledged)" (-not (Test-Path (HandoffPath $r $J $lib)))
Check "19 committed source untouched by the gated run (a == a0)" ((Read1 $r $J "a.json") -eq "a0")
# Confirmed re-run with the acknowledgement.
$res = RunPre $r $J $lib -Allow
Check "19 forced pre-export emits no RESULT (gate bypassed)" ($res -eq "")
Check "19 forced pre-export wrote the handoff" (Test-Path (HandoffPath $r $J $lib))
$res = RunPost $r $J $lib -Allow
Check "19 forced post-export RESULT=clean" ($res -eq "RESULT=clean")
Check "19 overwrite applied (a == a1)" ((Read1 $r $J "a.json") -eq "a1")

Write-Host "`n=== 20. MISSING BASE: post-export backstop refuses to overwrite without acknowledgement ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
$abs = Join-Path $r $J; New-Item -ItemType Directory -Force -Path $abs | Out-Null
Set-Content (Join-Path $abs "a.json") "a0" -NoNewline
git -C $r add -A; git -C $r commit -q -m "committed source, no base"
WriteCache $r $J $lib @{ "a.json"="a1" }
# Simulate Omnis bypassing the pre-export signal: force pre (writes handoff), then run
# post WITHOUT the flag. The backstop must refuse rather than silently overwrite.
RunPre $r $J $lib -Allow | Out-Null
$res = RunPost $r $J $lib
Check "20 post-export backstop reports RESULT=missing-base" ($res -eq "RESULT=missing-base")
Check "20 committed source NOT overwritten (a == a0)" ((Read1 $r $J "a.json") -eq "a0")
Check "20 handoff cleared after backstop (clean retry)" (-not (Test-Path (HandoffPath $r $J $lib)))

Write-Host "`n=== 21. NO false gate: a genuine first export (path untracked in HEAD) proceeds silently ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Set-Content (Join-Path $r "README.md") "hello" -NoNewline
git -C $r add README.md; git -C $r commit -q -m "unrelated commit; JSON path NOT in HEAD"
WriteCache $r $J $lib @{ "a.json"="a0" }
$res = RunPre $r $J $lib
Check "21 pre-export does NOT gate (no committed source to lose)" ($res -eq "")
$res = RunPost $r $J $lib
Check "21 first export proceeds RESULT=clean" ($res -eq "RESULT=clean")
Check "21 export applied (a == a0)" ((Read1 $r $J "a.json") -eq "a0")

Write-Host "`n=== RESULT: $pass passed, $fail failed ===" -ForegroundColor Yellow
if ($fail -gt 0) { exit 1 }
