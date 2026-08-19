'use strict';

/* =====================================================================
 * TimeServer 前端逻辑
 * - 实时毫秒时钟（requestAnimationFrame 驱动）
 * - 多时区显示
 * - NTP 风格服务器对时（偏移 / 延迟检测，60s 自动对时）
 * - 秒表 / 倒计时工具
 * ===================================================================== */

/* ------------------------- DOM 引用 ------------------------- */
const $ = (id) => document.getElementById(id);

const els = {
  clockTime: $('clock-time'),
  clockMs: $('clock-ms'),
  clockDate: $('clock-date'),
  greeting: $('greeting'),
  timezoneSelect: $('timezone-select'),
  utcOffset: $('utc-offset'),
  statUnix: $('stat-unix'),
  statServer: $('stat-server'),
  statOffset: $('stat-offset'),
  statDelay: $('stat-delay'),
  navStatus: $('nav-status'),
  footerMeta: $('footer-meta'),
  btnSync: $('btn-sync'),
  syncT0: $('sync-t0'),
  syncT3: $('sync-t3'),
  toast: $('toast'),
};

/* ------------------------- 配置 ------------------------- */
const SYNC_INTERVAL = 60_000; // 自动对时间隔
const SYNC_SAMPLES = 5;       // 每次对时采样次数

const TZ_LIST = [
  { name: '北京 / 上海 / 香港 / 台北', tz: 'Asia/Shanghai' },
  { name: '东京 · 日本', tz: 'Asia/Tokyo' },
  { name: '首尔 · 韩国', tz: 'Asia/Seoul' },
  { name: '新加坡', tz: 'Asia/Singapore' },
  { name: '悉尼 · 澳大利亚', tz: 'Australia/Sydney' },
  { name: '迪拜', tz: 'Asia/Dubai' },
  { name: '莫斯科', tz: 'Europe/Moscow' },
  { name: '柏林 · 中欧', tz: 'Europe/Berlin' },
  { name: '伦敦 · 英国', tz: 'Europe/London' },
  { name: '巴黎 · 法国', tz: 'Europe/Paris' },
  { name: '纽约 · 美东', tz: 'America/New_York' },
  { name: '洛杉矶 · 美西', tz: 'America/Los_Angeles' },
  { name: '芝加哥 · 美中', tz: 'America/Chicago' },
  { name: 'UTC 世界标准时', tz: 'UTC' },
];

/* ------------------------- 全局状态 ------------------------- */
/**
 * 安全存储：预览面板 iframe / 隐私模式下 localStorage 访问会被禁用
 * （访问即抛 SecurityError），若在脚本顶层直接读取会导致整个脚本崩溃。
 * 这里统一封装，失败时自动降级为内存存储。
 */
const memoryStore = new Map();
const safeStorage = {
  get(key) {
    try { return window.localStorage.getItem(key); }
    catch { return memoryStore.has(key) ? memoryStore.get(key) : null; }
  },
  set(key, value) {
    try { window.localStorage.setItem(key, value); }
    catch { memoryStore.set(key, value); }
  },
};

const state = {
  timezone: safeStorage.get('ts-timezone') || 'Asia/Shanghai',
  serverOffset: 0,          // 服务器 - 本机（毫秒），正值=服务器更快
  serverReachable: false,
  lastServerTime: null,
  lastSyncAt: 0,
};

/* ------------------------- 时钟渲染 ------------------------- */
let clockTicker = 0;

function localNow() {
  // 本机时间 + 服务器偏移 → 更接近真实世界时间
  return Date.now() + state.serverOffset;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

/** 校验时区有效性，无效时回退默认时区，避免 Intl 抛异常 */
function safeTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: tz });
    return tz;
  } catch {
    return 'Asia/Shanghai';
  }
}

