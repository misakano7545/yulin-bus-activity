// app.js 面板前端逻辑。
//
// 只打本服务已有的三个接口，不新增后端：
//   GET /lines                      线路目录（46 条 = 23 条线 × 2 方向）
//   GET /lines/{id}                 站点序列 + 走向折线
//   GET /lines/{id}/realtime        实时车辆
//
// CSP 是 script-src 'self' 且无 unsafe-inline，所以：不写内联事件、不用 eval。
// 所有站点/线路名都经 textContent 落 DOM，不拼 innerHTML（上游数据也是外部输入）。
//
// 地图是自绘 SVG，不引地图库、不拉瓦片：折线本来就有，站点位置直接用折线上的
// 站点标记，车辆按 (order, pos) 插值 —— 于是车辆永远压在道路上，且全程不需要
// 坐标基准换算（上游 gpstype=bd，而车辆是 WGS，两者差约 500m；站点自身的
// lat/lng 与折线也不是同一套，实测差 1km 以上，所以地图一律不碰站坐标）。
'use strict';

const $ = (s) => document.querySelector(s);
const REFRESH_MS = 10000;
const SVGNS = 'http://www.w3.org/2000/svg';
const VB_W = 1000, VB_H = 700, VB_PAD = 76;

let routes = [];      // 按线路名合并后的 22 条：{name, dirs:[Line,…], night:[Line,…]}
let current = null;   // 当前线路名
let detail = [];      // 当前线路各方向的 {dir, stops, track, rt}
let sel = null;       // 选中的站点 {lineId, order}；刷新后要恢复高亮
let night = null;     // 本线夜班服务：{stops:Set, from, to}；无夜班则 null
let timer = null;

// "17:47" → 1067（当日分钟数）
const hm = (s) => { const [h, m] = s.split(':'); return +h * 60 + +m; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const isMobile = () => matchMedia('(max-width:820px)').matches;

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
const svgEl = (tag, attrs) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
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

/* ── 线路配色 ─────────────────────────────────────────────────────── */
// 设计稿按线路给色徽章。颜色必须稳定（刷新不能跳），所以按线路名取哈希下标，
// 不按出现顺序分配。
const PALETTE = ['#5b4fd8', '#0f9d63', '#e07b39', '#2f7fd8', '#b03a5b', '#8e44ad', '#0f8b8d', '#a9761a'];
function lineColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/* ── 移动端抽屉 ───────────────────────────────────────────────────── */
// 桌面端 .menubtn/.scrim 都是 display:none，这里只管移动端的开合。
let closeDrawer = () => {};

function initDrawer() {
  const side = $('#side'), scrim = $('#scrim');
  const set = (open) => { side.classList.toggle('open', open); scrim.classList.toggle('on', open); };
  $('#btnMenu').addEventListener('click', () => set(!side.classList.contains('open')));
  scrim.addEventListener('click', () => set(false));
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { set(false); deselect(); } });
  closeDrawer = () => set(false);
}

/* ── 到站卡（桌面浮层 / 移动端底部抽屉）────────────────────────────── */
let stopCache = new Map();   // `${lineId}:${order}` → 到站数据；每次刷新作废

function showCard() { $('#infosect').classList.add('on'); }
function hideCard() { $('#infosect').classList.remove('on'); }
function deselect() {
  sel = null;
  document.querySelectorAll('.rstop.on').forEach((x) => x.classList.remove('on'));
  if (isMobile()) hideCard(); else renderCard();
}

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
    if (dy > sheet.getBoundingClientRect().height * 0.3) hideCard();
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
  grab.addEventListener('keydown', (e) => {  // 键盘可达
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hideCard(); }
  });
}

/* ── 侧栏：按线路名合并方向（46 个方向 → 22 条）────────────────────── */
// 「6路夜班」并入「6」—— 夜班是同一条线的夜间服务，站表是日班的子集
const baseName = (n) => n.replace(/路?夜班$/, '');

// 上游把营运状态塞进了线路名后缀（13（临时停运）、动车专线（22路）（临时停运））。
// 只认这几个已知状态词，不做通用「去掉尾部括号」—— 大容山专线（28路）、
// 广西先进制造城（玉林）公交快速专线 的括号是名字本身。
const LINE_TAG = /[（(](临时停运|临时绕行|暂停运营)[）)]$/;

