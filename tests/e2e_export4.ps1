Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scripts = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts_proto"
$pass = 0; $fail = 0
function Check($label, $cond) {
    if ($cond) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}
function New-Repo {
    $r = Join-Path ([System.IO.Path]::GetTempPath()) "e2e4-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $r | Out-Null
    git -C $r init -q; git -C $r config user.email t@t.t; git -C $r config user.name t
    Set-Content -Path (Join-Path $r "Lib.lbs") -Value "bin" -NoNewline
    return $r
}
function CacheDir($repo, $json, $lib) {
    $out = pwsh -NoProfile -Command ". '$scripts/common.ps1'; Initialize-GitToolsState -RepoRoot '$repo' -JsonPath '$json' -LibraryId 'LIB' -LibraryPath '$lib'; Write-Output (Get-ExportCacheDir)" 2>$null
    return ($out | Select-Object -Last 1).Trim()
}
function Run($script, $repo, $json, $lib) {
    $out = pwsh -NoProfile -File "$scripts/$script" -RepoRoot $repo -JsonPath $json -LibraryId "LIB" -LibraryPath $lib 2>$null
    if ($LASTEXITCODE -ne 0) { throw "$script exited $LASTEXITCODE" }
    return ($out | Where-Object { $_ -match "^RESULT=" }) -join ""
}
# Simulate Omnis: overwrite the export cache with a complete library snapshot.
function Export($repo, $json, $lib, $files) {
    $c = CacheDir $repo $json $lib
    if (Test-Path $c) { Get-ChildItem -Force $c | Remove-Item -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $c | Out-Null
    foreach ($k in $files.Keys) {
        $p = Join-Path $c $k; New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null
        Set-Content -Path $p -Value $files[$k] -NoNewline
    }
    Run "pre-export.ps1" $repo $json $lib | Out-Null
    return Run "post-export.ps1" $repo $json $lib
}
# Simulate a colleague committing a new state of the source directly (a pull).
function Commit($repo, $json, $files, $msg) {
    $abs = Join-Path $repo $json
    if (Test-Path $abs) { Get-ChildItem -Force $abs | Remove-Item -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $abs | Out-Null
    foreach ($k in $files.Keys) {
        $p = Join-Path $abs $k; New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null
        Set-Content -Path $p -Value $files[$k] -NoNewline
    }
    git -C $repo add -A; git -C $repo commit -q -m $msg
}
function Import($repo, $json, $lib, $files) {
    Commit $repo $json $files "import source"
    $out = pwsh -NoProfile -File "$scripts/post-import.ps1" -RepoRoot $repo -JsonPath $json -LibraryId "LIB" -LibraryPath $lib 2>$null
    if ($LASTEXITCODE -ne 0) { throw "post-import exited $LASTEXITCODE" }
}
function SrcFiles($repo, $json) {
    $abs = Join-Path $repo $json
    if (-not (Test-Path $abs)) { return @{} }
    $h = @{}
    Get-ChildItem -Recurse -File $abs | ForEach-Object {
        $rel = $_.FullName.Substring($abs.Length+1).Replace([IO.Path]::DirectorySeparatorChar,'/')
        $h[$rel] = (Get-Content -Raw $_.FullName)
    }
    return $h
}
$J = "Source/Lib"

# These two scenarios both drive the FALLBACK merge-base path (the live source is no
# longer GitTools' last output, so the base is recomputed from HEAD's history by
# Resolve-FallbackMergeBase -> Get-HeadJsonTreeHistory) with the true common ancestor
# sitting SEVERAL commits back. They are the regression guard for the batched subtree
# resolution: if that function ever truncates, misorders, or drops the oldest entry of
# the history, the correct deep ancestor is not found and the base collapses to "<none>",
# which turns the three-way merge below into a blind overwrite - flipping both outcomes.

Write-Host "`n=== 12. DEEP FALLBACK: real conflict found against an ancestor 4 commits back ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Import $r $J $lib @{ "a.json"="a0"; "b.json"="b0" }            # recorded base = {a0,b0}
# Colleague advances 'a' over several commits (deep history), 'b' untouched.
Commit $r $J @{ "a.json"="a1"; "b.json"="b0" } "c1"
Commit $r $J @{ "a.json"="a2"; "b.json"="b0" } "c2"
Commit $r $J @{ "a.json"="a3"; "b.json"="b0" } "c3"
Commit $r $J @{ "a.json"="a4"; "b.json"="b0" } "c4"           # HEAD = {a4,b0}; ancestor {a0,b0} is 4 back
$res = Export $r $J $lib @{ "a.json"="aMINE"; "b.json"="b0" } # my library changed 'a' differently
Check "RESULT=conflict (right deep base -> 3-way merge sees both edits to a)" ($res -eq "RESULT=conflict")

Write-Host "`n=== 13. DEEP FALLBACK: clean 3-way merge preserves a colleague change 3 commits back ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Import $r $J $lib @{ "a.json"="a0"; "b.json"="b0" }            # recorded base = {a0,b0}
# Colleague advances 'b' over several commits; 'a' untouched.
Commit $r $J @{ "a.json"="a0"; "b.json"="b1" } "c1"
Commit $r $J @{ "a.json"="a0"; "b.json"="b2" } "c2"
Commit $r $J @{ "a.json"="a0"; "b.json"="b3" } "c3"          # HEAD = {a0,b3}; ancestor {a0,b0} is 3 back
$res = Export $r $J $lib @{ "a.json"="aMINE"; "b.json"="b0" } # my library changed only 'a'
$f = SrcFiles $r $J
Check "RESULT=clean (disjoint edits merge cleanly)" ($res -eq "RESULT=clean")
Check "my change applied (a.json == aMINE)" ($f["a.json"] -eq "aMINE")
Check "colleague's deep change preserved (b.json == b3, not overwritten to b0)" ($f["b.json"] -eq "b3")

Write-Host "`n=== RESULT: $pass passed, $fail failed ===" -ForegroundColor Yellow
if ($fail -gt 0) { exit 1 }
