function Get-EgoShenquanStorePlan {
    param([string]$Workbook, [string[]]$Brands, [switch]$StrictCenters)

    $file = Get-Item -LiteralPath $Workbook -ErrorAction Stop
    if ($file.PSIsContainer -or $file.Extension -ine '.xlsx') { throw '请提供 .xlsx 格式的神券报名清单。' }
    $archive = [IO.Compression.ZipFile]::OpenRead($file.FullName)
    try {
        function Read-WorkbookXml([string]$Entry) {
            $part = $archive.GetEntry($Entry)
            if (!$part) { throw "工作簿缺少 $Entry" }
            $stream = $part.Open()
            try {
                $doc = [xml]::new()
                $doc.XmlResolver = $null
                $doc.Load($stream)
                return ,$doc
            } finally {
                $stream.Dispose()
            }
        }

        $shared = @()
        if ($archive.GetEntry('xl/sharedStrings.xml')) {
            $shared = @((Read-WorkbookXml 'xl/sharedStrings.xml').SelectNodes("/*[local-name()='sst']/*[local-name()='si']") |
                ForEach-Object { ($_.SelectNodes(".//*[local-name()='t']") | ForEach-Object InnerText) -join '' })
        }

        $workbookXml = Read-WorkbookXml 'xl/workbook.xml'
        $relations = Read-WorkbookXml 'xl/_rels/workbook.xml.rels'
        $targets = @{}
        foreach ($rel in $relations.DocumentElement.ChildNodes) {
            if ($rel.LocalName -eq 'Relationship' -and $rel.GetAttribute('Type').EndsWith('/worksheet') -and $rel.GetAttribute('TargetMode') -ne 'External') {
                $target = [uri]::new([uri]'https://xlsx.invalid/xl/workbook.xml', $rel.GetAttribute('Target'))
                if ($target.Host -eq 'xlsx.invalid') { $targets[$rel.GetAttribute('Id')] = $target.AbsolutePath.TrimStart('/') }
            }
        }

        $matchingSheets = @()
        foreach ($sheet in $workbookXml.SelectNodes("//*[local-name()='sheets']/*[local-name()='sheet']")) {
            $relationId = ($sheet.Attributes | Where-Object { $_.LocalName -eq 'id' } | Select-Object -First 1).Value
            if (!$relationId -or !$targets.ContainsKey($relationId)) { continue }
            $table = Read-WorkbookXml $targets[$relationId]
            $rows = @(foreach ($row in $table.SelectNodes("//*[local-name()='sheetData']/*[local-name()='row']")) {
                $cells = @{}
                foreach ($cell in $row.SelectNodes("*[local-name()='c']")) {
                    $ref = $cell.GetAttribute('r')
                    if ($ref -notmatch '^([A-Z]+)\d+$') { continue }
                    $column = $Matches[1]
                    $value = $cell.SelectSingleNode("*[local-name()='v']")
                    $text = if ($cell.GetAttribute('t') -eq 'inlineStr') {
                        ($cell.SelectNodes(".//*[local-name()='t']") | ForEach-Object InnerText) -join ''
                    } elseif ($cell.GetAttribute('t') -eq 's') {
                        $shared[[int]$value.InnerText]
                    } else {
                        $value.InnerText
                    }
                    $cells[$column] = ([string]$text).Trim()
                }
                @{ rowNumber = $row.GetAttribute('r'); cells = $cells }
            })
            for ($i = 0; $i -lt [Math]::Min($rows.Count, 20); $i++) {
                $headers = $rows[$i].cells
                $flag = @($headers.Keys | Where-Object { $headers[$_] -eq '不报神券' })
                $id = @($headers.Keys | Where-Object { $headers[$_] -in @('美团ID', '门店ID') })
                $center = @($headers.Keys | Where-Object { $headers[$_] -in @('中台', '所属中台') })
                if (!$flag.Count -or !$id.Count) { continue }
                if ($flag.Count -ne 1 -or $id.Count -ne 1 -or $center.Count -gt 1) {
                    throw "工作表 $($sheet.GetAttribute('name')) 的筛选列不唯一。"
                }
                $matchingSheets += @{
                    name = $sheet.GetAttribute('name')
                    rows = @($rows | Select-Object -Skip ($i + 1))
                    id = $id[0]
                    flag = $flag[0]
                    center = $center | Select-Object -First 1
                }
                break
            }
        }
    } finally {
        $archive.Dispose()
    }

    if ($matchingSheets.Count -ne 1) { throw '请提供一张同时包含「美团ID」或「门店ID」及「不报神券」列的工作表。' }
    $sheet = $matchingSheets[0]
    if ($Brands.Count -gt 1 -and !$sheet.center) { throw '双中台清单需要「中台」列来归属门店。' }
    $plan = @{}
    foreach ($brand in $Brands) {
        $plan[$brand] = @{ excluded = [Collections.Generic.List[string]]::new(); included = [Collections.Generic.List[string]]::new() }
    }
    $seen = [Collections.Generic.HashSet[string]]::new()
    foreach ($row in $sheet.rows) {
        $cells = $row.cells
        $id = $cells[$sheet.id]
        $flag = $cells[$sheet.flag]
        $brand = if ($sheet.center) {
            switch ($cells[$sheet.center]) {
                { $_ -in @('小仓','小仓生活','xiaocang') } { 'xiaocang' }
                { $_ -in @('乐心宜','lexinyi') } { 'lexinyi' }
                default { $null }
            }
        } else { $Brands[0] }
        if (!$id -and !$flag) { continue }
        if (!$brand -and $StrictCenters) { throw "工作表 $($sheet.name) 第 $($row.rowNumber) 行的中台无法识别。" }
        if (!$brand -or !$plan.ContainsKey($brand)) { continue }
        if ($id -notmatch '^\d+$') { throw "工作表 $($sheet.name) 第 $($row.rowNumber) 行缺少有效的美团门店 ID。" }
        if (!$seen.Add($id)) { throw "工作表 $($sheet.name) 第 $($row.rowNumber) 行的门店 ID 重复。" }
        if ($flag -in @('是', '不报', '不报神券')) {
            $plan[$brand].excluded.Add($id)
        } elseif (!$flag -or $flag -in @('否', '报', '报名')) {
            $plan[$brand].included.Add($id)
        } else {
            throw "工作表 $($sheet.name) 第 $($row.rowNumber) 行的「不报神券」标记无法识别。"
        }
    }
    if (!$seen.Count) { throw '清单里没有本次中台的美团门店 ID，请核对中台列。' }

    return $plan
}
