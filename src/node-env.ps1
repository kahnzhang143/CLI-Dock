# 找 Node.js —— 找不到就免管理员自动装一份（官方 zip 解压到用户目录）
#
# 为什么用 zip 而不是 winget/msi：Node 的 MSI 是装到 Program Files 的，必须要管理员，
# 而“装不上就停下让你自己装”这个体验很差。官方 zip 解压到 %LOCALAPPDATA% 不需要任何权限，
# 也不写注册表，删掉目录就等于卸载干净。

function Get-NodeVersionOf([string]$exe) {
    if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { return $null }
    try {
        $raw = (& $exe --version 2>$null) -join ''
        if ($raw -match 'v(\d+)\.(\d+)\.(\d+)') {
            return [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
        }
    } catch { }
    return $null
}

function Install-NodePortable {
    param([string]$Target = (Join-Path $env:LOCALAPPDATA 'CLIDock\node'))

    $ProgressPreference = 'SilentlyContinue'
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    Write-Host "正在从 nodejs.org 获取 Node.js LTS 版本信息…"
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 40
    $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
    if (-not $lts) { throw '无法解析 nodejs.org 的版本列表' }

    $ver = $lts.version           # 形如 v22.11.0
    $name = "node-$ver-win-$arch"
    $url = "https://nodejs.org/dist/$ver/$name.zip"
    $zip = Join-Path $env:TEMP "$name.zip"

    Write-Host "正在下载 $url （约 30MB，只需一次）…"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 900
    if (-not (Test-Path -LiteralPath $zip)) { throw "下载失败：$url" }

    $stamp = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $tmp = Join-Path $env:TEMP "clidock-node-$stamp"
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)

    $inner = Join-Path $tmp $name
    if (-not (Test-Path -LiteralPath $inner)) {
        $dirs = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
        if ($dirs) { $inner = $dirs.FullName }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $inner 'node.exe'))) { throw '压缩包里没有 node.exe' }

    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
    Move-Item -LiteralPath $inner -Destination $Target -Force

    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue

    $exe = Join-Path $Target 'node.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw '解压后找不到 node.exe' }
    return $exe
}

<#
.SYNOPSIS
  返回可用的 Node.js（要求主版本 >= 18）。
  返回 @{ ok; path; version; source; reason }
#>
function Resolve-Node {
    param([switch]$NoInstall)

    $portable = Join-Path $env:LOCALAPPDATA 'CLIDock\node\node.exe'
    # 随包的 Node（放在 CLI Dock 根目录的 node\node.exe）：
    # 整个文件夹拷给别人、对方没有外网或不准装软件时，靠它直接跑起来。
    $bundled = @(
        (Join-Path (Split-Path -Parent $PSScriptRoot) 'node\node.exe'),
        (Join-Path $PSScriptRoot 'node\node.exe')
    )
    $candidates = @()
    if ($env:CLIDOCK_NODE) { $candidates += $env:CLIDOCK_NODE }
    $candidates += $bundled
    $onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { $candidates += $onPath.Source }
    $candidates += $portable
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }

    $tooOld = $null
    foreach ($exe in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        $ver = Get-NodeVersionOf $exe
        if (-not $ver) { continue }
        if ($ver.Major -ge 18) {
            return @{ ok = $true; path = $exe; version = "v$ver"; source = 'found' }
        }
        if (-not $tooOld) { $tooOld = @{ path = $exe; version = "v$ver" } }
    }

    if ($NoInstall) {
        $reason = if ($tooOld) {
            "检测到 Node.js $($tooOld.version)（$($tooOld.path)），版本太低，需要 18 及以上。请自行安装：https://nodejs.org/zh-cn/download"
        } else {
            "这台机器上没有找到 Node.js 18+，需要先安装：https://nodejs.org/zh-cn/download"
        }
        return @{ ok = $false; reason = $reason }
    }

    Write-Host ""
    if ($tooOld) { Write-Host "检测到 Node.js $($tooOld.version)，版本太低（需要 18+）。" -ForegroundColor Yellow }
    else { Write-Host "没有找到 Node.js，尝试免管理员自动安装…" -ForegroundColor Yellow }

    try {
        $exe = Install-NodePortable
        $ver = Get-NodeVersionOf $exe
        if (-not $ver -or $ver.Major -lt 18) { throw "装出来的版本不可用：$ver" }
        Write-Host "已安装 Node.js v$ver 到 $exe（免管理员，删掉该目录即可卸载）" -ForegroundColor Green
        return @{ ok = $true; path = $exe; version = "v$ver"; source = 'installed' }
    } catch {
        $msg = $_.Exception.Message
        Write-Host ""
        Write-Host "自动安装失败：$msg" -ForegroundColor Red
        Write-Host "常见原因：没有外网 / 代理拦截 / 用户目录不可写（无权限）。" -ForegroundColor Yellow
        Write-Host "请手动安装 Node.js 18 及以上版本，装完再双击 Launch.cmd：" -ForegroundColor Yellow
        Write-Host "    https://nodejs.org/zh-cn/download" -ForegroundColor Yellow
        Write-Host "（若已装在别的路径，可设环境变量 CLIDOCK_NODE 指向 node.exe）" -ForegroundColor Yellow
        return @{ ok = $false; reason = "自动安装失败：$msg" }
    }
}
