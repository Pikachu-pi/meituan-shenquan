[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$SkipShortcuts,
    [string]$XiaocangAccount,
    [string]$LexinyiAccount,
    [ValidateRange(1024,65535)][int]$XiaocangPort = 9335,
    [ValidateRange(1024,65535)][int]$LexinyiPort = 9334
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -ne 7) { throw '请使用 Windows 上的官方 PowerShell 7 运行安装程序。' }
if ($XiaocangPort -eq $LexinyiPort) { throw '两个浏览器端口必须不同。' }
$sqHome = if ($env:MEITUAN_SHENQUAN_HOME) { [IO.Path]::GetFullPath($env:MEITUAN_SHENQUAN_HOME) } else { Join-Path $env:LOCALAPPDATA 'MeituanShenquan' }
$sqConfigPath = Join-Path $sqHome 'config.json'
$sqPrevious = if (Test-Path -LiteralPath $sqConfigPath) { Get-Content -LiteralPath $sqConfigPath -Raw | ConvertFrom-Json } else { $null }
if ($sqPrevious) {
    if (-not $PSBoundParameters.ContainsKey('XiaocangPort')) { $XiaocangPort = [int]$sqPrevious.brands.xiaocang.port }
    if (-not $PSBoundParameters.ContainsKey('LexinyiPort')) { $LexinyiPort = [int]$sqPrevious.brands.lexinyi.port }
    if ($XiaocangPort -eq $LexinyiPort) { throw '已有配置的浏览器端口不独立，已停止。' }
}
$sqAssets = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets'
$sqPwsh = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
if (-not (Test-Path -LiteralPath $sqPwsh -PathType Leaf)) { throw '找不到官方 PowerShell 7：请通过 install.cmd 安装。' }

