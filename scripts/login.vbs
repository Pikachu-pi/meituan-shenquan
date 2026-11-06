Option Explicit
Dim sh, fso, cfg, stream, dataHome, brand, command, scriptDir, pwsh, exitCode
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
If WScript.Arguments.Count <> 2 Then WScript.Quit 2
dataHome = WScript.Arguments(0)
brand = WScript.Arguments(1)
If brand <> "xiaocang" And brand <> "lexinyi" Then WScript.Quit 2
pwsh = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\PowerShell\7\pwsh.exe"
If Not fso.FileExists(pwsh) Then
  MsgBox "Official PowerShell 7 was not found. Run install.cmd.", 16, "Meituan Shenquan"
  WScript.Quit 1
End If
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Environment("PROCESS")("MEITUAN_SHENQUAN_HOME") = dataHome
command = """" & pwsh & """ -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\Invoke-Shenquan.ps1"" -Brand " & brand & " -Mode Login"
exitCode = sh.Run(command, 0, True)
If exitCode <> 0 Then MsgBox "Login browser could not open. Check active workflow/pending state, then run Invoke-Shenquan.ps1 -Mode Login in PowerShell to see the reason.", 16, "Meituan Shenquan"
WScript.Quit exitCode
