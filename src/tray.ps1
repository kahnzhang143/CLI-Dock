# CLI Dock 托盘图标：关闭窗口后仍留在托盘，右键菜单可以重新打开面板 / 停止全部 / 退出
param([int]$Port = $(if ($env:CLIDOCK_PORT) { [int]$env:CLIDOCK_PORT } else { 7811 }))

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DockWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$script:Url = "http://127.0.0.1:$Port"
$script:LogFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\tray.log'

# 界面语言跟随后端 settings.language（中文 / English），切换后 3 秒内菜单自己变
$script:Lang = 'zh'

function T([string]$Zh, [string]$En) {
    if ($script:Lang -eq 'en') { return $En }
    return $Zh
}

function Write-TrayLog([string]$Message) {
    try {
        $dir = Split-Path -Parent $script:LogFile
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        Add-Content -Path $script:LogFile -Value ("[{0}] {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message) -Encoding UTF8
    } catch { }
}
$script:Edge = @(
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

function Get-DockState {
    try {
        return Invoke-RestMethod -Uri "$($script:Url)/api/state" -TimeoutSec 2 -ErrorAction Stop
    } catch {
        return $null
    }
}

function Show-DockPanel {
    $proc = Get-Process -Name msedge -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*CLI Dock*' } |
        Select-Object -First 1
    if ($proc) {
        [void][DockWin32]::ShowWindow($proc.MainWindowHandle, 9)   # SW_RESTORE
        [void][DockWin32]::SetForegroundWindow($proc.MainWindowHandle)
        return
    }
    if ($script:Edge) {
        Start-Process -FilePath $script:Edge -ArgumentList @("--app=$($script:Url)", '--window-size=1520,950', '--window-position=100,60')
    } else {
        Start-Process $script:Url
    }
}

function Stop-AllPrograms {
    $state = Get-DockState
    if (-not $state) { return }
    foreach ($app in $state.apps) {
        if ($app.status -eq 'running' -or $app.status -eq 'starting' -or $app.status -eq 'restarting') {
            try {
                Invoke-RestMethod -Method Post -Uri "$($script:Url)/api/apps/$($app.id)/stop" -TimeoutSec 5 | Out-Null
            } catch { }
        }
    }
}

function Exit-Dock {
    try {
        Invoke-RestMethod -Method Post -Uri "$($script:Url)/api/shutdown" -TimeoutSec 5 | Out-Null
    } catch { }
    $script:notify.Visible = $false
    $script:notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
    exit 0
}

# ---- 托盘图标：现画一个深蓝圆 + 黄色 “>”，不依赖外部 ico 文件
#      配色与 /icon/cli-dock.svg 一致：蓝 #0058A3 底、黄 #FFDB00 笔触。
#      “>” 直接用两条线段画，不用字体——14px 的字体在 16px 托盘里会细到看不见
$bmp = New-Object System.Drawing.Bitmap 32, 32
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$brandBlue = [System.Drawing.Color]::FromArgb(255, 0, 88, 163)
$brandYellow = [System.Drawing.Color]::FromArgb(255, 255, 219, 0)
$g.FillEllipse((New-Object System.Drawing.SolidBrush $brandBlue), 1, 1, 30, 30)
$pen = New-Object System.Drawing.Pen -ArgumentList $brandYellow, 5
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Miter
$chevron = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF 11, 7),
    (New-Object System.Drawing.PointF 21, 16),
    (New-Object System.Drawing.PointF 11, 25)
)
$g.DrawLines($pen, $chevron)
$pen.Dispose()
$g.Dispose()
$script:icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())

$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = $script:icon
$script:notify.Text = 'CLI Dock'
$script:notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

# 先问一下服务端用的哪种语言，托盘菜单第一次就显示对
$state0 = Get-DockState
if ($state0 -and $state0.settings -and $state0.settings.language -eq 'en') { $script:Lang = 'en' }

$itemOpen = $menu.Items.Add((T '打开 CLI Dock 面板' 'Open CLI Dock panel'))
$itemOpen.Font = New-Object System.Drawing.Font($itemOpen.Font, [System.Drawing.FontStyle]::Bold)
$itemOpen.add_Click({ Show-DockPanel })

$itemWeb = $menu.Items.Add((T '在浏览器中打开' 'Open in browser'))
$itemWeb.add_Click({ Start-Process $script:Url })

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$itemStop = $menu.Items.Add((T '停止所有运行中的程序' 'Stop all running programs'))
$itemStop.add_Click({ Stop-AllPrograms })

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$itemExit = $menu.Items.Add((T '退出 CLI Dock（停止全部并关闭服务）' 'Quit CLI Dock (stop everything and shut down)'))
$itemExit.add_Click({ Exit-Dock })

function Update-TrayText {
    $itemOpen.Text = T '打开 CLI Dock 面板' 'Open CLI Dock panel'
    $itemWeb.Text = T '在浏览器中打开' 'Open in browser'
    $itemStop.Text = T '停止所有运行中的程序' 'Stop all running programs'
    $itemExit.Text = T '退出 CLI Dock（停止全部并关闭服务）' 'Quit CLI Dock (stop everything and shut down)'
}

$script:notify.ContextMenuStrip = $menu
$script:notify.add_DoubleClick({ Show-DockPanel })

# ---- 主循环：用 WinForms Timer + Application::Run()（真正跑消息泵，
#      自己用 DoEvents 拼循环会卡死，托盘菜单也会失灵）
$script:misses = 0
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 3000
$script:timer.add_Tick({
    $state = Get-DockState
    if ($state) {
        $script:misses = 0
        if ($state.settings -and $state.settings.language) {
            $lang = if ($state.settings.language -eq 'en') { 'en' } else { 'zh' }
            if ($lang -ne $script:Lang) {
                $script:Lang = $lang
                Update-TrayText
                Write-TrayLog (T "界面语言切换为中文" "UI language switched to English")
            }
        }
        $running = $state.stats.running
        $total = $state.stats.total
        $text = if ($script:Lang -eq 'en') { "CLI Dock · $running running / $total total" } else { "CLI Dock · 运行中 $running / 共 $total" }
        if ($text.Length -le 62) { $script:notify.Text = $text }
    } else {
        $script:misses++
        Write-TrayLog (T "连不上服务（第 $($script:misses) 次）" "Cannot reach the service (attempt $($script:misses))")
        if ($script:misses -ge 3) {
            Write-TrayLog (T '服务已停止，托盘退出' 'Service is gone, tray exits')
            $script:timer.Stop()
            $script:notify.Visible = $false
            $script:notify.Dispose()
            [System.Windows.Forms.Application]::Exit()
        }
    }
})
$script:timer.Start()

Write-TrayLog (T "托盘启动，服务地址 $($script:Url)" "Tray started, service at $($script:Url)")
[System.Windows.Forms.Application]::Run()

