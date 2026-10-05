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
const PITCH = 64;     // 一站的像素宽，必须与 CSS 里 .rstop 的 width 一致

let routes = [];      // 按线路名合并后的 23 条：{name, dirs:[Line,…]}
let current = null;   // 当前线路名
let detail = [];      // 当前线路各方向的 {dir, stops, rt}
let sel = null;       // 选中的站点 {lineId, order}；刷新后要恢复高亮
let night = null;     // 本线夜班服务：{stops:Set, from, to}；无夜班则 null
let timer = null;

// "17:47" → 1067（当日分钟数）
const hm = (s) => { const [h, m] = s.split(':'); return +h * 60 + +m; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

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

// 到站倒计时：按分钟说，一分钟内说「即将到站」，已过站直说
const mins = (sec) => (sec > 0 ? (sec <= 60 ? '即将到站' : `约 ${Math.round(sec / 60)} 分钟`) : '已过站');

// 运营状态：上游 state 0 正常 / -1 等待发车 / -2 临时停运 / -3 末班已过
function stateOf(rt) {
  if (!rt) return ['idle', '—'];
  if (rt.state === 0) return ['run', rt.buses.length ? '运营中' : '暂无车辆'];
  if (rt.state === -1) return ['idle', '等待发车'];
  if (rt.state === -2) return ['off', '临时停运'];
  if (rt.state === -3) return ['off', '末班已过'];
  return ['idle', rt.desc || `状态 ${rt.state}`];
}

/* ── 移动端抽屉 ───────────────────────────────────────────────────── */
// 桌面端 .menubtn/.scrim 都是 display:none，这里只管移动端的开合。
let closeDrawer = () => {};

function initDrawer() {
  const side = document.querySelector('.side');
  const scrim = $('#scrim');
  const set = (open) => {
    side.classList.toggle('open', open);
    scrim.classList.toggle('on', open);
  };
  $('#btnMenu').addEventListener('click', () => set(!side.classList.contains('open')));
  scrim.addEventListener('click', () => set(false));
  addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  closeDrawer = () => set(false);
}

/* ── 到站信息面板 ─────────────────────────────────────────────────── */
// 桌面：内联块，靠 display 显隐。移动端：底部抽屉，靠 transform 滑入滑出。
let stopCache = new Map();   // `${lineId}:${order}` → 到站数据；每次刷新作废

function showInfo() { $('#infosect').classList.add('on'); }
function hideInfo() { $('#infosect').classList.remove('on'); }

// 移动端抽屉的拖拽手柄。桌面端 .grab 是 display:none，收不到指针事件。
function initSheet() {
  const sheet = $('#infosect'), grab = $('#grab');
  let y0 = 0, dy = 0, dragging = false;

  grab.addEventListener('pointerdown', (e) => {
    dragging = true; y0 = e.clientY; dy = 0;
    grab.setPointerCapture(e.pointerId);
    sheet.style.transition = 'none';        // 拖动期间跟手，不要缓动
  });
  grab.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > sheet.getBoundingClientRect().height * 0.3) hideInfo();
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
  grab.addEventListener('keydown', (e) => {  // 键盘可达
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hideInfo(); }
  });
}

/* ── 侧栏：按线路名合并方向（46 个方向 → 22 条）────────────────────── */
// 「6路夜班」并入「6」—— 夜班是同一条线的夜间服务，站表是日班的子集
const baseName = (n) => n.replace(/路?夜班$/, '');

function groupByName(ls) {
  const m = new Map();
  for (const l of ls) {
    const base = baseName(l.name);
    if (!m.has(base)) m.set(base, { name: base, dirs: [], night: [] });
    const g = m.get(base);
    (l.name === base ? g.dirs : g.night).push(l);
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

// 一轨 = 一个方向，按行车顺序从左到右排，箭头一律在右端。
// 两轨各带各的站表 —— 23 条线里只有 1 条两方向严格互逆，合并会藏站造站。
// nightOn 时，夜班不停的站标红。
function railEl(it, nightOn) {
  const { dir, stops, rt } = it;
  const box = el('div', 'railbox');

  const head = el('div', 'railhead');
  const [cls, txt] = stateOf(rt);
  head.append(el('span', 'dir', `${dir.start} → ${dir.end}`));
  head.append(el('span', 'st ' + cls, txt));
  head.append(el('span', 'cnt', `${stops.length} 站 · ${(rt.buses || []).length} 辆`));
  if (nightOn) head.append(el('span', 'legend', '红字 = 夜班不停'));
  box.append(head);

  const byOrder = new Map();
  for (const b of (rt.buses || [])) {
    if (!byOrder.has(b.order)) byOrder.set(b.order, []);
    byOrder.get(b.order).push(b);
  }

  const scroll = el('div', 'railscroll');
  const rail = el('div', 'rail');

  stops.forEach((s, i) => {
    // 注意别写成 'rstop' + (cond ? ' term' : null) —— 假分支会拼出 "rstopnull"
    const term = i === 0 || i === stops.length - 1;
    const skip = nightOn && !night.stops.has(s.name);
    let cls2 = term ? 'rstop term' : 'rstop';
    if (skip) cls2 += ' skip';
    const st = el('div', cls2);
    const wrap = el('div', 'rbuswrap');
    for (const b of (byOrder.get(s.order) || [])) {
      const chip = el('span', 'rbus');   // 只是标记，点击冒泡到站点
      chip.append(busIcon(), el('span', null, b.fleetNo));
      // pos 是车在「上一站 → 本站」上的比例：1 = 已到本站（钉在圆点上，与站名对齐），
      // <1 = 在途（插在两站之间）。上游 order 给的是正在接近的站。
      const prev = stops[i - 1];
      chip.title = b.pos >= 1
        ? `${b.fleetNo} · 已到 ${s.name}`
        : `${b.fleetNo} · ${prev ? prev.name : '起点'} → ${s.name} 之间`;
      if (b.pos < 1) chip.style.transform = `translateX(${((b.pos - 1) * PITCH).toFixed(1)}px)`;
      wrap.append(chip);
    }
    st.append(wrap);
    st.append(el('i', 'dot'));
    const nm = el('span', 'nm', s.name);
    nm.title = skip ? `${s.name}（夜班不停）` : s.name;   // 超两行被截时也能看全
    st.append(nm);
    st.tabIndex = 0;
    st.dataset.line = dir.lineId;
    st.dataset.order = s.order;
    st.addEventListener('click', () => selectStop(it, s, st));
    st.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectStop(it, s, st); }
    });
    rail.append(st);
  });
  rail.append(el('i', 'railcap r'));

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
  const nightOn = !!(night && nowMin() >= night.from && nowMin() <= night.to);
  detail.forEach((it) => box.append(railEl(it, nightOn)));
}

