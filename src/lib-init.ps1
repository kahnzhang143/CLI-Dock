# 准备 lib\ 里的 System.Data.SQLite.dll（含 x64/x86 的 SQLite.Interop.dll）
#
# 为什么是三个文件而不是一个：System.Data.SQLite 是“托管 + 原生”混合程序集，
# 只有 System.Data.SQLite.dll 时，一 Open() 就会报
#   Unable to load DLL 'SQLite.Interop.dll'
# 官方的 NuGet 实包里这三件套是一起的，所以从 nuget.org 下
# Stub.System.Data.SQLite.Core.NetFramework 解压出来即可，全程免管理员、不写注册表。
#
# 用法：
#   .\lib-init.ps1            检查，缺了就下载安装（人类可读输出走 Write-Host）
#   .\lib-init.ps1 -Quiet     不打印过程
#   .\lib-init.ps1 -Force     强制重新下载
#   .\lib-init.ps1 -Check     只检查不下载
# 契约：stdout 只输出一行 JSON 结果 { ok, path, interop64, interop86, version, message }

param(
    [switch]$Quiet,
    [switch]$Force,
    [switch]$Check,
    [string]$Version = '1.0.119'
)

$ErrorActionPreference = 'Stop'

# 输出的 JSON 必须是 UTF-8：否则中文 message 会按控制台代码页写成乱码
try {
    $utf8Out = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8Out
    $OutputEncoding = $utf8Out
} catch { }

