# SQLite 数据代理：Node 加载不了 .NET 程序集，所以由这个常驻 PowerShell 进程持有连接，
# 走 stdin/stdout 的 JSON 行协议接活（和 metrics.ps1 常驻是同一个思路）。
#
# 两种模式：
#   .\db-host.ps1 -Db data\cli-dock.db                 常驻，逐行读 stdin 的 JSON 请求
#   .\db-host.ps1 -Db data\cli-dock.db -Request '{...}' 一次性执行后退出（启动时同步读取用）
#
# 请求：{"id":1,"op":"query|exec|scalar|batch|ping","sql":"...","params":[...],"batch":[{sql,params}]}
# 响应：{"id":1,"ok":true,"rows":[...]} / {"id":1,"ok":false,"error":"..."}

param(
    [string]$Db,
    [string]$Request,
    [string]$LibDir = (Join-Path $PSScriptRoot 'lib'),
    [int]$IdleTimeoutSec = 0
)

$ErrorActionPreference = 'Stop'

# 输出必须是干净的 UTF-8 单行 JSON：先切编码，再保证所有日志都去 stderr
try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
} catch { }

# 关键：管道里的 UTF-8 不能交给 [Console]::Out/In —— 它们按控制台代码页（中文系统是 GBK）解码，
# 中文日志进库就成了 "τ¼¼ 3 µ¼¬" 这种乱码。这里直接拿标准流，用 UTF-8 读写。
$stdinReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
$stdoutWriter = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$stdoutWriter.AutoFlush = $true

function Write-Log([string]$text) {
    try { [Console]::Error.WriteLine("[db-host] $text") } catch { }
}

function Send($obj) {
    $json = ConvertTo-Json -InputObject $obj -Compress -Depth 8
    $stdoutWriter.WriteLine($json)
    $stdoutWriter.Flush()
}

function ConvertTo-DbValue($value) {
    if ($null -eq $value) { return [System.DBNull]::Value }
    if ($value -is [bool]) { if ($value) { return 1 } else { return 0 } }
    return $value
}

$dllPath = Join-Path $LibDir 'System.Data.SQLite.dll'
if (-not (Test-Path -LiteralPath $dllPath)) {
    Write-Log "找不到 $dllPath，请先运行 lib-init.ps1"
    if ($Request) { Send @{ ok = $false; error = '缺少 System.Data.SQLite.dll' } }
    exit 1
}

try {
    if (-not ('System.Data.SQLite.SQLiteConnection' -as [type])) { Add-Type -Path $dllPath }
} catch {
    Write-Log "加载 System.Data.SQLite 失败：$($_.Exception.Message)"
    if ($Request) { Send @{ ok = $false; error = "加载失败：$($_.Exception.Message)" } }
    exit 1
}

