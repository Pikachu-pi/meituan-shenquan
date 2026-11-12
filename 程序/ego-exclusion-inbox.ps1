function Get-EgoExclusionFolder {
    Join-Path (Split-Path -Parent $PSScriptRoot) '剔除清单'
}

function Get-EgoInboxWorkbooks {
    param([string]$Folder)
    if (!(Test-Path -LiteralPath $Folder -PathType Container)) { return }
    Get-ChildItem -LiteralPath $Folder -File -Filter '*.xlsx' |
        Where-Object { !$_.Name.StartsWith('~$') } |
        Sort-Object Name
}

function Get-EgoExclusionWorkbook {
    param([string]$Folder, [string]$Workbook)
    if ($Folder -and ![IO.Path]::IsPathRooted($Workbook)) {
        $inboxFile = Join-Path $Folder $Workbook
        if (Test-Path -LiteralPath $inboxFile -PathType Leaf) { $Workbook = $inboxFile }
    }
    $file = Get-Item -LiteralPath $Workbook -ErrorAction Stop
    if ($file.PSIsContainer -or $file.Extension -ine '.xlsx' -or $file.Name.StartsWith('~$')) {
        throw '请提供神券报名清单的 .xlsx 文件。'
    }
    return $file
}

function Move-EgoExclusionWorkbook {
    param([string]$Folder, [string]$Workbook)
    $file = Get-EgoExclusionWorkbook -Workbook $Workbook
    if ($file.DirectoryName -ieq $Folder) { return $file.FullName }
    $destination = Join-Path $Folder $file.Name
    for ($suffix = 2; Test-Path -LiteralPath $destination; $suffix++) {
        $destination = Join-Path $Folder "$($file.BaseName)-$suffix$($file.Extension)"
    }
    # File.Move fails if another import creates this destination first.
    [IO.File]::Move($file.FullName, $destination)
    return $destination
}

function Select-EgoInboxWorkbook {
    param([string]$Folder, [switch]$AllowEmpty)
    $workbooks = @(Get-EgoInboxWorkbooks -Folder $Folder)
    if ($workbooks.Count -eq 1) { return $workbooks[0].FullName }
    if (!$workbooks.Count -and $AllowEmpty) { return }
    if (!$workbooks.Count) { throw "剔除清单文件夹里没有 .xlsx：$Folder" }
    throw "剔除清单文件夹有多张表，请只保留本次表，或用 -ExclusionWorkbook 指定：$($workbooks.Name -join '、')"
}
