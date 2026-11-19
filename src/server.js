'use strict';

/**
 * CLI Dock —— 本地命令行程序管理器（后端）
 * 零依赖，只使用 Node 内置模块。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const ROOT = __dirname;
// 代码全在 src\，运行数据（数据库、日志）放在上一级 data\：
// 这样升级/替换 src 里的程序文件不会碰到数据，备份时只拷 data 就够了。
const APP_ROOT = path.dirname(ROOT);
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(APP_ROOT, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SAMPLES_DIR = path.join(ROOT, 'samples');

const HOST = '127.0.0.1';
const PORT = Number(process.env.CLIDOCK_PORT || 7811);
const MAX_LINES = 4000;
const MAX_RUNS_KEPT = 30;
const RUNNABLE_EXT = new Set(['.ps1', '.py', '.cmd', '.bat', '.exe', '.js', '.vbs']);

const SYS_ROOT = process.env.SystemRoot || 'C:\\Windows';
const PS_EXE = path.join(SYS_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CMD_EXE = process.env.ComSpec || path.join(SYS_ROOT, 'System32', 'cmd.exe');
const TASKKILL_EXE = path.join(SYS_ROOT, 'System32', 'taskkill.exe');

fs.mkdirSync(LOG_DIR, { recursive: true });

/**
 * 把配置里写的路径还原成真实路径。三种写法都支持：
 *   1) `~\Downloads\x.ps1`   → 用户目录下（换机器换用户名也能用）
 *   2) `samples\x.ps1`       → 相对 CLI Dock 目录（整个文件夹搬到哪都能用）
 *   3) `C:\xxx\x.ps1`        → 绝对路径，原样使用
 * 这样 config.json 不必写死绝对路径，拷到别的机器才不会全失效。
 */
function resolveUserPath(raw) {
  const p = String(raw == null ? '' : raw).trim().replace(/^"(.*)"$/, '$1').trim();
  if (!p) return '';
  if (p === '~') return os.homedir();
  if (/^~[\\/]/.test(p)) return path.join(os.homedir(), p.slice(2));
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.resolve(ROOT, p);
}

/** 反过来：能相对化就相对化，让 config.json 不再写死这台机器的绝对路径。
 *  - 在 CLI Dock 目录里      → `samples\x.ps1`
 *  - 在用户目录里            → `~\Downloads\x.ps1`
 *  - 其它（D:\ 盘等）        → 保持绝对路径
 */
function toPortablePath(abs) {
  const p = String(abs == null ? '' : abs).trim();
  if (!p || !path.isAbsolute(p)) return p;
  const inside = (base) => {
    const rel = path.relative(base, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel;
  };
  const inRoot = inside(ROOT);
  if (inRoot) return inRoot;
  const inHome = inside(os.homedir());
  if (inHome) return '~\\' + inHome;
  return p;
}

/** 判断这个“命令”是不是一个文件路径（而不是 python/curl 这种命令名）。 */
function looksLikePath(command) {
  return /[\\/]/.test(command) || /\.(ps1|py|cmd|bat|exe|js|vbs)$/i.test(command);
}

/* PowerShell 启动器：把输出编码切成 UTF-8，再把参数原样交给真正的脚本。
 *
 * 两个必须踩过的坑：
 *  1) @array splat 只按“位置”传参，"-Name value" 这种具名参数根本绑不上，
 *     所以要把参数拆成 hashtable（具名）+ array（位置）分别 splat。
 *  2) 参数为空时不能 splat：$null 会被当成一个真实参数传进去，
 *     目标脚本的 [int] 参数解析成 0，撞上 [ValidateRange()] 就直接启动失败。
 *  3) 调用失败（参数校验、路径错误…）必须回非 0 退出码，
 *     否则界面会显示“正常结束”，看不出这个程序其实起不来。
 */
const PS_LAUNCHER = path.join(DATA_DIR, 'launcher.ps1');

function ensureLauncher() {
  const content = [
    'param(',
    '  [Parameter(Mandatory = $true)][string]$Target,',
    '  [Parameter(ValueFromRemainingArguments = $true)]$Rest',
    ')',
    'try {',
    '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '  $OutputEncoding = [System.Text.Encoding]::UTF8',
    '} catch { }',
    '',
    '$named = @{}',
    '$positional = @()',
    '$tokens = @()',
    'if ($null -ne $Rest) {',
    '  foreach ($item in $Rest) { if ($null -ne $item) { $tokens += [string]$item } }',
    '}',
    'for ($i = 0; $i -lt $tokens.Count; $i++) {',
    '  $token = $tokens[$i]',
    '  if ($token -match \'^-{1,2}[A-Za-z_][\\w-]*(:.+)?$\') {',
    '    if ($token -match \'^-(?<name>[A-Za-z_][\\w-]*):(?<val>.+)$\') {',
    "      $named[$Matches['name']] = $Matches['val']",
    '      continue',
    '    }',
    '    $name = $token.TrimStart(\'-\')',
    '    $next = $null',
    '    if ($i + 1 -lt $tokens.Count) { $next = $tokens[$i + 1] }',
    '    if ($null -ne $next -and $next -notmatch \'^-{1,2}[A-Za-z_]\') {',
    '      $named[$name] = $next',
    '      $i++',
    '    } else {',
    '      $named[$name] = $true',
    '    }',
    '  } else {',
    '    $positional += $token',
    '  }',
    '}',
    '',
    'try {',
    '  & $Target @named @positional',
    '  $success = $?',
    '} catch {',
    '  [Console]::Error.WriteLine([string]$_.Exception.Message)',
    '  exit 1',
    '}',
    '',
    'if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    'if (-not $success) { exit 1 }',
    'exit 0',
    '',
  ].join('\r\n');
  try {
    fs.writeFileSync(PS_LAUNCHER, '\ufeff' + content, 'utf8');
  } catch (err) {
    console.error('[launcher] 写入失败', err.message);
  }
}

ensureLauncher();

/* ---------------------------------------------------------------- 编码 */

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
const GBK_DECODER = (() => {
  try {
    return new TextDecoder('gbk');
  } catch (err) {
    return null;
  }
})();

function decodeLine(buf) {
  if (!buf || buf.length === 0) return '';
  try {
    return UTF8_STRICT.decode(buf);
  } catch (err) {
    if (GBK_DECODER) return GBK_DECODER.decode(buf);
    return buf.toString('latin1');
  }
}

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function cleanLine(text) {
  let out = String(text).replace(ANSI_RE, '');
  // Windows 的子进程一般输出 CRLF；进度条会用 \r 覆盖同一行。
  // 取最后一段非空白内容，避免把整行当成空行丢掉。
  const parts = out.split('\r');
  if (parts.length > 1) {
    out = '';
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].trim() !== '') {
        out = parts[i];
        break;
      }
    }
  }
  return out.replace(/[ \t]+$/, '');
}

/* ---------------------------------------------------------------- 配置 */

const DEFAULT_SETTINGS = {
  python: 'python',
  powershell: PS_EXE,
  stopGraceMs: 2500,
  // 进程负载采集要多养一个常驻 PowerShell（约 80MB），关掉就只看系统级负载
  metricsEnabled: true,
  // 界面语言：zh（中文）/ en（English），界面、托盘、系统日志行都跟它走
  language: 'zh',
};

