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
$J = "Source/Lib"

# Resolve-FallbackMergeBase must never report "no base" (which the caller turns into a
# blind overwrite of committed work) just because the recorded base sits beyond the fast
# window. These suites drive a deliberately TINY fast cap so the base is provably outside
# it, then assert the deep full-history escalation still finds it. (End-to-end this only
# bites past 1000 path-commits; a small cap exercises the same code path in milliseconds.)

Write-Host "`n=== 16. DEEP ESCALATION: a recorded base beyond the fast window is still found ===" -ForegroundColor Yellow
$r = Join-Path ([System.IO.Path]::GetTempPath()) "e2e6-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $r | Out-Null
git -C $r init -q; git -C $r config user.email t@t.t; git -C $r config user.name t
Set-Content -Path (Join-Path $r "Lib.lbs") -Value "bin" -NoNewline
$lib = Join-Path $r "Lib.lbs"
$abs = Join-Path $r $J; New-Item -ItemType Directory -Force -Path $abs | Out-Null

Initialize-GitToolsState -RepoRoot $r -JsonPath $J -LibraryId LIB -LibraryPath $lib
Set-Content (Join-Path $abs "a.json") "a0" -NoNewline
git -C $r add -A; git -C $r commit -q -m import
& "$scripts/post-import.ps1" -RepoRoot $r -JsonPath $J -LibraryId LIB -LibraryPath $lib 2>$null | Out-Null

# Colleague advances 'a' over 5 commits, so the recorded import base is now 5 path-commits back.
1..5 | ForEach-Object {
    Set-Content (Join-Path $abs "a.json") "a$_" -NoNewline
    git -C $r add -A; git -C $r commit -q -m "colleague $_"
}

Initialize-GitToolsState -RepoRoot $r -JsonPath $J -LibraryId LIB -LibraryPath $lib
$meta = Read-GitToolsMeta
$recordedBase = $meta.baseTree   # the import base {a0}, 5 commits back

Check "precondition: a base was recorded" ($recordedBase -ne "")
# The base genuinely sits OUTSIDE a fast window of 2 commits.
$fastWindow = Get-HeadJsonTreeHistory -MaxCommits 2
Check "base is outside the 2-commit fast window" (-not ($fastWindow -contains $recordedBase))

# Full resolver with a tiny fast cap: the fast pass misses, but the deep escalation finds it.
Check "tiny-cap resolve still finds the base (not '')" ((Resolve-FallbackMergeBase -Meta $meta -MaxCommits 2) -eq $recordedBase)
# Default cap also finds it (base is well within 1000 here).
Check "default-cap resolve finds the base" ((Resolve-FallbackMergeBase -Meta $meta) -eq $recordedBase)

Write-Host "`n=== 17. DEEP ESCALATION via the LINEAGE branch (shortcut disabled) ===" -ForegroundColor Yellow
# Blank meta.sourceTree so the clean-merge-handoff shortcut cannot fire; only the base
# lineage subtree-match can locate the base, exercising the deep escalation on that branch.
$metaNoShortcut = [pscustomobject]@{
    version = 2; jsonPath = $J; baseTree = $meta.baseTree; sourceTree = ""; status = "clean"; pending = $null
}
Check "lineage-only, tiny cap: deep search still finds the base" ((Resolve-FallbackMergeBase -Meta $metaNoShortcut -MaxCommits 2) -eq $recordedBase)

Write-Host "`n=== 18. NO false base: a fresh history with no recorded base still returns '' ===" -ForegroundColor Yellow
# A repo that never imported/exported here has an empty base lineage; even the deep walk
# must report "" so the caller applies as a first export (rather than hunting forever).
$r2 = Join-Path ([System.IO.Path]::GetTempPath()) "e2e6b-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $r2 | Out-Null
git -C $r2 init -q; git -C $r2 config user.email t@t.t; git -C $r2 config user.name t
$lib2 = Join-Path $r2 "Lib.lbs"; Set-Content -Path $lib2 -Value "bin" -NoNewline
$abs2 = Join-Path $r2 $J; New-Item -ItemType Directory -Force -Path $abs2 | Out-Null
Set-Content (Join-Path $abs2 "a.json") "z0" -NoNewline
git -C $r2 add -A; git -C $r2 commit -q -m "source only, no gittools state"
Initialize-GitToolsState -RepoRoot $r2 -JsonPath $J -LibraryId LIB -LibraryPath $lib2
$meta2 = Read-GitToolsMeta
Check "no recorded base -> resolver returns '' (first-export apply)" ((Resolve-FallbackMergeBase -Meta $meta2) -eq "")

Write-Host "`n=== RESULT: $pass passed, $fail failed ===" -ForegroundColor Yellow
if ($fail -gt 0) { exit 1 }
