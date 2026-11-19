'use strict';

/**
 * SQLite 存储层（通过常驻 PowerShell 进程访问 System.Data.SQLite.dll）
 *
 * 为什么不让 Node 直接读 SQLite：
 *   1) 用户指定用 lib\System.Data.SQLite.dll，它是 .NET 程序集，Node 加载不了；
 *   2) 用 npm 原生模块（better-sqlite3）就得带 node-gyp/预编译二进制，违背“零依赖、拷过去就能用”。
 * 所以：db-host.ps1 常驻持有连接，这里只做 JSON 行协议 + 队列 + 批量写。
 *
 * 任何一步失败（没 lib、没外网、DLL 加载不了）都退回 JSON 存储，功能不受影响。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS apps (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL DEFAULT '',
     description TEXT NOT NULL DEFAULT '',
     runtime TEXT NOT NULL DEFAULT '',
     command TEXT NOT NULL DEFAULT '',
     args TEXT NOT NULL DEFAULT '',
     cwd TEXT NOT NULL DEFAULT '',
     env TEXT NOT NULL DEFAULT '',
     port TEXT NOT NULL DEFAULT '',
     params_json TEXT NOT NULL DEFAULT '[]',
     values_json TEXT NOT NULL DEFAULT '{}',
     auto_start INTEGER NOT NULL DEFAULT 0,
     auto_restart INTEGER NOT NULL DEFAULT 0,
     max_restarts INTEGER NOT NULL DEFAULT 5,
     stop_mode TEXT NOT NULL DEFAULT 'force',
     schedule_json TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL DEFAULT 0,
     last_run_json TEXT NOT NULL DEFAULT 'null',
     runs_json TEXT NOT NULL DEFAULT '[]'
   )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     app_id TEXT NOT NULL,
     run_id TEXT,
     status TEXT,
     exit_code INTEGER,
     started_at INTEGER,
     ended_at INTEGER,
     trigger TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS log_lines (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     app_id TEXT NOT NULL,
     run_id TEXT,
     seq INTEGER,
     ts INTEGER,
     stream INTEGER,
     text TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`,
  'CREATE INDEX IF NOT EXISTS idx_log_app ON log_lines(app_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_runs_app ON runs(app_id, id)',
];

const APP_UPSERT = `INSERT INTO apps (id, name, description, runtime, command, args, cwd, env, port,
  params_json, values_json, auto_start, auto_restart, max_restarts, stop_mode, schedule_json,
  created_at, last_run_json, runs_json)
  VALUES (@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8,@p9,@p10,@p11,@p12,@p13,@p14,@p15,@p16,@p17,@p18)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, description=excluded.description, runtime=excluded.runtime,
    command=excluded.command, args=excluded.args, cwd=excluded.cwd, env=excluded.env,
    port=excluded.port, params_json=excluded.params_json, values_json=excluded.values_json,
    auto_start=excluded.auto_start, auto_restart=excluded.auto_restart,
    max_restarts=excluded.max_restarts, stop_mode=excluded.stop_mode,
    schedule_json=excluded.schedule_json, created_at=excluded.created_at,
    last_run_json=excluded.last_run_json, runs_json=excluded.runs_json`;

const SETTING_UPSERT = 'INSERT INTO settings (key, value) VALUES (@p0,@p1) ON CONFLICT(key) DO UPDATE SET value=excluded.value';

const LOG_INSERT = 'INSERT INTO log_lines (app_id, run_id, seq, ts, stream, text) VALUES (@p0,@p1,@p2,@p3,@p4,@p5)';
const RUN_INSERT = 'INSERT INTO runs (app_id, run_id, status, exit_code, started_at, ended_at, trigger) VALUES (@p0,@p1,@p2,@p3,@p4,@p5,@p6)';

const LOG_FLUSH_INTERVAL = 700;
const LOG_QUEUE_LIMIT = 4000; // 队列上限，防止 DB 卡住时内存疯涨
const MAX_LOG_ROWS = 200000; // 超出后只保留最近这么多行

function parseLastJson(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.startsWith('{') || line.startsWith('[')) {
      try {
        return JSON.parse(line);
      } catch (err) {
        /* 继续往上找 */
      }
    }
  }
  return null;
}

function safeJsonParse(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value === null || value === undefined ? fallback : value;
  } catch (err) {
    return fallback;
  }
}

