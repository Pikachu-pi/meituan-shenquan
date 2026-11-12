#requires -Version 7
param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ego-exclusion-inbox.ps1')
$inbox = Get-EgoExclusionFolder
$officialPage = 'https://lite.ego.app/download?auto=1'
$installerUrl = 'https://cdn.ego.app/setup/windows/x64/egoliteSetup-Y7MbxKIuhzFB.exe'
$publisher = 'CITRO LABS PTE. LIMITED'

function Get-EgoCli {
    Get-Command ego-browser -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Test-EgoCli($Cli) {
    if (!$Cli) { return $false }
    $guide = & $Cli.Source skill
    $LASTEXITCODE -eq 0 -and [bool]($guide -match '^\[ego-browser:skill\] end of guide')
}

$ego = Get-EgoCli
$installedApp = @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), $env:LOCALAPPDATA) |
    Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'Citro Labs\ego lite\Application\ego.exe') -PathType Leaf) } |
    Select-Object -First 1
$ready = Test-EgoCli $ego
if ($CheckOnly) {
    [ordered]@{egoReady=$ready;egoInstalled=[bool]($ego -or $installedApp);inbox=$inbox;inboxExists=(Test-Path -LiteralPath $inbox)} | ConvertTo-Json
    return
}

if (!$ready -and !$ego -and !$installedApp) {
    if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
        throw "请通过 Ego Lite 官方页面选择适合这台电脑的安装程序：$officialPage"
    }
    $installer = Join-Path ([IO.Path]::GetTempPath()) ('EgoLiteSetup-'+[guid]::NewGuid().ToString('N')+'.exe')
    try {
        Write-Output '正在从 Ego Lite 官方站点下载安装程序。'
        try {
            Invoke-WebRequest -Uri $installerUrl -OutFile $installer -TimeoutSec 180 -ErrorAction Stop
        } catch {
            throw "Ego Lite 下载失败。可从官方页面下载安装：$officialPage"
        }
        $signature = Get-AuthenticodeSignature -LiteralPath $installer
        $signedBy = if ($signature.SignerCertificate) {
            $signature.SignerCertificate.GetNameInfo(
                [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        }
        if ($signature.Status -ne 'Valid' -or $signedBy -ine $publisher) {
            throw "Ego Lite 安装程序未通过签名验证。请从官方页面核对：$officialPage"
        }
        Write-Output '请按 Ego Lite 安装窗口中的提示继续。'
        $process = Start-Process -FilePath $installer -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "Ego Lite 安装程序退出码 $($process.ExitCode)。" }
    } finally {
        [IO.File]::Delete($installer)
    }
    $ready = Test-EgoCli (Get-EgoCli)
}

[IO.Directory]::CreateDirectory($inbox) | Out-Null
if (!$ready) { throw '请打开 Ego Lite 完成首次设置，重新打开终端后再运行安装检查。' }
Write-Output "安装检查通过。剔除清单入口 $inbox"