function uid(prefix) {
  return prefix + crypto.randomBytes(6).toString('hex');
}

function detectRuntime(command) {
  const ext = path.extname(String(command || '')).toLowerCase();
  if (ext === '.ps1') return 'ps1';
  if (ext === '.py') return 'py';
  if (ext === '.cmd' || ext === '.bat') return 'cmd';
  if (ext === '.exe') return 'exe';
  return 'custom';
}

/** 运行状态统一收敛：exit 0 → 正常结束(completed)，非 0 → 异常退出(failed) */
function normalizeStatus(raw) {
  if (raw === 'exited' || raw === 'completed') return 'completed';
  if (raw === 'crashed' || raw === 'failed') return 'failed';
  return raw || 'idle';
}

const SCHEDULE_MODES = ['none', 'interval', 'daily', 'weekly', 'once'];
const SCHEDULE_UNITS = ['seconds', 'minutes', 'hours'];
const UNIT_MS = { seconds: 1000, minutes: 60000, hours: 3600000 };
// 数字沿用 JS 的 Date#getDay()：0 = 周日
const WEEK_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEK_TEXT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_ALIAS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** "08:30, 17:30" → [{h:8,m:30},{h:17,m:30}]，无效项丢弃 */
function parseTimes(raw) {
  return String(raw || '')
    .split(/[,\s;，、]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(\d{1,2})[:：](\d{2})$/);
      if (!m) return null;
      const h = Number(m[1]);
      const mi = Number(m[2]);
      if (h > 23 || mi > 59) return null;
      return { h, m: mi };
    })
    .filter(Boolean)
    .sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m));
}

/** "1,3,5" / [1,3,5] / ["周一"] → [1,3,5]，只要 0..6 */
function parseWeekdays(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,\s;，、]+/);
  const out = [];
  list.forEach((item) => {
    const s = String(item).trim();
    if (!s) return;
    if (/^[0-6]$/.test(s)) {
      out.push(Number(s));
      return;
    }
    const idx = WEEK_TEXT.findIndex((t) => t === s || t === s.replace('星期', '周'));
    if (idx >= 0) {
      out.push(idx);
      return;
    }
    // 也认英文写法：Mon / Monday / mon
    const en = WEEK_ALIAS[s.slice(0, 3).toLowerCase()];
    if (en !== undefined) out.push(en);
  });
  return [...new Set(out)].sort((a, b) => a - b);
}

function normalizeSchedule(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: !!s.enabled,
    mode: SCHEDULE_MODES.includes(s.mode) ? s.mode : 'none',
    intervalValue: Number(s.intervalValue) > 0 ? Number(s.intervalValue) : 30,
    intervalUnit: SCHEDULE_UNITS.includes(s.intervalUnit) ? s.intervalUnit : 'minutes',
    times: typeof s.times === 'string' ? s.times : Array.isArray(s.times) ? s.times.join(',') : '',
    // 每周模式：0=周日 … 6=周六
    weekdays: parseWeekdays(s.weekdays).join(','),
    at: typeof s.at === 'string' ? s.at : '',
  };
}

function normalizeRunRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    runId: raw.runId || null,
    status: normalizeStatus(raw.status),
    exitCode: raw.exitCode === undefined ? null : raw.exitCode,
    startedAt: raw.startedAt || null,
    endedAt: raw.endedAt || null,
    log: raw.log || null,
    trigger: raw.trigger || 'manual',
  };
}

function normalizeApp(raw) {
  const app = raw && typeof raw === 'object' ? raw : {};
  return {
    id: app.id || uid('app_'),
    name: String(app.name || tr('未命名程序', 'Untitled program')),
    description: String(app.description || ''),
    runtime: app.runtime || detectRuntime(app.command),
    command: String(app.command || ''),
    args: String(app.args || ''),
    cwd: String(app.cwd || ''),
    env: String(app.env || ''),
    port: app.port ? String(app.port) : '',
    params: Array.isArray(app.params)
      ? app.params
          .filter((p) => p && p.key)
          .map((p) => ({ key: String(p.key), label: String(p.label || ''), def: String(p.def ?? ''), hint: String(p.hint || '') }))
      : [],
    values: app.values && typeof app.values === 'object' ? app.values : {},
    autoStart: !!app.autoStart,
    autoRestart: !!app.autoRestart,
    maxRestarts: Number.isFinite(app.maxRestarts) ? app.maxRestarts : 5,
    stopMode: app.stopMode === 'graceful' ? 'graceful' : 'force',
    schedule: normalizeSchedule(app.schedule),
    createdAt: app.createdAt || Date.now(),
    lastRun: normalizeRunRecord(app.lastRun),
    runs: Array.isArray(app.runs) ? app.runs.map(normalizeRunRecord).filter(Boolean).slice(0, MAX_RUNS_KEPT) : [],
  };
}

function loadConfig() {
  try {
    // 用记事本之类的编辑器改过 config.json 会带 BOM，JSON.parse 会直接报错，
    // 那样就会静默变成“0 个程序”，所以先剥掉 BOM。
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return {
      settings: Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {}),
      // 老配置里存的是绝对路径：能相对化就转成 samples\x.ps1 / ~\Downloads\x.ps1，
      // 这样以后整个文件夹搬走、或者换了用户名，条目依然有效
      apps: Array.isArray(parsed.apps)
        ? parsed.apps.map(normalizeApp).map((app) => {
            app.command = toPortablePath(app.command);
            app.cwd = toPortablePath(app.cwd);
            return app;
          })
        : [],
    };
  } catch (err) {
    return { settings: Object.assign({}, DEFAULT_SETTINGS), apps: [] };
  }
}

let config = loadConfig();
let saveTimer = null;

/* ---------------------------------------------------------------- 界面语言
 * 服务端也会产生要显示在界面上的文字（计划描述、系统日志行、接口报错、
 * 目录快捷方式名）。这些都按 settings.language 出，一处切换全部跟着变。
 */
function uiLang() {
  return config.settings && config.settings.language === 'en' ? 'en' : 'zh';
}

/** 二选一文案：tr('中文', 'English') */
function tr(zh, en) {
  return uiLang() === 'en' ? en : zh;
}

/* ---------------------------------------------------------------- 存储层
 * 数据落在 data\cli-dock.db（SQLite，经 lib\System.Data.SQLite.dll）。
 * 任何一步不可用（没 lib、没外网、DLL 加载失败）就退回 data\config.json，
 * 功能不受影响，界面里会标出当前用的是哪种。
 */