function Find-SqFile([string[]]$Candidates) {
    foreach ($candidate in $Candidates) { if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return [IO.Path]::GetFullPath($candidate) } }
    return $null
}
function Find-SqCommand([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}
function Test-SqVersion([string]$Executable, [version]$Minimum) {
    if (-not $Executable) { return $false }
    if ($Executable -match '[\\/]Microsoft[\\/]WindowsApps[\\/]') { return $false }
    try { $output = & $Executable --version 2>$null; if ($LASTEXITCODE -ne 0) { return $false }; $match = [regex]::Match(($output -join ' '), '(\d+\.\d+\.\d+)'); return $match.Success -and ([version]$match.Value -ge $Minimum) } catch { return $false }
}
function Find-SqNode {
    foreach ($candidate in @((Find-SqCommand 'node.exe'), (Join-Path $env:ProgramFiles 'nodejs\node.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))) {
        if (Test-SqVersion $candidate ([version]'22.20.0')) { return $candidate }
    }
    return $null
}
function Find-SqPython {
    $launcher = Find-SqCommand 'py.exe'
    if ($launcher -and $launcher -notmatch '[\\/]Microsoft[\\/]WindowsApps[\\/]') {
        try {
            $installed = & $launcher -0p 2>$null
            if ($LASTEXITCODE -eq 0) {
                foreach ($line in $installed) {
                    $match = [regex]::Match($line, '([A-Za-z]:\\.+?python(?:3)?\.exe)\s*$')
                    if ($match.Success -and (Test-SqVersion $match.Groups[1].Value ([version]'3.11.0'))) { return $match.Groups[1].Value }
                }
            }
        } catch {}
    }
    foreach ($candidate in @((Find-SqCommand 'python.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'), (Join-Path $env:ProgramFiles 'Python312\python.exe'))) {
        if (Test-SqVersion $candidate ([version]'3.11.0')) { return $candidate }
    }
    return $null
}
function Find-SqBrowser([string]$Brand) {
    if ($Brand -eq 'xiaocang') {
        return Find-SqFile @((Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'), (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'), (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'))
    }
    return Find-SqFile @((Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'), (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'), (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'))
}
function Install-SqWinget([string]$Id) {
    $winget = Find-SqCommand 'winget.exe'
    if (-not $winget) { throw "缺少 $Id，且本机无 winget。请从官方渠道安装后重新运行安装程序。" }
    & $winget install --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) { throw "winget 安装 $Id 失败，退出码 $LASTEXITCODE。" }
}
function Invoke-SqChecked([string]$Component, [string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "安装 $Component 失败，退出码 $LASTEXITCODE。根据上方错误处理后，重新运行 install.cmd。" }
}
function Find-SqHarness {
    foreach ($candidate in @((Find-SqCommand 'browser-harness.exe'), (Join-Path $sqHome 'harness\Scripts\browser-harness.exe'))) {
        if (Test-SqVersion $candidate ([version]'0.1.13')) { return $candidate }
    }
    return $null
}
function Find-SqCli {
    foreach ($candidate in @((Find-SqCommand 'playwright-cli.cmd'), (Join-Path $sqHome 'tools\node_modules\.bin\playwright-cli.cmd'))) {
        if (Test-SqVersion $candidate ([version]'0.1.23')) { return $candidate }
    }
    return $null
}

$sqNode = Find-SqNode
$sqPython = Find-SqPython
$sqHarness = Find-SqHarness
$sqCli = Find-SqCli
$sqEdge = Find-SqBrowser 'xiaocang'
$sqChrome = Find-SqBrowser 'lexinyi'
$sqRuntime = Join-Path $sqHome 'runtime'
$sqCoreInstalled = $false
$sqCorePackage = Join-Path $sqRuntime 'node_modules\playwright-core\package.json'
if (Test-Path -LiteralPath $sqCorePackage) { try { $sqCoreInstalled = (Get-Content -LiteralPath $sqCorePackage -Raw | ConvertFrom-Json).version -eq '1.64.1' } catch {} }
$sqOccupied = @{}
foreach ($brandPort in @($XiaocangPort,$LexinyiPort)) { $sqOccupied[[string]$brandPort] = @(Get-NetTCPConnection -LocalPort $brandPort -State Listen -ErrorAction SilentlyContinue).Count -gt 0 }
if ($CheckOnly) {
    [ordered]@{checkOnly=$true;home=$sqHome;nodeReady=[bool]$sqNode;pythonReady=[bool]$sqPython;browserHarnessReady=[bool]$sqHarness;playwrightCliReady=[bool]$sqCli;playwrightCoreReady=$sqCoreInstalled;edgeReady=[bool]$sqEdge;chromeReady=[bool]$sqChrome;configured=(Test-Path -LiteralPath $sqConfigPath);occupiedPorts=$sqOccupied;changesMade=$false}|ConvertTo-Json -Depth 4
    exit 0
}
foreach ($guard in @('locks','pending','active-run')) {
    $guardDir = Join-Path $sqHome $guard
    if ((Test-Path -LiteralPath $guardDir) -and @(Get-ChildItem -LiteralPath $guardDir -Filter '*.json' -File).Count) { throw "存在运行锁或未决提交，先处理后再安装/更新：$guardDir" }
}
if (-not $sqNode) { Install-SqWinget 'OpenJS.NodeJS.LTS'; $sqNode = Find-SqNode; if (-not $sqNode) { throw 'Node.js 需 >= 22.20；安装后请重开 PowerShell 再运行。' } }
$sqNpm = Join-Path (Split-Path -Parent $sqNode) 'npm.cmd'
if (-not (Test-Path -LiteralPath $sqNpm)) { throw 'Node.js 安装中缺少 npm.cmd，请修复官方 Node.js 安装。' }
if (-not $sqPython -and -not $sqHarness) { Install-SqWinget 'Python.Python.3.12'; $sqPython = Find-SqPython; if (-not $sqPython) { throw 'Python 3.11+ 未就绪，请重开 PowerShell 后重试。' } }
if (-not $sqEdge) { Install-SqWinget 'Microsoft.Edge'; $sqEdge = Find-SqBrowser 'xiaocang'; if (-not $sqEdge) { throw '未能定位 Microsoft Edge。' } }
if (-not $sqChrome) { Install-SqWinget 'Google.Chrome'; $sqChrome = Find-SqBrowser 'lexinyi'; if (-not $sqChrome) { throw '未能定位 Google Chrome。' } }
if (-not $XiaocangAccount) { $XiaocangAccount = if ($sqPrevious) {$sqPrevious.brands.xiaocang.expectedAccount} else {Read-Host '请输入小仓中台的预期网页登录账号（不是密码）'} }
if (-not $LexinyiAccount) { $LexinyiAccount = if ($sqPrevious) {$sqPrevious.brands.lexinyi.expectedAccount} else {Read-Host '请输入乐心宜中台的预期网页登录账号（不是密码）'} }
if ([string]::IsNullOrWhiteSpace($XiaocangAccount) -or [string]::IsNullOrWhiteSpace($LexinyiAccount) -or $XiaocangAccount -match '[\r\n]' -or $LexinyiAccount -match '[\r\n]') { throw '两个预期网页登录账号都必须填写。不要填写密码。' }
if ($sqPrevious -and ($sqPrevious.brands.xiaocang.port -ne $XiaocangPort -or $sqPrevious.brands.lexinyi.port -ne $LexinyiPort)) { throw '已有配置端口与本次参数不同，保留已有配置；请先明确处理原配置。' }
if (-not $sqPrevious -and ($sqOccupied[[string]$XiaocangPort] -or $sqOccupied[[string]$LexinyiPort])) { throw '默认端口已被占用。现有进程未改动；请使用两个空闲端口参数重新安装。' }
[IO.Directory]::CreateDirectory($sqHome) | Out-Null
if (-not $sqCoreInstalled) {
    [IO.Directory]::CreateDirectory($sqRuntime) | Out-Null
    Copy-Item -LiteralPath (Join-Path $sqAssets 'runtime-package.json') -Destination (Join-Path $sqRuntime 'package.json')
    Copy-Item -LiteralPath (Join-Path $sqAssets 'runtime-package-lock.json') -Destination (Join-Path $sqRuntime 'package-lock.json')
    Invoke-SqChecked 'Playwright 运行库' $sqNpm @('ci','--prefix',$sqRuntime,'--ignore-scripts','--no-audit','--no-fund')
}
if (-not $sqCli) {
    $sqTools = Join-Path $sqHome 'tools'; [IO.Directory]::CreateDirectory($sqTools) | Out-Null
    Copy-Item -LiteralPath (Join-Path $sqAssets 'cli-package.json') -Destination (Join-Path $sqTools 'package.json')
    Copy-Item -LiteralPath (Join-Path $sqAssets 'cli-package-lock.json') -Destination (Join-Path $sqTools 'package-lock.json')
    Invoke-SqChecked 'Playwright CLI' $sqNpm @('ci','--prefix',$sqTools,'--ignore-scripts','--no-audit','--no-fund')
    $sqCli = Find-SqCli; if (-not $sqCli) { throw 'Playwright CLI 安装后校验失败。' }
}
if (-not $sqHarness) {
    $sqVenv = Join-Path $sqHome 'harness'
    Invoke-SqChecked 'Browser Harness 虚拟环境' $sqPython @('-m','venv',$sqVenv)
    $sqVenvPython = Join-Path $sqVenv 'Scripts\python.exe'
    Invoke-SqChecked 'Browser Harness' $sqVenvPython @('-m','pip','--disable-pip-version-check','install','browser-harness==0.1.13')
    $sqHarness = Find-SqHarness; if (-not $sqHarness) { throw 'Browser Harness 安装后校验失败。' }
}
$sqConfig = [ordered]@{version=1;home=$sqHome;nodePath=$sqNode;pwshPath=$sqPwsh;runtimeDir=$sqRuntime;harnessPath=$sqHarness;cliPath=$sqCli;viewport=@{width=1920;height=1080};brand=$sqPrevious.brand;activityId=$sqPrevious.activityId;inventory=$sqPrevious.inventory;brands=@{
    xiaocang=@{port=$XiaocangPort;executable=$sqEdge;profileDir=(Join-Path $sqHome 'profiles\xiaocang');expectedAccount=$XiaocangAccount.Trim()}
    lexinyi=@{port=$LexinyiPort;executable=$sqChrome;profileDir=(Join-Path $sqHome 'profiles\lexinyi');expectedAccount=$LexinyiAccount.Trim()}
}}
if ($sqPrevious) {
    foreach ($brandKey in @('xiaocang','lexinyi')) {
        if ($sqPrevious.brands.$brandKey.expectedAccount -ne $sqConfig.brands[$brandKey].expectedAccount) { throw '已有账号绑定不同，未覆盖；请先人工核对并处理该专用配置。' }
        $sqConfig.brands[$brandKey].profileDir = $sqPrevious.brands.$brandKey.profileDir
    }
}
$sqConfigTemp = $sqConfigPath + '.tmp'
[IO.File]::WriteAllText($sqConfigTemp,($sqConfig|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false)); Move-Item -LiteralPath $sqConfigTemp -Destination $sqConfigPath -Force
if (-not $SkipShortcuts) {
    $sqDesktop = [Environment]::GetFolderPath('DesktopDirectory'); $sqShell = New-Object -ComObject WScript.Shell
    foreach ($brandKey in @('xiaocang','lexinyi')) {
        $sqName = if ($brandKey -eq 'xiaocang') {'小仓中台登录（Edge）'}else{'乐心宜中台登录（Chrome）'}
        $sqShortcutPath = Join-Path $sqDesktop ($sqName + '.lnk')
        if (Test-Path -LiteralPath $sqShortcutPath) { $sqExisting = $sqShell.CreateShortcut($sqShortcutPath); if ($sqExisting.Arguments -notlike ('*' + (Join-Path $PSScriptRoot 'login.vbs') + '*')) { throw "桌面已有同名非本项目快捷方式，未覆盖：$sqShortcutPath" } }
        $sqShortcut = $sqShell.CreateShortcut($sqShortcutPath); $sqShortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
        $sqShortcut.Arguments = '"' + (Join-Path $PSScriptRoot 'login.vbs') + '" "' + $sqHome + '" "' + $brandKey + '"'
        $sqShortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
        $sqShortcut.IconLocation = $sqConfig.brands[$brandKey].executable + ',0'; $sqShortcut.Description = '仅打开专用登录浏览器；不会执行神券报名或取消。'; $sqShortcut.Save()
    }
}
Write-Output '安装完成。请分别打开桌面两个登录入口，手动登录对应账号，登录完成后正常关闭浏览器窗口。'
Write-Output ('随后运行 Invoke-Shenquan.ps1 -Brand lexinyi -Mode VerifyLogin（小仓用 xiaocang）检查后台登录状态。配置：' + $sqConfigPath)