class Store {
  constructor(options) {
    const opts = options || {};
    this.root = opts.root;
    this.dbFile = opts.dbFile || path.join(path.dirname(this.root), 'data', 'cli-dock.db');
    this.hostScript = path.join(this.root, 'db-host.ps1');
    this.libScript = path.join(this.root, 'lib-init.ps1');
    this.mode = 'json';
    this.reason = '未初始化';
    this.info = { backend: 'json' };
    this.schemaRowsRemoved = 0;

    this.child = null;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.pending = new Map();
    this.seq = 1;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.restarts = 0;
    this.closing = false;

    this.logQueue = [];
    this.logDropped = 0;
    this.logTimer = null;
  }

  /* ------------------------------------------------------------ 启动 */

  /** 同步初始化：确保 lib、建表、载入数据。失败则 mode 保持 'json'。 */
  initSync() {
    if (!fs.existsSync(this.hostScript) || !fs.existsSync(this.libScript)) {
      this.reason = '缺少 db-host.ps1 / lib-init.ps1';
      return { ok: false, reason: this.reason };
    }

    // 1) 准备 SQLite 运行时（缺了自动下载，免管理员）
    let lib = null;
    try {
      const run = spawnSync(
        PS_EXE,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.libScript, '-Quiet'],
        { timeout: 300000, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
      );
      lib = parseLastJson(run.stdout);
      if (!lib) {
        lib = { ok: false, message: (run.stderr || '').toString().trim().slice(0, 300) || 'lib-init.ps1 没有输出结果' };
      }
    } catch (err) {
      lib = { ok: false, message: err.message };
    }
    if (!lib || !lib.ok) {
      this.reason = (lib && lib.message) || 'SQLite 组件不可用';
      return { ok: false, reason: this.reason };
    }

    // 2) 建表 + 一次性取回 apps / settings / 统计
    const queries = [
      'SELECT * FROM apps ORDER BY created_at ASC',
      'SELECT key, value FROM settings',
      `SELECT (SELECT COUNT(*) FROM log_lines) AS logs, (SELECT COUNT(*) FROM runs) AS runs, sqlite_version() AS ver`,
    ];
    const request = { id: 1, op: 'init', batch: SCHEMA.map((sql) => ({ sql })), queries };
    let result = null;
    try {
      const run = spawnSync(
        PS_EXE,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.hostScript, '-Db', this.dbFile, '-Request', JSON.stringify(request)],
        { timeout: 120000, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
      );
      result = parseLastJson(run.stdout);
      if (!result) {
        result = { ok: false, error: (run.stderr || '').toString().trim().slice(0, 400) || 'db-host.ps1 没有返回结果' };
      }
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result || !result.ok) {
      this.reason = (result && result.error) || '数据库初始化失败';
      return { ok: false, reason: this.reason };
    }

    const appRows = (result.results && result.results[0]) || [];
    const settingRows = (result.results && result.results[1]) || [];
    const counts = ((result.results && result.results[2]) || [])[0] || {};

    this.mode = 'sqlite';
    this.reason = '';
    this.info = {
      backend: 'sqlite',
      dbFile: this.dbFile,
      sqliteVersion: counts.ver || lib.version || '',
      libVersion: lib.message || '',
      logRows: Number(counts.logs) || 0,
      runRows: Number(counts.runs) || 0,
    };

    const settings = {};
    settingRows.forEach((row) => {
      if (!row || !row.key) return;
      const value = row.value;
      // 保持原来的类型：数字/布尔都按存储时的 JSON 还原
      if (value === 'true') settings[row.key] = true;
      else if (value === 'false') settings[row.key] = false;
      else if (/^-?\d+(\.\d+)?$/.test(String(value))) settings[row.key] = Number(value);
      else settings[row.key] = value;
    });

    const apps = appRows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      runtime: row.runtime,
      command: row.command,
      args: row.args,
      cwd: row.cwd,
      env: row.env,
      port: row.port,
      params: safeJsonParse(row.params_json, []),
      values: safeJsonParse(row.values_json, {}),
      autoStart: !!row.auto_start,
      autoRestart: !!row.auto_restart,
      maxRestarts: Number(row.max_restarts) || 0,
      stopMode: row.stop_mode || 'force',
      schedule: safeJsonParse(row.schedule_json, {}),
      createdAt: Number(row.created_at) || 0,
      lastRun: safeJsonParse(row.last_run_json, null),
      runs: safeJsonParse(row.runs_json, []),
    }));

    this.startHost();
    this.trimLogs();
    return { ok: true, apps, settings, info: this.info };
  }

  /** 常驻代理：后续所有写操作都走它，避免每次开进程 */
  startHost() {
    if (this.closing) return;
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // 没人 await 时不要让 Promise 报警
    this.readyPromise.catch(() => {});

    let child;
    try {
      child = spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.hostScript, '-Db', this.dbFile], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.reason = `启动 db-host 失败：${err.message}`;
      this.mode = 'json';
      if (this.rejectReady) this.rejectReady(new Error(this.reason));
      return;
    }
    this.child = child;

    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderrBuffer = (this.stderrBuffer + chunk.toString('utf8')).slice(-4000);
      console.error('[db-host]', chunk.toString('utf8').trim());
    });
    child.on('error', (err) => {
      console.error('[db-host] 进程错误:', err.message);
    });
    child.on('exit', (code) => {
      this.child = null;
      const err = new Error(`db-host 退出（code ${code}）`);
      this.pending.forEach((item) => item.reject(err));
      this.pending.clear();
      if (this.rejectReady) this.rejectReady(err);
      if (!this.closing && this.mode === 'sqlite' && this.restarts < 3) {
        this.restarts += 1;
        console.error(`[db-host] 5 秒后重启（第 ${this.restarts} 次）`);
        setTimeout(() => this.startHost(), 5000);
      }
    });
  }

  onStdout(chunk) {
    this.stdoutBuffer += chunk.toString('utf8');
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      index = this.stdoutBuffer.indexOf('\n');
      if (!line || line[0] !== '{') continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        continue;
      }
      if (msg.ready) {
        if (this.resolveReady) this.resolveReady(true);
        continue;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg);
      else waiter.reject(new Error(msg.error || '未知数据库错误'));
    }
  }

  /** 发一个请求；未就绪时等就绪，永不抛到调用方（调用方自己 catch） */
  send(payload) {
    if (this.mode !== 'sqlite') return Promise.resolve(null);
    const ready = this.readyPromise || Promise.resolve(true);
    return ready.then(
      () =>
        new Promise((resolve, reject) => {
          if (!this.child || !this.child.stdin.writable) {
            reject(new Error('数据库连接不可用'));
            return;
          }
          const id = this.seq;
          this.seq += 1;
          payload.id = id;
          this.pending.set(id, { resolve, reject });
          try {
            this.child.stdin.write(`${JSON.stringify(payload)}\n`);
          } catch (err) {
            this.pending.delete(id);
            reject(err);
          }
        })
    );
  }

  /* ------------------------------------------------------------ 写 */

  saveApps(apps) {
    if (this.mode !== 'sqlite') return Promise.resolve(null);
    const batch = apps.map((app) => ({
      sql: APP_UPSERT,
      params: [
        app.id,
        app.name || '',
        app.description || '',
        app.runtime || '',
        app.command || '',
        app.args || '',
        app.cwd || '',
        app.env || '',
        app.port || '',
        JSON.stringify(app.params || []),
        JSON.stringify(app.values || {}),
        app.autoStart ? 1 : 0,
        app.autoRestart ? 1 : 0,
        Number(app.maxRestarts) || 0,
        app.stopMode || 'force',
        JSON.stringify(app.schedule || {}),
        Number(app.createdAt) || Date.now(),
        JSON.stringify(app.lastRun || null),
        JSON.stringify((app.runs || []).slice(0, 30)),
      ],
    }));
    // 已经删掉的条目要同步删行，否则重启会“复活”
    batch.push({
      sql: 'DELETE FROM apps WHERE id NOT IN (SELECT value FROM json_each(@p0))',
      params: [JSON.stringify(apps.map((a) => a.id))],
    });
    return this.send({ op: 'batch', batch }).catch((err) => {
      console.error('[db] 保存程序列表失败:', err.message);
      return null;
    });
  }

  saveSettings(settings) {
    if (this.mode !== 'sqlite') return Promise.resolve(null);
    const batch = Object.keys(settings || {}).map((key) => ({
      sql: SETTING_UPSERT,
      params: [key, String(settings[key])],
    }));
    return this.send({ op: 'batch', batch }).catch((err) => {
      console.error('[db] 保存设置失败:', err.message);
      return null;
    });
  }

  recordRun(appId, run) {
    if (this.mode !== 'sqlite' || !run) return Promise.resolve(null);
    return this.send({
      op: 'exec',
      sql: RUN_INSERT,
      params: [appId, run.runId || '', run.status || '', run.exitCode === null || run.exitCode === undefined ? null : Number(run.exitCode), run.startedAt || null, run.endedAt || null, run.trigger || ''],
    }).then((msg) => {
      this.info.runRows = (this.info.runRows || 0) + 1;
      return msg;
    }).catch(() => null);
  }

  /** 日志按批入库：每条输出都写一次进程会被拖死，攒 700ms 一起进事务 */
  pushLog(appId, run, line) {
    if (this.mode !== 'sqlite' || !line) return;
    if (this.logQueue.length >= LOG_QUEUE_LIMIT) {
      this.logDropped += 1;
      return;
    }
    this.logQueue.push({
      sql: LOG_INSERT,
      params: [appId, (run && run.runId) || '', line.i || 0, Date.now(), line.s === 2 ? 2 : 1, line.m || ''],
    });
    if (!this.logTimer) {
      this.logTimer = setTimeout(() => this.flushLogs(), LOG_FLUSH_INTERVAL);
      if (this.logTimer.unref) this.logTimer.unref();
    }
  }

  flushLogs() {
    if (this.logTimer) {
      clearTimeout(this.logTimer);
      this.logTimer = null;
    }
    if (this.mode !== 'sqlite' || !this.logQueue.length) return Promise.resolve(null);
    const batch = this.logQueue.slice(0, 500);
    this.logQueue = this.logQueue.slice(batch.length);
    if (this.logQueue.length && !this.logTimer) {
      this.logTimer = setTimeout(() => this.flushLogs(), LOG_FLUSH_INTERVAL);
      if (this.logTimer.unref) this.logTimer.unref();
    }
    return this.send({ op: 'batch', batch }).then((msg) => {
      // 界面上的“日志行数”要跟着涨，否则一直是启动时的旧值
      this.info.logRows = (this.info.logRows || 0) + batch.length;
      return msg;
    }).catch((err) => {
      console.error('[db] 写日志失败:', err.message);
      return null;
    });
  }

  /** 日志表太大就只留最近的，避免几年后几个 G */
  trimLogs() {
    if (this.mode !== 'sqlite') return Promise.resolve(null);
    return this.send({
      op: 'exec',
      sql: 'DELETE FROM log_lines WHERE id <= (SELECT MAX(id) FROM log_lines) - @p0',
      params: [MAX_LOG_ROWS],
    }).catch(() => null);
  }

  /* ------------------------------------------------------------ 读 */

  query(sql, params) {
    return this.send({ op: 'query', sql, params: params || [] }).then((msg) => (msg && msg.rows) || []);
  }

  latestLogs(appId, limit) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 2000);
    if (appId) {
      return this.query('SELECT app_id, run_id, seq, ts, stream, text FROM log_lines WHERE app_id = @p0 ORDER BY id DESC LIMIT @p1', [appId, n]);
    }
    return this.query('SELECT app_id, run_id, seq, ts, stream, text FROM log_lines ORDER BY id DESC LIMIT @p0', [n]);
  }

  describe() {
    let bytes = 0;
    try {
      bytes = fs.statSync(this.dbFile).size;
    } catch (err) {
      /* 还没建库 */
    }
    return {
      backend: this.mode,
      dbFile: this.mode === 'sqlite' ? this.dbFile : null,
      bytes,
      sqliteVersion: this.info.sqliteVersion || '',
      logRows: this.info.logRows || 0,
      runRows: this.info.runRows || 0,
      pendingLogs: this.logQueue.length,
      droppedLogs: this.logDropped,
      reason: this.mode === 'sqlite' ? '' : this.reason,
    };
  }

  async close() {
    this.closing = true;
    try {
      while (this.logQueue.length) {
        // eslint-disable-next-line no-await-in-loop
        await this.flushLogs();
      }
      if (this.logTimer) clearTimeout(this.logTimer);
      if (this.child) {
        try {
          this.child.stdin.write('quit\n');
        } catch (err) {
          /* ignore */
        }
        const child = this.child;
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try {
              child.kill();
            } catch (err) {
              /* ignore */
            }
            resolve();
          }, 1500);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } catch (err) {
      console.error('[db] 关闭失败:', err.message);
    }
  }
}

module.exports = { Store, SCHEMA };
