Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scripts = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts"
$pass = 0; $fail = 0
function Check($label, $cond) {
    if ($cond) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}
function New-Repo {
    $r = Join-Path ([System.IO.Path]::GetTempPath()) "e2e2-$(Get-Random)"
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
function Meta($repo, $json, $lib) {
    $out = pwsh -NoProfile -Command ". '$scripts/common.ps1'; Initialize-GitToolsState -RepoRoot '$repo' -JsonPath '$json' -LibraryId 'LIB' -LibraryPath '$lib'; (Read-GitToolsMeta | ConvertTo-Json -Compress)" 2>$null
    return ($out | Select-Object -Last 1) | ConvertFrom-Json
}
$J = "Source/Lib"

Write-Host "`n=== 6. IMPORT then matching export stays clean ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
New-Item -ItemType Directory -Force -Path (Join-Path $r $J) | Out-Null
Set-Content -Path (Join-Path $r "$J/a.json") -Value "a0" -NoNewline
git -C $r add -A; git -C $r commit -q -m "source committed"
$out = pwsh -NoProfile -File "$scripts/post-import.ps1" -RepoRoot $r -JsonPath $J -LibraryId LIB -LibraryPath $lib 2>$null
$res = ($out | Where-Object { $_ -match "^RESULT=" }) -join ""
Check "post-import RESULT=clean" ($res -eq "RESULT=clean")
$m = Meta $r $J $lib
Check "meta.baseTree == sourceTree after import" ($m.baseTree -eq $m.sourceTree -and $m.baseTree)
$res = Export $r $J $lib @{ "a.json"="a0" }   # library matches imported source
Check "export of identical content = clean" ($res -eq "RESULT=clean")

Write-Host "`n=== 7. CONFLICT then RESOLVE -> next export clean, base advanced ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Export $r $J $lib @{ "a.json"="a0"; "b.json"="b0" } | Out-Null
git -C $r add -A; git -C $r commit -q -m import
Set-Content -Path (Join-Path $r "$J/b.json") -Value "bMOD" -NoNewline
git -C $r add -A; git -C $r commit -q -m "colleague mod b"
$res = Export $r $J $lib @{ "a.json"="a0" }    # I deleted b -> delete/modify conflict
Check "got conflict" ($res -eq "RESULT=conflict")
# resolve: accept the deletion and COMMIT it (uncommitted edits are disposable)
git -C $r rm -q (Join-Path $r "$J/b.json") 2>$null
git -C $r add -A; git -C $r commit -q -m "resolve: accept deletion"
$res = Export $r $J $lib @{ "a.json"="a0" }    # re-export with deletion
Check "after resolve, export clean" ($res -eq "RESULT=clean")
$m = Meta $r $J $lib
Check "status clean, no pending" ($m.status -eq "clean" -and -not $m.pending)

Write-Host "`n=== 8. CONFLICT then DISCARD -> next export reproduces conflict ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Export $r $J $lib @{ "a.json"="a0"; "b.json"="b0" } | Out-Null
git -C $r add -A; git -C $r commit -q -m import
Set-Content -Path (Join-Path $r "$J/b.json") -Value "bMOD" -NoNewline
git -C $r add -A; git -C $r commit -q -m "colleague mod b"
$res = Export $r $J $lib @{ "a.json"="a0" }
Check "got conflict" ($res -eq "RESULT=conflict")
# discard: restore the JSON path back to HEAD (handles unmerged index entries)
git -C $r restore --source=HEAD --staged --worktree -- $J; git -C $r clean -fdq -- $J
$res = Export $r $J $lib @{ "a.json"="a0" }    # same library, same situation
Check "after discard, conflict reproduced" ($res -eq "RESULT=conflict")

Write-Host "`n=== RESULT: $pass passed, $fail failed ===" -ForegroundColor Yellow
if ($fail -gt 0) { exit 1 }
