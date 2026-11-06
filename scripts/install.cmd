@echo off
setlocal
set "SQ_EXIT=0"
set "SQ_PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if exist "%SQ_PWSH%" goto setup
where winget.exe >nul 2>nul
if errorlevel 1 (
  echo Official PowerShell 7 is required. Install it from https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows
  set "SQ_EXIT=1"
  goto finish
)
winget.exe install --id Microsoft.PowerShell --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
set "SQ_EXIT=%errorlevel%"
if not "%SQ_EXIT%"=="0" goto finish
if not exist "%SQ_PWSH%" (
  echo PowerShell 7 was not found after installation. Reopen this installer after checking the official installation.
  set "SQ_EXIT=1"
  goto finish
)
:setup
"%SQ_PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set "SQ_EXIT=%errorlevel%"
:finish
echo.
echo Installer exit code: %SQ_EXIT%
if not "%SQ_EXIT%"=="0" echo Keep the error above for troubleshooting before retrying.
if not "%SQ_INSTALL_NO_PAUSE%"=="1" pause
exit /b %SQ_EXIT%