const Store = require('./db-client').Store;
const store = new Store({ root: ROOT, dbFile: path.join(DATA_DIR, 'cli-dock.db') });
const STORAGE_BOOT = (function bootStorage() {
  const result = store.initSync();
  if (!result || !result.ok) {
    console.warn(`[storage] SQLite 不可用，使用 JSON：${store.reason}`);
    return { mode: 'json', reason: store.reason };
  }
  const fromDb = {
    settings: Object.assign({}, DEFAULT_SETTINGS, result.settings || {}),
    apps: (result.apps || []).map(normalizeApp).map((app) => {
      app.command = toPortablePath(app.command);
      app.cwd = toPortablePath(app.cwd);
      return app;
    }),
  };
  if (fromDb.apps.length) {
    config = fromDb;
    // 旧版本（JSON 存储）还在跑时会把 config.json 又写回来，留着容易搞不清哪份是真的
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const stale = `${CONFIG_FILE}.stale-backup`;
        if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
        fs.renameSync(CONFIG_FILE, stale);
        console.log('[storage] 数据已在 SQLite 里，把遗留的 config.json 归档为 config.json.stale-backup');
      } catch (err) {
        console.warn(`[storage] 归档遗留 config.json 失败：${err.message}`);
      }
    }
    console.log(`[storage] 已从 SQLite 载入 ${fromDb.apps.length} 个程序（引擎 ${result.info.sqliteVersion}）`);
    return { mode: 'sqlite', migrated: false };
  }
  // 数据库是空的：把旧的 config.json 搬进来，然后留个备份不再用它
  if (config.apps.length) {
    console.log(`[storage] 首次启动，正在把 ${config.apps.length} 个程序从 config.json 迁移到 SQLite…`);
    store.saveSettings(config.settings);
    store.saveApps(config.apps);
    try {
      const backup = `${CONFIG_FILE}.migrated-backup`;
      // 备份只有一份：老备份直接覆盖，config.json 一定要移走，
      // 否则它和数据库同时存在，以后容易搞不清哪份才是真的
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
      fs.renameSync(CONFIG_FILE, backup);
      console.log(`[storage] 迁移完成，旧配置已备份为 ${path.basename(backup)}`);
    } catch (err) {
      console.warn(`[storage] 备份旧配置失败：${err.message}`);
    }
    return { mode: 'sqlite', migrated: true };
  }
  return { mode: 'sqlite', migrated: false };
})();

function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (store.mode === 'sqlite') {
      store.saveApps(config.apps);
      store.saveSettings(config.settings);
      return;
    }
    const payload = JSON.stringify({ version: 1, settings: config.settings, apps: config.apps }, null, 2);
    const tmp = CONFIG_FILE + '.tmp';
    fs.writeFile(tmp, payload, 'utf8', (err) => {
      if (err) return console.error('[config] 写入失败', err.message);
      fs.rename(tmp, CONFIG_FILE, (e) => e && console.error('[config] 重命名失败', e.message));
    });
  }, 120);
}

function findApp(id) {
  return config.apps.find((a) => a.id === id) || null;
}

/* ---------------------------------------------------------------- 进程守护 */

const running = new Map(); // appId -> run
const recent = new Map(); // appId -> 最后一次运行的 run（用于读取日志）
const pendingRestart = new Map(); // appId -> { timer, at, attempt }

function hhmmss(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function applyParams(text, app) {
  return String(text == null ? '' : text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key) => {
    const v = app.values ? app.values[key] : undefined;
    return v !== undefined && v !== null && v !== '' ? String(v) : m;
  });
}

function splitArgs(input) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(input || ''))) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return out;
}

function parseEnv(text) {
  const out = {};
  String(text || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const i = trimmed.indexOf('=');
      if (i > 0) out[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
    });
  return out;
}

function buildSpawn(app) {
  const rawCommand = applyParams(app.command, app).trim();
  const runtime = app.runtime || detectRuntime(rawCommand);
  // 相对路径按 CLI Dock 目录解析，~\ 按用户目录解析。
  // 「自定义命令行」里可能自带参数（curl https://…），整串交给 cmd，不能当文件路径展开。
  const command =
    runtime === 'custom' || !looksLikePath(rawCommand) ? rawCommand : resolveUserPath(rawCommand);
  const argStr = applyParams(app.args, app);
  const env = Object.assign({}, process.env, parseEnv(app.env));
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUNBUFFERED = '1';
  Object.keys(app.values || {}).forEach((k) => {
    env[k] = String(app.values[k]);
  });

  let cwd = resolveUserPath(applyParams(app.cwd, app));
  if (!cwd) {
    cwd = looksLikePath(command) && fs.existsSync(command) ? path.dirname(command) : ROOT;
  }

  let file;
  let args;
  let display;

  if (!command)
    return { error: tr('程序路径为空，请在配置里填写要运行的程序', 'The program path is empty — fill in what to run in the config') };

  if (runtime === 'ps1') {
    file = config.settings.powershell || PS_EXE;
    // 通过启动器运行：先把 [Console]::OutputEncoding 切成 UTF-8，
    // 否则 PowerShell 5.1 会把中文按系统代码页输出成 "???"，日志里就查不出问题了。
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_LAUNCHER, command].concat(splitArgs(argStr));
    display = `${file} -File "${command}" ${argStr}`.trim();
  } else if (runtime === 'py') {
    file = config.settings.python || 'python';
    args = ['-u', command].concat(splitArgs(argStr));
  } else if (runtime === 'exe') {
    file = command;
    args = splitArgs(argStr);
  } else {
    file = CMD_EXE;
    args = ['/d', '/s', '/c', `${command} ${argStr}`.trim()];
  }

  return { file, args, cwd, env, runtime, commandText: command, display: display || `${file} ${args.join(' ')}` };
}

/** 启动前的静态检查：文件是否存在、PowerShell 脚本编码是否有坑。 */
function preflightNotes(command, runtime) {
  const notes = [];
  // 自定义命令行是“一整条命令”（可能带 URL、参数），不能拿 existsSync 判活
  if (runtime === 'custom' || !looksLikePath(command)) return notes;
  if (!fs.existsSync(command)) {
    notes.push({ fatal: tr(`找不到文件：${command}`, `File not found: ${command}`) });
    return notes;
  }
  if (runtime === 'ps1') {
    try {
      const buf = fs.readFileSync(command);
      const hasBom = buf.length > 2 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      const hasNonAscii = buf.some((b) => b > 0x7f);
      if (!hasBom && hasNonAscii) {
        notes.push({
          warn: tr(
            '该 .ps1 是 UTF-8 无 BOM 且含中文，PowerShell 5.1 会按 GBK 解析，可能出现乱码或语法错误；建议另存为“UTF-8 with BOM”。',
            'This .ps1 is UTF-8 without BOM and contains non-ASCII text. PowerShell 5.1 reads it as GBK, so output may be garbled or the script may fail to parse. Save it as “UTF-8 with BOM”.'
          ),
        });
      }
    } catch (err) {
      /* ignore */
    }
  }
  return notes;
}

