# CLI Dock 启动器：后台拉起 Node 服务，再用 Edge 的应用窗口模式打开界面
param(
    [int]$Port = $(if ($env:CLIDOCK_PORT) { [int]$env:CLIDOCK_PORT } else { 7811 }),
    # 只起服务，不弹界面也不起托盘（给“无头运行 / 排查启动问题”用）
    [switch]$NoWindow
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$appRoot = Split-Path -Parent $root
$url = "http://127.0.0.1:$Port"
$dataDir = Join-Path $appRoot 'data'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }

function Test-Port([int]$p) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $p, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

if (-not (Test-Path (Join-Path $root 'server.js'))) {
    Write-Host "找不到 server.js，请把本脚本放在 CLI Dock 目录里。" -ForegroundColor Red
    exit 1
}

# 端口开着不代表就是 CLI Dock：别的机器上 7811 很可能被别的服务占了，
# 那种情况下再“打开界面”只会看到别人的服务，所以要先认一下是不是自己。
function Test-Dock([int]$p) {
    try {
        $state = Invoke-RestMethod -Uri "http://127.0.0.1:$p/api/state" -TimeoutSec 3 -ErrorAction Stop
        return ($null -ne $state.apps -and $null -ne $state.stats)
    } catch {
        return $false
    }
}

$nodeEnvScript = Join-Path $root 'node-env.ps1'
if (Test-Path $nodeEnvScript) {
    . $nodeEnvScript
    $skipInstall = ($env:CLIDOCK_SKIP_NODE_INSTALL -eq '1')
    $nodeInfo = Resolve-Node -NoInstall:$skipInstall
    if (-not $nodeInfo.ok) {
        Write-Host $nodeInfo.reason -ForegroundColor Red
        exit 1
    }
} else {
    $nodeInfo = $null
}
if ($nodeInfo) {
    $nodePath = $nodeInfo.path
} else {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) {
        Write-Host "没有找到 Node.js，请先安装 Node.js 18 及以上版本。" -ForegroundColor Red
        exit 1
    }
    $nodePath = $cmd.Source
}
if ($nodeInfo -and $nodeInfo.source -eq 'found') {
    Write-Host "Node.js $($nodeInfo.version)（$nodePath）"
}

# SQLite 组件：lib\ 里有就直接用，没有就静默下载（免管理员）。失败也不拦启动，退回 JSON。
$libInit = Join-Path $root 'lib-init.ps1'
if (Test-Path $libInit) {
    $libJson = $null
    try {
        $libJson = (& $libInit | Select-Object -Last 1) 2>$null
        $libResult = $libJson | ConvertFrom-Json
        if ($libResult.ok) {
            Write-Host "SQLite 组件就绪（引擎 $($libResult.version)）"
        } else {
            Write-Host "SQLite 组件不可用：$($libResult.message)" -ForegroundColor Yellow
            Write-Host "  程序会用 JSON 存储继续运行（功能不受影响）。" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "SQLite 组件检查失败：$($_.Exception.Message)（将使用 JSON 存储）" -ForegroundColor Yellow
    }
}

$dockAlreadyUp = $false
if (Test-Port $Port) {
    if (Test-Dock $Port) {
        $dockAlreadyUp = $true
        Write-Host "CLI Dock 服务已在运行（端口 $Port），直接打开界面。"
    } else {
        Write-Host "端口 $Port 被别的程序占用了，不是 CLI Dock。" -ForegroundColor Red
        Write-Host "换个端口再启动，例如：" -ForegroundColor Yellow
        Write-Host "    set CLIDOCK_PORT=7900" -ForegroundColor Yellow
        Write-Host "    Launch.cmd" -ForegroundColor Yellow
        exit 1
    }
}

if (-not $dockAlreadyUp) {
    Write-Host "正在启动后台服务…"
    $stdout = Join-Path $dataDir 'server.out.log'
    $stderr = Join-Path $dataDir 'server.err.log'
    # 显式把端口传给 node，保证 -Port 参数与 set CLIDOCK_PORT 两种方式都一致
    $env:CLIDOCK_PORT = "$Port"
    Start-Process -FilePath $nodePath -ArgumentList 'server.js' -WorkingDirectory $root `
        -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
    $ok = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        if (Test-Port $Port) { $ok = $true; break }
    }
    if (-not $ok) {
        Write-Host "服务启动失败，可以看看 $stderr，或在目录里执行 node server.js。" -ForegroundColor Red
        exit 1
    }
}

if ($NoWindow) {
    Write-Host "CLI Dock 服务已启动（无窗口模式）：$url"
    exit 0
}

$trayScript = Join-Path $root 'tray.ps1'
# 用完整路径做精确匹配：模糊匹配 *tray.ps1* 会把“命令行里恰好提到这个文件名”的
# 无关进程（比如正在编辑脚本的编辑器）也认成托盘，于是跳过启动。
$trayPattern = [regex]::Escape($trayScript)
$trayRunning = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match $trayPattern }
if (-not $trayRunning) {
    if (Test-Path $trayScript) {
        $trayOut = Join-Path $dataDir 'tray.out.log'
        $trayErr = Join-Path $dataDir 'tray.err.log'
        try {
            # 必须重定向子进程输出：不重定向时子进程会挂在父进程的管道上，
            # 父进程一退出托盘就跟着没，而且出错也看不到。
            $trayProc = Start-Process -FilePath 'powershell.exe' `
                -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $trayScript, '-Port', $Port) `
                -WindowStyle Hidden -RedirectStandardOutput $trayOut -RedirectStandardError $trayErr -PassThru
            Start-Sleep -Milliseconds 1500
            if ($trayProc.HasExited) {
                Write-Host "托盘图标没起来（退出码 $($trayProc.ExitCode)），详见 $trayErr" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "托盘图标启动失败：$($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

$edge = @(
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($edge) {
    $alreadyOpen = Get-Process -Name msedge -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*CLI Dock*' } |
        Select-Object -First 1
    if ($alreadyOpen) {
        Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DockFocus {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
        [void][DockFocus]::ShowWindow($alreadyOpen.MainWindowHandle, 9)
        [void][DockFocus]::SetForegroundWindow($alreadyOpen.MainWindowHandle)
    } else {
        Start-Process -FilePath $edge -ArgumentList @("--app=$url", '--window-size=1520,950', '--window-position=100,60')
    }
} else {
    Start-Process $url
}

Write-Host "CLI Dock 已打开：$url"
Write-Host "托盘图标已就位——关掉窗口不会退出，右键托盘图标可以重新打开或彻底退出。"