function Invoke-LibInit {
    $root = $PSScriptRoot
    $libDir = Join-Path $root 'lib'
    $dllPath = Join-Path $libDir 'System.Data.SQLite.dll'
    $interop64 = Join-Path $libDir 'x64\SQLite.Interop.dll'
    $interop86 = Join-Path $libDir 'x86\SQLite.Interop.dll'

    function Say([string]$text, [string]$color = 'Gray') {
        if (-not $Quiet) { Write-Host $text -ForegroundColor $color }
    }

    # 真的加载一次并开个内存库：文件在不等于能用（版本不对、缺 interop、被杀软拦都会失败）
    function Test-SqliteRuntime([string]$Dll) {
        try {
            if (-not ('System.Data.SQLite.SQLiteConnection' -as [type])) { Add-Type -Path $Dll }
            $conn = New-Object System.Data.SQLite.SQLiteConnection('Data Source=:memory:;Version=3')
            $conn.Open()
            $cmd = $conn.CreateCommand()
            $cmd.CommandText = 'select sqlite_version()'
            $ver = [string]$cmd.ExecuteScalar()
            $conn.Close()
            return @{ ok = $true; sqlite = $ver }
        } catch {
            $msg = $_.Exception.Message
            if ($_.Exception.InnerException) { $msg = "$msg / $($_.Exception.InnerException.Message)" }
            return @{ ok = $false; error = $msg }
        }
    }

    $present = (Test-Path -LiteralPath $dllPath) -and (Test-Path -LiteralPath $interop64) -and (Test-Path -LiteralPath $interop86)
    if ($present -and -not $Force) {
        $probe = Test-SqliteRuntime $dllPath
        if ($probe.ok) {
            Say "SQLite 运行时已就绪：$dllPath（引擎 $($probe.sqlite)）" 'DarkGray'
            return @{ ok = $true; path = $dllPath; interop64 = $interop64; interop86 = $interop86; version = $probe.sqlite; message = '已存在' }
        }
        Say "lib\ 里的 SQLite 组件加载失败，准备重新安装：$($probe.error)" 'Yellow'
        $Force = $true
    }

    if ($Check) {
        return @{ ok = $false; message = 'lib\ 里缺少 System.Data.SQLite.dll 或 SQLite.Interop.dll（-Check 不下载）'; path = $dllPath }
    }

    Say "正在准备 SQLite 组件（下载 System.Data.SQLite，约 11MB，只需一次）…" 'Yellow'
    $ProgressPreference = 'SilentlyContinue'
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

    $pkgId = 'stub.system.data.sqlite.core.netframework'
    $tmpDir = Join-Path $env:TEMP ("clidock-lib-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $nupkg = Join-Path $tmpDir "$pkgId.nupkg"

    try {
        # 版本固定优先（可复现），拿不到就退回 nuget 最新版
        $versions = @($Version)
        try {
            $index = Invoke-RestMethod "https://api.nuget.org/v3-flatcontainer/$pkgId/index.json" -UseBasicParsing -TimeoutSec 40
            if ($index.versions -and $index.versions.Count) {
                $latest = $index.versions[-1]
                if ($latest -ne $Version) { $versions += $latest }
            }
        } catch { }

        $downloaded = $false
        $usedVersion = $Version
        foreach ($v in $versions) {
            $url = "https://api.nuget.org/v3-flatcontainer/$pkgId/$v/$pkgId.$v.nupkg"
            try {
                Say "  下载 $url" 'DarkGray'
                Invoke-WebRequest -Uri $url -OutFile $nupkg -UseBasicParsing -TimeoutSec 600
                if ((Get-Item $nupkg).Length -gt 1MB) { $downloaded = $true; $usedVersion = $v; break }
            } catch {
                Say "  版本 $v 下载失败：$($_.Exception.Message)" 'DarkGray'
            }
        }
        if (-not $downloaded) { throw '从 nuget.org 下载失败（无外网或被代理拦截）' }

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [System.IO.Compression.ZipFile]::OpenRead($nupkg)
        $map = @(
            @{ entry = 'lib/net46/System.Data.SQLite.dll'; dest = $dllPath },
            @{ entry = 'build/net46/x64/SQLite.Interop.dll'; dest = $interop64 },
            @{ entry = 'build/net46/x86/SQLite.Interop.dll'; dest = $interop86 }
        )
        foreach ($item in $map) {
            $entry = $zip.Entries | Where-Object { $_.FullName -eq $item.entry } | Select-Object -First 1
            if (-not $entry) { throw "包里找不到 $($item.entry)" }
            $parent = Split-Path -Parent $item.dest
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $item.dest, $true)
            Say ("  释放 {0} ({1:N0} KB)" -f $item.dest, ((Get-Item $item.dest).Length / 1KB)) 'DarkGray'
        }
        $zip.Dispose()

        $probe = Test-SqliteRuntime $dllPath
        if (-not $probe.ok) { throw "释放完成但仍无法加载：$($probe.error)" }

        Say "SQLite 组件已就绪（引擎 $($probe.sqlite)，包版本 $usedVersion）：$libDir" 'Green'
        return @{ ok = $true; path = $dllPath; interop64 = $interop64; interop86 = $interop86; version = $probe.sqlite; message = "已下载安装（$usedVersion）" }
    } catch {
        $msg = $_.Exception.Message
        Say "SQLite 组件准备失败：$msg" 'Red'
        Say "程序会退回 JSON 存储（功能不受影响）。要启用 SQLite，可手动把官方 NuGet 包" 'Yellow'
        Say "  Stub.System.Data.SQLite.Core.NetFramework 里的三件套放到：" 'Yellow'
        Say "    lib\System.Data.SQLite.dll" 'Yellow'
        Say "    lib\x64\SQLite.Interop.dll" 'Yellow'
        Say "    lib\x86\SQLite.Interop.dll" 'Yellow'
        return @{ ok = $false; message = $msg; path = $dllPath; interop64 = $interop64; interop86 = $interop86 }
    } finally {
        Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$result = Invoke-LibInit
# 结果走“输出流”（不是 [Console]::Out）：这样 start.ps1 里用 & 调用能直接 | ConvertFrom-Json，
# 而作为独立进程被 Node 启动时同样会落到 stdout 上，两边都能解析。
Write-Output (ConvertTo-Json -InputObject $result -Compress -Depth 5)
exit $(if ($result.ok) { 0 } else { 1 })
