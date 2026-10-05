// app.js 面板前端逻辑。
//
// 只打本服务已有的三个接口，不新增后端：
//   GET /lines                      线路目录
//   GET /lines/{id}                 站点序列
//   GET /lines/{id}/realtime        实时车辆
//
// CSP 是 script-src 'self' 且无 unsafe-inline，所以：不写内联事件、不用 eval。
// 所有站点/线路名都经 textContent 落 DOM，不拼 innerHTML（上游数据也是外部输入）。
'use strict';

const $ = (s) => document.querySelector(s);
const REFRESH_MS = 10000;

let lines = [];
let current = null;
let stops = [];
let stopByOrder = new Map();
let timer = null;

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
  return r.json();
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ── 主题 ─────────────────────────────────────────────────────────── */
// 三态：auto（默认，跟随系统）→ 手动点过之后记 light/dark。
// 图标不在这里换，靠 [data-theme] 的 CSS 显隐，少一段拼 innerHTML。
const LS_THEME = 'bus.theme';
const mqLight = matchMedia('(prefers-color-scheme: light)');
let theme = localStorage.getItem(LS_THEME) || 'auto';

function applyTheme() {
  const eff = theme === 'auto' ? (mqLight.matches ? 'light' : 'dark') : theme;
  document.documentElement.dataset.theme = eff;
  $('#btnTheme').title = eff === 'light' ? '切换到深色' : '切换到浅色';
}

function initTheme() {
  applyTheme();
  mqLight.addEventListener('change', () => { if (theme === 'auto') applyTheme(); });
  $('#btnTheme').addEventListener('click', () => {
    theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem(LS_THEME, theme);
    applyTheme();
  });
}

// 站序 → 正式站名；站序不在本线站点表里（上游给 0 或越界）时回退成站序
const stopName = (order) => stopByOrder.get(order) || `第 ${order} 站`;

// 秒 → 「15分44秒」；到点或已过站返回「—」
function dur(sec) {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}分${s}秒` : `${s}秒`;
}

// 运营状态：上游 state 0 正常 / -1 等待发车 / -2 临时停运 / -3 末班已过
function stateOf(rt) {
  if (!rt) return ['idle', '—'];
  if (rt.state === 0) return ['run', rt.buses.length ? '运营中' : '暂无车辆'];
  if (rt.state === -1) return ['idle', '等待发车'];
  if (rt.state === -2) return ['off', '临时停运'];
  if (rt.state === -3) return ['off', '末班已过'];
  return ['idle', rt.desc || `状态 ${rt.state}`];
}

function renderLines(filter) {
  const f = (filter || '').trim().toLowerCase();
  const ul = $('#lines');
  ul.textContent = '';
  const hit = lines.filter((l) =>
    !f || l.name.toLowerCase().includes(f) ||
    l.start.toLowerCase().includes(f) || l.end.toLowerCase().includes(f));

  if (!hit.length) {
    ul.append(el('li', 'note', '没有匹配的线路'));
    return;
  }
  for (const l of hit) {
    const li = el('li', l.lineId === current ? 'on' : null);
    li.append(el('span', 'no', l.name));
    li.append(el('span', 'to', `${l.start} → ${l.end}`));
    li.tabIndex = 0;
    li.addEventListener('click', () => select(l.lineId));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(l.lineId); }
    });
    ul.append(li);
  }
}

function renderStops(rt) {
  const card = $('#stopcard');
  card.textContent = '';
  const ul = el('ul', 'stops');

  // 车按当前位置（order）挂到对应站点行
  const byOrder = new Map();
  for (const b of (rt?.buses || [])) {
    if (!byOrder.has(b.order)) byOrder.set(b.order, []);
    byOrder.get(b.order).push(b);
  }

  stops.forEach((s, i) => {
    const li = el('li', i === stops.length - 1 ? 'term' : null);
    li.append(el('i', 'rail'));
    li.append(el('span', 'ord', String(s.order)));
    li.append(el('span', 'pin'));
    li.append(el('span', 'nm', s.name));

    for (const b of (byOrder.get(s.order) || [])) {
      const chip = el('span', 'bus');
      chip.append(el('span', 'fno', b.fleetNo));
      // 接口字段是 eta / arriveAt（不是导出文件里的 etaSec）
      chip.append(el('span', 'eta', b.arriveAt
        ? `${dur(b.eta)} · ${b.arriveAt} 到终点`
        : `到终点 ${dur(b.eta)}`));
      chip.title = `${b.rawId || b.fleetNo} → 第 ${b.targetOrder} 站`;
      li.append(chip);
    }
    ul.append(li);
  });
  card.append(ul);
}

function renderBuses(rt) {
  const sect = $('#bussect'), box = $('#buses');
  box.textContent = '';
  const bs = rt?.buses || [];
  sect.hidden = bs.length === 0;

  for (const b of bs) {
    const c = el('div', 'buscard');
    const h = el('div', 'h');
    h.append(el('span', 'fno', b.fleetNo));
    if (b.rawId && !/^\d+$/.test(b.rawId)) h.append(el('span', 'pl', b.rawId));
    if (b.confidence === 'low') h.append(el('span', 'pl', '车牌未识别'));
    c.append(h);
    const row = (k, v) => {
      const r = el('div', 'row');
      r.append(el('span', null, k), el('b', null, v));
      c.append(r);
    };
    row('当前', stopName(b.order));
    row('目标', stopName(b.targetOrder));
    row('预计', b.arriveAt ? `${dur(b.eta)} · ${b.arriveAt}` : dur(b.eta));
    box.append(c);
  }
}

async function refresh() {
  if (!current) return;
  try {
    const rt = await api(`/lines/${encodeURIComponent(current)}/realtime`);
    renderStops(rt);
    renderBuses(rt);
    const [cls, txt] = stateOf(rt);
    $('#state').className = 'pill ' + cls;
    $('#statetxt').textContent = txt;
    $('#ts').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  } catch (e) {
    $('#state').className = 'pill off';
    $('#statetxt').textContent = '获取失败';
    const card = $('#stopcard');
    card.textContent = '';
    card.append(el('div', 'note bad', `取实时数据失败：${e.message}`));
  }
}

async function select(lineId) {
  current = lineId;
  const meta = lines.find((l) => l.lineId === lineId);
  $('#title').textContent = meta ? `${meta.name} 路` : lineId;
  $('#sub').textContent = meta
    ? `${meta.start} → ${meta.end} · ${meta.firstTime}–${meta.lastTime}`
    : '';
  renderLines($('#q').value);

  const card = $('#stopcard');
  card.textContent = '';
  card.append(el('div', 'note', '加载站点…'));
  try {
    const r = await api(`/lines/${encodeURIComponent(lineId)}`);
    stops = r.stops || [];
    stopByOrder = new Map(stops.map((s) => [s.order, s.name]));
    await refresh();
  } catch (e) {
    card.textContent = '';
    card.append(el('div', 'note bad', `取站点失败：${e.message}`));
  }
}

async function boot() {
  initTheme();
  $('#q').addEventListener('input', (e) => renderLines(e.target.value));
  try {
    lines = await api('/lines');
    renderLines('');
    if (lines.length) await select(lines[0].lineId);
    timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  } catch (e) {
    $('#lines').textContent = '';
    $('#lines').append(el('li', 'note bad', `取线路失败：${e.message}`));
  }
}

boot();