/** 渲染时钟（异常绝不外抛，保证驱动循环不中断） */
function renderClock() {
  try {
    const tz = safeTimeZone(state.timezone);
    const now = new Date(localNow());
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(now);

    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
    const hh = get('hour'), mm = get('minute'), ss = get('second');

    // 毫秒直接用 UTC 毫秒部分（与秒同步，不受时区影响）
    const ms = now.getUTCMilliseconds();

    els.clockTime.textContent = `${hh}:${mm}:${ss}`;
    els.clockMs.textContent = `.${pad3(ms)}`;

    // 日期
    const d = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    }).format(now);
    els.clockDate.textContent = d;

    // 统计
    els.statUnix.textContent = String(now.getTime());
  } catch (err) {
    console.error('[Clock] 渲染异常:', err);
  }
}

/**
 * 双驱动时钟：
 * - requestAnimationFrame 提供平滑毫秒动画（页面可见时）
 * - setInterval 兜底（页面隐藏/失焦时 rAF 会被浏览器节流暂停，
 *   间隔心跳保证时钟仍在走，恢复可见后自动衔接）
 */
function startClock() {
  let lastFrameAt = 0;

  const rafTick = (now) => {
    lastFrameAt = now;
    renderClock();
    clockTicker = requestAnimationFrame(rafTick);
  };
  clockTicker = requestAnimationFrame(rafTick);

  setInterval(() => {
    if (performance.now() - lastFrameAt > 150) {
      renderClock(); // rAF 被暂停（后台/不可见）时兜底刷新
    }
  }, 100);
}

/* ------------------------- 时区 ------------------------- */
function buildTimezoneOptions() {
  els.timezoneSelect.innerHTML = '';
  for (const item of TZ_LIST) {
    const opt = document.createElement('option');
    opt.value = item.tz;
    opt.textContent = `${item.name}  (${item.tz})`;
    if (item.tz === state.timezone) opt.selected = true;
    els.timezoneSelect.appendChild(opt);
  }
}

function updateUtcOffsetLabel() {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: state.timezone, timeZoneName: 'longOffset',
    }).formatToParts(now);
    const tzName = (parts.find((p) => p.type === 'timeZoneName') || {}).value || '';
    els.utcOffset.textContent = tzName;
  } catch {
    els.utcOffset.textContent = state.timezone;
  }
}

/* ------------------------- 问候语 ------------------------- */
function renderGreeting() {
  const h = new Date(localNow()).getHours();
  let text;
  if (h < 5) text = '夜深了，时间服务器仍为你值守';
  else if (h < 9) text = '早安，新的一天从精确的时间开始';
  else if (h < 12) text = '上午好，时间正在流逝';
  else if (h < 14) text = '中午好，稍作休息';
  else if (h < 18) text = '下午好，继续加油';
  else if (h < 22) text = '晚上好，别忘了抬头看月亮';
  else text = '夜深了，注意休息';
  els.greeting.textContent = `「${text}」`;
}

