// app.js 面板前端逻辑。
//
// 只打本服务已有的三个接口，不新增后端：
//   GET /lines                      线路目录（46 条 = 23 条线 × 2 方向）
//   GET /lines/{id}                 站点序列
//   GET /lines/{id}/realtime        实时车辆
//
// CSP 是 script-src 'self' 且无 unsafe-inline，所以：不写内联事件、不用 eval。
// 所有站点/线路名都经 textContent 落 DOM，不拼 innerHTML（上游数据也是外部输入）。
'use strict';

const $ = (s) => document.querySelector(s);
const REFRESH_MS = 10000;

let routes = [];      // 按线路名合并后的 23 条：{name, dirs:[Line,…]}
let current = null;   // 当前线路名
let detail = [];      // 当前线路各方向的 {dir, stops, rt}
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

// 站序 → 正式站名；站序不在该方向站点表里（上游给 0 或越界）时回退成站序
const nameOf = (stops, order) =>
  (stops.find((s) => s.order === order) || {}).name || `第 ${order} 站`;

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

/* ── 侧栏：46 个方向按线路名合并成 23 条 ───────────────────────────── */
function groupByName(ls) {
  const m = new Map();
  for (const l of ls) {
    if (!m.has(l.name)) m.set(l.name, { name: l.name, dirs: [] });
    m.get(l.name).dirs.push(l);
  }
  return [...m.values()];
}

function renderLines(filter) {
  const f = (filter || '').trim().toLowerCase();
  const ul = $('#lines');
  ul.textContent = '';
  const hit = routes.filter((r) =>
    !f || r.name.toLowerCase().includes(f) ||
    r.dirs.some((d) => d.start.toLowerCase().includes(f) || d.end.toLowerCase().includes(f)));

  if (!hit.length) {
    ul.append(el('li', 'note', '没有匹配的线路'));
    return;
  }
  for (const r of hit) {
    const li = el('li', r.name === current ? 'on' : null);
    li.append(el('span', 'no', r.name));
    li.append(el('span', 'to', `${r.dirs[0].start} → ${r.dirs[0].end}`));
    if (r.online) li.append(el('span', 'n', String(r.online)));
    li.tabIndex = 0;
    li.addEventListener('click', () => select(r.name));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(r.name); }
    });
    ul.append(li);
  }
}

/* ── 走向条 ───────────────────────────────────────────────────────── */
const BUS_SVG = 'M2 2h12v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2zm0 1v5h12V3H2zm1 7.2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm10 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z';

function busIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', BUS_SVG);
  svg.append(p);
  return svg;
}

// 一轨 = 一个方向。reversed 时倒序渲染，好让两轨共用同一条空间轴。
function railEl(it, reversed) {
  const { dir, stops, rt } = it;
  const box = el('div', 'railbox');

  const head = el('div', 'railhead');
  const [cls, txt] = stateOf(rt);
  head.append(el('span', 'arrow', reversed ? '←' : '→'));
  head.append(el('span', 'dir', `${dir.start} → ${dir.end}`));
  head.append(el('span', 'st ' + cls, txt));
  head.append(el('span', 'cnt', `${stops.length} 站 · ${(rt.buses || []).length} 辆`));
  box.append(head);

  const byOrder = new Map();
  for (const b of (rt.buses || [])) {
    if (!byOrder.has(b.order)) byOrder.set(b.order, []);
    byOrder.get(b.order).push(b);
  }

  const scroll = el('div', 'railscroll');
  const rail = el('div', 'rail');
  // 箭头只在行车终点一侧，指向行进方向（两轨各一个，不是两端各一个）
  if (reversed) rail.append(el('i', 'railcap l'));

  const list = reversed ? [...stops].reverse() : stops;
  list.forEach((s, i) => {
    // 注意别写成 'rstop' + (cond ? ' term' : null) —— 假分支会拼出 "rstopnull"
    const term = i === 0 || i === list.length - 1;
    const st = el('div', term ? 'rstop term' : 'rstop');
    const wrap = el('div', 'rbuswrap');
    for (const b of (byOrder.get(s.order) || [])) {
      const btn = el('button', 'rbus');
      btn.type = 'button';
      btn.append(busIcon(), el('span', null, b.fleetNo));
      btn.title = b.arriveAt ? `${b.fleetNo} · ${dur(b.eta)} · ${b.arriveAt} 到终点` : `${b.fleetNo} · 到终点 ${dur(b.eta)}`;
      btn.addEventListener('click', () => showBus(it, b, btn));
      wrap.append(btn);
    }
    st.append(wrap);
    st.append(el('i', 'dot'));
    const nm = el('span', 'nm', s.name);
    nm.title = s.name;              // 站名超两行被截时仍能看全
    st.append(nm);
    rail.append(st);
  });
  if (!reversed) rail.append(el('i', 'railcap r'));

  scroll.append(rail);
  box.append(scroll);
  return box;
}

