# CLI-Dock.exe 的入口脚本（用 ps12exe 打包成 exe）。
#
# 这层壳只做一件事：把 src\start.ps1 拉起来。真正的逻辑全在 src 里，
# 所以改了脚本不需要重新打包 exe。
#
#   CLI-Dock.exe                       打开面板（等同 Launch.cmd）
#   CLI-Dock.exe -stop                 停止服务和托盘
#   CLI-Dock.exe -Port 7900            换端口
#   CLI-Dock.exe -Port 7900 -NoWindow  只起服务，不弹界面不起托盘

$root = $PSScriptRoot   # 编译后这里的值就是 exe 所在目录（项目根）
$startScript = Join-Path $root 'src\start.ps1'
$stopScript = Join-Path $root 'src\stop.ps1'

if (-not (Test-Path -LiteralPath $startScript)) {
    Write-Host "找不到 $startScript" -ForegroundColor Red
    Write-Host "请把 CLI-Dock.exe 放在 CLI Dock 目录根下，和 src 文件夹同级。" -ForegroundColor Yellow
    exit 1
}

# 参数自己解析成具名参数再 splat：
#   - 直接 & script @array 会把数组元素当“位置参数”，-Port 就被当成 Port 的值
#   - 也不要用子进程转发，多一层 PowerShell 会让 exe 迟迟不退出
$wantStop = $false
$params = @{}
for ($i = 0; $i -lt $args.Count; $i++) {
    $a = "$($args[$i])"
    if ($a -match '^(--?)?stop$') { $wantStop = $true; continue }
    if ($a -match '^--?port$' -and ($i + 1) -lt $args.Count) {
        $params['Port'] = [int]$args[$i + 1]
        $i++
        continue
    }
    if ($a -match '^--?nowindow$') { $params['NoWindow'] = $true; continue }
    Write-Host "忽略未知参数：$a" -ForegroundColor Yellow
}

try {
    if ($wantStop) {
        if (Test-Path -LiteralPath $stopScript) { & $stopScript @params }
    } else {
        & $startScript @params
    }
} catch {
    Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
exit 0
