Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scripts = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts"

$pass = 0; $fail = 0
function Check($label, $cond) {
    if ($cond) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}

function New-Repo {
    $r = Join-Path ([System.IO.Path]::GetTempPath()) "e2e-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $r | Out-Null
    git -C $r init -q
    git -C $r config user.email t@t.t; git -C $r config user.name t
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
function OmnisExport($repo, $json, $lib, $files) {
    $c = CacheDir $repo $json $lib
    if (Test-Path $c) { Get-ChildItem -Force $c | Remove-Item -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $c | Out-Null
    foreach ($k in $files.Keys) {
        $p = Join-Path $c $k; New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null
        Set-Content -Path $p -Value $files[$k] -NoNewline
    }
}
function Export($repo, $json, $lib, $files) {
    OmnisExport $repo $json $lib $files
    Run "pre-export.ps1" $repo $json $lib | Out-Null
    return Run "post-export.ps1" $repo $json $lib
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
function HasConflict($repo, $json) {
    $u = git -C $repo diff --name-only --diff-filter=U -- $json
    return -not [string]::IsNullOrWhiteSpace($u)
}

$J = "Source/Lib"

Write-Host "`n=== 1. ORIGINAL BUG: full discard of a deletion ===" -ForegroundColor Yellow
$r = New-Repo
Export $r $J (Join-Path $r "Lib.lbs") @{ "a.json"="A"; "sub/b.json"="B" } | Out-Null
git -C $r add -A; git -C $r commit -q -m init
Export $r $J (Join-Path $r "Lib.lbs") @{ "a.json"="A" } | Out-Null    # delete b
git -C $r checkout -q -- $J; git -C $r clean -fdq -- $J               # discard back to HEAD (a+b)
$res = Export $r $J (Join-Path $r "Lib.lbs") @{ "a.json"="A" }        # library still lacks b
$f = SrcFiles $r $J
Check "RESULT=clean" ($res -eq "RESULT=clean")
Check "b.json dropped (deletion reproduced)" (-not $f.ContainsKey("sub/b.json"))
Check "a.json present" ($f.ContainsKey("a.json"))

Write-Host "`n=== 2. PARTIAL DISCARD: commit a1, discard b WIP, re-export ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Export $r $J $lib @{ "a.json"="a0"; "b.json"="b0" } | Out-Null
git -C $r add -A; git -C $r commit -q -m init
Export $r $J $lib @{ "a.json"="a1"; "b.json"="b1" } | Out-Null        # a1 ready, b1 WIP
git -C $r add -- "$J/a.json"; git -C $r commit -q -m "a1 only"        # commit a1 only
git -C $r checkout -q -- "$J/b.json"                                  # discard b -> b0
$res = Export $r $J $lib @{ "a.json"="a1"; "b.json"="b1" }            # library still a1,b1
$f = SrcFiles $r $J
Check "RESULT=clean" ($res -eq "RESULT=clean")
Check "a.json == a1" ($f["a.json"] -eq "a1")
Check "b.json == b1 (WIP resurfaces)" ($f["b.json"] -eq "b1")

Write-Host "`n=== 3. DELETE/MODIFY CONFLICT: I delete b, colleague modified b ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Export $r $J $lib @{ "a.json"="a0"; "b.json"="b0" } | Out-Null
git -C $r add -A; git -C $r commit -q -m import
# colleague modifies b and commits (simulate by editing the committed source directly)
Set-Content -Path (Join-Path $r "$J/b.json") -Value "bMOD" -NoNewline
git -C $r add -A; git -C $r commit -q -m "colleague mod b"
$res = Export $r $J $lib @{ "a.json"="a0" }                          # my library deleted b
Check "RESULT=conflict" ($res -eq "RESULT=conflict")
Check "live path has unresolved conflict" (HasConflict $r $J)

Write-Host "`n=== 4. COLLEAGUE ADDED a class my library lacks ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Export $r $J $lib @{ "a.json"="a0"; "b.json"="b0" } | Out-Null
git -C $r add -A; git -C $r commit -q -m import
Set-Content -Path (Join-Path $r "$J/c.json") -Value "c1" -NoNewline   # colleague adds c
git -C $r add -A; git -C $r commit -q -m "colleague add c"
$res = Export $r $J $lib @{ "a.json"="a0"; "b.json"="b0" }            # library lacks c
$f = SrcFiles $r $J
Check "RESULT=clean" ($res -eq "RESULT=clean")
Check "c.json preserved" ($f.ContainsKey("c.json") -and $f["c.json"] -eq "c1")
Check "a,b present" ($f.ContainsKey("a.json") -and $f.ContainsKey("b.json"))

Write-Host "`n=== 5. CONTINUATION: iterative export before commit (no false conflict) ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Export $r $J $lib @{ "a.json"="a0" } | Out-Null
git -C $r add -A; git -C $r commit -q -m init
Export $r $J $lib @{ "a.json"="a1" } | Out-Null                       # export 1 (uncommitted)
$res = Export $r $J $lib @{ "a.json"="a2" }                           # export 2 (uncommitted)
$f = SrcFiles $r $J
Check "RESULT=clean (no false conflict)" ($res -eq "RESULT=clean")
Check "a.json == a2" ($f["a.json"] -eq "a2")

Write-Host "`n=== RESULT: $pass passed, $fail failed ===" -ForegroundColor Yellow
if ($fail -gt 0) { exit 1 }