function groupByName(ls) {
  const m = new Map();
  for (const l of ls) {
    const t = LINE_TAG.exec(l.name);
    const bare = t ? l.name.slice(0, t.index) : l.name;
    const base = baseName(bare);
    if (!m.has(base)) m.set(base, { name: base, dirs: [], night: [], tag: null });
    const g = m.get(base);
    if (t) g.tag = t[1];
    (bare === base ? g.dirs : g.night).push(l);
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
    if (r.tag) li.classList.add('off');
    const b = el('span', 'badge', r.name);
    b.style.background = lineColor(r.name);
    li.append(b);
    li.append(el('span', 'to', `${r.dirs[0].start} → ${r.dirs[0].end}`));
    if (r.tag) li.append(el('span', 'tag', r.tag));
    if (r.online) li.append(el('span', 'n', String(r.online)));
    li.tabIndex = 0;
    li.addEventListener('click', () => select(r.name));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(r.name); }
    });
    ul.append(li);
  }
}

/* ── 折线几何 ─────────────────────────────────────────────────────── */
// 折线点 [lng, lat, stopOrder]，stopOrder>0 表示「这个点就是第 N 站」。
// 末站没有标记（上游只在站与站之间打点），取折线终点兜底。
function trackIdx(track) {
  const m = new Map();
  for (let i = 0; i < track.length; i++) if (track[i][2]) m.set(track[i][2], i);
  return m;
}
const stopIdx = (track, idx, order) => (idx.has(order) ? idx.get(order) : track.length - 1);

// 车在「order-1 站 → order 站」这一段上，pos 是段内比例（1=已到本站）。
// 沿折线按累积长度取点，所以车永远落在道路上，而不是两点直线连线上。
function busPoint(track, idx, order, pos) {
  const a = stopIdx(track, idx, Math.max(1, order - 1));
  const b = stopIdx(track, idx, Math.max(1, order));
  if (b <= a) return track[a] || track[0];
  let total = 0;
  const seg = [];
  for (let i = a; i < b; i++) {
    const dx = track[i + 1][0] - track[i][0], dy = track[i + 1][1] - track[i][1];
    const d = Math.hypot(dx, dy);
    seg.push(d); total += d;
  }
  if (total === 0) return track[a];
  let want = Math.min(Math.max(pos, 0), 1) * total;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i]) {
      const t = seg[i] === 0 ? 0 : want / seg[i];
      return [track[a + i][0] + (track[a + i + 1][0] - track[a + i][0]) * t,
              track[a + i][1] + (track[a + i + 1][1] - track[a + i][1]) * t];
    }
    want -= seg[i];
  }
  return track[b];
}

// 经纬度 → viewBox 坐标：先按中心纬度做平面化（经度缩 cos），再等比缩放居中，y 轴翻转。
function projector(pts) {
  let lng0 = 0, lat0 = 0;
  for (const p of pts) { lng0 += p[0]; lat0 += p[1]; }
  lng0 /= pts.length; lat0 /= pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const p of pts) {
    const x = p[0] * k, y = p[1];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  const s = Math.min((VB_W - 2 * VB_PAD) / Math.max(maxx - minx, 1e-9),
                     (VB_H - 2 * VB_PAD) / Math.max(maxy - miny, 1e-9));
  const ox = (VB_W - (maxx - minx) * s) / 2, oy = (VB_H - (maxy - miny) * s) / 2;
  return ([lng, lat]) => [(lng * k - minx) * s + ox, VB_H - ((lat - miny) * s + oy)];
}

const BUS_D = 'M2 2h12v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2zm0 1v5h12V3H2zm1 7.2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm10 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z';

/* ── 地图 ─────────────────────────────────────────────────────────── */
// 只画「当前选中站点所属的方向」；没选中就画第一个方向。
// 换方向靠点走向条上另一条轨的站点 —— 不再加一套方向切换控件。
function focusDir() {
  if (sel) {
    const d = detail.find((it) => it.dir.lineId === sel.lineId);
    if (d) return d;
  }
  return detail[0];
}

