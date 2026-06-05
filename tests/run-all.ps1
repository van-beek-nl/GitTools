#!/usr/bin/env pwsh
# Run every end-to-end export suite in this directory and aggregate the result.
#
# Each e2e_*.ps1 suite builds its own throwaway temp repositories, drives the
# real pre/post-export(+import) scripts through the same entry points Omnis uses,
# and prints "  PASS"/"  FAIL" lines plus a per-suite "=== RESULT: N passed, M
# failed ===" footer, exiting non-zero if anything failed. This runner invokes
# each in its own pwsh process (so one suite's strict-mode abort cannot stop the
# rest), echoes their output, and exits non-zero if any suite failed - suitable
# for a pre-commit check or CI gate.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$suites = Get-ChildItem -Path $PSScriptRoot -Filter "e2e_*.ps1" | Sort-Object Name
$failed = @()

foreach ($suite in $suites) {
    Write-Host "`n########## $($suite.Name) ##########" -ForegroundColor Cyan
    & pwsh -NoProfile -File $suite.FullName
    if ($LASTEXITCODE -ne 0) { $failed += $suite.Name }
}

Write-Host "`n========================================" -ForegroundColor Yellow
if ($failed.Count -gt 0) {
    Write-Host "SUITES FAILED: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "ALL $($suites.Count) SUITES PASSED" -ForegroundColor Green