function appendRaw(app, run, stream, raw) {
  const text = cleanLine(raw);
  if (text === '') return;
  const now = new Date();
  const line = { i: ++run.seq, t: hhmmss(now), s: stream === 2 ? 2 : 1, m: text };
  run.lines.push(line);
  if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
  fs.appendFile(run.logFile, `[${now.toISOString()}] [${stream === 2 ? 'ERR' : 'OUT'}] ${text}\n`, () => {});
  // 同时进 SQLite（批量入队，不阻塞输出）；.log 文件保留为原始记录，可直接用记事本查看
  store.pushLog(app.id, run, line);

  if (!run.url) {
    const m = text.match(/(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]+\.\w+)(?::\d{2,5})?(?:\/[^\s"'<>)\]]*)?)/i);
    if (m) {
      run.url = m[1];
      broadcastSoon();
    }
  }
}

function feed(app, run, stream, chunk) {
  const st = run.streams;
  st[stream] = Buffer.concat([st[stream], chunk]);
  let idx;
  while ((idx = st[stream].indexOf(0x0a)) !== -1) {
    const raw = st[stream].subarray(0, idx);
    st[stream] = st[stream].subarray(idx + 1);
    appendRaw(app, run, stream, decodeLine(raw));
  }
  if (st[stream].length > 1024 * 1024) {
    appendRaw(app, run, stream, decodeLine(st[stream]));
    st[stream] = Buffer.alloc(0);
  }
}

function killTree(pid) {
  if (!pid) return;
  execFile(TASKKILL_EXE, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
}

function startApp(app, opts) {
  const options = opts || {};
  if (running.has(app.id))
    return { ok: false, message: tr('程序已在运行中', 'The program is already running') };

  const built = buildSpawn(app);
  if (built.error) return { ok: false, message: built.error };

  const notes = preflightNotes(built.commandText || applyParams(app.command, app).trim(), built.runtime);
  const fatal = notes.find((n) => n.fatal);
  if (fatal) return { ok: false, message: fatal.fatal };

  const runId = uid('run_');
  const trigger = options.trigger || 'manual';
  const run = {
    runId,
    appId: app.id,
    startedAt: Date.now(),
    endedAt: null,
    status: 'starting',
    exitCode: null,
    trigger,
    seq: 0,
    lines: [],
    url: null,
    restarts: options.restarts || 0,
    stopping: false,
    stopTimer: null,
    child: null,
    pid: null,
    logFile: path.join(LOG_DIR, `${app.id}-${Date.now()}.log`),
    streams: { 1: Buffer.alloc(0), 2: Buffer.alloc(0) },
  };

  running.set(app.id, run);
  recent.set(app.id, run);
  pendingRestart.delete(app.id);

  appendRaw(app, run, 1, tr(`▶ 启动命令: ${built.display}`, `▶ Command: ${built.display}`));
  appendRaw(app, run, 1, tr(`▶ 工作目录: ${built.cwd}`, `▶ Working directory: ${built.cwd}`));
  if (trigger === 'schedule')
    appendRaw(
      app,
      run,
      1,
      tr(`▶ 由计划任务触发（${describeSchedule(app.schedule)}）`, `▶ Triggered by schedule (${describeSchedule(app.schedule)})`)
    );
  if (trigger === 'autostart') appendRaw(app, run, 1, tr('▶ 由“随控制台启动”触发', '▶ Started with the console'));
  notes.filter((n) => n.warn).forEach((n) => appendRaw(app, run, 1, `⚠ ${n.warn}`));

  let child;
  try {
    child = spawn(built.file, built.args, {
      cwd: built.cwd,
      env: built.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    appendRaw(app, run, 2, tr(`✖ 启动失败: ${err.message}`, `✖ Failed to start: ${err.message}`));
    finishRun(app, run, -1, null);
    return { ok: false, message: err.message };
  }

  run.child = child;
  run.pid = child.pid || null;
  run.status = 'running';
  writeMetricsPidFile();

  child.stdout.on('data', (c) => {
    if (process.env.CLIDOCK_DEBUG) console.log('[dbg] out', run.runId, c.length);
    feed(app, run, 1, c);
  });
  child.stderr.on('data', (c) => {
    if (process.env.CLIDOCK_DEBUG) console.log('[dbg] err', run.runId, c.length);
    feed(app, run, 2, c);
  });

  child.on('error', (err) => {
    appendRaw(app, run, 2, tr(`✖ 进程错误: ${err.message}`, `✖ Process error: ${err.message}`));
    if (err.code === 'ENOENT') {
      appendRaw(
        app,
        run,
        2,
        tr(
          `✖ 找不到可执行文件: ${built.file}（可在“设置”里修改 python / powershell 路径）`,
          `✖ Executable not found: ${built.file} (change the python / powershell path in Settings)`
        )
      );
    }
    finishRun(app, run, -1, null);
  });

  child.on('exit', (code, signal) => finishRun(app, run, code === null ? -1 : code, signal));

  appendRaw(app, run, 1, tr(`▶ 已启动，PID ${run.pid || '未知'}`, `▶ Started, PID ${run.pid || 'unknown'}`));
  broadcastSoon();
  saveConfig();
  return { ok: true, runId };
}

function finishRun(app, run, code, signal) {
  if (run.finished) return;
  run.finished = true;
  if (run.stopTimer) clearTimeout(run.stopTimer);
  run.endedAt = Date.now();
  run.exitCode = code;
  run.pid = null;
  run.status = run.stopping ? 'stopped' : code === 0 ? 'completed' : 'failed';

  const duration = formatDuration(run.endedAt - run.startedAt);
  const tail = signal ? tr(`，信号 ${signal}`, `, signal ${signal}`) : '';
  if (run.stopping) {
    appendRaw(app, run, 1, tr(`■ 已手动停止（退出码 ${code}${tail}，运行 ${duration}）`, `■ Stopped manually (exit code ${code}${tail}, ran ${duration})`));
  } else if (code === 0) {
    appendRaw(app, run, 1, tr(`✔ 正常结束（退出码 0，运行 ${duration}）`, `✔ Finished normally (exit code 0, ran ${duration})`));
  } else {
    appendRaw(app, run, 2, tr(`✖ 异常退出（退出码 ${code}${tail}，运行 ${duration}）`, `✖ Exited with an error (exit code ${code}${tail}, ran ${duration})`));
  }

  running.delete(app.id);
  recent.set(app.id, run);
  writeMetricsPidFile();

  app.lastRun = {
    runId: run.runId,
    status: run.status,
    exitCode: code,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    log: path.basename(run.logFile),
    trigger: run.trigger,
  };
  app.runs = [app.lastRun].concat(app.runs || []).slice(0, MAX_RUNS_KEPT);
  store.recordRun(app.id, app.lastRun);
  pruneLogs(app);
  saveConfig();

  const shouldRestart = !run.stopping && code !== 0 && app.autoRestart && run.restarts < app.maxRestarts;
  if (shouldRestart) {
    const attempt = run.restarts + 1;
    const delay = Math.min(30, 2 * attempt) * 1000;
    appendRaw(
      app,
      run,
      1,
      tr(
        `↻ ${delay / 1000}s 后自动重启（第 ${attempt}/${app.maxRestarts} 次）`,
        `↻ Restarting in ${delay / 1000}s (attempt ${attempt}/${app.maxRestarts})`
      )
    );
    const timer = setTimeout(() => {
      pendingRestart.delete(app.id);
      startApp(app, { restarts: attempt, trigger: 'restart' });
    }, delay);
    pendingRestart.set(app.id, { timer, at: Date.now() + delay, attempt });
  }

  broadcastSoon();
}

function pruneLogs(app) {
  const keep = new Set((app.runs || []).map((r) => r.log));
  fs.readdir(LOG_DIR, (err, files) => {
    if (err) return;
    files
      .filter((f) => f.startsWith(app.id + '-') && !keep.has(f))
      .forEach((f) => fs.unlink(path.join(LOG_DIR, f), () => {}));
  });
}

function stopApp(app, opts) {
  const run = running.get(app.id);
  if (!run) return { ok: false, message: tr('程序未在运行', 'The program is not running') };
  run.stopping = true;
  run.status = 'stopping';
  appendRaw(app, run, 1, tr('■ 正在停止…', '■ Stopping…'));
  broadcastSoon();

  if (app.stopMode === 'graceful') {
    try {
      run.child && run.child.kill();
    } catch (err) {
      /* ignore */
    }
    run.stopTimer = setTimeout(() => killTree(run.pid), Math.max(500, Number(config.settings.stopGraceMs) || 2500));
  } else {
    killTree(run.pid);
  }
  return { ok: true };
}

function restartApp(app) {
  const run = running.get(app.id);
  if (run) {
    stopApp(app);
    const wait = () => {
      if (running.has(app.id)) return setTimeout(wait, 250);
      startApp(app, { restarts: 0 });
    };
    setTimeout(wait, 400);
    return { ok: true, message: tr('正在重启', 'Restarting') };
  }
  return startApp(app, { restarts: 0 });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (uiLang() === 'en') {
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${sec}秒`;
  return `${sec}秒`;
}

/* ---------------------------------------------------------------- 指标采集
 * 用一个常驻 PowerShell 子进程定时吐 JSON（每 2 秒），比反复起进程省得多。
 * 它只读 data/metrics-pids.txt 里列出的 PID，不管托管程序的死活。
 */

const METRICS_SCRIPT = path.join(DATA_DIR, 'metrics.ps1');
const METRICS_PID_FILE = path.join(DATA_DIR, 'metrics-pids.txt');
const METRICS_BEAT_FILE = path.join(DATA_DIR, 'metrics-heartbeat.txt');

const procStats = new Map(); // pid -> { mem, cpuSec, at }
const procCpu = new Map(); // pid -> 百分比（相对整机）
let sysCpu = null;
let metricsChild = null;
let metricsBackoff = 3000;

/** 磁盘剩余空间（数据所在盘）。statfs 在 Windows 上可用，取不到就返回 null，界面显示 “—”。 */
let diskCache = { at: 0, value: null };
function diskInfo() {
  if (Date.now() - diskCache.at < 10000) return diskCache.value;
  diskCache.at = Date.now();
  try {
    const st = fs.statfsSync(APP_ROOT);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    diskCache.value = total > 0 ? { total, free } : null;
  } catch (err) {
    diskCache.value = null;
  }
  return diskCache.value;
}

function ensureMetricsScript() {
  const content = [
    'param([int]$IntervalMs = 2000)',
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
    '$pidFile = Join-Path $PSScriptRoot \'metrics-pids.txt\'',
    '$beatFile = Join-Path $PSScriptRoot \'metrics-heartbeat.txt\'',
    '$tick = 0',
    'while ($true) {',
    '  $tick++',
    '  # 服务端不再写心跳（被强杀 / 崩溃）就自己退出，别留孤儿进程占内存',
    '  $beatOk = $false',
    '  try {',
    '    $beat = Get-Item -Path $beatFile -ErrorAction Stop',
    '    if (((Get-Date) - $beat.LastWriteTime).TotalSeconds -lt 30) { $beatOk = $true }',
    '  } catch { }',
    '  if (-not $beatOk) { exit 0 }',
    '  $result = [ordered]@{ t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); pids = @{}; temp = $null }',
    '  try {',
    '    $raw = Get-Content -Path $pidFile -Raw -ErrorAction Stop',
    '    $ids = @()',
    '    if ($raw) {',
    '      foreach ($piece in ($raw -split \'[,;\\s]+\')) {',
    '        if ($piece -match \'^\\d+$\') { $ids += [int]$piece }',
    '      }',
    '    }',
    '    if ($ids.Count -gt 0) {',
    '      foreach ($p in (Get-Process -Id $ids -ErrorAction SilentlyContinue)) {',
    '        $result.pids["$($p.Id)"] = @{ mem = $p.WorkingSet64; cpu = [math]::Round($p.TotalProcessorTime.TotalSeconds, 3) }',
    '      }',
    '    }',
    '  } catch { }',
    '  try { $result | ConvertTo-Json -Compress -Depth 5 } catch { }',
    '  Start-Sleep -Milliseconds $IntervalMs',
    '}',
    '',
  ].join('\r\n');
  try {
    fs.writeFileSync(METRICS_SCRIPT, '\ufeff' + content, 'utf8');
  } catch (err) {
    console.error('[metrics] 写入失败', err.message);
  }
}

function writeMetricsPidFile() {
  const pids = [...running.values()]
    .map((run) => run.pid)
    .filter(Boolean)
    .join(',');
  fs.writeFile(METRICS_PID_FILE, pids, () => {});
}

/** 心跳：采集进程靠它判断服务端是否还活着，避免变成孤儿进程 */
function writeMetricsHeartbeat() {
  fs.writeFile(METRICS_BEAT_FILE, String(Date.now()), () => {});
}

setInterval(writeMetricsHeartbeat, 5000);

function handleMetricsLine(line) {
  let data;
  try {
    data = JSON.parse(line);
  } catch (err) {
    return;
  }
  const now = Number(data.t) || Date.now();
  const cores = os.cpus().length || 1;
  const pids = data.pids && typeof data.pids === 'object' ? data.pids : {};
  Object.keys(pids).forEach((pidStr) => {
    const entry = pids[pidStr] || {};
    const cur = { mem: Number(entry.mem) || 0, cpuSec: Number(entry.cpu) || 0, at: now };
    const prev = procStats.get(pidStr);
    procStats.set(pidStr, cur);
    if (prev && now > prev.at) {
      const secs = (now - prev.at) / 1000;
      const pct = ((cur.cpuSec - prev.cpuSec) / secs) * 100 / cores;
      procCpu.set(pidStr, Math.max(0, Math.round(pct * 10) / 10));
    }
  });
  const alive = new Set(Object.keys(pids));
  [...procStats.keys()].forEach((pidStr) => {
    if (!alive.has(pidStr)) {
      procStats.delete(pidStr);
      procCpu.delete(pidStr);
    }
  });
  broadcastSoon();
}

function startMetricsDaemon() {
  if (metricsChild) return;
  if (config.settings.metricsEnabled === false) return;
  ensureMetricsScript();
  writeMetricsPidFile();
  writeMetricsHeartbeat();
  try {
    metricsChild = spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', METRICS_SCRIPT], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    metricsChild = null;
    return;
  }
  metricsBackoff = 3000;
  let buf = '';
  metricsChild.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith('{')) handleMetricsLine(line);
    }
    if (buf.length > 1024 * 1024) buf = '';
  });
  metricsChild.on('error', () => {
    metricsChild = null;
  });
  metricsChild.on('exit', () => {
    metricsChild = null;
    metricsBackoff = Math.min(30000, metricsBackoff * 2);
    setTimeout(startMetricsDaemon, metricsBackoff);
  });
}

function stopMetricsDaemon() {
  if (metricsChild) {
    try {
      killTree(metricsChild.pid);
    } catch (err) {
      /* ignore */
    }
    metricsChild = null;
  }
}

let lastSysSample = null;

function sampleSystemCpu() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  cpus.forEach((cpu) => {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  });
  const prev = lastSysSample;
  lastSysSample = { idle, total };
  if (!prev) return;
  const dTotal = total - prev.total;
  const dIdle = idle - prev.idle;
  if (dTotal <= 0) return;
  sysCpu = Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 1000) / 10));
}

/** 按 PID 拿到某个程序的负载：内存、CPU 百分比、累计 CPU 秒数 */
function appMetrics(run) {
  if (!run || !run.pid) return null;
  const stat = procStats.get(String(run.pid));
  if (!stat) return null;
  return {
    mem: stat.mem,
    cpu: procCpu.get(String(run.pid)) || 0,
    cpuSec: Math.round(stat.cpuSec * 10) / 10,
  };
}

setInterval(sampleSystemCpu, 2000);
sampleSystemCpu();

/* ---------------------------------------------------------------- 计划任务 */

const nextRuns = new Map(); // appId -> 下次触发时间戳

const UNIT_TEXT = { seconds: '秒', minutes: '分钟', hours: '小时' };

function describeSchedule(sched) {
  const en = uiLang() === 'en';
  if (!sched || !sched.enabled || sched.mode === 'none') return en ? 'Not enabled' : '未启用';
  if (sched.mode === 'interval') {
    const unit = sched.intervalUnit || 'minutes';
    if (en) return `Every ${sched.intervalValue} ${unit}`;
    return `每隔 ${sched.intervalValue} ${UNIT_TEXT[unit] || '分钟'}`;
  }
  if (sched.mode === 'daily') return `${en ? 'Daily ' : '每天 '}${sched.times || (en ? '(no time set)' : '（未设置时间）')}`;
  if (sched.mode === 'weekly') {
    const days = parseWeekdays(sched.weekdays);
    if (!days.length) return en ? 'Weekly (no weekday chosen)' : '每周（未选择星期几）';
    const names = days.map((d) => (en ? WEEK_TEXT_EN[d] : WEEK_TEXT[d])).join(en ? ', ' : '、');
    const times = sched.times || (en ? '(no time set)' : '（未设置时间）');
    return en ? `${names} at ${times}` : `每${names} ${times}`;
  }
  if (sched.mode === 'once') {
    const at = Date.parse(sched.at);
    if (!Number.isFinite(at)) return en ? 'Once (no time set)' : '单次（未设置时间）';
    const when = new Date(at).toLocaleString(en ? 'en-US' : 'zh-CN', { hour12: false });
    return en ? `Once ${when}` : `单次 ${when}`;
  }
  return en ? 'Not enabled' : '未启用';
}

function computeNextRun(sched, from) {
  if (!sched || !sched.enabled || sched.mode === 'none') return null;

  if (sched.mode === 'interval') {
    const value = Math.max(5, Number(sched.intervalValue) || 30);
    return from + value * (UNIT_MS[sched.intervalUnit] || 60000);
  }

  if (sched.mode === 'once') {
    const t = Date.parse(sched.at);
    if (!Number.isFinite(t)) return null;
    // 过期就不再自动触发，避免重启控制台时“补跑”重要任务
    return t > from ? t : null;
  }

  if (sched.mode === 'daily') {
    const times = parseTimes(sched.times);
    if (!times.length) return null;
    const base = new Date(from);
    for (const t of times) {
      const cand = new Date(base.getFullYear(), base.getMonth(), base.getDate(), t.h, t.m, 0, 0).getTime();
      if (cand > from + 500) return cand;
    }
    const first = times[0];
    return new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, first.h, first.m, 0, 0).getTime();
  }

  if (sched.mode === 'weekly') {
    const times = parseTimes(sched.times);
    const days = parseWeekdays(sched.weekdays);
    if (!times.length || !days.length) return null;
    const base = new Date(from);
    // 从今天开始最多看 8 天，够覆盖“本周剩下的日子 + 下周同一天”
    for (let offset = 0; offset <= 8; offset++) {
      const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
      if (!days.includes(day.getDay())) continue;
      for (const t of times) {
        const cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), t.h, t.m, 0, 0).getTime();
        if (cand > from + 500) return cand;
      }
    }
    return null;
  }

  return null;
}

function scheduleNext(app, from) {
  const next = computeNextRun(app.schedule, from === undefined ? Date.now() : from);
  if (next) nextRuns.set(app.id, next);
  else nextRuns.delete(app.id);
  return next || null;
}

function schedulerTick() {
  const now = Date.now();
  config.apps.forEach((app) => {
    const sched = app.schedule;
    if (!sched || !sched.enabled || sched.mode === 'none') return;
    const next = nextRuns.get(app.id);
    if (!next || next > now) return;

    if (running.has(app.id) || pendingRestart.has(app.id)) {
      // 上一轮还没跑完（周期性任务可能比间隔更久），这次跳过
      scheduleNext(app, now);
      broadcastSoon();
      return;
    }

    console.log(`[schedule] 触发 ${app.name}（${describeSchedule(sched)}）`);
    const result = startApp(app, { trigger: 'schedule' });
    if (sched.mode === 'once') {
      sched.enabled = false;
      nextRuns.delete(app.id);
      saveConfig();
    } else {
      scheduleNext(app, now);
    }
    if (!result.ok) console.error(`[schedule] ${app.name} 启动失败：${result.message}`);
    broadcastSoon();
  });
}

setInterval(schedulerTick, 10000);

/* ---------------------------------------------------------------- 状态 */

function buildState() {
  const apps = config.apps.map((app) => {
    const run = running.get(app.id);
    const pending = pendingRestart.get(app.id);
    const live = !!run;
    const last = app.lastRun || null;
    let status = 'idle';
    if (live) status = run.status;
    else if (pending) status = 'restarting';
    else if (last) status = normalizeStatus(last.status);

    // 路径可能写成相对/~/ 形式，也可能因为换了机器而失效——界面要能直接看出来
    const resolved = resolveUserPath(app.command);
    const appRuntime = app.runtime || detectRuntime(app.command);
    const pathMissing = appRuntime !== 'custom' && !!resolved && looksLikePath(resolved) && !fs.existsSync(resolved);

    return {
      id: app.id,
      name: app.name,
      description: app.description,
      runtime: app.runtime,
      command: app.command,
      commandResolved: resolved,
      pathMissing,
      args: app.args,
      cwd: app.cwd,
      env: app.env,
      port: app.port,
      params: app.params,
      values: app.values,
      autoStart: app.autoStart,
      autoRestart: app.autoRestart,
      maxRestarts: app.maxRestarts,
      stopMode: app.stopMode,
      schedule: app.schedule,
      scheduleText: describeSchedule(app.schedule),
      nextRunAt: nextRuns.get(app.id) || null,
      createdAt: app.createdAt,
      status,
      pid: live ? run.pid : null,
      startedAt: live ? run.startedAt : last ? last.startedAt : null,
      endedAt: live ? null : last ? last.endedAt : null,
      exitCode: live ? null : last ? last.exitCode : null,
      trigger: live ? run.trigger : last ? last.trigger : null,
      restarts: live ? run.restarts : 0,
      restartAt: pending ? pending.at : null,
      url: live && run.url ? run.url : app.port ? `http://127.0.0.1:${app.port}` : null,
      metrics: appMetrics(run),
      runs: (app.runs || []).slice(0, 15),
      lineCount: live ? run.seq : recent.has(app.id) ? recent.get(app.id).seq : 0,
    };
  });

  const active = apps.filter((a) => a.status === 'running' || a.status === 'starting' || a.status === 'restarting');
  const managedCpu = Math.round(active.reduce((sum, a) => sum + ((a.metrics && a.metrics.cpu) || 0), 0) * 10) / 10;
  const managedMem = active.reduce((sum, a) => sum + ((a.metrics && a.metrics.mem) || 0), 0);

  const stats = {
    total: apps.length,
    running: active.length,
    failed: apps.filter((a) => a.status === 'failed').length,
    completed: apps.filter((a) => a.status === 'completed').length,
    stopped: apps.filter((a) => a.status === 'idle' || a.status === 'stopped').length,
  };

  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  return {
    apps,
    stats,
    system: {
      cpuPercent: sysCpu,
      memUsed: totalMem - freeMem,
      memTotal: totalMem,
      disk: diskInfo(),
      dockMem: process.memoryUsage().rss,
      cores: (os.cpus() || []).length,
      uptimeSec: Math.round(process.uptime() * 1000) / 1000,
      managedCpu,
      managedMem,
      managedCount: active.length,
      storage: store.describe(),
      nodeVersion: process.version,
    },
    settings: {
      python: config.settings.python,
      powershell: config.settings.powershell,
      stopGraceMs: config.settings.stopGraceMs,
      metricsEnabled: config.settings.metricsEnabled !== false,
      language: uiLang(),
    },
    serverTime: Date.now(),
  };
}

/* ---------------------------------------------------------------- SSE */

const clients = new Set();
let broadcastTimer = null;

function broadcastSoon() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    if (!clients.size) return;
    const payload = `data: ${JSON.stringify(buildState())}\n\n`;
    clients.forEach((res) => {
      try {
        res.write(payload);
      } catch (err) {
        clients.delete(res);
      }
    });
  }, 80);
}