function renderMap() {
  const map = $('#map');
  map.textContent = '';
  if (!detail.length) return;

  const it = focusDir();
  const track = it.track || [];
  if (!track.length || !it.stops.length) {
    const t = svgEl('text', { x: VB_W / 2, y: VB_H / 2, 'text-anchor': 'middle', class: 'stoplab' });
    t.textContent = '这条线路没有走向数据';
    map.append(t);
    return;
  }

  const idx = trackIdx(track);
  const nightOn = !!(night && nowMin() >= night.from && nowMin() <= night.to);
  const buses = it.rt.buses || [];
  const byOrder = new Map();
  for (const b of buses) {
    if (!byOrder.has(b.order)) byOrder.set(b.order, []);
    byOrder.get(b.order).push(b);
  }

  // 投影只依赖折线，不依赖站坐标
  const proj = projector(track);

  // 走向折线
  const pts = track.map((p) => proj(p).map((v) => v.toFixed(1)).join(',')).join(' ');
  map.append(svgEl('polyline', { class: 'rail', points: pts }));

  // 折线本身没有方向感，在行车终点补一个箭头
  if (track.length > 1) {
    const e = proj(track[track.length - 1]), pv = proj(track[track.length - 2]);
    const ang = (Math.atan2(e[1] - pv[1], e[0] - pv[0]) * 180) / Math.PI;
    map.append(svgEl('path', { class: 'arrow', d: 'M0,0 L-15,-7.5 L-15,7.5 Z',
      transform: `translate(${e[0].toFixed(1)},${e[1].toFixed(1)}) rotate(${ang.toFixed(1)})` }));
  }

  // 站点圆点 + 标注
  for (const s of it.stops) {
    const [x, y] = proj(track[stopIdx(track, idx, s.order)]);
    const term = s.order === it.stops[0].order || s.order === it.stops[it.stops.length - 1].order;
    const skip = nightOn && !night.stops.has(s.name);
    const on = sel && sel.lineId === it.dir.lineId && sel.order === s.order;
    let cls = 'stop' + (skip ? ' skip' : '') + (term ? ' term' : '');
    if (on) cls += ' on';
    const c = svgEl('circle', { class: cls, cx: x.toFixed(1), cy: y.toFixed(1), r: on ? 8 : term ? 6.5 : 5 });
    c.tabIndex = 0;
    c.addEventListener('click', () => selectStop(it, s));
    c.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectStop(it, s); }
    });
    map.append(c);

    // 43 站的线全标名字会糊成一片：只标首末站、选中站、以及此刻有车的站
    if (term || on || byOrder.has(s.order)) {
      const t = svgEl('text', { class: 'stoplab' + (on ? ' on' : ''), x: x.toFixed(1), y: (y + 22).toFixed(1),
        'text-anchor': 'middle' });
      t.textContent = s.name;
      map.append(t);
    }
  }

  // 车辆：按 (order, pos) 落在折线上
  for (const b of buses) {
    const [x, y] = proj(busPoint(track, idx, b.order, b.pos));
    const g = svgEl('g', { transform: `translate(${(x - 11).toFixed(1)},${(y - 11).toFixed(1)})` });
    g.append(svgEl('rect', { class: 'bus', width: 22, height: 22, rx: 6 }));
    g.append(svgEl('path', { class: 'busglyph', d: BUS_D, transform: 'translate(3,3)' }));
    const ti = svgEl('title', {});
    ti.textContent = `${b.fleetNo} · 前往 ${it.stops.find((s) => s.order === b.order)?.name || '下一站'}`;
    g.append(ti);
    map.append(g);
  }
}

/* ── 到站卡内容 ───────────────────────────────────────────────────── */
function renderCard() {
  const box = $('#businfo');
  box.textContent = '';
  if (!detail.length) { hideCard(); return; }

  const it = focusDir();

  if (sel) {
    const s = it.stops.find((x) => x.order === sel.order);
    if (s) {
      const h = el('div', 'h');
      h.append(el('span', 'stn', s.name));
      h.append(el('span', 'dir', `${it.dir.start} → ${it.dir.end}`));
      box.append(h);

      const cached = stopCache.get(`${it.dir.lineId}:${s.order}`);
      const rows = el('div', 'rows');
      rows.id = 'rows';
      if (cached === undefined) rows.append(el('div', 'note', '查询中…'));
      else fillRows(rows, cached);
      box.append(rows);
    }
  } else {
    const h = el('div', 'h');
    h.append(el('span', 'stn', current || '线路'));
    h.append(el('span', 'dir', `${it.dir.start} → ${it.dir.end}`));
    box.append(h);
    box.append(el('div', 'note', '点地图上的站点，看车还有多久到。'));
  }

  box.append(stripEl());
}

function fillRows(rows, rt) {
  rows.textContent = '';
  const buses = (rt.buses || []).slice().sort((a, b) => {
    const av = a.eta > 0 ? a.eta : Infinity, bv = b.eta > 0 ? b.eta : Infinity;
    return av - bv;
  });
  if (!buses.length) {
    rows.append(el('div', 'note', '该方向当前没有在线车辆。'));
    return;
  }
  for (const b of buses) {
    const r = el('div', 'row');
    r.append(el('span', 'fno', b.fleetNo));
    r.append(el('span', 'eta', mins(b.eta)));
    if (b.eta > 0 && b.arriveAt) r.append(el('span', 'at', b.arriveAt));
    rows.append(r);
  }
}

