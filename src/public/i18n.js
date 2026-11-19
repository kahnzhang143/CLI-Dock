'use strict';

/* ------------------------------------------------------------ 中英文文案表
 * 用法：
 *   t('key')                 取当前语言的文案
 *   t('key', { n: 3 })       占位符写成 {n}
 *   静态 HTML 用属性标注，切换语言时 applyI18n() 统一刷一遍：
 *     data-i18n="key"              文本内容
 *     data-i18n-html="key"         含标签的内容（用 innerHTML）
 *     data-i18n-title="key"        title 提示
 *     data-i18n-placeholder="key"  input 占位
 * 语言存在 localStorage（本窗口立即生效），同时写回后端 settings.language（托盘也跟着变）。
 */

(function (global) {
  const LANG_STORAGE_KEY = 'clidock-lang';

  const DICT = {
    zh: {
      /* ---- 通用 ---- */
      'common.cancel': '取消',
      'common.save': '保存',
      'common.close': '关闭',
      'common.copy': '复制',

      /* ---- 顶部 ---- */
      'app.title': 'CLI Dock · 本地程序管理器',
      'brand.sub': '本地程序管理器',
      'top.home.title': '返回总览',
      'top.import': '导入程序',
      'top.theme.title': '切换明亮 / 深色主题',
      'top.settings.title': '设置',
      'top.quit.title': '停止全部并退出',
      'top.stat.running': '运行中',
      'top.stat.failed': '已报错',
      'top.stat.total': '已纳管',

      /* ---- 侧栏 ---- */
      'side.title': '我的程序',
      'side.search.placeholder': '搜索名称或路径',
      'side.empty.search.title': '没有匹配的程序',
      'side.empty.search.hint': '换个关键字试试',
      'side.empty.title': '还没有导入程序',
      'side.empty.hint': '点右上角“导入程序”开始',
      'side.foot.total': '共 {n} 个程序',
      'side.foot.running': '{n} 个在跑',
      'side.foot.idle': '空闲',
      'side.starting': '启动中…',

      /* ---- 状态 ---- */
      'status.idle': '未运行',
      'status.starting': '启动中',
      'status.running': '运行中',
      'status.stopping': '停止中',
      'status.stopped': '已手动停止',
      'status.completed': '正常结束',
      'status.failed': '已报错',
      'status.restarting': '重启中',

      /* ---- 总览 ---- */
      'ov.title': '总览',
      'ov.sub': '所有已纳管的程序',
      'ov.filter.all': '全部',
      'ov.filter.running': '运行中',
      'ov.filter.failed': '已报错',
      'ov.filter.stopped': '已结束',
      'ov.stats': '{running} 个运行中 · {failed} 个报错 · 共 {total} 个',
      'ov.empty.title': '还没有任何程序',
      'ov.empty.hint': '把平时要在命令行里跑的 PowerShell / Python 脚本导进来，点一下就能启动、看日志、看状态。',
      'ov.empty.button': '＋ 导入第一个程序',
      'ov.empty.filtered': '当前筛选下没有程序',

      /* ---- 负载看板 ---- */
      'metrics.cpu': '系统 CPU',
      'metrics.cores': '{n} 线程',
      'metrics.mem': '系统内存',
      'metrics.disk': '磁盘可用',
      'metrics.disk.fail': '读取失败',
      'metrics.disk.note': '数据所在磁盘 · 日志会一直占用这里',
      'metrics.disk.nostatf': '磁盘信息不可用',
      'metrics.managed': '托管程序',
      'metrics.managed.unit': '个在跑',
      'metrics.managed.mem': '{n} MB 合计',
      'metrics.managed.off': '采集已关闭',
      'metrics.managedCpu': '托管 CPU',
      'metrics.managedCpu.off': '已关闭',
      'metrics.managedCpu.note': '所有被托管程序的合计',
      'metrics.managedCpu.noteOff': '在设置里重新打开',
      'metrics.uptime': 'Dock 已运行',
      'metrics.uptime.self': '本进程 {n} MB',
      'metrics.uptime.note': '服务进程存活时间',
      'metrics.storage': '数据存储',
      'metrics.storage.sqliteNote': '引擎 {version} · 日志 {rows} 行',
      'metrics.storage.sqliteTitle': '{file}\n{pending} 行待写入',
      'metrics.storage.fallback': '降级',
      'metrics.storage.jsonNote': 'SQLite 不可用，用的是 config.json',

      /* ---- 卡片 ---- */
      'card.noDesc': '（无备注）',
      'card.noCommand': '（未配置命令）',
      'card.uptime': '已跑 {d}',
      'card.exitCode': '退出码 {n}',
      'card.next': '下次 {t}',
      'card.pathMissing': '路径失效：找不到 {path}',
      'card.failedNote': '异常退出 · 退出码 {code} · {time}',
      'card.completedNote': '正常结束 · 退出码 0 · {time}',
      'card.start': '启动',
      'card.stop': '停止',
      'card.open': '打开地址',
      'card.logs': '查看日志',
      'card.tips.title': '小提示',
      'tips.param.key': '{{PARAM}}',
      'tips.param.text': '参数值写在参数页，命令和启动参数里都能引用',
      'tips.port.key': '端口',
      'tips.port.text': '网页类程序填上端口，卡片会出现“打开地址”',
      'tips.log.key': '日志',
      'tips.log.text': '搜索框过滤关键字，勾“仅错误”只看 stderr',
      'tips.restart.key': '自动重启',
      'tips.restart.text': '勾上后异常退出会自动重试，次数可配',

      /* ---- 详情 ---- */
      'detail.back': '← 总览',
      'detail.running': '正在运行',
      'detail.runningFor': ' · 已运行 {d}',
      'detail.triggerWrap': '（{t}）',
      'detail.trigger.schedule': '计划触发',
      'detail.trigger.autostart': '随控制台启动',
      'detail.trigger.restart': '自动重启',
      'detail.trigger.manual': '手动启动',
      'detail.failedBanner': '✖ 上次运行异常退出 · 退出码 <b>{code}</b> · 结束于 {time} · 耗时 {dur}{trig}',
      'detail.stoppedBanner': '■ 上次运行被你手动停止 · 结束于 {time} · 运行 {dur}{trig}',
      'detail.okBanner': '✔ 上次运行正常结束 · 退出码 <b>0</b> · 结束于 {time} · 耗时 {dur}{trig}',
      'detail.triggerSuffix': ' · {t}',
      'meta.runtime': '运行时',
      'meta.uptime': '已运行',
      'meta.mem': '内存',
      'meta.cpuTotal': '累计 CPU',
      'meta.exitCode': '退出码',
      'meta.restarts': '重启次数',
      'meta.schedule': '计划',
      'meta.nextRun': '下次运行',
      'meta.restartAt': '自动重启于',
      'meta.url.title': '在浏览器中打开',
      'act.restart': '重启',
      'act.edit': '编辑配置',

      /* ---- 页签 ---- */
      'tab.logs': '日志',
      'tab.params': '参数',
      'tab.schedule': '计划',
      'tab.runs': '运行记录',
      'tab.config': '配置',

      /* ---- 日志 ---- */
      'logs.search.placeholder': '在日志中搜索关键字（报错、订单号、接口路径…）',
      'logs.backLive': '← 回到实时',
      'logs.errorsOnly': '仅错误',
      'logs.follow': '自动滚动',
      'logs.clear': '清屏',
      'logs.stat.history': '历史日志',
      'logs.stat.lines': '{n} 行',
      'logs.stat.errors': '{n} 错误',
      'logs.stat.live': '实时',
      'logs.empty.idle': '还没有运行记录，点上方“启动”开始运行。',
      'logs.empty.none': '暂无日志输出。',
      'logs.copy.none': '没有可复制的日志',
      'logs.copy.ok': '已复制 {n} 行日志',
      'logs.copy.fail': '复制失败，请手动选中日志',
      'logs.history.loaded': '已载入历史日志 {file}',
      'logs.history.missing': '这条记录没有日志文件',

      /* ---- 参数 ---- */
      'params.title': '运行参数',
      'params.desc': '参数值会持久保存在本机，重启程序时自动带入。命令 / 参数 / 工作目录里可用 <code>{{参数名}}</code> 引用，同时也会作为环境变量注入。',
      'params.add': '＋ 添加参数',
      'params.save': '保存参数',
      'params.key.placeholder': '参数名，如 ENV',
      'params.value.placeholder': '参数值',
      'params.delete.title': '删除这个参数',
      'params.hint': '提示：保存后点击“启动”，参数会带进命令行；修改参数不需要重新导入程序。',
      'params.saved': '参数已保存',

      /* ---- 计划 ---- */
      'sched.title': '计划任务',
      'sched.desc': '到点自动启动。周期性跑完就退出的任务（比如每次只跑一轮的脚本）退出码 0 会显示 <strong>正常结束</strong>，只有非 0 才算报错。',
      'sched.save': '保存计划',
      'sched.enabled': '启用计划',
      'sched.mode': '触发方式',
      'sched.mode.none': '不启用',
      'sched.mode.interval': '每隔一段时间',
      'sched.mode.daily': '每天固定时间',
      'sched.mode.weekly': '每周指定几天 + 时间',
      'sched.mode.once': '指定时间，只跑一次',
      'sched.interval': '间隔',
      'sched.unit': '单位',
      'sched.unit.minutes': '分钟',
      'sched.unit.seconds': '秒',
      'sched.unit.hours': '小时',
      'sched.dailyTimes': '每天时间',
      'sched.dailyTimes.hint': '24 小时制，多个用逗号分隔',
      'sched.weekdays': '星期几',
      'sched.weekdays.hint': '可多选',
      'sched.weekday.1': '一',
      'sched.weekday.2': '二',
      'sched.weekday.3': '三',
      'sched.weekday.4': '四',
      'sched.weekday.5': '五',
      'sched.weekday.6': '六',
      'sched.weekday.0': '日',
      'sched.dayName.1': '周一',
      'sched.dayName.2': '周二',
      'sched.dayName.3': '周三',
      'sched.dayName.4': '周四',
      'sched.dayName.5': '周五',
      'sched.dayName.6': '周六',
      'sched.dayName.0': '周日',
      'sched.weeklyTimes': '运行时间',
      'sched.weeklyTimes.hint': '24 小时制，多个用逗号分隔',
      'sched.onceAt': '执行时间',
      'sched.summary.current': '当前：<b>{text}</b>',
      'sched.summary.none': '当前：<b>未启用计划</b>',
      'sched.summary.next': '下次运行：<b>{time}</b>（还有 {rest}）',
      'sched.summary.expired': '这个时间点已经过去了，不会再自动触发；重新选一个时间，或直接点「启动」。',
      'sched.summary.single': '同一时间只跑一个实例：到点时如果它还在运行，这一次会被跳过。',
      'sched.summary.exit': '“跑一次就退出”的任务不用改任何东西——退出码 0 会记为「正常结束」，非 0 才算报错。',
      'sched.need.daily': '请填写每天的时间，例如 08:30',
      'sched.need.weekdays': '请选择星期几',
      'sched.need.weeklyTimes': '请填写运行时间，例如 09:00',
      'sched.need.once': '请选择执行时间',
      'sched.saved': '计划已保存：{text}',
      'sched.disabled': '计划已关闭',
      'sched.text.none': '未启用',
      'sched.text.interval': '每隔 {n} {unit}',
      'sched.text.daily': '每天 {times}',
      'sched.text.noTimes': '（未设置时间）',
      'sched.text.weekly': '每{days} {times}',
      'sched.text.weeklyNoDays': '每周（未选择星期几）',
      'sched.text.once': '单次 {time}',
      'sched.text.onceNoTime': '单次（未设置时间）',
      'sched.dayJoin': '、',

      /* ---- 运行记录 ---- */
      'runs.title': '运行记录',
      'runs.desc': '每次启动都会留下完整日志文件，选中可回看当时输出。',
      'runs.empty.title': '还没有运行记录',
      'runs.empty.hint': '启动一次程序后，这里会留下每次运行的完整日志。',
      'runs.trigger.schedule': '计划',
      'runs.trigger.autostart': '自启',
      'runs.trigger.restart': '重启',
      'runs.trigger.manual': '手动',
      'runs.trigger.latest': '{t} · 最近',
      'runs.result.failed': '异常退出（退出码 {code}）',
      'runs.result.stopped': '手动停止',
      'runs.result.ok': '正常结束（退出码 0）',
      'runs.info': '{result} · 时长 {dur}',
      'runs.open': '回看日志',

      /* ---- 配置 ---- */
      'config.title': '配置',
      'config.desc': '导入一次即可长期使用，需要改动时点“编辑配置”。',
      'config.edit': '编辑配置',
      'config.delete': '删除程序',
      'config.row.runtime': '运行时',
      'config.row.command': '程序路径',
      'config.row.resolved': '实际路径',
      'config.row.args': '启动参数',
      'config.row.cwd': '工作目录',
      'config.row.port': '访问端口',
      'config.row.stopMode': '停止方式',
      'config.row.schedule': '计划任务',
      'config.row.autostart': '自动启动',
      'config.row.autorestart': '自动重启',
      'config.row.env': '环境变量',
      'config.row.desc': '备注',
      'config.row.created': '加入时间',
      'config.pathMissing': '  ⚠ 找不到该文件',
      'config.empty.fill': '（未填写）',
      'config.empty.none': '（无）',
      'config.empty.cwd': '（脚本所在目录）',
      'config.empty.port': '（未设置）',
      'config.notEnabled': '未启用',
      'config.scheduleValue': '{text} · 下次 {time}',
      'config.stop.graceful': '先温和退出，超时强制',
      'config.stop.force': '强制结束进程树',
      'config.autostart.on': '开：打开 CLI Dock 时自动拉起',
      'config.autostart.off': '关',
      'config.autorestart.on': '开：异常退出后最多重启 {n} 次',
      'config.autorestart.off': '关',

      /* ---- 导入 / 编辑 ---- */
      'import.title': '导入程序',
      'import.title.edit': '编辑程序',
      'import.save': '保存并纳管',
      'import.save.edit': '保存修改',
      'import.hint': '保存后会出现在左侧列表，随时一键启动',
      'import.hint.edit': '修改后保存，不影响已保存的日志',
      'import.picker.note': '从目录里挑一个程序，路径会自动填好',
      'import.picker.expand': '展开目录',
      'import.picker.up': '↑ 上一级',
      'import.picker.go': '打开',
      'import.picker.upRow': '.. 上一级',
      'import.field.name': '名称',
      'import.field.name.placeholder': '例如：库存同步脚本',
      'import.field.runtime': '运行时',
      'import.runtime.cmd': '批处理 (.cmd/.bat)',
      'import.runtime.exe': '可执行文件 (.exe)',
      'import.runtime.custom': '自定义命令行',
      'import.field.command': '程序路径 / 命令',
      'import.field.command.hint': '支持相对路径（相对本程序目录）和 ~\\ 开头（用户目录）',
      'import.field.command.placeholder': 'C:\\scripts\\sync.ps1   或   ~\\Downloads\\sync.ps1   或   samples\\hello.ps1',
      'import.field.args': '启动参数',
      'import.field.args.hint': '支持 {{参数名}} 占位',
      'import.field.cwd': '工作目录',
      'import.field.cwd.hint': '留空则使用脚本所在目录，也支持相对路径 / ~\\',
      'import.field.cwd.placeholder': 'C:\\scripts  或  ~\\Downloads',
      'import.field.port': '访问端口',
      'import.field.port.hint': '可选，网页类程序',
      'import.field.stopMode': '停止方式',
      'import.stop.force': '强制结束进程树（默认）',
      'import.stop.graceful': '先温和退出，超时再强制',
      'import.field.env': '环境变量',
      'import.field.env.hint': '每行一个 KEY=VALUE',
      'import.field.desc': '备注',
      'import.field.desc.placeholder': '这个程序做什么，出问题找谁',
      'import.switch.autostart': '打开 CLI Dock 时自动启动',
      'import.switch.autorestart': '异常退出后自动重启',
      'import.switch.maxRestarts': '最多重启',
      'import.switch.times': '次',
      'import.need.name': '请先填写名称',
      'import.need.command': '请填写要运行的程序路径',
      'import.saved': '程序已导入',
      'import.updated': '配置已更新',
      'import.picked': '已选择 {name}',

      /* ---- 设置 ---- */
      'settings.title': '设置',
      'settings.language': '界面语言',
      'settings.language.hint': '立即生效，托盘菜单一起变',
      'settings.ps': 'PowerShell 路径',
      'settings.python': 'Python 路径',
      'settings.python.hint': '可用 python / py / 绝对路径',
      'settings.grace': '温和停止的等待时间（毫秒）',
      'settings.metrics': '采集每个进程的 CPU / 内存 / 温度（会多一个常驻 PowerShell，约 80–100MB）',
      'settings.footer': '配置保存在 data/config.json',
      'settings.saved': '设置已保存',

      /* ---- 其他提示 ---- */
      'err.request': '请求失败（{code}）',
      'err.backend': '无法连接后端服务：{msg}',
      'act.started': '已发送启动命令',
      'act.failed': '操作失败',
      'app.deleted': '已删除',
      'app.deleteConfirm': '确定删除「{name}」吗？\n只会从 CLI Dock 里移除，不会删除磁盘上的脚本文件。',
      'quit.confirm': '退出 CLI Dock？\n所有正在运行的程序会被一起停止。',
      'quit.done': 'CLI Dock 已退出，可以关闭这个窗口了。',
      'theme.toDark': '切换到深色主题',
      'theme.toLight': '切换到明亮主题',
    },

    en: {
      /* ---- generic ---- */
      'common.cancel': 'Cancel',
      'common.save': 'Save',
      'common.close': 'Close',
      'common.copy': 'Copy',

      /* ---- top bar ---- */
      'app.title': 'CLI Dock · Local program manager',
      'brand.sub': 'Local program manager',
      'top.home.title': 'Back to overview',
      'top.import': 'Import program',
      'top.theme.title': 'Switch light / dark theme',
      'top.settings.title': 'Settings',
      'top.quit.title': 'Stop everything and quit',
      'top.stat.running': 'Running',
      'top.stat.failed': 'Failed',
      'top.stat.total': 'Managed',

      /* ---- sidebar ---- */
      'side.title': 'My programs',
      'side.search.placeholder': 'Search name or path',
      'side.empty.search.title': 'No matching programs',
      'side.empty.search.hint': 'Try another keyword',
      'side.empty.title': 'No programs yet',
      'side.empty.hint': 'Click “Import program” in the top right to start',
      'side.foot.total': '{n} programs',
      'side.foot.running': '{n} running',
      'side.foot.idle': 'Idle',
      'side.starting': 'starting…',

      /* ---- status ---- */
      'status.idle': 'Not running',
      'status.starting': 'Starting',
      'status.running': 'Running',
      'status.stopping': 'Stopping',
      'status.stopped': 'Stopped by you',
      'status.completed': 'Finished OK',
      'status.failed': 'Failed',
      'status.restarting': 'Restarting',

      /* ---- overview ---- */
      'ov.title': 'Overview',
      'ov.sub': 'All managed programs',
      'ov.filter.all': 'All',
      'ov.filter.running': 'Running',
      'ov.filter.failed': 'Failed',
      'ov.filter.stopped': 'Ended',
      'ov.stats': '{running} running · {failed} failed · {total} total',
      'ov.empty.title': 'No programs yet',
      'ov.empty.hint': 'Import the PowerShell / Python scripts you normally run from a command line — then start them, read logs and watch status with one click.',
      'ov.empty.button': '＋ Import your first program',
      'ov.empty.filtered': 'Nothing matches this filter',

      /* ---- metrics ---- */
      'metrics.cpu': 'System CPU',
      'metrics.cores': '{n} threads',
      'metrics.mem': 'System memory',
      'metrics.disk': 'Disk free',
      'metrics.disk.fail': 'unavailable',
      'metrics.disk.note': 'Disk holding the data · logs keep growing here',
      'metrics.disk.nostatf': 'Disk info unavailable',
      'metrics.managed': 'Managed programs',
      'metrics.managed.unit': 'running',
      'metrics.managed.mem': '{n} MB total',
      'metrics.managed.off': 'collection off',
      'metrics.managedCpu': 'Managed CPU',
      'metrics.managedCpu.off': 'off',
      'metrics.managedCpu.note': 'Sum of all managed programs',
      'metrics.managedCpu.noteOff': 'Turn it back on in settings',
      'metrics.uptime': 'Dock uptime',
      'metrics.uptime.self': 'this process {n} MB',
      'metrics.uptime.note': 'How long the service has been up',
      'metrics.storage': 'Data storage',
      'metrics.storage.sqliteNote': 'Engine {version} · {rows} log rows',
      'metrics.storage.sqliteTitle': '{file}\n{pending} rows pending',
      'metrics.storage.fallback': 'fallback',
      'metrics.storage.jsonNote': 'SQLite unavailable, using config.json',

      /* ---- cards ---- */
      'card.noDesc': '(no notes)',
      'card.noCommand': '(no command set)',
      'card.uptime': 'up {d}',
      'card.exitCode': 'exit code {n}',
      'card.next': 'next {t}',
      'card.pathMissing': 'Path is invalid: {path} not found',
      'card.failedNote': 'Exited with an error · exit code {code} · {time}',
      'card.completedNote': 'Finished normally · exit code 0 · {time}',
      'card.start': 'Start',
      'card.stop': 'Stop',
      'card.open': 'Open address',
      'card.logs': 'View logs',
      'card.tips.title': 'Tips',
      'tips.param.key': '{{PARAM}}',
      'tips.param.text': 'Put values on the Parameters tab and reference them everywhere',
      'tips.port.key': 'Port',
      'tips.port.text': 'Give a web program a port and its card shows “Open address”',
      'tips.log.key': 'Logs',
      'tips.log.text': 'Filter by keyword; “Errors only” shows just stderr',
      'tips.restart.key': 'Auto restart',
      'tips.restart.text': 'When on, a failed program is retried automatically, count configurable',

      /* ---- detail ---- */
      'detail.back': '← Overview',
      'detail.running': 'Running',
      'detail.runningFor': ' · for {d}',
      'detail.triggerWrap': ' ({t})',
      'detail.trigger.schedule': 'scheduled',
      'detail.trigger.autostart': 'started with the console',
      'detail.trigger.restart': 'auto restart',
      'detail.trigger.manual': 'manual start',
      'detail.failedBanner': '✖ Last run exited with an error · exit code <b>{code}</b> · ended {time} · took {dur}{trig}',
      'detail.stoppedBanner': '■ Last run was stopped by you · ended {time} · ran {dur}{trig}',
      'detail.okBanner': '✔ Last run finished normally · exit code <b>0</b> · ended {time} · took {dur}{trig}',
      'detail.triggerSuffix': ' · {t}',
      'meta.runtime': 'Runtime',
      'meta.uptime': 'Uptime',
      'meta.mem': 'Memory',
      'meta.cpuTotal': 'CPU total',
      'meta.exitCode': 'Exit code',
      'meta.restarts': 'Restarts',
      'meta.schedule': 'Schedule',
      'meta.nextRun': 'Next run',
      'meta.restartAt': 'Restarts at',
      'meta.url.title': 'Open in browser',
      'act.restart': 'Restart',
      'act.edit': 'Edit config',

      /* ---- tabs ---- */
      'tab.logs': 'Logs',
      'tab.params': 'Parameters',
      'tab.schedule': 'Schedule',
      'tab.runs': 'Run history',
      'tab.config': 'Config',

      /* ---- logs ---- */
      'logs.search.placeholder': 'Search the log for a keyword (error, order no., endpoint…)',
      'logs.backLive': '← Back to live',
      'logs.errorsOnly': 'Errors only',
      'logs.follow': 'Auto-scroll',
      'logs.clear': 'Clear',
      'logs.stat.history': 'History',
      'logs.stat.lines': '{n} lines',
      'logs.stat.errors': '{n} errors',
      'logs.stat.live': 'Live',
      'logs.empty.idle': 'No runs yet — click “Start” above to run it.',
      'logs.empty.none': 'No output yet.',
      'logs.copy.none': 'Nothing to copy',
      'logs.copy.ok': 'Copied {n} lines',
      'logs.copy.fail': 'Copy failed — select the text manually',
      'logs.history.loaded': 'Loaded log file {file}',
      'logs.history.missing': 'This run has no log file',

      /* ---- params ---- */
      'params.title': 'Run parameters',
      'params.desc': 'Values are stored on this machine and filled in automatically on the next start. Use <code>{{name}}</code> in the command, arguments or working directory — values are also injected as environment variables.',
      'params.add': '＋ Add parameter',
      'params.save': 'Save parameters',
      'params.key.placeholder': 'Name, e.g. ENV',
      'params.value.placeholder': 'Value',
      'params.delete.title': 'Remove this parameter',
      'params.hint': 'Tip: after saving, click “Start” — values are passed on the command line. Changing values never needs a re-import.',
      'params.saved': 'Parameters saved',

      /* ---- schedule ---- */
      'sched.title': 'Scheduled runs',
      'sched.desc': 'Starts automatically when due. A task that finishes and exits (for instance a script that runs one round) shows <strong>Finished OK</strong> for exit code 0; only a non-zero code counts as an error.',
      'sched.save': 'Save schedule',
      'sched.enabled': 'Enable schedule',
      'sched.mode': 'Trigger',
      'sched.mode.none': 'Not enabled',
      'sched.mode.interval': 'Every interval',
      'sched.mode.daily': 'Daily at fixed times',
      'sched.mode.weekly': 'Weekly on chosen days + times',
      'sched.mode.once': 'Once at a given time',
      'sched.interval': 'Interval',
      'sched.unit': 'Unit',
      'sched.unit.minutes': 'minutes',
      'sched.unit.seconds': 'seconds',
      'sched.unit.hours': 'hours',
      'sched.dailyTimes': 'Daily times',
      'sched.dailyTimes.hint': '24-hour clock, separate times with commas',
      'sched.weekdays': 'Weekdays',
      'sched.weekdays.hint': 'multiple allowed',
      'sched.weekday.1': 'Mon',
      'sched.weekday.2': 'Tue',
      'sched.weekday.3': 'Wed',
      'sched.weekday.4': 'Thu',
      'sched.weekday.5': 'Fri',
      'sched.weekday.6': 'Sat',
      'sched.weekday.0': 'Sun',
      'sched.dayName.1': 'Mon',
      'sched.dayName.2': 'Tue',
      'sched.dayName.3': 'Wed',
      'sched.dayName.4': 'Thu',
      'sched.dayName.5': 'Fri',
      'sched.dayName.6': 'Sat',
      'sched.dayName.0': 'Sun',
      'sched.weeklyTimes': 'Run times',
      'sched.weeklyTimes.hint': '24-hour clock, separate times with commas',
      'sched.onceAt': 'Run at',
      'sched.summary.current': 'Current: <b>{text}</b>',
      'sched.summary.none': 'Current: <b>schedule disabled</b>',
      'sched.summary.next': 'Next run: <b>{time}</b> (in {rest})',
      'sched.summary.expired': 'That time has already passed and will not fire again — pick a new time, or just click “Start”.',
      'sched.summary.single': 'Only one instance at a time: if it is still running when due, that round is skipped.',
      'sched.summary.exit': 'Tasks that “run once and exit” need no changes — exit code 0 is recorded as “Finished OK”, only a non-zero code counts as an error.',
      'sched.need.daily': 'Enter the daily time, e.g. 08:30',
      'sched.need.weekdays': 'Choose at least one weekday',
      'sched.need.weeklyTimes': 'Enter the run time, e.g. 09:00',
      'sched.need.once': 'Choose the date and time',
      'sched.saved': 'Schedule saved: {text}',
      'sched.disabled': 'Schedule disabled',
      'sched.text.none': 'Not enabled',
      'sched.text.interval': 'Every {n} {unit}',
      'sched.text.daily': 'Daily {times}',
      'sched.text.noTimes': '(no time set)',
      'sched.text.weekly': '{days} at {times}',
      'sched.text.weeklyNoDays': 'Weekly (no weekday chosen)',
      'sched.text.once': 'Once {time}',
      'sched.text.onceNoTime': 'Once (no time set)',
      'sched.dayJoin': ', ',

      /* ---- runs ---- */
      'runs.title': 'Run history',
      'runs.desc': 'Every start keeps a full log file; pick one to read its output.',
      'runs.empty.title': 'No runs yet',
      'runs.empty.hint': 'After the first start, every run keeps its full log here.',
      'runs.trigger.schedule': 'schedule',
      'runs.trigger.autostart': 'autostart',
      'runs.trigger.restart': 'restart',
      'runs.trigger.manual': 'manual',
      'runs.trigger.latest': '{t} · latest',
      'runs.result.failed': 'Exited with an error (exit code {code})',
      'runs.result.stopped': 'Stopped manually',
      'runs.result.ok': 'Finished normally (exit code 0)',
      'runs.info': '{result} · duration {dur}',
      'runs.open': 'Open log',

      /* ---- config ---- */
      'config.title': 'Config',
      'config.desc': 'Import once and keep using it; click “Edit config” when something changes.',
      'config.edit': 'Edit config',
      'config.delete': 'Delete program',
      'config.row.runtime': 'Runtime',
      'config.row.command': 'Program path',
      'config.row.resolved': 'Resolved path',
      'config.row.args': 'Arguments',
      'config.row.cwd': 'Working directory',
      'config.row.port': 'Port',
      'config.row.stopMode': 'Stop method',
      'config.row.schedule': 'Schedule',
      'config.row.autostart': 'Auto start',
      'config.row.autorestart': 'Auto restart',
      'config.row.env': 'Environment',
      'config.row.desc': 'Notes',
      'config.row.created': 'Added',
      'config.pathMissing': '  ⚠ file not found',
      'config.empty.fill': '(empty)',
      'config.empty.none': '(none)',
      'config.empty.cwd': '(script folder)',
      'config.empty.port': '(not set)',
      'config.notEnabled': 'Not enabled',
      'config.scheduleValue': '{text} · next {time}',
      'config.stop.graceful': 'Graceful first, then force',
      'config.stop.force': 'Force-kill the process tree',
      'config.autostart.on': 'On: starts with CLI Dock',
      'config.autostart.off': 'Off',
      'config.autorestart.on': 'On: retried up to {n} times after a failure',
      'config.autorestart.off': 'Off',

      /* ---- import / edit ---- */
      'import.title': 'Import program',
      'import.title.edit': 'Edit program',
      'import.save': 'Save and add',
      'import.save.edit': 'Save changes',
      'import.hint': 'It shows up in the list on the left and can be started with one click',
      'import.hint.edit': 'Changes are saved; existing logs are kept',
      'import.picker.note': 'Pick a program from a folder and its path is filled in',
      'import.picker.expand': 'Browse folders',
      'import.picker.up': '↑ Up',
      'import.picker.go': 'Open',
      'import.picker.upRow': '.. parent folder',
      'import.field.name': 'Name',
      'import.field.name.placeholder': 'e.g. Stock sync script',
      'import.field.runtime': 'Runtime',
      'import.runtime.cmd': 'Batch (.cmd/.bat)',
      'import.runtime.exe': 'Executable (.exe)',
      'import.runtime.custom': 'Custom command line',
      'import.field.command': 'Program path / command',
      'import.field.command.hint': 'Relative paths (to the CLI Dock folder) and ~\\ (your user folder) both work',
      'import.field.command.placeholder': 'C:\\scripts\\sync.ps1   or   ~\\Downloads\\sync.ps1   or   samples\\hello.ps1',
      'import.field.args': 'Arguments',
      'import.field.args.hint': 'supports {{name}} placeholders',
      'import.field.cwd': 'Working directory',
      'import.field.cwd.hint': 'Leave empty to use the script folder; relative paths and ~\\ work too',
      'import.field.cwd.placeholder': 'C:\\scripts  or  ~\\Downloads',
      'import.field.port': 'Port',
      'import.field.port.hint': 'optional, for web programs',
      'import.field.stopMode': 'Stop method',
      'import.stop.force': 'Force-kill the process tree (default)',
      'import.stop.graceful': 'Graceful first, then force after a timeout',
      'import.field.env': 'Environment variables',
      'import.field.env.hint': 'one KEY=VALUE per line',
      'import.field.desc': 'Notes',
      'import.field.desc.placeholder': 'What it does, and who to ask when it breaks',
      'import.switch.autostart': 'Start when CLI Dock starts',
      'import.switch.autorestart': 'Restart automatically after a failure',
      'import.switch.maxRestarts': 'Max restarts',
      'import.switch.times': 'times',
      'import.need.name': 'Enter a name first',
      'import.need.command': 'Enter the program path to run',
      'import.saved': 'Program imported',
      'import.updated': 'Config updated',
      'import.picked': 'Selected {name}',

      /* ---- settings ---- */
      'settings.title': 'Settings',
      'settings.language': 'Language',
      'settings.language.hint': 'Applies immediately, the tray menu switches too',
      'settings.ps': 'PowerShell path',
      'settings.python': 'Python path',
      'settings.python.hint': 'python, py or an absolute path',
      'settings.grace': 'Graceful stop timeout (ms)',
      'settings.metrics': 'Collect CPU / memory / temperature per process (spawns one extra PowerShell, ~80–100 MB)',
      'settings.footer': 'Settings live in data/config.json',
      'settings.saved': 'Settings saved',

      /* ---- misc ---- */
      'err.request': 'Request failed ({code})',
      'err.backend': 'Cannot reach the backend service: {msg}',
      'act.started': 'Start requested',
      'act.failed': 'Action failed',
      'app.deleted': 'Deleted',
      'app.deleteConfirm': 'Delete “{name}”?\nThis only removes it from CLI Dock; the script on disk stays.',
      'quit.confirm': 'Quit CLI Dock?\nAll running programs will be stopped too.',
      'quit.done': 'CLI Dock has quit. You can close this window.',
      'theme.toDark': 'Switch to dark theme',
      'theme.toLight': 'Switch to light theme',
    },
  };

  const LANGS = ['zh', 'en'];
  let lang = 'zh';

  function normalize(value) {
    return value === 'en' ? 'en' : 'zh';
  }

  function getLang() {
    return lang;
  }

  function locale() {
    return lang === 'en' ? 'en-US' : 'zh-CN';
  }

  /** 取文案：缺 key 时退回中文，再退回 key 本身，避免界面出现空白 */
  function t(key, vars) {
    const table = DICT[lang] || DICT.zh;
    let text = table[key];
    if (text === undefined) text = DICT.zh[key];
    if (text === undefined) text = key;
    if (vars) {
      text = String(text).replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined || vars[name] === null ? m : String(vars[name])));
    }
    return text;
  }

  /** 把一个元素当作文案容器刷成指定 key（用于 文本/HTML/title/placeholder） */
  function applyI18n(root) {
    const scope = root && root.querySelectorAll ? root : document;
    if (scope === document) {
      document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');
    }
    scope.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });
    scope.querySelectorAll('[data-i18n-html]').forEach((node) => {
      node.innerHTML = t(node.dataset.i18nHtml);
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((node) => {
      node.title = t(node.dataset.i18nTitle);
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
      node.placeholder = t(node.dataset.i18nPlaceholder);
    });
    scope.querySelectorAll('[data-i18n-aria]').forEach((node) => {
      node.setAttribute('aria-label', t(node.dataset.i18nAria));
    });
  }

  /** 切换语言：只管记下选择 + 刷静态文案，业务层随后重绘动态内容 */
  function setLang(value, opts) {
    lang = normalize(value);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch (err) {
      /* 隐私模式忽略 */
    }
    if (!opts || opts.apply !== false) applyI18n();
    return lang;
  }

  /** 启动时决定用哪种语言：?lang= → localStorage → 后端设置 → 中文 */
  function initialLang(serverLang) {
    let chosen = null;
    try {
      const q = new URLSearchParams(location.search).get('lang');
      if (q) chosen = q;
      if (!chosen) chosen = localStorage.getItem(LANG_STORAGE_KEY);
    } catch (err) {
      chosen = null;
    }
    if (!chosen) chosen = serverLang;
    return normalize(chosen);
  }

  global.I18N = { LANGS, t, getLang, setLang, applyI18n, initialLang, normalize, locale };
  global.t = t;
})(window);
