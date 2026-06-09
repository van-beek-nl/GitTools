Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scripts = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts_proto"
$pass = 0; $fail = 0
function Check($label, $cond) {
    if ($cond) { Write-Host "  PASS  $label" -ForegroundColor Green; $script:pass++ }
    else       { Write-Host "  FAIL  $label" -ForegroundColor Red;   $script:fail++ }
}
function New-Repo {
    $r = Join-Path ([System.IO.Path]::GetTempPath()) "e2e3-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $r | Out-Null
    git -C $r init -q; git -C $r config user.email t@t.t; git -C $r config user.name t
    Set-Content -Path (Join-Path $r "Lib.lbs") -Value "bin" -NoNewline
    return $r
}
function CacheDir($repo, $json, $lib) {
    $o = pwsh -NoProfile -Command ". '$scripts/common.ps1'; Initialize-GitToolsState -RepoRoot '$repo' -JsonPath '$json' -LibraryId 'LIB' -LibraryPath '$lib'; Write-Output (Get-ExportCacheDir)" 2>$null
    return ($o | Select-Object -Last 1).Trim()
}
function Export($repo, $json, $lib, $files) {
    $c = CacheDir $repo $json $lib
    if (Test-Path $c) { Get-ChildItem -Force $c | Remove-Item -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $c | Out-Null
    foreach ($k in $files.Keys) {
        $p = Join-Path $c $k; New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null
        Set-Content -Path $p -Value $files[$k] -NoNewline
    }
    pwsh -NoProfile -File "$scripts/pre-export.ps1" -RepoRoot $repo -JsonPath $json -LibraryId LIB -LibraryPath $lib 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "pre-export failed" }
    $out = pwsh -NoProfile -File "$scripts/post-export.ps1" -RepoRoot $repo -JsonPath $json -LibraryId LIB -LibraryPath $lib 2>$null
    if ($LASTEXITCODE -ne 0) { throw "post-export failed" }
    return ($out | Where-Object { $_ -match "^RESULT=" }) -join ""
}
function Stat($repo, $path) {  # porcelain XY for a single path
    $s = git -C $repo status --porcelain -- $path
    if ([string]::IsNullOrEmpty($s)) { return "  " } else { return $s.Substring(0,2) }
}
$J = "Source/Lib"

Write-Host "`n=== 9. ISSUE 3: re-export preserves an UNCHANGED staged file ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Export $r $J $lib @{ "a.json"="a0"; "b.json"="b0" } | Out-Null
git -C $r add -A; git -C $r commit -q -m init
Export $r $J $lib @{ "a.json"="a1"; "b.json"="b1" } | Out-Null   # uncommitted export
git -C $r add -- "$J/b.json"                                     # user stages b (b1)
Export $r $J $lib @{ "a.json"="a2"; "b.json"="b1" } | Out-Null   # re-export: a changes, b unchanged
$sb = Stat $r "$J/b.json"; $sa = Stat $r "$J/a.json"
Check "b.json still STAGED (M in index col)" ($sb[0] -eq 'M')
Check "b.json content still b1" ((Get-Content -Raw (Join-Path $r "$J/b.json")) -eq "b1")
Check "a.json UNSTAGED modified" ($sa[0] -eq ' ' -and $sa[1] -eq 'M')
Check "a.json content a2" ((Get-Content -Raw (Join-Path $r "$J/a.json")) -eq "a2")

Write-Host "`n=== 10. ISSUE 2: conflict leaves clean (non-conflicting) change UNSTAGED ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
Export $r $J $lib @{ "a.json"="a0" } | Out-Null
git -C $r add -A; git -C $r commit -q -m import
Set-Content -Path (Join-Path $r "$J/a.json") -Value "aC" -NoNewline   # colleague modifies a
git -C $r add -A; git -C $r commit -q -m "colleague a"
$res = Export $r $J $lib @{ "a.json"="aM"; "n.json"="n1" }             # I modify a differently + add n
Check "RESULT=conflict" ($res -eq "RESULT=conflict")
$sa = Stat $r "$J/a.json"; $sn = Stat $r "$J/n.json"
Check "a.json is UU (unmerged conflict)" ($sa -eq 'UU')
Check "new n.json is UNSTAGED (untracked '??', not staged 'A')" ($sn -eq '??')
Check "n.json content present" ((Get-Content -Raw (Join-Path $r "$J/n.json")) -eq "n1")

Write-Host "`n=== 11. ISSUE 1: conflict apply does NOT rewrite unchanged files ===" -ForegroundColor Yellow
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
$big = @{ "a.json"="a0" }; 1..40 | ForEach-Object { $big["x/$_.json"] = "const$_" }
Export $r $J $lib $big | Out-Null
git -C $r add -A; git -C $r commit -q -m import
Set-Content -Path (Join-Path $r "$J/a.json") -Value "aC" -NoNewline
git -C $r add -A; git -C $r commit -q -m "colleague a"
$xfile = Join-Path $r "$J/x/7.json"
$before = (Get-Item $xfile).LastWriteTimeUtc.Ticks
Start-Sleep -Milliseconds 50
$big2 = @{ "a.json"="aM" }; 1..40 | ForEach-Object { $big2["x/$_.json"] = "const$_" }
$res = Export $r $J $lib $big2     # conflict on a; all x unchanged
$after = (Get-Item $xfile).LastWriteTimeUtc.Ticks
Check "RESULT=conflict" ($res -eq "RESULT=conflict")
Check "unchanged x/7.json NOT rewritten (mtime preserved)" ($before -eq $after)
Check "x/7.json content intact" ((Get-Content -Raw $xfile) -eq "const7")

Write-Host "`n=== 11b. MULTI-FILE CONFLICT: every conflicted path marked UU (batched force-remove) ===" -ForegroundColor Yellow
# Exercises Apply-ConflictedMergeToLiveJsonPath with MANY conflicted paths at once:
# the stage-0 entries are force-removed in a single batched git call before the
# unmerged stage 1/2/3 records are added. If that batch ever dropped a path, the
# follow-up --index-info could not add unmerged stages over its surviving stage-0
# entry, so that file would not show as UU.
$r = New-Repo; $lib = Join-Path $r "Lib.lbs"
$base = @{}; 1..12 | ForEach-Object { $base["f$_.json"] = "v0-$_" }
Export $r $J $lib $base | Out-Null
git -C $r add -A; git -C $r commit -q -m import
1..12 | ForEach-Object { Set-Content -Path (Join-Path $r "$J/f$_.json") -Value "colleague-$_" -NoNewline }
git -C $r add -A; git -C $r commit -q -m "colleague edits all"
$mine = @{}; 1..12 | ForEach-Object { $mine["f$_.json"] = "mine-$_" }
$res = Export $r $J $lib $mine                       # modify/modify on all 12 files
Check "RESULT=conflict" ($res -eq "RESULT=conflict")
$uu = @(1..12 | Where-Object { (Stat $r "$J/f$_.json") -eq 'UU' }).Count
Check "all 12 files marked UU" ($uu -eq 12)

Write-Host "`n=== RESULT: $pass passed, $fail failed ===" -ForegroundColor Yellow
if ($fail -gt 0) { exit 1 }