if (-not $Db) { $Db = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\cli-dock.db' }
$dbFull = [System.IO.Path]::GetFullPath($Db)
$dbDir = Split-Path -Parent $dbFull
if ($dbDir -and -not (Test-Path -LiteralPath $dbDir)) { New-Item -ItemType Directory -Path $dbDir -Force | Out-Null }

if (-not (Test-Path -LiteralPath $dbFull) -and $Request) {
    # 一次性模式也可能是“首次建库”，不需要提前存在
}

$connStr = "Data Source=$dbFull;Version=3;Pooling=False;BusyTimeout=5000;"
try {
    $conn = New-Object System.Data.SQLite.SQLiteConnection($connStr)
    $conn.Open()
    $setup = $conn.CreateCommand()
    $setup.CommandText = 'PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;'
    $setup.ExecuteNonQuery() | Out-Null
    $setup.Dispose()
} catch {
    Write-Log "打开数据库失败：$($_.Exception.Message)"
    if ($Request) { Send @{ ok = $false; error = "打开数据库失败：$($_.Exception.Message)" } }
    exit 1
}

$cmdCache = @{}

function Get-Cmd([string]$sql) {
    if ($cmdCache.ContainsKey($sql)) { return $cmdCache[$sql] }
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $sql
    $cmdCache[$sql] = $cmd
    return $cmd
}

function Invoke-One($req) {
    $sql = [string]$req.sql
    if (-not $sql) { throw '缺少 sql' }
    $cmd = Get-Cmd $sql
    $cmd.Parameters.Clear()
    $params = @()
    if ($req.params) { $params = @($req.params) }
    for ($i = 0; $i -lt $params.Count; $i++) {
        $cmd.Parameters.AddWithValue("@p$i", (ConvertTo-DbValue $params[$i])) | Out-Null
    }
    $op = [string]$req.op
    if (-not $op) { $op = 'exec' }

    if ($op -eq 'scalar') {
        $value = $cmd.ExecuteScalar()
        if ($value -is [System.DBNull]) { $value = $null }
        return @{ ok = $true; value = $value }
    }
    if ($op -eq 'query') {
        $reader = $cmd.ExecuteReader()
        $rows = New-Object System.Collections.ArrayList
        try {
            while ($reader.Read()) {
                $row = [ordered]@{}
                for ($c = 0; $c -lt $reader.FieldCount; $c++) {
                    $name = $reader.GetName($c)
                    $value = $reader.GetValue($c)
                    if ($value -is [System.DBNull]) { $value = $null }
                    $row[$name] = $value
                }
                [void]$rows.Add($row)
            }
        } finally {
            $reader.Close()
        }
        return @{ ok = $true; rows = @($rows) }
    }
    $affected = $cmd.ExecuteNonQuery()
    return @{ ok = $true; affected = $affected }
}

function Invoke-Batch($req) {
    $items = @($req.batch)
    $trans = $conn.BeginTransaction()
    $affected = 0
    try {
        foreach ($item in $items) {
            $cmd = Get-Cmd ([string]$item.sql)
            $cmd.Transaction = $trans
            $cmd.Parameters.Clear()
            $params = @()
            if ($item.params) { $params = @($item.params) }
            for ($i = 0; $i -lt $params.Count; $i++) {
                $cmd.Parameters.AddWithValue("@p$i", (ConvertTo-DbValue $params[$i])) | Out-Null
            }
            $affected += $cmd.ExecuteNonQuery()
        }
        $trans.Commit()
        return @{ ok = $true; affected = $affected }
    } catch {
        try { $trans.Rollback() } catch { }
        throw
    } finally {
        try { $trans.Dispose() } catch { }
    }
}

function Invoke-Init($req) {
    # 启动用：建表（幂等）+ 一次返回多组查询结果，让 Node 一次进程启动就能拿到全部数据
    $affected = 0
    if ($req.batch) {
        $batchResult = Invoke-Batch $req
        $affected = $batchResult.affected
    }
    $results = @()
    foreach ($q in @($req.queries)) {
        if (-not $q) { continue }
        $cmd = Get-Cmd ([string]$q)
        $cmd.Parameters.Clear()
        $reader = $cmd.ExecuteReader()
        $rows = New-Object System.Collections.ArrayList
        try {
            while ($reader.Read()) {
                $row = [ordered]@{}
                for ($c = 0; $c -lt $reader.FieldCount; $c++) {
                    $value = $reader.GetValue($c)
                    if ($value -is [System.DBNull]) { $value = $null }
                    $row[$reader.GetName($c)] = $value
                }
                [void]$rows.Add($row)
            }
        } finally {
            $reader.Close()
        }
        $results += , @($rows)
    }
    return @{ ok = $true; affected = $affected; results = $results }
}

function Invoke-Request($req) {
    $id = $req.id
    try {
        $op = [string]$req.op
        if ($op -eq 'ping') { return @{ id = $id; ok = $true; pong = $true } }
        if ($op -eq 'init') {
            $result = Invoke-Init $req
        } elseif ($op -eq 'batch') {
            $result = Invoke-Batch $req
        } else {
            $result = Invoke-One $req
        }
        $result.id = $id
        return $result
    } catch {
        return @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
}

# —— 一次性模式 ——
if ($Request) {
    try {
        $req = ConvertFrom-Json -InputObject $Request
    } catch {
        Send @{ ok = $false; error = "请求 JSON 解析失败：$($_.Exception.Message)" }
        $conn.Close()
        exit 1
    }
    $response = Invoke-Request $req
    Send $response
    try { $conn.Close() } catch { }
    exit 0
}

# —— 常驻模式 ——
Send @{ id = 0; ok = $true; ready = $true; db = $dbFull }
$lastActive = Get-Date
while ($true) {
    $line = $stdinReader.ReadLine()
    if ($null -eq $line) { break }          # 父进程退出 → stdin 关闭 → 跟着退
    $line = $line.Trim()
    if (-not $line) { continue }
    if ($line -eq 'quit' -or $line -eq '{"op":"quit"}') { break }
    $lastActive = Get-Date

    $req = $null
    try {
        $req = ConvertFrom-Json -InputObject $line
    } catch {
        Send @{ ok = $false; error = "JSON 解析失败：$($_.Exception.Message)" }
        continue
    }
    if ($req.op -eq 'quit') { break }
    Send (Invoke-Request $req)

    if ($IdleTimeoutSec -gt 0 -and ((Get-Date) - $lastActive).TotalSeconds -gt $IdleTimeoutSec) { break }
}

foreach ($key in $cmdCache.Keys) { try { $cmdCache[$key].Dispose() } catch { } }
try { $conn.Close() } catch { }
