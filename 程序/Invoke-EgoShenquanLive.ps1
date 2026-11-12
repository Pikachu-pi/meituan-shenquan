#requires -Version 7
[CmdletBinding(DefaultParameterSetName='New')]
param(
    [Parameter(ParameterSetName='New')][ValidateSet('Check','Register','Cancel')][string]$Action = 'Check',
    [Parameter(ParameterSetName='Verify', Mandatory)][switch]$Verify,
    [Parameter(ParameterSetName='New')]
    [Parameter(ParameterSetName='Verify', Mandatory)][string]$RunDir,
    [ValidateSet('both','xiaocang','lexinyi')][string]$Brand = 'both',
    [Parameter(ParameterSetName='New')][ValidatePattern('^\d*[1-9]\d*$')][string]$ActivityId,
    [Parameter(ParameterSetName='New')][string]$ActivityTitle,
    [Parameter(ParameterSetName='New')][ValidateRange(1,2147483647)][int]$Inventory,
    [Parameter(ParameterSetName='New')][string]$XiaocangProfile,
    [Parameter(ParameterSetName='New')][string]$LexinyiProfile,
    [Parameter(ParameterSetName='New')][string]$XiaocangAccount,
    [Parameter(ParameterSetName='New')][string]$LexinyiAccount,
    [Parameter(ParameterSetName='New')][string]$ExclusionWorkbook,
    [Parameter(ParameterSetName='New')][switch]$UseExclusionFolder,
    [Parameter(ParameterSetName='New')][switch]$SaveConfig,
    [Parameter(ParameterSetName='New')][ValidateSet('List','None')][string]$ExclusionChoice,
    [Parameter(ParameterSetName='New')][switch]$Submit
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (!$Verify -and $Action -ne 'Check' -and !$Submit) { throw '正式报名或取消需要明确的 -Submit。只读核验用 -Action Check。' }
if ($Action -eq 'Check' -and $Submit) { throw '只读核验不接受 -Submit。' }
if ($SaveConfig -and $Action -ne 'Check') { throw '请用只读核验的 -SaveConfig 保存绑定。' }
if ($ExclusionChoice -and !$SaveConfig) { throw '用 Check -SaveConfig 保存剔除设置。' }
if ($ExclusionWorkbook -and $UseExclusionFolder) { throw '请明确选定一张清单。' }
if ($Action -ne 'Register' -and ($ExclusionWorkbook -or $UseExclusionFolder)) { throw '清单仅用于报名。' }

$sqHome = if ($env:MEITUAN_SHENQUAN_HOME) { [IO.Path]::GetFullPath($env:MEITUAN_SHENQUAN_HOME) } else { Join-Path $env:LOCALAPPDATA 'MeituanShenquan' }
. (Join-Path $PSScriptRoot 'ego-exclusion-inbox.ps1')
$sqInbox = Get-EgoExclusionFolder
$sqConfigPath = Join-Path $sqHome 'ego-config.json'
if (!$RunDir) { $RunDir = Join-Path $sqHome ('ego-runs/'+[DateTime]::Now.ToString('yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)) }
$sqOut = [IO.Path]::GetFullPath($RunDir)
$sqManifest = Join-Path $sqOut '正式运行参数.json'
$sqBrands = if ($Brand -eq 'both') { @('xiaocang','lexinyi') } else { @($Brand) }
$sqModule = [uri]::new((Join-Path $PSScriptRoot 'ego-live.mjs')).AbsoluteUri
$sqCli = Get-Command ego-browser -CommandType Application -ErrorAction Stop | Select-Object -First 1
function Read-SqConfig {
    if (!(Test-Path -LiteralPath $sqConfigPath)) { return @{ version = 1; centers = @{} } }
    $config = Get-Content -LiteralPath $sqConfigPath -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
    if ($config.version -ne 1 -or $config.centers -isnot [System.Collections.IDictionary]) { throw '本机 Ego Lite 配置格式不支持。' }
    return $config
}

function Read-SqWorkbook([string]$Workbook) {
    . (Join-Path $PSScriptRoot 'ego-store-plan.ps1')
    $file = Get-EgoExclusionWorkbook -Folder $sqInbox -Workbook $Workbook
    $hash = (Get-FileHash -LiteralPath $file.FullName).Hash
    $plan = Get-EgoShenquanStorePlan -Workbook $file.FullName -Brands $sqBrands -StrictCenters
    if ($hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) { throw '清单读取时发生变化，请保存关闭后重试。' }
    @{ workbook = @{ name=$file.Name; sha256=$hash }; plan=$plan }
}

if ($Verify) {
    if (!(Test-Path -LiteralPath $sqManifest -PathType Leaf)) { throw '请提供正式入口的原运行目录。' }
    $sqRuns = @(Get-Content -LiteralPath $sqManifest -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable)
    $sqRuns = @($sqRuns | Where-Object { $_.brand -in $sqBrands -and $_.action -in @('register','cancel') -and (Test-Path -LiteralPath (Join-Path $sqOut "$($_.brand)/提交意图.json")) })
    if (!$sqRuns.Count) { throw '原目录中没有指定中台的正式提交意图。' }
    if ($sqRuns | Where-Object { $_.home -ine $sqHome }) { throw '请使用本次运行原来的本机数据目录核对。' }
} else {
    if (Test-Path -LiteralPath $sqManifest) { throw '该目录已有正式运行记录。请换目录，或用 -Verify 核对原提交。' }
    $sqConfig = Read-SqConfig
    $sqProfiles = @{ xiaocang=$XiaocangProfile; lexinyi=$LexinyiProfile }
    $sqAccounts = @{ xiaocang=$XiaocangAccount; lexinyi=$LexinyiAccount }
    $sqWorkbook = $null
    $sqPlan = @{}
    $sqExclusions = $sqConfig.exclusions
    if ($SaveConfig -and !$ExclusionChoice -and !$sqExclusions) {
        throw '首次保存请先确认是否有固定剔除表，使用 -ExclusionChoice List 或 None。'
    }
    if ($ExclusionChoice -eq 'List') {
        $list = Read-SqWorkbook (Select-EgoInboxWorkbook -Folder $sqInbox)
        $sqExclusions = @{ mode='list'; workbook=$list.workbook }
    }
    if ($ExclusionChoice -eq 'None') {
        if (@(Get-EgoInboxWorkbooks -Folder $sqInbox).Count) { throw '改为无剔除前，请先把固定表移出「剔除清单」。' }
        $sqExclusions = @{ mode='none' }
    }
    if ($Action -eq 'Register') {
        if ($sqExclusions.mode -notin @('list','none')) { throw '首次报名请先核验并保存固定剔除设置。' }
        if ($UseExclusionFolder) { $ExclusionWorkbook = Select-EgoInboxWorkbook -Folder $sqInbox }
        if (!$ExclusionWorkbook) { $ExclusionWorkbook = Select-EgoInboxWorkbook -Folder $sqInbox -AllowEmpty }
        if ($ExclusionWorkbook) {
            $list = Read-SqWorkbook $ExclusionWorkbook
            $sqPlan = $list.plan
            $sqWorkbook = $list.workbook
        }
    }
    $sqRuns = @(foreach ($center in $sqBrands) {
        $saved = $sqConfig.centers[$center]
        $explicitProfile = $sqProfiles[$center]
        $name = if ($explicitProfile) { $explicitProfile.Trim() } else { $saved.profileName }
        $profileId = if (!$name) { $saved.profileId }
        $account = if ($sqAccounts[$center]) { $sqAccounts[$center].Trim() } else { $saved.account }
        $id = if ($ActivityId) { $ActivityId } else { $saved.activityId }
        $title = if ($ActivityTitle) { $ActivityTitle.Trim() }
        $stock = if ($Inventory) { $Inventory } else { $saved.inventory }
        if ((!$name -and !$profileId) -or !$account -or !$id) { throw "请提供 $center 的 Ego Lite 资料名、预期美团账号和活动 ID，或先做只读绑定。" }
        if ($Action -ne 'Check' -and !$saved.verifiedAt) { throw "请先完成 $center 的首次只读核验并保存设置。" }
        if (($SaveConfig -or $Action -eq 'Register') -and !$stock) { throw "请先确认 $center 的每日库存，再用 -Inventory 保存或报名。" }
        @{
            action=$Action.ToLowerInvariant(); brand=$center; submit=[bool]$Submit; home=$sqHome
            runId=[guid]::NewGuid().ToString('N'); taskName="shenquan-$center-$([guid]::NewGuid().ToString('N').Substring(0,12))"
            profileName=$name; profileId=$profileId; account=$account; activityId=[string]$id; activityTitle=$title; inventory=$stock
            workbook=$sqWorkbook; exclusionMode=if ($sqWorkbook) { 'list' } elseif ($Action -eq 'Register') { 'none' }
            configuredExclusions=if ($SaveConfig) { $sqExclusions }
            registrationIds=@($sqPlan[$center].included | Where-Object { $_ }); excludedIds=@($sqPlan[$center].excluded | Where-Object { $_ })
        }
    })
    if ($sqRuns.Count -eq 2 -and ($sqRuns[0].account -ieq $sqRuns[1].account -or
            ($sqRuns[0].profileId -and $sqRuns[0].profileId -eq $sqRuns[1].profileId) -or
            ($sqRuns[0].profileName -and $sqRuns[0].profileName -ceq $sqRuns[1].profileName))) {
        throw '两个中台需要独立的 Ego Lite 资料和商家账号。'
    }
    [IO.Directory]::CreateDirectory($sqOut) | Out-Null
    $manifestData = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $sqRuns -Depth 8))
    $manifestStream = [IO.File]::Open($sqManifest, 'CreateNew', 'Write', 'None')
    try { $manifestStream.Write($manifestData); $manifestStream.Flush($true) } finally { $manifestStream.Dispose() }
}

$sqIncomplete = @()
$sqChecked = @{}
foreach ($run in $sqRuns) {
    $run.home = $sqHome
    $run.out = Join-Path $sqOut $run.brand
    $run.verifyOnly = [bool]$Verify
    if ($Verify) { $run.submit = $false }
    [IO.Directory]::CreateDirectory($run.out) | Out-Null
    $round = Join-Path $run.out ("round-"+[guid]::NewGuid().ToString('N')+".mjs")
    $inputJson = ConvertTo-Json -InputObject $run -Depth 8
    $code = @"
import { runEgoLive } from "$sqModule";
await runEgoLive($inputJson, { profiles, listTaskSpaces, taskSpace });
"@
    [IO.File]::WriteAllText($round, $code, [Text.UTF8Encoding]::new($false))
    $roundUri = [uri]::new($round).AbsoluteUri.Replace("'", '%27')
    & $sqCli.Source nodejs -e "await import('$roundUri')"
    $exitCode = $LASTEXITCODE
    $resultPath = Join-Path $run.out '结果.json'
    $result = if (Test-Path -LiteralPath $resultPath) { Get-Content -LiteralPath $resultPath -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable }
    if ($exitCode -ne 0 -or !$result -or $result.stage -ne 'complete') {
        $sqIncomplete += $run.brand
        continue
    }
    if ($SaveConfig) {
        $sqChecked[$run.brand] = @{
            account=$result.account; profileId=$result.profileId; profileName=$result.profileName
            activityId=$result.activityId; activityTitle=$result.activityTitle; inventory=$result.inventory
            verifiedAt=$result.updatedAt
        }
    }
    [pscustomobject]@{中台=$run.brand;活动=$result.activityTitle;当前报名=$result.before;提交=$result.submitted;成功=$result.successful;失败=$result.failed;结果=$resultPath}
}

if ($sqChecked.Count) {
    [IO.Directory]::CreateDirectory($sqHome) | Out-Null
    $configLock = [IO.File]::Open(($sqConfigPath+'.lock'), 'OpenOrCreate', 'Write', 'None')
    try {
        $config = Read-SqConfig
        foreach ($center in $sqChecked.Keys) { $config.centers[$center] = $sqChecked[$center] }
        if ($ExclusionChoice -and !$sqIncomplete.Count) {
            $sqExclusions.savedAt = [DateTimeOffset]::Now.ToString('o')
            $config.exclusions = $sqExclusions
        }
        $temp = $sqConfigPath+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
        [IO.File]::WriteAllText($temp, ($config | ConvertTo-Json -Depth 6))
        [IO.File]::Move($temp, $sqConfigPath, $true)
    } finally { $configLock.Dispose() }
    Write-Output "已保存只读核验通过的中台绑定 $sqConfigPath"
}
Write-Output "运行目录 $sqOut"
if ($sqIncomplete.Count) { throw "未完成 $($sqIncomplete -join ', ')。请查看原运行记录。有提交意图时用 -Verify 核对。" }
