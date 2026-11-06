[CmdletBinding()]
param(
    [ValidateSet('xiaocang','lexinyi')][string]$Brand,
    [ValidateSet('Run','Configure','Login','VerifyLogin','Status')][string]$Mode='Run',
    [ValidateSet('check-scope','execute','prepare-cancel','cancel','verify-cancel','prepare-register','register','confirm-register','verify-register','result-details','verify')][string]$Phase='execute',
    [string]$RunDir,
    [ValidateNotNullOrEmpty()][string]$ActivityId,
    [ValidateNotNullOrEmpty()][string]$Inventory
)
$ErrorActionPreference='Stop'
if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -ne 7) { throw '请使用官方 PowerShell 7。' }
$sqHome=if($env:MEITUAN_SHENQUAN_HOME){[IO.Path]::GetFullPath($env:MEITUAN_SHENQUAN_HOME)}else{Join-Path $env:LOCALAPPDATA 'MeituanShenquan'}
$sqConfigPath=Join-Path $sqHome 'config.json'
if (-not (Test-Path -LiteralPath $sqConfigPath -PathType Leaf)) { throw '未找到本机配置，请先运行 scripts/install.cmd。' }
$sqConfig=Get-Content -LiteralPath $sqConfigPath -Raw|ConvertFrom-Json
if (-not (Test-Path -LiteralPath $sqConfig.nodePath -PathType Leaf)) { throw '找不到已配置的 Node.js，请重新运行 setup.ps1。' }
if($Mode -in @('Run','Configure')) {
    $sqPhase=if($Mode -eq 'Configure'){'configure'}else{$Phase}
    $sqArgs=@((Join-Path $PSScriptRoot 'run.cjs'),'--phase',$sqPhase)
    if($Brand){$sqArgs+=@('--brand',$Brand)}
    if($RunDir){$sqArgs+=@('--run-dir',[IO.Path]::GetFullPath($RunDir))}
    if($PSBoundParameters.ContainsKey('ActivityId')){$sqArgs+=@('--activity-id',$ActivityId)}
    if($PSBoundParameters.ContainsKey('Inventory')){$sqArgs+=@('--inventory',$Inventory)}
} else {
    $sqBrand=if($Brand){$Brand}else{$sqConfig.brand}
    if($sqBrand -notin @('xiaocang','lexinyi')){throw '请指定 -Brand，或先保存默认中台。'}
    $sqCommand=@{Login='login';VerifyLogin='verify-login';Status='status'}[$Mode]
    $sqArgs=@((Join-Path $PSScriptRoot 'browser.cjs'),$sqCommand,$sqBrand)
}
& $sqConfig.nodePath @sqArgs
exit $LASTEXITCODE
