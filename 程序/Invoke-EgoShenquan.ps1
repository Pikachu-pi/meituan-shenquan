#requires -Version 7
[CmdletBinding(DefaultParameterSetName='New')]
param(
    [Parameter(ParameterSetName='New')][ValidateSet('both','xiaocang','lexinyi')][string]$Brand = 'both',
    [Parameter(ParameterSetName='New')][ValidatePattern('^\d*[1-9]\d*$')][string]$ActivityId,
    [Parameter(ParameterSetName='New')][ValidateRange(1,2147483647)][int]$Inventory,
    [Parameter(ParameterSetName='New')][ValidateNotNullOrEmpty()][string]$XiaocangProfile = '小仓',
    [Parameter(ParameterSetName='New')][ValidateNotNullOrEmpty()][string]$LexinyiProfile = '乐心宜',
    [Parameter(ParameterSetName='New')][ValidateNotNullOrEmpty()][string]$XiaocangAccount,
    [Parameter(ParameterSetName='New')][ValidateNotNullOrEmpty()][string]$LexinyiAccount,
    [Parameter(ParameterSetName='New')][string]$ExclusionWorkbook,
    [Parameter(ParameterSetName='New')][switch]$UseExclusionFolder,
    [Parameter(ParameterSetName='New')][switch]$NoExclusions,
    [Parameter(ParameterSetName='Folder', Mandatory)][switch]$ExclusionFolder,
    [Parameter(ParameterSetName='Import', Mandatory)][ValidateNotNullOrEmpty()][string]$ImportExclusionWorkbook,
    [Parameter(ParameterSetName='New')]
    [Parameter(ParameterSetName='Resume', Mandatory)][string]$RunDir,
    [Parameter(ParameterSetName='Resume', Mandatory)][switch]$Resume
)