setInterval(() => {
  clients.forEach((res) => {
    try {
      res.write(': ping\n\n');
    } catch (err) {
      clients.delete(res);
    }
  });
}, 20000);

/* ---------------------------------------------------------------- HTTP 工具 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error(tr('请求体过大', 'Request body too large')));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error(tr('JSON 解析失败', 'Failed to parse JSON')));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\//, ''));
  const target = path.join(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/* ---------------------------------------------------------------- 路由 */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 2000\n\n`);
      res.write(`data: ${JSON.stringify(buildState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (pathname === '/api/state') {
      return sendJson(res, 200, buildState());
    }

    // 直接查 SQLite 里的历史日志/运行记录（默认存储为 SQLite 时可用）
    if (pathname === '/api/db/logs') {
      if (store.mode !== 'sqlite') {
        return sendJson(res, 200, {
          ok: false,
          message: tr(`当前使用 ${store.mode} 存储：${store.reason}`, `Using ${store.mode} storage: ${store.reason}`),
        });
      }
      const appId = url.searchParams.get('appId') || '';
      const limit = Number(url.searchParams.get('limit')) || 200;
      try {
        const rows = await store.latestLogs(appId, limit);
        return sendJson(res, 200, { ok: true, rows });
      } catch (err) {
        return sendJson(res, 500, { ok: false, message: err.message });
      }
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.language === 'zh' || body.language === 'en') config.settings.language = body.language;
      if (typeof body.python === 'string' && body.python.trim()) config.settings.python = body.python.trim();
      if (typeof body.powershell === 'string' && body.powershell.trim()) config.settings.powershell = body.powershell.trim();
      if (Number.isFinite(Number(body.stopGraceMs))) config.settings.stopGraceMs = Number(body.stopGraceMs);
      if (typeof body.metricsEnabled === 'boolean') {
        config.settings.metricsEnabled = body.metricsEnabled;
        if (body.metricsEnabled) {
          startMetricsDaemon();
        } else {
          stopMetricsDaemon();
          procStats.clear();
          procCpu.clear();
        }
      }
      saveConfig();
      broadcastSoon();
      return sendJson(res, 200, { ok: true, settings: config.settings });
    }

    if (pathname === '/api/browse') {
      const raw = url.searchParams.get('dir') || os.homedir();
      let dir = resolveUserPath(raw) || os.homedir();
      try {
        if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
      } catch (err) {
        dir = os.homedir();
      }
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        return sendJson(res, 200, { dir, parent: path.dirname(dir), dirs: [], files: [], error: err.message });
      }
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('$') && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      const files = entries
        .filter((e) => e.isFile() && RUNNABLE_EXT.has(path.extname(e.name).toLowerCase()))
        .map((e) => {
          const p = path.join(dir, e.name);
          let size = 0;
          try {
            size = fs.statSync(p).size;
          } catch (err) {
            /* ignore */
          }
          return { name: e.name, path: p, ext: path.extname(e.name).toLowerCase(), size };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      const shortcuts = [
        { name: tr('桌面', 'Desktop'), path: path.join(os.homedir(), 'Desktop') },
        { name: tr('下载', 'Downloads'), path: path.join(os.homedir(), 'Downloads') },
        { name: tr('文档', 'Documents'), path: path.join(os.homedir(), 'Documents') },
        { name: tr('程序目录', 'App folder'), path: ROOT },
      ].filter((s) => {
        try {
          return fs.statSync(s.path).isDirectory();
        } catch (err) {
          return false;
        }
      });
      return sendJson(res, 200, { dir, parent: path.dirname(dir), dirs: dirs.slice(0, 300), files: files.slice(0, 300), shortcuts });
    }

    if (pathname === '/api/apps' && req.method === 'POST') {
      const body = await readBody(req);
      // 能相对化就相对化：本目录里的存成 samples\x.ps1，用户目录里的存成 ~\Downloads\x.ps1，
      // 这样整夹拷到别的机器、或者换了用户名，条目依然有效
      if (typeof body.command === 'string') body.command = toPortablePath(body.command);
      if (typeof body.cwd === 'string') body.cwd = toPortablePath(body.cwd);
      const existing = body.id ? findApp(body.id) : null;
      const merged = normalizeApp(
        Object.assign({}, existing || {}, body, {
          values: Object.assign({}, existing ? existing.values : {}, body.values || {}),
          runs: existing ? existing.runs : [],
          lastRun: existing ? existing.lastRun : null,
          createdAt: existing ? existing.createdAt : Date.now(),
        })
      );
      if (existing) {
        const idx = config.apps.findIndex((a) => a.id === existing.id);
        config.apps[idx] = merged;
      } else {
        config.apps.push(merged);
      }
      scheduleNext(merged);
      saveConfig();
      broadcastSoon();
      return sendJson(res, 200, { ok: true, app: merged, state: buildState() });
    }

    const appMatch = pathname.match(/^\/api\/apps\/([\w-]+)(\/.*)?$/);
    if (appMatch) {
      const app = findApp(appMatch[1]);
      if (!app) return sendJson(res, 404, { ok: false, message: tr('程序不存在', 'Program not found') });
      const action = appMatch[2] || '';

      if (action === '' && req.method === 'DELETE') {
        stopApp(app);
        setTimeout(() => killTree(recent.get(app.id) && recent.get(app.id).pid), 0);
        config.apps = config.apps.filter((a) => a.id !== app.id);
        saveConfig();
        broadcastSoon();
        return sendJson(res, 200, { ok: true });
      }

      if (action === '/start' && req.method === 'POST') {
        const r = startApp(app, {});
        return sendJson(res, r.ok ? 200 : 400, Object.assign({ state: buildState() }, r));
      }

      if (action === '/stop' && req.method === 'POST') {
        const r = stopApp(app);
        return sendJson(res, r.ok ? 200 : 400, Object.assign({ state: buildState() }, r));
      }

      if (action === '/restart' && req.method === 'POST') {
        const r = restartApp(app);
        return sendJson(res, r.ok ? 200 : 400, Object.assign({ state: buildState() }, r));
      }

      if (action === '/values' && req.method === 'POST') {
        const body = await readBody(req);
        app.values = body.values && typeof body.values === 'object' ? body.values : {};
        saveConfig();
        broadcastSoon();
        return sendJson(res, 200, { ok: true, values: app.values });
      }

      if (action === '/schedule' && req.method === 'POST') {
        const body = await readBody(req);
        app.schedule = normalizeSchedule(body.schedule || body);
        scheduleNext(app);
        saveConfig();
        broadcastSoon();
        return sendJson(res, 200, {
          ok: true,
          schedule: app.schedule,
          scheduleText: describeSchedule(app.schedule),
          nextRunAt: nextRuns.get(app.id) || null,
          state: buildState(),
        });
      }

      if (action === '/tail') {
        const since = Number(url.searchParams.get('since') || 0);
        const run = running.get(app.id) || recent.get(app.id);
        if (!run) return sendJson(res, 200, { lines: [], seq: 0, running: false, status: app.lastRun ? app.lastRun.status : 'idle' });
        const lines = run.lines.filter((l) => l.i > since).slice(-2000);
        return sendJson(res, 200, {
          runId: run.runId,
          seq: run.seq,
          lines,
          running: running.has(app.id),
          status: running.has(app.id) ? run.status : run.status,
          total: run.lines.length,
        });
      }

      if (action === '/tail' && req.method === 'DELETE') {
        const run = running.get(app.id) || recent.get(app.id);
        if (run) run.lines = [];
        return sendJson(res, 200, { ok: true, seq: run ? run.seq : 0 });
      }
    }

    if (pathname === '/api/log' && req.method === 'GET') {
      const file = path.basename(url.searchParams.get('file') || '');
      const target = path.join(LOG_DIR, file);
      if (!file || !target.startsWith(LOG_DIR))
        return sendJson(res, 400, { ok: false, message: tr('非法日志文件', 'Invalid log file') });
      try {
        const text = fs.readFileSync(target, 'utf8');
        const lines = text.split(/\r?\n/).filter(Boolean).slice(-4000);
        return sendJson(res, 200, { ok: true, file, lines });
      } catch (err) {
        return sendJson(res, 404, {
          ok: false,
          message: tr('日志文件不存在（可能已被清理）', 'Log file not found (it may have been cleaned up)'),
        });
      }
    }

    if (pathname === '/api/shutdown' && req.method === 'POST') {
      // 退出时不等“温和停止”的宽限期，直接杀整棵进程树：
      // 否则服务 800ms 后就退出，宽限期内该杀的进程会变成孤儿留在系统里。
      [...running.values()].forEach((run) => {
        if (run.stopTimer) clearTimeout(run.stopTimer);
        killTree(run.pid);
      });
      sendJson(res, 200, { ok: true });
      setTimeout(() => {
        stopMetricsDaemon();
        [...running.values()].forEach((run) => killTree(run.pid));
        store
          .close()
          .catch(() => null)
          .then(() => process.exit(0));
        // 兜底：DB 关不上也不能卡住退出
        setTimeout(() => process.exit(0), 4000).unref();
      }, 1200);
      return;
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, message: tr('接口不存在', 'API endpoint not found') });
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, message: err.message });
    else res.end();
  }
});