/* ── 选中站点 → 各车到该站还有多久 ───────────────────────────────── */
async function selectStop(it, s, node, quiet) {
  document.querySelectorAll('.rstop.on').forEach((x) => x.classList.remove('on'));
  node.classList.add('on');
  sel = { lineId: it.dir.lineId, order: s.order };

  const box = $('#businfo');
  if (!quiet) {
    box.textContent = '';
    box.append(el('div', 'note', '查询中…'));
  }
  showInfo();

  try {
    // targetOrder 让上游把 ETA 算到该站，而不是终点站。
    // 同一次刷新周期内重复点站直接吃缓存，不再打接口。
    const key = `${it.dir.lineId}:${s.order}`;
    let rt = stopCache.get(key);
    if (!rt) {
      rt = await api(`/lines/${encodeURIComponent(it.dir.lineId)}/realtime?targetOrder=${s.order}`);
      stopCache.set(key, rt);
    }
    box.textContent = '';

    const h = el('div', 'h');
    h.append(el('span', 'stn', s.name));
    h.append(el('span', 'dir', `${it.dir.start} → ${it.dir.end}`));
    box.append(h);

    const buses = (rt.buses || []).slice().sort((a, b) => {
      const av = a.eta > 0 ? a.eta : Infinity, bv = b.eta > 0 ? b.eta : Infinity;
      return av - bv;
    });
    if (!buses.length) {
      box.append(el('div', 'note', '该方向当前没有在线车辆。'));
      return;
    }
    for (const b of buses) {
      const r = el('div', 'row');
      r.append(el('span', 'fno', b.fleetNo));
      r.append(el('span', 'eta', mins(b.eta)));
      if (b.eta > 0 && b.arriveAt) r.append(el('span', 'at', b.arriveAt));
      box.append(r);
    }
  } catch (e) {
    box.textContent = '';
    box.append(el('div', 'note bad', `取到站数据失败：${e.message}`));
  }
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
    stopCache.clear();                // 数据变了，到站缓存作废

    g.online = detail.reduce((n, it) => n + (it.rt.buses || []).length, 0);
    const [cls, txt] = stateOf((detail.find((it) => it.rt.state === 0) || detail[0]).rt);
    $('#state').className = 'pill ' + cls;
    $('#statetxt').textContent = txt;
    $('#ts').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });

    renderStrip();
    renderLines($('#q').value);

    // 刷新重建了轨道，恢复选中高亮并刷新到站倒计时
    if (sel) {
      const node = document.querySelector(
        `.rstop[data-line="${sel.lineId}"][data-order="${sel.order}"]`);
      const it = detail.find((x) => x.dir.lineId === sel.lineId);
      const s = it && it.stops.find((x) => x.order === sel.order);
      if (node && s) await selectStop(it, s, node, true);
      else sel = null;
    }
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
  sel = null;
  closeDrawer();          // 移动端选完就收起抽屉
  const g = routes.find((r) => r.name === name);
  $('#title').textContent = name;
  $('#sub').textContent = g ? `${g.dirs[0].start} → ${g.dirs[0].end}` : '';
  hideInfo();
  renderLines($('#q').value);
  $('#strip').textContent = '';
  $('#strip').append(el('div', 'note', '加载中…'));

  // 夜班站表与时段是静态的，选线路时取一次；服务端对 /lines/{id} 有 1h 缓存
  night = null;
  if (g && g.night.length) {
    try {
      const rs = await Promise.all(g.night.map((d) => api(`/lines/${encodeURIComponent(d.lineId)}`)));
      night = {
        stops: new Set(rs.flatMap((r) => (r.stops || []).map((s) => s.name))),
        from: Math.min(...g.night.map((d) => hm(d.firstTime))),
        to: Math.max(...g.night.map((d) => hm(d.lastTime))),
      };
    } catch { /* 夜班取不到就退化成不标红 */ }
  }

  await refresh();
}

async function boot() {
  initTheme();
  initDrawer();
  initSheet();
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
