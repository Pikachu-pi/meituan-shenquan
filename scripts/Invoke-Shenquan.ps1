[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('xiaocang','lexinyi')][string]$Brand,
    [ValidateSet('Run','Login','VerifyLogin','Status')][string]$Mode='Run',
    [ValidateSet('check-scope','preflight','execute','prepare-cancel','cancel','verify-cancel','prepare-register','register','confirm-register','verify-register','result-details','verify')][string]$Phase='preflight',
    [string]$RunDir,
    [ValidateNotNullOrEmpty()][string]$ActivityId,
    [ValidateNotNullOrEmpty()][string]$Inventory
)
$ErrorActionPreference='Stop'
if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -ne 7) { throw '请使用官方 PowerShell 7。' }
$sqHome=if($env:MEITUAN_SHENQUAN_HOME){[IO.Path]::GetFullPath($env:MEITUAN_SHENQUAN_HOME)}else{Join-Path $env:LOCALAPPDATA 'MeituanShenquan'}
$sqConfig=Get-Content -LiteralPath (Join-Path $sqHome 'config.json') -Raw|ConvertFrom-Json
if (-not (Test-Path -LiteralPath $sqConfig.nodePath -PathType Leaf)) { throw '找不到已配置的 Node.js，请重新运行 setup.ps1。' }
if($Mode -eq 'Run') {
    $sqArgs=@((Join-Path $PSScriptRoot 'run.cjs'),'--brand',$Brand,'--phase',$Phase)
    if($RunDir){$sqArgs+=@('--run-dir',[IO.Path]::GetFullPath($RunDir))}
    if($PSBoundParameters.ContainsKey('ActivityId')){$sqArgs+=@('--activity-id',$ActivityId)}
    if($PSBoundParameters.ContainsKey('Inventory')){$sqArgs+=@('--inventory',$Inventory)}
} else {
    $sqCommand=@{Login='login';VerifyLogin='verify-login';Status='status'}[$Mode]
    $sqArgs=@((Join-Path $PSScriptRoot 'browser.cjs'),$sqCommand,$Brand)
}
& $sqConfig.nodePath @sqArgs
exit $LASTEXITCODE
