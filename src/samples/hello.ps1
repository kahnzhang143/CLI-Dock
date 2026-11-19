# 示例：心跳脚本（PowerShell）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File hello.ps1 0
param([int]$Rounds = 0)

$ErrorActionPreference = 'Stop'
Write-Output "[hello] 启动于 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Output "[hello] 循环次数: $(if ($Rounds -le 0) { '无限' } else { $Rounds })"

$i = 0
while ($true) {
    $i++
    Write-Output "[hello] 第 $i 次心跳 $(Get-Date -Format 'HH:mm:ss')"
    if ($i % 5 -eq 0) { [Console]::Error.WriteLine("[hello] 这是模拟的一行错误输出，用来演示错误高亮") }
    if ($Rounds -gt 0 -and $i -ge $Rounds) {
        Write-Output "[hello] 达到循环上限，正常退出"
        break
    }
    Start-Sleep -Seconds 2
}