/* ------------------------- 对时（NTP 风格） ------------------------- */
async function syncWithServer(showToast = false) {
  try {
    const samples = [];
    let lastT0 = 0, lastT3 = 0;

    for (let i = 0; i < SYNC_SAMPLES; i++) {
      const t0 = Date.now();
      const r = await fetch(`/api/sync?t0=${t0}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const t3 = Date.now();
      if (typeof data.t1 !== 'number') throw new Error('响应缺少 t1');

      const offset = ((data.t1 - data.t0) + (data.t2 - data.t3)) / 2;
      const delay = (t3 - data.t0) - (data.t2 - data.t1);
      if (delay >= 0) samples.push({ offset, delay });
      lastT0 = t0;
      lastT3 = t3;
    }

    if (samples.length === 0) throw new Error('无有效采样');

    // 取中位数偏移，剔除异常抖动
    samples.sort((a, b) => a.offset - b.offset);
    const best = samples[Math.floor(samples.length / 2)];
    const avgDelay = samples.reduce((s, x) => s + x.delay, 0) / samples.length;

    state.serverOffset = Math.round(best.offset);
    state.lastServerTime = Date.now() + state.serverOffset;
    state.lastSyncAt = Date.now();
    state.serverReachable = true;

    // 渲染
    els.statOffset.textContent = formatOffset(state.serverOffset);
    els.statDelay.textContent = `${avgDelay.toFixed(1)} ms`;
    els.statServer.textContent = new Date(state.lastServerTime).toISOString();
    els.navStatus.textContent = '已同步';
    els.navStatus.classList.remove('is-offline');
    els.syncT0.textContent = `t0 = ${lastT0} ms`;
    els.syncT3.textContent = `t3 = ${lastT3} ms`;

    if (showToast) showToast(`对时完成 · 偏移 ${formatOffset(state.serverOffset)} · 延迟 ${avgDelay.toFixed(1)}ms`);
    return true;
  } catch (err) {
    state.serverReachable = false;
    els.statOffset.textContent = '—';
    els.statDelay.textContent = '—';
    els.statServer.textContent = '离线';
    els.navStatus.textContent = '仅本地';
    els.navStatus.classList.add('is-offline');
    if (showToast) showToast('无法连接时间服务器（静态预览模式）', 'warn');
    return false;
  }
}

function formatOffset(ms) {
  if (!Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  if (abs < 1) return '±0 ms';
  return `${ms > 0 ? '+' : '-'}${abs} ms`;
}

/* ------------------------- 秒表 ------------------------- */
const stopwatch = {
  running: false, base: 0, startTs: 0, laps: [],
  raf: 0,
};

function swNow() { return stopwatch.base + (stopwatch.running ? performance.now() - stopwatch.startTs : 0); }

function swFormat(ms) {
  const total = Math.floor(ms);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

function swRender() {
  $('stopwatch-display').textContent = swFormat(swNow());
  if (stopwatch.running) stopwatch.raf = requestAnimationFrame(swRender);
}

function swSetButtons() {
  $('sw-start').textContent = stopwatch.running ? '暂停' : '开始';
  $('sw-lap').disabled = !stopwatch.running;
  $('sw-reset').disabled = !stopwatch.running && stopwatch.base === 0 && stopwatch.laps.length === 0;
}

function swStart() {
  if (stopwatch.running) {
    stopwatch.base = swNow();
    stopwatch.running = false;
    cancelAnimationFrame(stopwatch.raf);
  } else {
    stopwatch.startTs = performance.now();
    stopwatch.running = true;
    swRender();
  }
  swSetButtons();
}

function swLap() {
  const ms = swNow();
  const prev = stopwatch.laps.length
    ? stopwatch.laps[stopwatch.laps.length - 1].total : 0;
  stopwatch.laps.push({ total: ms, split: ms - prev });
  const li = document.createElement('li');
  li.innerHTML = `<span>计次 ${pad2(stopwatch.laps.length)}</span>
    <span>${swFormat(ms)}</span>
    <span class="mono" style="color:var(--accent)">+${swFormat(ms - prev)}</span>`;
  const list = $('sw-laps');
  list.prepend(li);
  while (list.children.length > 8) list.lastElementChild.remove();
}

function swReset() {
  stopwatch.running = false;
  stopwatch.base = 0;
  stopwatch.laps = [];
  cancelAnimationFrame(stopwatch.raf);
  $('stopwatch-display').textContent = '00:00:00.00';
  $('sw-laps').innerHTML = '';
  swSetButtons();
}

/* ------------------------- 倒计时 ------------------------- */
const countdown = {
  running: false, endAt: 0, duration: 0, totalMs: 0,
  interval: 0,
};

function cdRender() {
  const remain = Math.max(0, countdown.endAt - performance.now());
  const h = Math.floor(remain / 3600000);
  const m = Math.floor((remain % 3600000) / 60000);
  const s = Math.floor((remain % 60000) / 1000);
  $('cd-display').textContent = `${pad2(h)}:${pad2(m)}:${pad2(s)}`;

  // 进度环（周长 = 2π×52 ≈ 326.7）
  const ratio = countdown.totalMs > 0 ? remain / countdown.totalMs : 0;
  $('cd-ring').style.strokeDashoffset = String(326.7 * (1 - ratio));

  if (remain <= 0) cdFinish();
}

function cdFinish() {
  countdown.running = false;
  clearInterval(countdown.interval);
  $('cd-done').hidden = false;
  $('cd-start').textContent = '开始';
  $('cd-reset').disabled = false;
  showToast('⏰ 倒计时结束！', 'warn');
}

function cdStart() {
  const preset = Number($('cd-preset').value);
  if (!countdown.running && countdown.totalMs === 0) {
    // 新开始
    countdown.duration = preset * 1000;
    countdown.totalMs = countdown.duration;
  }
  if (countdown.running) {
    clearInterval(countdown.interval);
    countdown.running = false;
    $('cd-start').textContent = '继续';
  } else {
    if (countdown.totalMs <= 0) return;
    countdown.endAt = performance.now() + countdown.totalMs;
    countdown.running = true;
    $('cd-start').textContent = '暂停';
    $('cd-done').hidden = true;
    $('cd-reset').disabled = false;
    countdown.interval = setInterval(cdRender, 100);
    cdRender();
  }
}

function cdReset() {
  countdown.running = false;
  clearInterval(countdown.interval);
  countdown.totalMs = 0;
  $('cd-display').textContent = '00:00:00';
  $('cd-ring').style.strokeDashoffset = '0';
  $('cd-start').textContent = '开始';
  $('cd-reset').disabled = true;
  $('cd-done').hidden = true;
}

/* ------------------------- 剪贴板与提示 ------------------------- */
function showToast(message, type = 'ok') {
  els.toast.textContent = message;
  els.toast.hidden = false;
  els.toast.style.borderColor = type === 'warn'
    ? 'rgba(251,191,36,.45)' : 'rgba(34,211,238,.35)';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

function bindCopyButtons() {
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        showToast('已复制到剪贴板');
      } catch {
        showToast('复制失败，请手动选择复制', 'warn');
      }
    });
  });
}

/* ------------------------- 页脚信息 ------------------------- */
function renderFooter() {
  const build = new Date().toISOString().slice(0, 10);
  els.footerMeta.textContent = `HTTP 时间 API · SNTP (RFC 4330) · 前端构建 ${build}`;
}

/* ------------------------- 初始化 ------------------------- */
function init() {
  // 时区有效性兜底（防止 localStorage 残留非法值），必须在构建选项前完成
  state.timezone = safeTimeZone(state.timezone);

  buildTimezoneOptions();
  updateUtcOffsetLabel();
  renderGreeting();
  renderClock();
  startClock();

  // 事件绑定
  els.timezoneSelect.addEventListener('change', () => {
    state.timezone = els.timezoneSelect.value;
    safeStorage.set('ts-timezone', state.timezone);
    updateUtcOffsetLabel();
  });
  els.btnSync.addEventListener('click', () => syncWithServer(true));

  $('sw-start').addEventListener('click', swStart);
  $('sw-lap').addEventListener('click', swLap);
  $('sw-reset').addEventListener('click', swReset);
  swSetButtons();

  $('cd-start').addEventListener('click', cdStart);
  $('cd-reset').addEventListener('click', cdReset);
  $('cd-preset').addEventListener('change', () => { if (!countdown.running) cdReset(); });

  bindCopyButtons();
  renderFooter();

  // 首次对时 + 定时对时
  syncWithServer();
  setInterval(() => syncWithServer(), SYNC_INTERVAL);
}

// 兼容 DOM 已就绪 / 未就绪两种加载时机
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
