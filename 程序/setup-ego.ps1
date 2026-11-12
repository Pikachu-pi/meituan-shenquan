#requires -Version 7
param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ego-exclusion-inbox.ps1')
$inbox = Get-EgoExclusionFolder
$ego = Get-Command ego-browser -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$ready = $false
if ($ego) {
    $guide = & $ego.Source skill
    $ready = $LASTEXITCODE -eq 0 -and [bool]($guide -match '^\[ego-browser:skill\] end of guide')
}
if ($CheckOnly) {
    [ordered]@{egoReady=$ready;inbox=$inbox;inboxExists=(Test-Path -LiteralPath $inbox)} | ConvertTo-Json
    return
}
if (!$ready) { throw '请从 https://lite.ego.app/ 安装并打开 Ego Lite，再重跑安装。' }
[IO.Directory]::CreateDirectory($inbox) | Out-Null
Write-Output "安装检查通过。剔除清单入口 $inbox"
