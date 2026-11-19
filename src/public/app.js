'use strict';

/* ------------------------------------------------------------ 基础工具 */

const $ = (id) => document.getElementById(id);

const STATUS_KEYS = {
  idle: 'status.idle',
  starting: 'status.starting',
  running: 'status.running',
  stopping: 'status.stopping',
  stopped: 'status.stopped',
  completed: 'status.completed',
  failed: 'status.failed',
  restarting: 'status.restarting',
};

function statusClass(status) {
  if (status === 'crashed') return 'failed';
  if (status === 'exited') return 'completed';
  return status || 'idle';
}

/** 状态文案：不缓存，切换语言后重绘即变 */
function statusLabel(status) {
  const key = STATUS_KEYS[statusClass(status)];
  return key ? t(key) : status;
}

/** 计划文案：跟着界面语言走（后端那份只用来写日志） */
function scheduleText(sched) {
  if (!sched || !sched.enabled || sched.mode === 'none') return t('sched.text.none');
  if (sched.mode === 'interval') {
    return t('sched.text.interval', {
      n: sched.intervalValue,
      unit: t('sched.unit.' + (sched.intervalUnit || 'minutes')),
    });
  }
  if (sched.mode === 'daily') {
    return t('sched.text.daily', { times: sched.times || t('sched.text.noTimes') });
  }
  if (sched.mode === 'weekly') {
    const days = String(sched.weekdays || '')
      .split(/[,\s;，、]+/)
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    if (!days.length) return t('sched.text.weeklyNoDays');
    return t('sched.text.weekly', {
      days: days.map((d) => t('sched.dayName.' + d)).join(t('sched.dayJoin')),
      times: sched.times || t('sched.text.noTimes'),
    });
  }
  if (sched.mode === 'once') {
    const ts = Date.parse(sched.at);
    if (!Number.isFinite(ts)) return t('sched.text.onceNoTime');
    return t('sched.text.once', { time: fmtTime(ts) });
  }
  return t('sched.text.none');
}

const RUNTIME_LABEL = {
  ps1: 'PS',
  py: 'PY',
  cmd: 'CMD',
  exe: 'EXE',
  custom: 'SHELL',
};

const ACTIVE = new Set(['running', 'starting', 'restarting', 'stopping']);

const S = {
  state: null,
  selected: null,
  tab: 'logs',
  filter: 'all',
  search: '',
  logSearch: '',
  onlyErr: false,
  follow: true,
  log: { appId: null, runId: null, seq: 0, lines: [], mode: 'live', file: null, title: '' },
  paramsFor: null,
  scheduleFor: null,
  editing: null,
  pickDir: '',
};

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

async function api(path, options) {
  const opts = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {});
  const res = await fetch(path, opts);
  let data = {};
  try {
    data = await res.json();
  } catch (err) {
    data = {};
  }
  if (!res.ok) throw new Error(data.message || t('err.request', { code: res.status }));
  return data;
}