/* ---------------------------------------------------------------- 首次种子数据 */

function seedSamples() {
  if (fs.existsSync(CONFIG_FILE) || config.apps.length) return;
  if (!fs.existsSync(SAMPLES_DIR)) return;
  const demo = [
    {
      name: tr('示例 · 心跳脚本 (PowerShell)', 'Sample · Heartbeat script (PowerShell)'),
      description: tr('每 2 秒输出一行，用来演示实时日志。', 'Prints a line every 2 seconds to demo live logs.'),
      runtime: 'ps1',
      command: path.join('samples', 'hello.ps1'),
      args: '{{ROUNDS}}',
      params: [{ key: 'ROUNDS', label: tr('循环次数', 'Rounds'), def: '0', hint: tr('0 表示一直运行', '0 means run forever') }],
      values: { ROUNDS: '0' },
      stopMode: 'force',
    },
    {
      name: tr('示例 · Python 计时器', 'Sample · Python ticker'),
      description: tr('演示 Python 程序导入与参数占位符。', 'Shows Python import and parameter placeholders.'),
      runtime: 'py',
      command: path.join('samples', 'tick.py'),
      args: '--interval {{INTERVAL}}',
      params: [
        { key: 'INTERVAL', label: tr('间隔秒数', 'Interval (seconds)'), def: '2', hint: tr('越大输出越慢', 'Bigger means slower output') },
      ],
      values: { INTERVAL: '2' },
      stopMode: 'graceful',
    },
    {
      name: tr('示例 · 本地网页服务', 'Sample · Local web server'),
      description: tr('启动后日志里出现地址，右上角可直接打开。', 'Its address shows up in the log and can be opened from the card.'),
      runtime: 'py',
      command: path.join('samples', 'web.py'),
      args: '--port {{PORT}}',
      port: '8765',
      params: [
        { key: 'PORT', label: tr('监听端口', 'Listen port'), def: '8765', hint: tr('修改后需重启', 'Restart after changing it') },
      ],
      values: { PORT: '8765' },
      stopMode: 'force',
    },
  ];
  config.apps = demo.map(normalizeApp);
  saveConfig();
}

