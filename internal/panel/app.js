// app.js 面板前端逻辑。
//
// 只打本服务已有的三个接口，不新增后端：
//   GET /lines                      线路目录（46 条 = 23 条线 × 2 方向）
//   GET /lines/{id}                 站点序列 + 走向折线
//   GET /lines/{id}/realtime        实时车辆
//
// CSP 是 script-src 'self'（外加 webapi.amap.com）且无 unsafe-inline，所以：
// 不写内联事件、不用 eval。站点/线路名一律经 textContent 落 DOM
//（上游数据也是外部输入）；地图覆盖物的 content 是自造 HTML，只用固定模板。
//
// 底图是高德 JS API（真实瓦片、可缩放），key 由 /amap.js 下发（见 panel.go）。
// 折线与车辆仍然用「沿折线按 (order, pos) 插值」定位 —— 车标永远压在道路上，
// 不需要车自身的经纬度，也就绕开了车辆坐标与折线基准是否一致的疑问（实测同基准）。
// 折线本身是 WGS-84，而高德底图是 GCJ-02，所以取到折线后统一转一次，下游全程 GCJ。
'use strict';

const $ = (s) => document.querySelector(s);
const REFRESH_MS = 10000;
const SVGNS = 'http://www.w3.org/2000/svg';

let routes = [];      // 按线路名合并后的 22 条：{name, dirs:[Line,…], night:[Line,…]}
let current = null;   // 当前线路名
let detail = [];      // 当前线路各方向的 {dir, stops, track, rt}
let sel = null;       // 选中的站点 {lineId, order}；刷新后要恢复高亮
let focusId = null;   // 手动切到的方向（lineId）；null = 用第一个方向
let shift = 'day';    // 'day' | 'night'：本线的班次（只有 6 路有夜班）
let shifts = { day: [], night: [] };   // 两个班次各自的方向；detail 指当前那个
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
  // 覆盖物的颜色走 CSS 变量，跟着主题自动变；只有底图要显式切一套样式
  if (amap) amap.setMapStyle(mapStyle());
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
// 排序键：没有 ETA（已过站 / 上游没给预测）的车排最后
const etaKey = (b) => (b.eta > 0 ? b.eta : Infinity);

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
  renderMap();     // 地图上的选中态也是 renderMap 画的，不重绘的话站还亮着
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

  $('#linecnt').textContent = f ? `${hit.length}/${routes.length} 条` : `${routes.length} 条`;

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

/* ── 坐标基准 ─────────────────────────────────────────────────────── */
// 上游折线是 WGS-84。实测依据：直接铺在高德瓦片上，整条线偏到街区里；按下面
// 转换后才压着道路，且用维基百科上「玉林站」的 WGS-84 坐标反查，转换后才落在
// 高德瓦片画的玉林站里。高德底图是 GCJ-02，所以进地图前统一转一次。
const GCJ_A = 6378245.0, GCJ_EE = 0.00669342162296594323;
const outOfChina = (lng, lat) =>
  !(lng > 72.004 && lng < 137.8347 && lat > 0.8293 && lat < 55.8271);

function wgs2gcj(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  const x = lng - 105, y = lat - 35, S = Math.sin;
  let dLat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dLat += (20 * S(6 * x * Math.PI) + 20 * S(2 * x * Math.PI)) * 2 / 3;
  dLat += (20 * S(y * Math.PI) + 40 * S(y / 3 * Math.PI)) * 2 / 3;
  dLat += (160 * S(y / 12 * Math.PI) + 320 * S(y * Math.PI / 30)) * 2 / 3;
  let dLng = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dLng += (20 * S(6 * x * Math.PI) + 20 * S(2 * x * Math.PI)) * 2 / 3;
  dLng += (20 * S(x * Math.PI) + 40 * S(x / 3 * Math.PI)) * 2 / 3;
  dLng += (150 * S(x / 12 * Math.PI) + 300 * S(x / 30 * Math.PI)) * 2 / 3;
  const rad = lat * Math.PI / 180, magic = 1 - GCJ_EE * S(rad) * S(rad), sq = Math.sqrt(magic);
  return [lng + dLng * 180 / (GCJ_A / sq * Math.cos(rad) * Math.PI),
          lat + dLat * 180 / (GCJ_A * (1 - GCJ_EE) / (magic * sq) * Math.PI)];
}