function toast(message, kind) {
  const node = el('div', 'toast' + (kind ? ' ' + kind : ''), message);
  $('toasts').appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity 180ms ease, transform 180ms ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 200);
  }, 3200);
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtBytes(bytes) {
  if (!bytes) return '-';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function appById(id) {
  return (S.state && S.state.apps.find((a) => a.id === id)) || null;
}

function selectedApp() {
  return S.selected ? appById(S.selected) : null;
}

const TRIGGER_KEYS = {
  schedule: 'detail.trigger.schedule',
  autostart: 'detail.trigger.autostart',
  restart: 'detail.trigger.restart',
  manual: 'detail.trigger.manual',
};

function triggerLabel(trigger) {
  const key = TRIGGER_KEYS[trigger];
  return key ? t(key) : '';
}

/* ------------------------------------------------------------ 数据流 */

async function refresh() {
  try {
    S.state = await api('/api/state');
    syncLangFromServer();
    render();
  } catch (err) {
    toast(t('err.backend', { msg: err.message }), 'err');
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (event) => {
    try {
      S.state = JSON.parse(event.data);
      render();
    } catch (err) {
      /* 忽略坏帧 */
    }
  };
  es.onerror = () => {
    /* 浏览器会自动重连 */
  };
}

/* ------------------------------------------------------------ 渲染 */

function render() {
  if (!S.state) return;
  renderTop();
  renderSidebar();
  if (S.selected) {
    renderDetail();
  } else {
    renderOverview();
  }
}

function renderTop() {
  const stats = S.state.stats;
  const box = $('topStats');
  box.innerHTML = '';
  const items = [
    { k: 'run', label: t('top.stat.running'), value: stats.running },
    { k: 'err', label: t('top.stat.failed'), value: stats.failed },
    { k: '', label: t('top.stat.total'), value: stats.total },
  ];
  items.forEach((item) => {
    const node = el('div', 'stat ' + item.k);
    node.appendChild(el('b', null, String(item.value)));
    node.appendChild(el('span', null, item.label));
    box.appendChild(node);
  });
}

/* ------------------------------------------------------------ 负载看板 */

function gaugeClass(percent) {
  if (percent === null || percent === undefined) return '';
  if (percent >= 85) return 'bad';
  if (percent >= 65) return 'warn';
  return '';
}

function makeTile(label, valueHtml, options) {
  const opts = options || {};
  const tile = el('div', 'tile');
  const labelNode = el('div', 'tile-label', label);
  if (opts.title) labelNode.title = opts.title;
  tile.appendChild(labelNode);

  const value = el('div', 'tile-value');
  value.innerHTML = valueHtml;
  tile.appendChild(value);

  if (typeof opts.percent === 'number') {
    const gauge = el('div', 'gauge ' + gaugeClass(opts.percent));
    const fill = el('i');
    fill.style.width = `${Math.max(0, Math.min(100, opts.percent))}%`;
    gauge.appendChild(fill);
    tile.appendChild(gauge);
  } else if (opts.note) {
    tile.appendChild(el('div', 'tile-label', opts.note));
  }
  return tile;
}

function renderMetrics() {
  const box = $('metrics');
  if (!box || !S.state) return;
  const sys = S.state.system || {};
  const metricsOn = !S.state.settings || S.state.settings.metricsEnabled !== false;
  box.innerHTML = '';

  const memPct = sys.memTotal ? (sys.memUsed / sys.memTotal) * 100 : null;
  const cpuText = `${sys.cpuPercent === null || sys.cpuPercent === undefined ? '—' : sys.cpuPercent}<small>%</small>${
    sys.cores ? `<small>${t('metrics.cores', { n: sys.cores })}</small>` : ''
  }`;
  box.appendChild(makeTile(t('metrics.cpu'), cpuText, { percent: sys.cpuPercent }));
  box.appendChild(
    makeTile(t('metrics.mem'), `${(sys.memUsed / 1024 ** 3).toFixed(1)}<small>/ ${(sys.memTotal / 1024 ** 3).toFixed(1)} GB</small>`, {
      percent: memPct,
    })
  );
  const disk = sys.disk || null;
  box.appendChild(
    makeTile(
      t('metrics.disk'),
      disk
        ? `${(disk.free / 1024 ** 3).toFixed(1)}<small>/ ${(disk.total / 1024 ** 3).toFixed(0)} GB</small>`
        : `—<small>${t('metrics.disk.fail')}</small>`,
      {
        percent: disk && disk.total ? (1 - disk.free / disk.total) * 100 : undefined,
        note: disk ? t('metrics.disk.note') : t('metrics.disk.nostatf'),
      }
    )
  );
  box.appendChild(
    makeTile(t('metrics.managed'), `${sys.managedCount || 0}<small> ${t('metrics.managed.unit')}</small>`, {
      note: metricsOn ? t('metrics.managed.mem', { n: ((sys.managedMem || 0) / 1024 ** 2).toFixed(0) }) : t('metrics.managed.off'),
    })
  );
  box.appendChild(
    makeTile(
      t('metrics.managedCpu'),
      metricsOn ? `${sys.managedCpu || 0}<small>%</small>` : `—<small>${t('metrics.managedCpu.off')}</small>`,
      {
        percent: metricsOn ? sys.managedCpu || 0 : undefined,
        note: metricsOn ? t('metrics.managedCpu.note') : t('metrics.managedCpu.noteOff'),
      }
    )
  );
  box.appendChild(
    makeTile(t('metrics.uptime'), fmtDuration((sys.uptimeSec || 0) * 1000), {
      note: sys.dockMem ? t('metrics.uptime.self', { n: ((sys.dockMem / 1024 ** 2).toFixed(0)) }) : t('metrics.uptime.note'),
    })
  );

  const storage = sys.storage || { backend: 'json' };
  if (storage.backend === 'sqlite') {
    const size = storage.bytes >= 1024 ** 2 ? `${(storage.bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(storage.bytes / 1024))} KB`;
    box.appendChild(
      makeTile(t('metrics.storage'), `SQLite<small>${size}</small>`, {
        note: t('metrics.storage.sqliteNote', {
          version: storage.sqliteVersion || '?',
          rows: (storage.logRows || 0).toLocaleString(I18N.locale()),
        }),
        title: t('metrics.storage.sqliteTitle', { file: storage.dbFile, pending: storage.pendingLogs || 0 }),
      })
    );
  } else {
    box.appendChild(
      makeTile(t('metrics.storage'), `JSON<small>${t('metrics.storage.fallback')}</small>`, {
        note: t('metrics.storage.jsonNote'),
        title: storage.reason || '',
      })
    );
  }
}

function renderSidebar() {
  const list = $('appList');
  const keyword = S.search.trim().toLowerCase();
  const apps = S.state.apps.filter((a) => {
    if (!keyword) return true;
    return (a.name + ' ' + a.command + ' ' + a.description).toLowerCase().includes(keyword);
  });
  $('appCount').textContent = String(S.state.apps.length);
  list.innerHTML = '';
  if (!apps.length) {
    const empty = el('div', 'empty');
    empty.style.padding = '30px 12px';
    empty.appendChild(el('strong', null, S.search ? t('side.empty.search.title') : t('side.empty.title')));
    empty.appendChild(el('p', 'muted', S.search ? t('side.empty.search.hint') : t('side.empty.hint')));
    list.appendChild(empty);
  }
  apps.forEach((app) => {
    const node = el('button', 'appitem' + (app.id === S.selected ? ' active' : ''));
    const dot = el('span', 'dot ' + statusClass(app.status));
    const info = el('div');
    info.appendChild(el('div', 'appitem-name', app.name));
    let sub;
    if (ACTIVE.has(app.status)) {
      sub = app.pid ? `PID ${app.pid}` : t('side.starting');
      if (app.metrics) sub += ` · ${app.metrics.cpu}% · ${fmtBytes(app.metrics.mem)}`;
    } else if (app.status === 'failed') {
      sub = t('card.exitCode', { n: app.exitCode ?? '-' });
    } else if (app.schedule && app.schedule.enabled && app.nextRunAt) {
      sub = t('card.next', { t: fmtTime(app.nextRunAt) });
    } else {
      sub = app.url || app.command;
    }
    info.appendChild(el('div', 'appitem-sub', sub || ''));
    const right = el('div', 'appitem-right');
    right.appendChild(el('span', 'rt', RUNTIME_LABEL[app.runtime] || 'CMD'));
    node.appendChild(dot);
    node.appendChild(info);
    node.appendChild(right);
    node.addEventListener('click', () => selectApp(app.id));
    list.appendChild(node);
  });

  const foot = $('sidebarFoot');
  foot.innerHTML = '';
  foot.appendChild(el('span', null, t('side.foot.total', { n: S.state.apps.length })));
  foot.appendChild(el('span', null, S.state.stats.running ? t('side.foot.running', { n: S.state.stats.running }) : t('side.foot.idle')));
}

function visibleByFilter(app) {
  if (S.filter === 'all') return true;
  if (S.filter === 'running') return ACTIVE.has(app.status);
  if (S.filter === 'failed') return app.status === 'failed';
  if (S.filter === 'stopped') return ['idle', 'stopped', 'completed'].includes(app.status);
  return true;
}

function renderOverview() {
  const grid = $('overviewGrid');
  const apps = S.state.apps.filter(visibleByFilter);
  grid.innerHTML = '';
  renderMetrics();

  if (!S.state.apps.length) {
    const empty = el('div', 'empty');
    empty.appendChild(el('strong', null, t('ov.empty.title')));
    empty.appendChild(el('p', 'muted', t('ov.empty.hint')));
    const btn = el('button', 'btn btn-primary', t('ov.empty.button'));
    btn.addEventListener('click', () => openImport(null));
    empty.appendChild(btn);
    grid.appendChild(empty);
    $('overviewSub').textContent = t('ov.sub');
    return;
  }

  $('overviewSub').textContent = t('ov.stats', {
    running: S.state.stats.running,
    failed: S.state.stats.failed,
    total: S.state.stats.total,
  });

  if (!apps.length) {
    const empty = el('div', 'empty');
    empty.appendChild(el('strong', null, t('ov.empty.filtered')));
    grid.appendChild(empty);
    return;
  }

  apps.forEach((app, index) => {
    const card = el('article', 'card');
    card.style.animationDelay = `${Math.min(index * 35, 240)}ms`;
    card.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      selectApp(app.id);
    });

    const top = el('div', 'card-top');
    const nameWrap = el('div', 'card-name');
    nameWrap.appendChild(el('span', 'dot ' + statusClass(app.status)));
    nameWrap.appendChild(el('span', null, app.name));
    top.appendChild(nameWrap);
    top.appendChild(el('span', 'pill ' + statusClass(app.status), statusLabel(app.status)));
    card.appendChild(top);

    card.appendChild(el('p', 'card-desc', app.description || t('card.noDesc')));

    const meta = el('div', 'card-meta');
    meta.appendChild(el('span', 'tag', RUNTIME_LABEL[app.runtime] || 'CMD'));
    if (ACTIVE.has(app.status) && app.pid) meta.appendChild(el('span', 'tag', `PID ${app.pid}`));
    if (ACTIVE.has(app.status) && app.startedAt)
      meta.appendChild(el('span', 'tag', t('card.uptime', { d: fmtDuration(Date.now() - app.startedAt) })));
    if (app.metrics) {
      meta.appendChild(el('span', 'tag', `CPU ${app.metrics.cpu}%`));
      meta.appendChild(el('span', 'tag', fmtBytes(app.metrics.mem)));
    }
    if (!ACTIVE.has(app.status) && app.exitCode !== null && app.exitCode !== undefined)
      meta.appendChild(el('span', 'tag', t('card.exitCode', { n: app.exitCode })));
    if (app.url) meta.appendChild(el('span', 'tag', app.url.replace(/^https?:\/\//, '')));
    card.appendChild(meta);

    const pathLine = el('div', 'card-path', app.command || t('card.noCommand'));
    if (app.pathMissing) pathLine.classList.add('path-missing');
    card.appendChild(pathLine);
    if (app.pathMissing) {
      card.appendChild(el('div', 'card-error', t('card.pathMissing', { path: app.commandResolved || app.command })));
    }

    if (app.schedule && app.schedule.enabled) {
      const sched = el('div');
      const chip = el('span', 'sched-chip', `⏱ ${scheduleText(app.schedule)}`);
      sched.appendChild(chip);
      if (app.nextRunAt) {
        const rest = el('span', 'tag', t('card.next', { t: fmtTime(app.nextRunAt) }));
        rest.style.marginLeft = '6px';
        sched.appendChild(rest);
      }
      card.appendChild(sched);
    }

    if (app.status === 'failed') {
      card.appendChild(
        el(
          'div',
          'card-error',
          t('card.failedNote', { code: app.exitCode ?? '-', time: app.endedAt ? fmtTime(app.endedAt) : '' })
        )
      );
    } else if (app.status === 'completed') {
      card.appendChild(
        el('div', 'card-error', t('card.completedNote', { time: app.endedAt ? fmtTime(app.endedAt) : '' }))
      );
      const lastError = card.lastElementChild;
      lastError.style.background = 'var(--green-soft)';
      lastError.style.borderColor = 'rgba(53, 209, 155, 0.28)';
      lastError.style.color = 'var(--green)';
    }

    const actions = el('div', 'card-actions');
    if (ACTIVE.has(app.status)) {
      const stop = el('button', 'btn btn-stop', t('card.stop'));
      stop.disabled = app.status === 'stopping';
      stop.addEventListener('click', () => act(app.id, 'stop'));
      actions.appendChild(stop);
    } else {
      const start = el('button', 'btn btn-primary', t('card.start'));
      start.addEventListener('click', () => act(app.id, 'start'));
      actions.appendChild(start);
    }
    if (app.url) {
      const open = el('button', 'btn btn-ghost', t('card.open'));
      open.addEventListener('click', () => window.open(app.url, '_blank'));
      actions.appendChild(open);
    }
    const detail = el('button', 'btn btn-ghost', t('card.logs'));
    detail.addEventListener('click', () => selectApp(app.id));
    actions.appendChild(detail);
    card.appendChild(actions);

    grid.appendChild(card);
  });

  if (S.state.apps.length < 4) grid.appendChild(tipsCard());
}

function tipsCard() {
  const card = el('article', 'card tips');
  card.appendChild(el('h3', null, t('card.tips.title')));
  const tips = [
    ['tips.param.key', 'tips.param.text'],
    ['tips.port.key', 'tips.port.text'],
    ['tips.log.key', 'tips.log.text'],
    ['tips.restart.key', 'tips.restart.text'],
  ];
  tips.forEach(([key, text]) => {
    const line = el('div', 'tip-line');
    line.appendChild(el('b', null, t(key)));
    line.appendChild(el('span', null, t(text)));
    card.appendChild(line);
  });
  return card;
}

function renderDetail() {
  const app = selectedApp();
  if (!app) {
    goHome();
    return;
  }

  $('dName').textContent = app.name;
  const pill = $('dStatus');
  const cls = statusClass(app.status);
  pill.className = 'pill ' + cls;
  pill.textContent = statusLabel(app.status);

  renderMeta(app);
  renderActions(app);
  renderResult(app);
  renderTabPanels(app);
}

/** 上一次运行到底是“正常结束”还是“报错”，单独用一条横幅说清楚 */
function renderResult(app) {
  const box = $('dResult');
  const cls = statusClass(app.status);
  box.className = 'result-banner';
  box.innerHTML = '';

  if (ACTIVE.has(app.status)) {
    box.classList.add('muted-line');
    const trig = triggerLabel(app.trigger);
    box.textContent =
      t('detail.running') +
      (trig ? t('detail.triggerWrap', { t: trig }) : '') +
      (app.startedAt ? t('detail.runningFor', { d: fmtDuration(Date.now() - app.startedAt) }) : '');
    return;
  }

  if (!app.endedAt || app.exitCode === null || app.exitCode === undefined) {
    box.classList.add('hidden');
    return;
  }

  const duration = app.endedAt && app.startedAt ? fmtDuration(app.endedAt - app.startedAt) : '-';
  const trigText = triggerLabel(app.trigger);
  const trig = trigText ? t('detail.triggerSuffix', { t: trigText }) : '';
  if (cls === 'failed') {
    box.classList.add('bad');
    box.innerHTML = t('detail.failedBanner', { code: app.exitCode, time: fmtTime(app.endedAt), dur: duration, trig });
  } else if (cls === 'stopped') {
    box.classList.add('muted-line');
    box.innerHTML = t('detail.stoppedBanner', { time: fmtTime(app.endedAt), dur: duration, trig });
  } else {
    box.classList.add('ok');
    box.innerHTML = t('detail.okBanner', { time: fmtTime(app.endedAt), dur: duration, trig });
  }
}

function renderMeta(app) {
  const box = $('dMeta');
  box.innerHTML = '';
  const add = (label, value, cls) => {
    const chip = el('span', 'chip-meta ' + (cls || ''));
    chip.appendChild(el('span', null, label));
    chip.appendChild(el('b', null, value));
    box.appendChild(chip);
    return chip;
  };
  add(t('meta.runtime'), RUNTIME_LABEL[app.runtime] || 'CMD');
  if (app.pid) add('PID', String(app.pid));
  if (ACTIVE.has(app.status) && app.startedAt) {
    const chip = el('span', 'chip-meta');
    chip.appendChild(el('span', null, t('meta.uptime')));
    const b = el('b', null, fmtDuration(Date.now() - app.startedAt));
    b.dataset.uptime = String(app.startedAt);
    chip.appendChild(b);
    box.appendChild(chip);
  }
  if (app.metrics) {
    add('CPU', `${app.metrics.cpu}%`);
    add(t('meta.mem'), fmtBytes(app.metrics.mem));
    if (app.metrics.cpuSec) add(t('meta.cpuTotal'), `${app.metrics.cpuSec}s`);
  }
  if (!ACTIVE.has(app.status) && app.exitCode !== null && app.exitCode !== undefined) {
    add(t('meta.exitCode'), String(app.exitCode));
  }
  if (app.restarts) add(t('meta.restarts'), String(app.restarts));
  if (app.schedule && app.schedule.enabled) {
    add(t('meta.schedule'), scheduleText(app.schedule));
  }
  if (app.nextRunAt) {
    add(t('meta.nextRun'), fmtTime(app.nextRunAt));
  }
  if (app.url) {
    const chip = el('span', 'chip-meta link', app.url);
    chip.title = t('meta.url.title');
    chip.addEventListener('click', () => window.open(app.url, '_blank'));
    box.appendChild(chip);
  }
  if (app.status === 'restarting' && app.restartAt) {
    add(t('meta.restartAt'), fmtTime(app.restartAt));
  }
}

function renderActions(app) {
  const box = $('dActions');
  box.innerHTML = '';
  const mk = (label, cls, onClick, disabled) => {
    const btn = el('button', 'btn ' + cls, label);
    if (disabled) btn.disabled = true;
    btn.addEventListener('click', onClick);
    box.appendChild(btn);
    return btn;
  };

  if (ACTIVE.has(app.status)) {
    mk(t('card.stop'), 'btn-stop', () => act(app.id, 'stop'), app.status === 'stopping');
    mk(t('act.restart'), 'btn-ghost', () => act(app.id, 'restart'));
  } else {
    mk(t('card.start'), 'btn-primary', () => act(app.id, 'start'));
  }
  if (app.url) mk(t('card.open'), 'btn-ghost', () => window.open(app.url, '_blank'));
  mk(t('act.edit'), 'btn-ghost', () => openImport(app));
}

function switchTab(tab) {
  S.tab = tab;
  $('dTabs').querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  ['logs', 'params', 'schedule', 'runs', 'config'].forEach((name) => {
    const panel = $('panel-' + name);
    if (panel) panel.classList.toggle('hidden', name !== tab);
  });
  const app = selectedApp();
  if (!app) return;
  if (tab === 'params') renderParams(app);
  if (tab === 'schedule') renderSchedule(app, true);
  if (tab === 'runs') renderRuns(app);
  if (tab === 'config') renderConfig(app);
  if (tab === 'logs' && S.log.mode === 'live') pollTail(0);
}

function renderTabPanels(app) {
  if (S.tab === 'config') renderConfig(app);
  if (S.tab === 'runs') renderRuns(app);
  if (S.tab === 'params' && S.paramsFor !== app.id) renderParams(app);
  if (S.tab === 'schedule') {
    if (S.scheduleFor !== app.id) renderSchedule(app, true);
    else renderScheduleSummary(app);
  }
}

/* ------------------------------------------------------------ 计划面板 */

function toDatetimeLocal(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fromDatetimeLocal(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function updateScheduleRows() {
  const mode = $('sched_mode').value;
  $('schedIntervalRow').classList.toggle('hidden', mode !== 'interval');
  $('schedDailyRow').classList.toggle('hidden', mode !== 'daily');
  $('schedWeeklyRow').classList.toggle('hidden', mode !== 'weekly');
  $('schedOnceRow').classList.toggle('hidden', mode !== 'once');
}

function readWeekdayChecks() {
  return Array.from(document.querySelectorAll('#schedWeekdays input:checked'))
    .map((input) => Number(input.value))
    .sort((a, b) => a - b);
}

function writeWeekdayChecks(raw) {
  const days = String(raw || '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  document.querySelectorAll('#schedWeekdays input').forEach((input) => {
    input.checked = days.includes(Number(input.value));
  });
}

function renderSchedule(app, withForm) {
  const s = app.schedule || { enabled: false, mode: 'none', intervalValue: 30, intervalUnit: 'minutes', times: '', weekdays: '', at: '' };
  if (withForm) {
    S.scheduleFor = app.id;
    $('sched_enabled').checked = !!s.enabled;
    $('sched_mode').value = s.mode || 'none';
    $('sched_value').value = s.intervalValue || 30;
    $('sched_unit').value = s.intervalUnit || 'minutes';
    $('sched_times').value = s.times || '';
    $('sched_weekly_times').value = s.mode === 'weekly' ? s.times || '' : '';
    writeWeekdayChecks(s.weekdays);
    $('sched_at').value = toDatetimeLocal(s.at);
    updateScheduleRows();
  }
  renderScheduleSummary(app);
}

function renderScheduleSummary(app) {
  const box = $('schedSummary');
  box.innerHTML = '';
  const lines = [];

  if (!app.schedule || !app.schedule.enabled || app.schedule.mode === 'none') {
    lines.push(t('sched.summary.none'));
  } else {
    lines.push(t('sched.summary.current', { text: scheduleText(app.schedule) }));
    if (app.nextRunAt) {
      lines.push(t('sched.summary.next', { time: fmtTime(app.nextRunAt), rest: fmtDuration(app.nextRunAt - Date.now()) }));
    } else if (app.schedule.mode === 'once') {
      lines.push(t('sched.summary.expired'));
    }
  }
  lines.push(t('sched.summary.single'));
  lines.push(t('sched.summary.exit'));

  lines.forEach((text) => {
    const p = el('div');
    p.innerHTML = text;
    box.appendChild(p);
  });
}

async function saveSchedule() {
  const app = selectedApp();
  if (!app) return;
  const mode = $('sched_mode').value;
  const weekly = mode === 'weekly';
  const schedule = {
    enabled: $('sched_enabled').checked && mode !== 'none',
    mode,
    intervalValue: Math.max(1, Number($('sched_value').value) || 30),
    intervalUnit: $('sched_unit').value,
    times: (weekly ? $('sched_weekly_times').value : $('sched_times').value).trim(),
    weekdays: weekly ? readWeekdayChecks().join(',') : '',
    at: fromDatetimeLocal($('sched_at').value),
  };
  if (schedule.enabled && mode === 'daily' && !schedule.times) {
    toast(t('sched.need.daily'), 'err');
    return;
  }
  if (schedule.enabled && weekly) {
    if (!schedule.weekdays) {
      toast(t('sched.need.weekdays'), 'err');
      return;
    }
    if (!schedule.times) {
      toast(t('sched.need.weeklyTimes'), 'err');
      return;
    }
  }
  if (schedule.enabled && mode === 'once' && !schedule.at) {
    toast(t('sched.need.once'), 'err');
    return;
  }
  try {
    const data = await api(`/api/apps/${app.id}/schedule`, { method: 'POST', body: JSON.stringify({ schedule }) });
    if (data.state) S.state = data.state;
    toast(
      data.schedule && data.schedule.enabled ? t('sched.saved', { text: scheduleText(data.schedule) }) : t('sched.disabled'),
      'ok'
    );
    S.scheduleFor = null;
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------ 参数面板 */

function renderParams(app) {
  S.paramsFor = app.id;
  const table = $('paramTable');
  table.innerHTML = '';

  const rows = [];
  const keys = new Set();
  (app.params || []).forEach((p) => {
    keys.add(p.key);
    rows.push({ key: p.key, label: p.label, hint: p.hint, value: app.values && app.values[p.key] !== undefined ? app.values[p.key] : p.def });
  });
  Object.keys(app.values || {}).forEach((k) => {
    if (!keys.has(k)) rows.push({ key: k, label: '', hint: '', value: app.values[k] });
  });
  if (!rows.length) rows.push({ key: '', label: '', hint: '', value: '' });

  rows.forEach((row) => table.appendChild(paramRow(row)));

  const hint = el('p', 'muted', t('params.hint'));
  hint.style.fontSize = '12px';
  hint.style.padding = '4px 2px';
  table.appendChild(hint);
}

function paramRow(row) {
  const wrap = el('div', 'param-row');
  const keyBox = el('div', 'param-key');
  const keyInput = el('input');
  keyInput.value = row.key || '';
  keyInput.placeholder = t('params.key.placeholder');
  keyInput.style.height = '28px';
  keyInput.style.padding = '0 8px';
  keyInput.style.background = 'transparent';
  keyInput.style.border = '1px solid var(--line)';
  keyInput.style.borderRadius = '7px';
  keyInput.style.color = 'var(--accent)';
  keyInput.style.fontFamily = 'var(--mono)';
  keyInput.style.fontSize = '12px';
  keyBox.appendChild(keyInput);
  const hintText = row.hint || (row.label ? row.label : '');
  if (hintText) keyBox.appendChild(el('span', null, hintText));

  const valueInput = el('input');
  valueInput.value = row.value === undefined || row.value === null ? '' : String(row.value);
  valueInput.placeholder = t('params.value.placeholder');
  valueInput.className = 'param-value';

  const del = el('button', 'btn btn-icon', '✕');
  del.title = t('params.delete.title');
  del.addEventListener('click', () => wrap.remove());

  wrap.appendChild(keyBox);
  wrap.appendChild(valueInput);
  wrap.appendChild(del);
  return wrap;
}

async function saveParams() {
  const app = selectedApp();
  if (!app) return;
  const params = [];
  const values = {};
  $('paramTable')
    .querySelectorAll('.param-row')
    .forEach((row) => {
      const key = row.querySelector('.param-key input').value.trim();
      const value = row.querySelector('.param-value').value;
      if (!key) return;
      const existing = (app.params || []).find((p) => p.key === key);
      params.push({ key, label: existing ? existing.label : '', def: existing ? existing.def : value, hint: existing ? existing.hint : '' });
      values[key] = value;
    });
  try {
    await api('/api/apps', {
      method: 'POST',
      body: JSON.stringify({ id: app.id, params, values }),
    });
    toast(t('params.saved'), 'ok');
    S.paramsFor = null;
    await refresh();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------ 运行记录 */

function renderRuns(app) {
  const box = $('runList');
  box.innerHTML = '';
  const runs = app.runs || [];
  if (!runs.length) {
    const empty = el('div', 'empty');
    empty.appendChild(el('strong', null, t('runs.empty.title')));
    empty.appendChild(el('p', 'muted', t('runs.empty.hint')));
    box.appendChild(empty);
    return;
  }
  runs.forEach((run, index) => {
    const row = el('div', 'run-row');
    const st = statusClass(run.status);
    row.appendChild(el('span', 'pill ' + st, statusLabel(run.status)));
    row.appendChild(el('span', 'mono', `${fmtTime(run.startedAt)}`));
    const info = el('span', 'mono');
    const resultText =
      st === 'failed'
        ? t('runs.result.failed', { code: run.exitCode ?? '-' })
        : st === 'stopped'
          ? t('runs.result.stopped')
          : t('runs.result.ok');
    info.textContent = t('runs.info', {
      result: resultText,
      dur: fmtDuration((run.endedAt || Date.now()) - run.startedAt),
    });
    row.appendChild(info);
    const triggerKey = ['schedule', 'autostart', 'restart'].indexOf(run.trigger) >= 0 ? run.trigger : 'manual';
    const triggerText = t('runs.trigger.' + triggerKey);
    row.appendChild(el('span', 'mono', index === 0 ? t('runs.trigger.latest', { t: triggerText }) : triggerText));
    const btn = el('button', 'btn btn-ghost', t('runs.open'));
    btn.addEventListener('click', () => loadHistoryLog(app.id, run));
    row.appendChild(btn);
    box.appendChild(row);
  });
}

async function loadHistoryLog(appId, run) {
  if (!run.log) {
    toast(t('logs.history.missing'), 'err');
    return;
  }
  try {
    const data = await api(`/api/log?file=${encodeURIComponent(run.log)}`);
    S.log.mode = 'history';
    S.log.file = run.log;
    S.log.lines = [];
    S.log.seq = 0;
    S.log.runId = 'history';
    const view = $('logView');
    view.innerHTML = '';
    const lines = data.lines.map((text, i) => {
      const m = text.match(/^\[([^\]]+)\]\s+\[(\w+)\]\s?([\s\S]*)$/);
      const time = m ? new Date(m[1]) : null;
      return {
        i: i + 1,
        t: time ? time.toTimeString().slice(0, 8) : '',
        s: m && m[2] === 'ERR' ? 2 : 1,
        m: m ? m[3] : text,
      };
    });
    S.log.lines = lines;
    appendLogNodes(lines, true);
    $('btnLive').classList.remove('hidden');
    switchTab('logs');
    toast(t('logs.history.loaded', { file: run.log }), 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function backToLive() {
  $('btnLive').classList.add('hidden');
  const app = selectedApp();
  if (!app) return;
  S.log.mode = 'live';
  S.log.lines = [];
  S.log.seq = 0;
  S.log.runId = null;
  $('logView').innerHTML = '';
  pollTail(0);
}

/* ------------------------------------------------------------ 配置面板 */

function renderConfig(app) {
  const box = $('configKV');
  box.innerHTML = '';
  const rows = [
    [t('config.row.runtime'), RUNTIME_LABEL[app.runtime] || app.runtime],
    [t('config.row.command'), (app.command || t('config.empty.fill')) + (app.pathMissing ? t('config.pathMissing') : '')],
    [t('config.row.resolved'), app.commandResolved || t('config.empty.fill')],
    [t('config.row.args'), app.args || t('config.empty.none')],
    [t('config.row.cwd'), app.cwd || t('config.empty.cwd')],
    [t('config.row.port'), app.port ? String(app.port) : t('config.empty.port')],
    [t('config.row.stopMode'), app.stopMode === 'graceful' ? t('config.stop.graceful') : t('config.stop.force')],
    [
      t('config.row.schedule'),
      app.schedule && app.schedule.enabled
        ? app.nextRunAt
          ? t('config.scheduleValue', { text: scheduleText(app.schedule), time: fmtTime(app.nextRunAt) })
          : scheduleText(app.schedule)
        : t('config.notEnabled'),
    ],
    [t('config.row.autostart'), app.autoStart ? t('config.autostart.on') : t('config.autostart.off')],
    [
      t('config.row.autorestart'),
      app.autoRestart ? t('config.autorestart.on', { n: app.maxRestarts }) : t('config.autorestart.off'),
    ],
    [t('config.row.env'), app.env || t('config.empty.none')],
    [t('config.row.desc'), app.description || t('config.empty.none')],
    [t('config.row.created'), fmtTime(app.createdAt)],
  ];
  rows.forEach(([k, v]) => {
    const row = el('div', 'kv-row');
    row.appendChild(el('span', null, k));
    const val = el('div', null, v);
    row.appendChild(val);
    box.appendChild(row);
  });
}

/* ------------------------------------------------------------ 日志 */

function classify(line) {
  if (line.s === 2) return 'err';
  if (/^[▶■✔↻⚠]/.test(line.m)) return 'sys';
  return '';
}

function buildLineNode(line) {
  const node = el('div', 'logline');
  const cls = classify(line);
  if (cls) node.classList.add(cls);
  node.appendChild(el('span', 'ts', line.t || ''));
  node.appendChild(el('span', 'tag', line.s === 2 ? 'ERR' : 'OUT'));
  node.appendChild(el('span', 'msg', line.m));
  node._line = line;
  applyLineFilter(node, line);
  return node;
}

function applyLineFilter(node, line) {
  const keyword = S.logSearch.trim().toLowerCase();
  const hit = keyword ? String(line.m).toLowerCase().includes(keyword) : false;
  node.classList.toggle('dim', !!keyword && !hit);
  node.classList.toggle('hit', !!keyword && hit);
  const hideForErr = S.onlyErr && line.s !== 2;
  node.style.display = hideForErr ? 'none' : '';
}

function refilterLogs() {
  $('logView')
    .querySelectorAll('.logline')
    .forEach((node) => {
      if (node._line) applyLineFilter(node, node._line);
    });
  updateLogStat();
}

function appendLogNodes(lines, reset) {
  const view = $('logView');
  if (reset) view.innerHTML = '';
  const emptyNode = view.querySelector('.log-empty');
  if (emptyNode) emptyNode.remove();
  const frag = document.createDocumentFragment();
  lines.forEach((line) => frag.appendChild(buildLineNode(line)));
  view.appendChild(frag);
  while (view.childElementCount > 4200) view.firstElementChild.remove();
  if (S.follow) view.scrollTop = view.scrollHeight;
  updateLogStat();
}

function updateLogStat() {
  const app = selectedApp();
  const total = S.log.lines.length;
  const errs = S.log.lines.filter((l) => l.s === 2).length;
  const parts = [];
  if (S.log.mode === 'history') parts.push(t('logs.stat.history'));
  parts.push(t('logs.stat.lines', { n: total }));
  if (errs) parts.push(t('logs.stat.errors', { n: errs }));
  if (app && ACTIVE.has(app.status)) parts.push(t('logs.stat.live'));
  $('logStat').textContent = parts.join(' · ');
}

let pollBusy = false;

async function pollTail(depth) {
  const app = selectedApp();
  if (!app || S.tab !== 'logs' || S.log.mode !== 'live') return;
  if (pollBusy) return;
  pollBusy = true;
  try {
    const data = await api(`/api/apps/${app.id}/tail?since=${S.log.seq}`);
    if (S.selected !== app.id || S.log.mode !== 'live') return;
    if (data.runId && data.runId !== S.log.runId) {
      S.log.runId = data.runId;
      S.log.seq = 0;
      S.log.lines = [];
      $('logView').innerHTML = '';
      if ((depth || 0) < 2) {
        pollBusy = false;
        return pollTail((depth || 0) + 1);
      }
    }
    if (data.lines && data.lines.length) {
      S.log.lines = S.log.lines.concat(data.lines);
      if (S.log.lines.length > 4200) S.log.lines = S.log.lines.slice(-4200);
      appendLogNodes(data.lines, false);
    } else {
      updateLogStat();
    }
    if (typeof data.seq === 'number') S.log.seq = data.seq;
    if (!S.log.lines.length && !data.runId) {
      const view = $('logView');
      if (!view.querySelector('.log-empty')) {
        view.appendChild(
          el('div', 'log-empty', app.status === 'idle' ? t('logs.empty.idle') : t('logs.empty.none'))
        );
      }
    }
  } catch (err) {
    /* 静默重试 */
  } finally {
    pollBusy = false;
  }
}

setInterval(() => pollTail(0), 450);

async function clearLog() {
  const app = selectedApp();
  if (!app) return;
  if (S.log.mode === 'history') {
    S.log.lines = [];
    $('logView').innerHTML = '';
    updateLogStat();
    return;
  }
  try {
    await api(`/api/apps/${app.id}/tail`, { method: 'DELETE' });
    S.log.lines = [];
    S.log.seq = S.log.seq;
    $('logView').innerHTML = '';
    updateLogStat();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function copyLogs() {
  const text = S.log.lines.map((l) => `${l.t} ${l.s === 2 ? '[ERR]' : '[OUT]'} ${l.m}`).join('\r\n');
  if (!text) {
    toast(t('logs.copy.none'));
    return;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => toast(t('logs.copy.ok', { n: S.log.lines.length }), 'ok'))
    .catch(() => toast(t('logs.copy.fail'), 'err'));
}

/* ------------------------------------------------------------ 操作 */

async function act(appId, action) {
  try {
    const data = await api(`/api/apps/${appId}/${action}`, { method: 'POST' });
    if (data.state) S.state = data.state;
    if (data.ok === false) toast(data.message || t('act.failed'), 'err');
    else if (action === 'start') toast(t('act.started'), 'ok');
    render();
    if (action === 'start' || action === 'restart') {
      S.log.mode = 'live';
      S.log.runId = null;
      S.log.seq = 0;
      setTimeout(() => pollTail(0), 120);
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

function selectApp(id) {
  S.selected = id;
  S.paramsFor = null;
  S.scheduleFor = null;
  S.log = { appId: id, runId: null, seq: 0, lines: [], mode: 'live', file: null, title: '' };
  $('logView').innerHTML = '';
  S.logSearch = '';
  $('logSearch').value = '';
  $('btnLive').classList.add('hidden');
  $('overview').classList.add('hidden');
  $('detail').classList.remove('hidden');
  switchTab('logs');
  render();
  pollTail(0);
}

function goHome() {
  S.selected = null;
  $('detail').classList.add('hidden');
  $('overview').classList.remove('hidden');
  render();
}

/* ------------------------------------------------------------ 导入 / 编辑 */

function openModal(id) {
  $(id).classList.remove('hidden');
  const focusable = $(id).querySelector('input, select, textarea');
  if (focusable) setTimeout(() => focusable.focus(), 40);
}

function closeModal(id) {
  $(id).classList.add('hidden');
}

function openImport(app) {
  S.editing = app ? app.id : null;
  $('importTitle').textContent = app ? t('import.title.edit') : t('import.title');
  $('btnSaveApp').textContent = app ? t('import.save.edit') : t('import.save');
  $('importHint').textContent = app ? t('import.hint.edit') : t('import.hint');

  $('f_name').value = app ? app.name : '';
  $('f_runtime').value = app ? app.runtime : 'ps1';
  $('f_command').value = app ? app.command : '';
  $('f_args').value = app ? app.args : '';
  $('f_cwd').value = app ? app.cwd : '';
  $('f_port').value = app ? app.port : '';
  $('f_env').value = app ? app.env : '';
  $('f_desc').value = app ? app.description : '';
  $('f_stopmode').value = app ? app.stopMode : 'force';
  $('f_autostart').checked = app ? !!app.autoStart : false;
  $('f_autorestart').checked = app ? !!app.autoRestart : false;
  $('f_maxrestart').value = app && app.maxRestarts ? app.maxRestarts : 5;

  const dir = app && app.command ? app.command.replace(/[\\/][^\\/]+$/, '') : S.pickDir;
  $('pickDir').value = dir || '';
  $('pickerPanel').classList.add('hidden');

  openModal('importModal');
}

async function saveApp() {
  const name = $('f_name').value.trim();
  const command = $('f_command').value.trim();
  if (!name) {
    toast(t('import.need.name'), 'err');
    return;
  }
  if (!command) {
    toast(t('import.need.command'), 'err');
    return;
  }
  const payload = {
    name,
    command,
    runtime: $('f_runtime').value,
    args: $('f_args').value,
    cwd: $('f_cwd').value.trim(),
    port: $('f_port').value.trim(),
    env: $('f_env').value,
    description: $('f_desc').value.trim(),
    stopMode: $('f_stopmode').value,
    autoStart: $('f_autostart').checked,
    autoRestart: $('f_autorestart').checked,
    maxRestarts: Math.max(1, Number($('f_maxrestart').value) || 5),
  };
  if (S.editing) payload.id = S.editing;
  try {
    const data = await api('/api/apps', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('importModal');
    toast(S.editing ? t('import.updated') : t('import.saved'), 'ok');
    if (data.state) S.state = data.state;
    render();
    if (!S.editing && data.app) selectApp(data.app.id);
    S.editing = null;
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteApp() {
  const app = selectedApp();
  if (!app) return;
  if (!window.confirm(t('app.deleteConfirm', { name: app.name }))) return;
  try {
    await api(`/api/apps/${app.id}`, { method: 'DELETE' });
    toast(t('app.deleted'), 'ok');
    S.selected = null;
    $('detail').classList.add('hidden');
    $('overview').classList.remove('hidden');
    await refresh();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------ 目录选择 */

async function browse(dir) {
  try {
    const data = await api(`/api/browse?dir=${encodeURIComponent(dir || '')}`);
    S.pickDir = data.dir;
    $('pickDir').value = data.dir;
    const list = $('pickList');
    list.innerHTML = '';

    const up = el('button', 'pick-row dir');
    up.appendChild(el('span', 'kind', 'DIR'));
    up.appendChild(el('span', null, t('import.picker.upRow')));
    up.addEventListener('click', () => browse(data.parent));
    list.appendChild(up);

    (data.dirs || []).forEach((d) => {
      const row = el('button', 'pick-row dir');
      row.appendChild(el('span', 'kind', 'DIR'));
      row.appendChild(el('span', null, d.name));
      row.appendChild(el('span', 'path', d.path));
      row.addEventListener('click', () => browse(d.path));
      list.appendChild(row);
    });

    (data.files || []).forEach((f) => {
      const row = el('button', 'pick-row');
      row.appendChild(el('span', 'kind', f.ext.replace('.', '').toUpperCase()));
      row.appendChild(el('span', null, f.name));
      row.appendChild(el('span', 'path', `${(f.size / 1024).toFixed(1)} KB`));
      row.addEventListener('click', () => {
        $('f_command').value = f.path;
        if (!$('f_cwd').value) $('f_cwd').value = S.pickDir;
        if (!$('f_name').value) $('f_name').value = f.name.replace(/\.[^.]+$/, '');
        const ext = f.ext.toLowerCase();
        $('f_runtime').value = ext === '.ps1' ? 'ps1' : ext === '.py' ? 'py' : ext === '.cmd' || ext === '.bat' ? 'cmd' : ext === '.exe' ? 'exe' : 'custom';
        toast(t('import.picked', { name: f.name }), 'ok');
      });
      list.appendChild(row);
    });

    const short = $('pickShortcuts');
    short.innerHTML = '';
    (data.shortcuts || []).forEach((s) => {
      const chip = el('button', 'chip', s.name);
      chip.addEventListener('click', () => browse(s.path));
      short.appendChild(chip);
    });

    if (data.error) toast(data.error, 'err');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------ 设置 */

function openSettings() {
  const s = (S.state && S.state.settings) || {};
  $('s_language').value = I18N.getLang();
  $('s_ps').value = s.powershell || '';
  $('s_python').value = s.python || '';
  $('s_grace').value = s.stopGraceMs || 2500;
  $('s_metrics').checked = s.metricsEnabled !== false;
  openModal('settingsModal');
}

/** 切语言：界面立即变，同时把选择写回后端（托盘、日志系统行都跟着用） */
async function changeLanguage(value) {
  const lang = I18N.normalize(value);
  if (lang === I18N.getLang()) return;
  I18N.setLang(lang);
  relocalize();
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ language: lang }) });
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function saveSettings() {
  const chosenLang = $('s_language').value;
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        language: I18N.normalize(chosenLang),
        powershell: $('s_ps').value.trim(),
        python: $('s_python').value.trim(),
        stopGraceMs: Number($('s_grace').value),
        metricsEnabled: $('s_metrics').checked,
      }),
    });
    closeModal('settingsModal');
    I18N.setLang(chosenLang);
    relocalize();
    toast(t('settings.saved'), 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------ 主题 */

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('btnTheme');
  if (btn) {
    btn.textContent = theme === 'light' ? '☾' : '☀';
    btn.title = t(theme === 'light' ? 'theme.toDark' : 'theme.toLight');
  }
  try {
    localStorage.setItem('clidock-theme', theme);
  } catch (err) {
    /* 隐私模式下忽略 */
  }
}

/* ------------------------------------------------------------ 语言 */

let langSynced = false; // 首次拿到后端状态时对齐一次即可，之后只跟用户操作走

function refreshModalTexts() {
  if (!$('importModal').classList.contains('hidden')) {
    const editing = !!S.editing;
    $('importTitle').textContent = editing ? t('import.title.edit') : t('import.title');
    $('btnSaveApp').textContent = editing ? t('import.save.edit') : t('import.save');
    $('importHint').textContent = editing ? t('import.hint.edit') : t('import.hint');
  }
}

/** 语言变了：静态文案 + 动态渲染 + 已经画好的零碎节点一起刷 */
function relocalize() {
  I18N.applyI18n();
  document.title = t('app.title');
  applyTheme(currentTheme());
  render();
  refreshModalTexts();
  const empty = $('logView') ? $('logView').querySelector('.log-empty') : null;
  if (empty) {
    const app = selectedApp();
    empty.textContent = app && app.status === 'idle' ? t('logs.empty.idle') : t('logs.empty.none');
  }
  updateLogStat();
}

/** 后端存着语言设置：第一次拿状态时对齐（?lang= 优先，用于临时预览） */
function syncLangFromServer() {
  if (langSynced) return;
  langSynced = true;
  const serverLang = S.state && S.state.settings && S.state.settings.language;
  if (!serverLang) return;
  let q = null;
  try {
    q = new URLSearchParams(location.search).get('lang');
  } catch (err) {
    q = null;
  }
  if (q) return;
  if (I18N.normalize(serverLang) !== I18N.getLang()) {
    I18N.setLang(serverLang);
    relocalize();
  }
}

/* ------------------------------------------------------------ 事件绑定 */

function bind() {
  $('btnHome').addEventListener('click', goHome);
  $('btnBack').addEventListener('click', goHome);
  $('btnImport').addEventListener('click', () => openImport(null));
  $('btnSettings').addEventListener('click', openSettings);
  $('btnQuit').addEventListener('click', async () => {
    if (!window.confirm(t('quit.confirm'))) return;
    try {
      await api('/api/shutdown', { method: 'POST' });
      document.body.innerHTML = `<div style="display:grid;place-items:center;height:100vh;font-family:system-ui;color:#8b95a7">${t('quit.done')}</div>`;
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('appSearch').addEventListener('input', (event) => {
    S.search = event.target.value;
    renderSidebar();
  });

  $('statusFilter').addEventListener('click', (event) => {
    const btn = event.target.closest('.seg');
    if (!btn) return;
    S.filter = btn.dataset.filter;
    $('statusFilter').querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b === btn));
    renderOverview();
  });

  $('dTabs').addEventListener('click', (event) => {
    const btn = event.target.closest('.tab');
    if (!btn) return;
    switchTab(btn.dataset.tab);
  });

  $('logSearch').addEventListener('input', (event) => {
    S.logSearch = event.target.value;
    refilterLogs();
  });

  $('toggleErr').addEventListener('click', (event) => {
    S.onlyErr = !S.onlyErr;
    event.target.classList.toggle('on', S.onlyErr);
    refilterLogs();
  });

  $('toggleFollow').addEventListener('click', (event) => {
    S.follow = !S.follow;
    event.target.classList.toggle('on', S.follow);
    if (S.follow) {
      const view = $('logView');
      view.scrollTop = view.scrollHeight;
    }
  });

  $('btnClearLog').addEventListener('click', clearLog);
  $('btnCopy').addEventListener('click', copyLogs);
  $('btnLive').addEventListener('click', backToLive);

  $('btnSaveParams').addEventListener('click', saveParams);
  $('btnAddParam').addEventListener('click', () => {
    $('paramTable').insertBefore(paramRow({ key: '', value: '' }), $('paramTable').lastElementChild);
  });

  $('btnTheme').addEventListener('click', () => {
    applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
  });

  $('btnSaveSchedule').addEventListener('click', saveSchedule);
  $('sched_mode').addEventListener('change', updateScheduleRows);
  $('sched_enabled').addEventListener('change', (event) => {
    if (event.target.checked && $('sched_mode').value === 'none') {
      $('sched_mode').value = 'interval';
      updateScheduleRows();
    }
  });

  $('btnEditConfig').addEventListener('click', () => {
    const app = selectedApp();
    if (app) openImport(app);
  });
  $('btnDeleteApp').addEventListener('click', deleteApp);

  $('btnSaveApp').addEventListener('click', saveApp);
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('s_language').addEventListener('change', (event) => changeLanguage(event.target.value));

  $('btnPickToggle').addEventListener('click', () => {
    const panel = $('pickerPanel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) browse($('pickDir').value || S.pickDir);
  });
  $('btnPickUp').addEventListener('click', () => {
    const dir = $('pickDir').value.replace(/[\\/][^\\/]+$/, '') || S.pickDir;
    browse(dir);
  });
  $('btnPickGo').addEventListener('click', () => browse($('pickDir').value));

  document.querySelectorAll('[data-close]').forEach((node) => {
    node.addEventListener('click', () => closeModal(node.dataset.close));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      ['importModal', 'settingsModal'].forEach((id) => {
        if (!$(id).classList.contains('hidden')) closeModal(id);
      });
    }
  });

  const logView = $('logView');
  logView.addEventListener('scroll', () => {
    const nearBottom = logView.scrollHeight - logView.scrollTop - logView.clientHeight < 40;
    if (!nearBottom && S.follow) {
      S.follow = false;
      $('toggleFollow').classList.remove('on');
    }
  });
}

setInterval(() => {
  document.querySelectorAll('[data-uptime]').forEach((node) => {
    const start = Number(node.dataset.uptime);
    if (start) node.textContent = fmtDuration(Date.now() - start);
  });
}, 1000);

/* ------------------------------------------------------------ 启动 */

bind();
I18N.setLang(I18N.initialLang(null), { apply: false });
document.title = t('app.title');
I18N.applyI18n();
const qTheme = new URLSearchParams(location.search).get('theme');
if (qTheme === 'dark' || qTheme === 'light') applyTheme(qTheme);
else applyTheme(currentTheme());
refresh().then(() => {
  // 便捷参数：?app=<id>&tab=logs 直接定位到某个程序，?modal=import 打开导入框
  const q = new URLSearchParams(location.search);
  const target = q.get('app');
  if (target && appById(target)) {
    selectApp(target);
    if (q.get('tab')) switchTab(q.get('tab'));
  }
  if (q.get('modal') === 'import') openImport(null);
  // ?static=1 时只用一次性拉取的状态（截图 / 无实时需求时用）
  if (!q.has('static')) connectEvents();
});