/* ---------------------------------------------------------------- 启动 */

seedSamples();

server.listen(PORT, HOST, () => {
  const line = `CLI Dock 已启动: http://${HOST}:${PORT}`;
  console.log(line);
  if (store.mode === 'sqlite') {
    console.log(`数据库: ${path.join(DATA_DIR, 'cli-dock.db')}（SQLite ${store.info.sqliteVersion || ''}）`);
  } else {
    console.log(`配置文件: ${CONFIG_FILE}（SQLite 不可用：${store.reason}）`);
  }
  console.log(`日志目录: ${LOG_DIR}`);
  startMetricsDaemon();
  config.apps.forEach((app) => {
    const next = scheduleNext(app, Date.now());
    if (next) console.log(`[schedule] ${app.name} 下次 ${new Date(next).toLocaleString('zh-CN', { hour12: false })}（${describeSchedule(app.schedule)}）`);
  });
  config.apps
    .filter((a) => a.autoStart)
    .forEach((app) => {
      console.log(`[autoStart] ${app.name}`);
      startApp(app, { trigger: 'autostart' });
    });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，可用环境变量 CLIDOCK_PORT 换一个端口。`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

function shutdown() {
  stopMetricsDaemon();
  [...running.values()].forEach((run) => killTree(run.pid));
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