function renderStrip() {
  const box = $('#strip');
  box.textContent = '';
  if (!detail.length) {
    box.append(el('div', 'note', '这条线路取不到站点数据。'));
    return;
  }
  // 第 1 个方向定轴；其余方向倒序渲染，端点因此左右对齐
  detail.forEach((it, i) => box.append(railEl(it, i > 0)));
}

/* ── 车辆信息 ─────────────────────────────────────────────────────── */
function showBus(it, b, btn) {
  document.querySelectorAll('.rbus.on').forEach((x) => x.classList.remove('on'));
  btn.classList.add('on');

  const box = $('#businfo');
  box.textContent = '';
  const h = el('div', 'h');
  h.append(el('span', 'fno', b.fleetNo));
  if (b.rawId && !/^\d+$/.test(b.rawId)) h.append(el('span', 'pl', b.rawId));
  if (b.confidence === 'low') h.append(el('span', 'pl', '车牌未识别'));
  h.append(el('span', 'dir', `${it.dir.start} → ${it.dir.end}`));
  box.append(h);

  const row = (k, v) => {
    const r = el('div', 'row');
    r.append(el('span', null, k), el('b', null, v));
    box.append(r);
  };
  row('当前', nameOf(it.stops, b.order));
  row('目标', nameOf(it.stops, b.targetOrder));
  row('预计', b.arriveAt ? `${dur(b.eta)} · ${b.arriveAt}` : dur(b.eta));
  $('#infosect').hidden = false;
}

/* ── 刷新 ─────────────────────────────────────────────────────────── */
async function refresh() {
  if (!current) return;
  const g = routes.find((r) => r.name === current);
  if (!g) return;
  const wanted = g.name;
  try {
    const next = await Promise.all(g.dirs.map(async (d) => {
      const [r, rt] = await Promise.all([
        api(`/lines/${encodeURIComponent(d.lineId)}`),
        api(`/lines/${encodeURIComponent(d.lineId)}/realtime`),
      ]);
      return { dir: d, stops: r.stops || [], rt };
    }));
    if (wanted !== current) return;   // 切线路时丢弃过期响应
    detail = next;

    g.online = detail.reduce((n, it) => n + (it.rt.buses || []).length, 0);
    const [cls, txt] = stateOf((detail.find((it) => it.rt.state === 0) || detail[0]).rt);
    $('#state').className = 'pill ' + cls;
    $('#statetxt').textContent = txt;
    $('#ts').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });

    renderStrip();
    renderLines($('#q').value);
  } catch (e) {
    $('#state').className = 'pill off';
    $('#statetxt').textContent = '获取失败';
    const box = $('#strip');
    box.textContent = '';
    box.append(el('div', 'note bad', `取实时数据失败：${e.message}`));
  }
}

async function select(name) {
  current = name;
  const g = routes.find((r) => r.name === name);
  $('#title').textContent = name;
  $('#sub').textContent = g ? `${g.dirs[0].start} → ${g.dirs[0].end}` : '';
  $('#infosect').hidden = true;
  renderLines($('#q').value);
  $('#strip').textContent = '';
  $('#strip').append(el('div', 'note', '加载中…'));
  await refresh();
}

async function boot() {
  initTheme();
  $('#q').addEventListener('input', (e) => renderLines(e.target.value));
  try {
    routes = groupByName(await api('/lines'));
    renderLines('');
    if (routes.length) await select(routes[0].name);
    timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  } catch (e) {
    $('#lines').textContent = '';
    $('#lines').append(el('li', 'note bad', `取线路失败：${e.message}`));
  }
}

boot();