// 折线点 [lng, lat, stopOrder] → 同结构、已转 GCJ。取到折线时转一次，下游全程 GCJ。
const toGCJ = (track) => track.map((p) => {
  const [lng, lat] = wgs2gcj(p[0], p[1]);
  return [lng, lat, p[2]];
});

const BUS_D = 'M2 2h12v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2zm0 1v5h12V3H2zm1 7.2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm10 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z';

/* ── 高德底图 ─────────────────────────────────────────────────────── */
// 实例只建一次：重建会丢掉瓦片缓存与相机位置。换线路只换覆盖物。
let amap = null;
let overlay = [];        // 当前线路的覆盖物，重绘前整批摘掉
let amapLoading = null;  // 首次加载高德脚本的 promise，复用避免重复插 script
let mapSeq = 0;          // 渲染序号：异步等脚本期间若有更新的渲染排队，这次作废
let fitted = '';         // 已经 setFitView 过的「线路:方向」；见 renderMap 里为什么需要它

const mapStyle = () => (document.documentElement.dataset.theme === 'light'
  ? 'amap://styles/normal' : 'amap://styles/dark');

function loadAmapScript() {
  const cfg = window.YBA_AMAP || {};
  if (!cfg.key) return Promise.reject(new Error('服务端未配置高德 key（YBA_AMAP_KEY）'));
  if (cfg.security) window._AMapSecurityConfig = { securityJsCode: cfg.security };
  return new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(cfg.key);
    s.onload = ok;
    s.onerror = () => no(new Error('高德脚本加载失败'));
    document.head.append(s);
  });
}

function ensureMap() {
  if (!amapLoading) {
    amapLoading = loadAmapScript().then(() => {
      amap = new AMap.Map('map', {
        viewMode: '2D', zoom: 15, center: [110.1584, 22.5978], mapStyle: mapStyle(),
      });
      amap.on('click', () => deselect());   // 点空白处取消选中
    });
  }
  return amapLoading;
}

function clearOverlay() {
  // ponytail: 每次刷新整批摘掉重建覆盖物。几十个 Marker，10 秒一次，暂时不值
  // 得拆成「站点只建一次、只动车辆」。副作用是刷新瞬间落下的那次点击会落空、
  // 悬停态被清掉；真要修就把车辆 Marker 单独拎出来只更新 position。
  if (overlay.length) { amap.remove(overlay); overlay = []; }
}

// 覆盖物用自定义 content 而不是高德内置图标：直接吃页面 CSS 变量，跟着主题走。
function stopContent(kind, label) {
  const box = el('div', 'am-stop' + kind);
  if (label != null) box.append(el('span', 'am-lab', label));
  return box;
}

/* ── 地图 ─────────────────────────────────────────────────────────── */
// 线路是双向的，地图与到站列表一次只画一个方向。方向按优先级取：
// 选中的站（点地图或走向条都会选中）> #dirs 上手动切的方向 > 第一个方向。
function focusDir() {
  const want = sel ? sel.lineId : focusId;
  if (want) {
    const d = detail.find((it) => it.dir.lineId === want);
    if (d) return d;
  }
  return detail[0];
}

// 方向切换。没有它就只能靠「点走向条上另一条轨的站」来换向 —— 那个入口
// 藏在侧栏最底下，等于没有。
function renderDirs() {
  const box = $('#dirs');
  box.textContent = '';
  if (detail.length < 2) return;   // 单向线没什么可切的
  const cur = focusDir();
  for (const it of detail) {
    const b = el('button', it === cur ? 'on' : null);
    b.type = 'button';
    b.append(el('span', 'tt', `开往 ${it.dir.end}`));
    b.append(el('span', 'ss', `${(it.rt.buses || []).length} 辆`));
    b.addEventListener('click', () => setFocus(it.dir.lineId));
    box.append(b);
  }
}

