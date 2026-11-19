# 停止 CLI Dock 以及它托管的所有程序
param([int]$Port = $(if ($env:CLIDOCK_PORT) { [int]$env:CLIDOCK_PORT } else { 7811 }))

try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/shutdown" -TimeoutSec 5 | Out-Null
    Write-Host "CLI Dock 已停止，托管的程序也一起结束了。"
} catch {
    Write-Host "没有发现正在运行的 CLI Dock（端口 $Port 无响应）。"
}

# 托盘图标如果还在，一并关掉（用完整路径精确匹配，避免误杀只是命令行里
# 提到 tray.ps1 的其他进程）
$trayScript = Join-Path $PSScriptRoot 'tray.ps1'
$trayPattern = [regex]::Escape($trayScript)
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match $trayPattern } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
Write-Host "托盘图标已关闭。"