/* ── 选中站点 → 各车到该站还有多久 ───────────────────────────────── */
async function selectStop(it, s) {
  sel = { lineId: it.dir.lineId, order: s.order };
  document.querySelectorAll('.rstop.on').forEach((x) => x.classList.remove('on'));
  document.querySelectorAll(`.rstop[data-line="${it.dir.lineId}"][data-order="${s.order}"]`)
    .forEach((x) => x.classList.add('on'));
  showCard();
  renderMap();
  renderCard();

  const key = `${it.dir.lineId}:${s.order}`;
  if (stopCache.has(key)) return;

  try {
    // targetOrder 让上游把 ETA 算到该站，而不是终点站。
    const rt = await api(`/lines/${encodeURIComponent(it.dir.lineId)}/realtime?targetOrder=${s.order}`);
    stopCache.set(key, rt);
    // 期间用户可能已经点了别的站，或刷新过（缓存会清空）
    if (!sel || sel.lineId !== it.dir.lineId || sel.order !== s.order) return;
    if (!stopCache.has(key)) return;
    const rows = $('#rows');
    if (rows) fillRows(rows, rt);
  } catch (e) {
    const rows = $('#rows');
    if (rows) { rows.textContent = ''; rows.append(el('div', 'note bad', `取到站数据失败：${e.message}`)); }
  }
}

/* ── 走向条：两方向共用一条轴，各占一条轨 ───────────────────────────
   每轨按自己的行车顺序排；中间站只是大致对齐 —— 22 条线里只有 1 条两方向严格互逆。
   它也是切换地图方向的入口：点另一条轨上的站，地图就切过去。 */
function stripEl() {
  const box = el('div', 'sect');
  box.append(el('h2', null, '线路走向'));
  const nightOn = !!(night && nowMin() >= night.from && nowMin() <= night.to);
  for (const it of detail) {
    const { dir, stops, rt } = it;
    const rb = el('div', 'railbox');

    const head = el('div', 'railhead');
    const [cls, txt] = stateOf(rt);
    head.append(el('span', 'dir', `${dir.start} → ${dir.end}`));
    head.append(el('span', 'st ' + cls, txt));
    head.append(el('span', 'cnt', `${stops.length} 站 · ${(rt.buses || []).length} 辆`));
    if (nightOn) head.append(el('span', 'legend', '红字 = 夜班不停'));
    rb.append(head);

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
      if (sel && sel.lineId === dir.lineId && sel.order === s.order) cls2 += ' on';
      const st = el('div', cls2);
      const wrap = el('div', 'rbuswrap');
      for (const b of (byOrder.get(s.order) || [])) {
        const chip = el('span', 'rbus');   // 只是标记，点击冒泡到站点
        chip.append(busIcon(), el('span', null, b.fleetNo));
        chip.title = `${b.fleetNo} · ${b.pos >= 1 ? '已到' : '前往'} ${s.name}`;
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
      st.addEventListener('click', () => selectStop(it, s));
      st.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectStop(it, s); }
      });
      rail.append(st);
    });
    scroll.append(rail);
    rb.append(scroll);
    box.append(rb);
  }
  return box;
}

function busIcon() {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', fill: 'currentColor' });
  svg.append(svgEl('path', { d: BUS_D }));
  return svg;
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
      return { dir: d, stops: r.stops || [], track: r.track || [], rt };
    }));
    if (wanted !== current) return;   // 切线路时丢弃过期响应
    detail = next;
    stopCache.clear();                // 数据变了，到站缓存作废

    g.online = detail.reduce((n, it) => n + (it.rt.buses || []).length, 0);
    const [cls, txt] = stateOf((detail.find((it) => it.rt.state === 0) || detail[0]).rt);
    $('#state').className = 'pill ' + cls;
    $('#statetxt').textContent = txt;
    $('#ts').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });

    $('#hint').hidden = true;
    renderLines($('#q').value);
    renderMap();
    if (sel) {
      const it = detail.find((x) => x.dir.lineId === sel.lineId);
      if (it && it.stops.some((x) => x.order === sel.order)) await selectStop(it, it.stops.find((x) => x.order === sel.order));
      else sel = null;
    }
    renderCard();
  } catch (e) {
    $('#state').className = 'pill off';
    $('#statetxt').textContent = '获取失败';
    $('#hint').hidden = false;
    $('#hint').textContent = `取实时数据失败：${e.message}`;
  }
}

async function select(name) {
  current = name;
  sel = null;
  stopCache.clear();
  closeDrawer();          // 移动端选完就收起抽屉
  const g = routes.find((r) => r.name === name);
  renderLines($('#q').value);
  $('#hint').hidden = false;
  $('#hint').textContent = '加载中…';

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
  if (isMobile()) hideCard(); else { showCard(); renderCard(); }
}

async function boot() {
  initTheme();
  initDrawer();
  initSheet();
  $('#q').addEventListener('input', (e) => renderLines(e.target.value));
  // 点地图空白处取消选中；点卡片内部不触发
  $('#stage').addEventListener('click', (e) => {
    if (e.target.closest('.card')) return;
    if (e.target.tagName === 'circle' || e.target.tagName === 'polyline') return;
    deselect();
  });
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