$ErrorActionPreference = 'Stop'
$sqHome = if ($env:MEITUAN_SHENQUAN_HOME) { [IO.Path]::GetFullPath($env:MEITUAN_SHENQUAN_HOME) } else { Join-Path $env:LOCALAPPDATA 'MeituanShenquan' }
. (Join-Path $PSScriptRoot 'ego-exclusion-inbox.ps1')
$sqInbox = Get-EgoExclusionFolder
[IO.Directory]::CreateDirectory($sqInbox) | Out-Null
if ($ExclusionFolder) { return $sqInbox }
if ($ImportExclusionWorkbook) {
    return Move-EgoExclusionWorkbook -Folder $sqInbox -Workbook $ImportExclusionWorkbook
}
$egoCli = Get-Command ego-browser -CommandType Application -ErrorAction Stop | Select-Object -First 1
$sqModuleUri = [uri]::new((Join-Path $PSScriptRoot 'ego-preflight.mjs')).AbsoluteUri
if (-not $RunDir) {
    $RunDir = Join-Path $sqHome "ego-runs/$([DateTime]::Now.ToString('yyyyMMdd-HHmmss'))-$([guid]::NewGuid().ToString('N').Substring(0,8))"
}
$sqOut = [IO.Path]::GetFullPath($RunDir)
$sqManifest = Join-Path $sqOut '运行参数.json'
if ($Resume) {
    $sqRuns = @(Get-Content -LiteralPath $sqManifest -Raw | ConvertFrom-Json -AsHashtable)
} else {
    if (Test-Path -LiteralPath $sqManifest) { throw '运行目录已使用。请指定新目录，或用 -Resume 继续原预演。' }
    $sqLocalConfig = Join-Path $sqHome 'config.json'
    if (Test-Path -LiteralPath $sqLocalConfig) {
        $sqDefaults = Get-Content -LiteralPath $sqLocalConfig -Raw | ConvertFrom-Json
        if (!$ActivityId) { $ActivityId = $sqDefaults.activityId }
        if (!$Inventory) { $Inventory = $sqDefaults.inventory }
        if (!$XiaocangAccount) { $XiaocangAccount = $sqDefaults.brands.xiaocang.expectedAccount }
        if (!$LexinyiAccount) { $LexinyiAccount = $sqDefaults.brands.lexinyi.expectedAccount }
    }
    if (!$ActivityId -or !$Inventory) { throw '请传入 -ActivityId 和 -Inventory，或先配置本机业务默认值。' }
    if ($Brand -in @('both','xiaocang') -and !$XiaocangAccount) { throw '请用 -XiaocangAccount 指定小仓美团账号。' }
    if ($Brand -in @('both','lexinyi') -and !$LexinyiAccount) { throw '请用 -LexinyiAccount 指定乐心宜美团账号。' }
    if ($Brand -eq 'both' -and ($XiaocangProfile -eq $LexinyiProfile -or $XiaocangAccount -eq $LexinyiAccount)) {
        throw '两个中台需要各自的 Ego Lite 资料和美团账号。'
    }
    $sqBrands = if ($Brand -eq 'both') { @('xiaocang', 'lexinyi') } else { @($Brand) }
    $sqChoices = [int][bool]$NoExclusions + [int][bool]$UseExclusionFolder + [int][bool]$ExclusionWorkbook
    if ($sqChoices -gt 1) { throw '请在无剔除、从清单文件夹选表和指定本次清单之间选择一项。' }
    if ($UseExclusionFolder) { $ExclusionWorkbook = Select-EgoInboxWorkbook -Folder $sqInbox }
    if (!$NoExclusions -and !$ExclusionWorkbook) { $ExclusionWorkbook = Select-EgoInboxWorkbook -Folder $sqInbox -AllowEmpty }

    $sqPlan = @{}
    $sqWorkbookRecord = $null
    if ($ExclusionWorkbook) {
        . (Join-Path $PSScriptRoot 'ego-store-plan.ps1')
        $sqFile = Get-EgoExclusionWorkbook -Folder $sqInbox -Workbook $ExclusionWorkbook
        $sqHash = (Get-FileHash -LiteralPath $sqFile.FullName).Hash
        $sqPlan = Get-EgoShenquanStorePlan -Workbook $sqFile.FullName -Brands $sqBrands
        if ($sqHash -ne (Get-FileHash -LiteralPath $sqFile.FullName).Hash) {
            throw '读取过程中清单发生了变化。请保存并关闭表格，再重新运行。'
        }
        $sqWorkbookRecord = @{ name = $sqFile.Name; sha256 = $sqHash }
        Write-Host "本次剔除清单 $($sqFile.Name)"
    }
    $sqRuns = @(foreach ($sqBrand in $sqBrands) {
        @{
            brand = $sqBrand
            profileName = if ($sqBrand -eq 'xiaocang') { $XiaocangProfile } else { $LexinyiProfile }
            account = if ($sqBrand -eq 'xiaocang') { $XiaocangAccount } else { $LexinyiAccount }
            activityId = $ActivityId
            inventory = $Inventory
            exclusionWorkbook = $sqWorkbookRecord
            excludedCount = if ($sqPlan[$sqBrand]) { $sqPlan[$sqBrand].excluded.Count } else { 0 }
            registrationIds = @($sqPlan[$sqBrand].included | Where-Object { $_ })
            taskName = "shenquan-$sqBrand-$([guid]::NewGuid().ToString('N').Substring(0,12))"
        }
    })
    [IO.Directory]::CreateDirectory($sqOut) | Out-Null
    [IO.File]::WriteAllText($sqManifest, (ConvertTo-Json -InputObject $sqRuns -Depth 4), [Text.UTF8Encoding]::new($false))
}

$sqIncomplete = @()
foreach ($sqRun in $sqRuns) {
    $sqRun.out = Join-Path $sqOut $sqRun.brand
    $sqResult = Join-Path $sqRun.out '结果.json'
    if ((Test-Path -LiteralPath $sqResult) -and (Get-Content -LiteralPath $sqResult -Raw | ConvertFrom-Json).stage -eq 'complete') {
        Write-Output "$($sqRun.brand) 已完成，结果见 $sqResult"
        continue
    }
    [IO.Directory]::CreateDirectory($sqRun.out) | Out-Null
    $sqRun.resume = [bool]$Resume
    $sqScript = Join-Path $sqRun.out "round-$([guid]::NewGuid().ToString('N')).mjs"
    $sqInput = ConvertTo-Json -InputObject $sqRun -Depth 4
    $sqCode = @"
import { runEgoPreflight } from "$sqModuleUri";
await runEgoPreflight($sqInput);
"@
    [IO.File]::WriteAllText($sqScript, $sqCode, [Text.UTF8Encoding]::new($false))
    $sqUri = [uri]::new($sqScript).AbsoluteUri.Replace("'", '%27')
    & $egoCli.Source nodejs -e "await import('$sqUri')"
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $sqResult) -or (Get-Content -LiteralPath $sqResult -Raw | ConvertFrom-Json).stage -ne 'complete') {
        $sqIncomplete += $sqRun.brand
    }
}

Write-Output "运行目录 $sqOut"
if ($sqIncomplete.Count) { throw "预演尚未完成 $($sqIncomplete -join ', ')。请查看 Ego Lite 提示或运行目录中的结果。" }