function setFocus(lineId) {
  if (focusId === lineId && !sel) return;
  focusId = lineId;
  sel = null;                                   // 选中的站在另一个方向上，不再成立
  fitted = '';                                  // 换方向要重新定视野
  document.querySelectorAll('.rstop.on').forEach((x) => x.classList.remove('on'));
  if (isMobile()) hideCard();
  renderDirs();
  renderArr();
  renderMeta();   // 首末班跟着方向走
  renderMap();
  renderCard();
}

// 状态胶囊。班次/方向一变就得重画：setShift 不重画的话，顶部会留着上一个班次的状态。
function renderState() {
  if (!detail.length) return;
  const [cls, txt] = stateOf((detail.find((it) => it.rt.state === 0) || detail[0]).rt);
  $('#state').className = 'pill ' + cls;
  $('#statetxt').textContent = txt;
}

// 班次切换（日班/夜班）。只有 6 路有夜班：夜班站表是日班的前缀，
// 但车辆、终点、首末班都是另一套 lineId，日班里看不到。
function renderShifts() {
  const box = $('#shifts');
  box.textContent = '';
  const g = routes.find((r) => r.name === current);
  if (!g || !g.night.length) return;

  for (const [k, label, ls] of [['day', '日班', g.dirs], ['night', '夜班', g.night]]) {
    const b = el('button', shift === k ? 'on' : null);
    b.type = 'button';
    b.append(el('span', 'tt', label));
    b.append(el('span', 'ss', spanOf(ls)));
    b.addEventListener('click', () => setShift(k));
    box.append(b);
  }
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const spanOf = (ls) => `${hhmm(Math.min(...ls.map((d) => hm(d.firstTime))))}–` +
                       `${hhmm(Math.max(...ls.map((d) => hm(d.lastTime))))}`;

function setShift(s) {
  if (shift === s || !shifts[s].length) return;
  shift = s;
  detail = shifts[s];
  sel = null;          // 选中的站在另一个班次的方向上，不再成立
  focusId = null;
  fitted = '';         // 班次换了，重新定视野
  document.querySelectorAll('.rstop.on').forEach((x) => x.classList.remove('on'));
  if (isMobile()) hideCard();
  renderState();
  renderShifts();
  renderDirs();
  renderArr();
  renderMeta();
  renderRails();
  renderMap();
  renderCard();
}

async function renderMap() {
  const hint = $('#hint');
  const seq = ++mapSeq;
  try {
    await ensureMap();
  } catch (e) {
    hint.hidden = false;
    hint.textContent = `底图不可用：${e.message}`;
    return;
  }
  if (seq !== mapSeq) return;   // 期间有更新的渲染，这次作废
  clearOverlay();
  if (!detail.length) return;

  const it = focusDir();
  const track = it.track || [];
  if (!track.length || !it.stops.length) {
    hint.hidden = false;
    hint.textContent = '这条线路没有走向数据';
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

  // showDir 让折线自己带方向箭头，省掉手画箭头那段几何
  overlay.push(new AMap.Polyline({
    path: track.map((p) => [p[0], p[1]]),
    strokeColor: lineColor(current || ''), strokeWeight: 6, strokeOpacity: 0.85,
    lineJoin: 'round', lineCap: 'round', showDir: true, zIndex: 50,
  }));

  for (const s of it.stops) {
    const spot = track[stopIdx(track, idx, s.order)];
    const term = s.order === it.stops[0].order || s.order === it.stops[it.stops.length - 1].order;
    const skip = nightOn && !night.stops.has(s.name);
    const on = !!(sel && sel.lineId === it.dir.lineId && sel.order === s.order);
    let kind = '';
    if (skip) kind += ' skip';
    if (term) kind += ' term';
    if (on) kind += ' on';
    // 每站都标名字。43 站的长线会挤，靠 .am-lab 的底色小片互相压住还算能看；
    // 真嫌糊就把这里收回去：只标首末站/选中站/此刻有车的站（原来的做法）。
    const box = stopContent(kind, s.name);
    const m = new AMap.Marker({
      position: [spot[0], spot[1]], anchor: 'center', content: box,
      zIndex: on ? 120 : term ? 110 : 100, cursor: 'pointer',
      title: skip ? `${s.name}（夜班不停）` : s.name,
    });
    m.on('click', () => selectStop(it, s));
    overlay.push(m);
  }

  for (const b of buses) {
    const p = busPoint(track, idx, b.order, b.pos);
    const box = el('div', 'am-bus');
    box.append(busIcon());
    overlay.push(new AMap.Marker({
      position: [p[0], p[1]], anchor: 'center', content: box, zIndex: 200,
      title: `${b.fleetNo} · 前往 ${it.stops.find((s) => s.order === b.order)?.name || '下一站'}`,
    }));
  }

  amap.add(overlay);
  // setFitView 只在换线路/换方向时跑一次。每 10 秒刷新都调的话，用户刚拖好、
  // 缩放好的视野会在下次刷新被拽回去 —— 车在动不等于视野要动。
  const key = `${current || ''}:${it.dir.lineId}`;
  if (key !== fitted) {
    // 第二个参数是 immediately=true：不要动画。实测这台机器上动画要跑 4 秒多，
    // 期间站点标记一直在移动，点它就是点空 —— 手机上（走隧道）这个窗口更难受。
    amap.setFitView(overlay, true, [70, 70, 70, 70], 16);
    fitted = key;
  }
  hint.hidden = true;
}

/* ── 侧栏：实时到站 / 本线信息 / 走向条 ───────────────────────────── */
// 到站卡按 ETA 升序。「还有 N 站」用 target−order：上游没传 targetOrder 时
// target 就是终点站序。
function renderArr() {
  const box = $('#arr');
  box.textContent = '';
  if (!detail.length) { box.append(el('div', 'note', '左侧选一条线路。')); return; }

  const it = focusDir();
  const buses = (it.rt.buses || []).slice().sort((a, b) => etaKey(a) - etaKey(b));
  if (!buses.length) {
    const [, txt] = stateOf(it.rt);
    box.append(el('div', 'note', txt === '运营中' ? `${it.dir.end} 方向暂无在线车辆。` : txt));
    return;
  }
  for (const b of buses) {
    // 「距终点 N 站」用站表总数减当前站序。上游的 targetOrder 是「下一站」而不是
    // 终点，拿它减 order 恒为 0（实测三辆车全是「还有 0 站」）。
    const left = Math.max(0, it.stops.length - b.order);
    let cls = 'acard';
    if (!(b.eta > 0)) cls += ' gone';
    else if (b.eta <= 180) cls += ' soon';
    const c = el('div', cls);

    // 这里不放线路徽章：整个分区就一条线一个方向，上面那组方向按钮已经写明了，
    // 每张卡再挂一个同样的徽章只是占掉一行文字的位置。
    const d = el('div', 'dest');
    d.append(el('b', null, `开往 ${it.dir.end}`));
    const sub = [`${b.fleetNo} 号车`, left > 0 ? `距终点 ${left} 站` : '已到终点'];
    if (b.eta > 0 && b.arriveAt) sub.push(`${b.arriveAt} 到`);
    if (b.confidence === 'low') sub.push(`未知车牌 ${b.rawId}`);
    d.append(el('span', null, sub.join(' · ')));
    c.append(d);

    c.append(el('span', 'eta', mins(b.eta)));
    box.append(c);
  }
}

// 本线信息：跟着方向切换走 —— 只显示当前方向的首末班/票价/状态。
// 票价只有实时接口给（线路静态接口没有）。
function renderMeta() {
  const box = $('#meta');
  box.textContent = '';
  if (!detail.length) return;
  const it = focusDir();
  const [cls, txt] = stateOf(it.rt);
  box.append(el('div', 'k txt', '方向'));
  box.append(el('div', 'v txt', `${it.dir.start} → ${it.dir.end}`));
  box.append(el('div', 'k txt', '首末班'));
  box.append(el('div', 'v', `${it.dir.firstTime}–${it.dir.lastTime}`));
  box.append(el('div', 'k txt', '票价'));
  box.append(el('div', 'v', it.rt.price || '—'));
  box.append(el('div', 'k txt', '当前状态'));
  box.append(el('div', 'v txt ' + cls, txt));
}

function renderCard() {
  const box = $('#businfo');
  box.textContent = '';
  if (!detail.length) { hideCard(); return; }

  const it = focusDir();
  const h = el('div', 'h');

  if (!sel) {
    h.append(el('span', 'stn', current || '线路'));
    h.append(el('span', 'dir', `${it.dir.start} → ${it.dir.end}`));
    box.append(h);
    box.append(el('div', 'note', '点地图或走向条上的站点，看车还有多久到。'));
    return;
  }

  const s = it.stops.find((x) => x.order === sel.order);
  if (!s) return;
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

function fillRows(rows, rt) {
  rows.textContent = '';
  const buses = (rt.buses || []).slice().sort((a, b) => etaKey(a) - etaKey(b));
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
  focusId = it.dir.lineId;   // 点哪条轨的站就把方向切过去，与 #dirs 的选中态保持一致
  document.querySelectorAll('.rstop.on').forEach((x) => x.classList.remove('on'));
  document.querySelectorAll(`.rstop[data-line="${it.dir.lineId}"][data-order="${s.order}"]`)
    .forEach((x) => x.classList.add('on'));
  showCard();
  renderDirs();   // 方向变了，切换器的选中态与到站列表都要跟上
  renderArr();
  renderMeta();
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

/* ── 走向条（侧栏「线路走向」段）：两方向共用一条轴，各占一条轨 ───────
   每轨按自己的行车顺序排；中间站只是大致对齐 —— 22 条线里只有 1 条两方向严格互逆。
   它也是切换地图方向的入口：点另一条轨上的站，地图就切过去。 */
function renderRails() {
  const box = $('#rails');
  box.textContent = '';
  if (!detail.length) return;
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
    // 日班与夜班一起取：夜班是另一套 lineId，不取就看不到夜班的车
    const all = [...g.dirs, ...g.night];
    const got = await Promise.all(all.map(async (d) => {
      const [r, rt] = await Promise.all([
        api(`/lines/${encodeURIComponent(d.lineId)}`),
        api(`/lines/${encodeURIComponent(d.lineId)}/realtime`),
      ]);
      return { dir: d, stops: r.stops || [], track: toGCJ(r.track || []), rt };
    }));
    if (wanted !== current) return;   // 切线路时丢弃过期响应
    shifts = { day: got.slice(0, g.dirs.length), night: got.slice(g.dirs.length) };
    if (!shifts[shift].length) shift = 'day';   // 这条线没有夜班就回日班
    detail = shifts[shift];
    stopCache.clear();                // 数据变了，到站缓存作废

    // 夜班站表直接从刚取到的夜班数据里来（原来为了拿站表单独请求一遍）
    night = g.night.length ? {
      stops: new Set(shifts.night.flatMap((it) => it.stops.map((s) => s.name))),
      from: Math.min(...g.night.map((d) => hm(d.firstTime))),
      to: Math.max(...g.night.map((d) => hm(d.lastTime))),
    } : null;

    g.online = [...shifts.day, ...shifts.night].reduce((n, it) => n + (it.rt.buses || []).length, 0);
    renderState();
    $('#upd').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });

    $('#hint').hidden = true;
    renderLines($('#q').value);
    renderMap();
    if (sel) {
      const it = detail.find((x) => x.dir.lineId === sel.lineId);
      if (it && it.stops.some((x) => x.order === sel.order)) await selectStop(it, it.stops.find((x) => x.order === sel.order));
      else sel = null;
    }
    renderArr();
    renderMeta();
    renderRails();
    renderShifts();
    renderDirs();
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
  focusId = null;         // 换线路后回到第一个方向
  shift = 'day';          // 以及日班（夜班站表/时段都由 refresh 里重建）
  stopCache.clear();
  closeDrawer();          // 移动端选完就收起抽屉
  const g = routes.find((r) => r.name === name);
  renderLines($('#q').value);
  $('#hint').hidden = false;
  $('#hint').textContent = '加载中…';

  await refresh();
  if (isMobile()) hideCard(); else { showCard(); renderCard(); }
}

async function boot() {
  initTheme();
  initDrawer();
  initSheet();
  $('#q').addEventListener('input', (e) => renderLines(e.target.value));
  $('#btnRefresh').addEventListener('click', () => { stopCache.clear(); refresh(); });
  // 点地图空白处取消选中由高德的 map click 处理（见 ensureMap），这里不再重复监听
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
