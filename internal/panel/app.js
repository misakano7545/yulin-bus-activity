// app.js 面板前端逻辑（照「车来了」线路页的单列格式重做）。
//
// 只打本服务已有的三个接口，不新增后端：
//   GET /lines                      线路目录（46 条 = 23 条线 × 2 方向）
//   GET /lines/{id}                 站点序列
//   GET /lines/{id}/realtime        实时车辆（?targetOrder=N 时 ETA 算到该站）
//
// CSP 是 script-src 'self' 且无 unsafe-inline，所以不写内联事件、不用 eval；
// 站点/线路名一律经 textContent 落 DOM（上游数据也是外部输入）。
//
// 没有地图：车辆位置由上游的 (order, pos) 插到走向条上，不需要经纬度，也就不需要
// 折线、坐标基准换算和高德 key —— 原来那套整段删了。
'use strict';

const $ = (s) => document.querySelector(s);
const REFRESH_MS = 10000;
const SVGNS = 'http://www.w3.org/2000/svg';
const BUS_D = 'M2 2h12v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2zm0 1v5h12V3H2zm1 7.2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm10 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z';

let routes = [];      // 按线路名合并后的 21 条：{name, dirs:[Line,…], alt, tag}
let current = null;   // 当前线路名；null = 停在列表页
let detail = [];      // 当前线路各方向的 {dir, stops, rt}
let sel = null;       // 选中的站点 {lineId, order}
let busSel = null;    // 选中的车辆 {lineId, fleetNo}
let busListOpen = false;  // 车辆列表开着：卡片区显示车辆列表而不是站点卡
let focusId = null;   // 手动切到的方向（lineId）；null = 第一个方向
let shift = 'day';    // 'day' | 'alt'：日班/普通 vs 夜班/定制
let shifts = { day: [], alt: [] };
let altSvc = null;    // 本线变体的服务：{label, stops:Set, from, to}；无变体则 null
let timer = null;
let stopCache = new Map();       // `${lineId}:${order}` → 该站的到站快照
let railScrollPending = false;   // 换线路/换变体/换方向时把选中站滚进视野；10 秒刷新不滚

/* ── 小工具 ───────────────────────────────────────────────────────── */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function svgEl(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
// 单 path 图标：描边还是填充由 index.html 里各自容器的 CSS 决定
const icon = (d) => {
  const s = svgEl('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  s.append(svgEl('path', { d }));
  return s;
};
function busIcon() {
  const s = svgEl('svg', { viewBox: '0 0 16 16' });
  s.append(svgEl('path', { d: BUS_D }));
  return s;
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
  return r.json();
}

// "17:47" → 1067（当日分钟数）
const hm = (s) => { const [h, m] = s.split(':'); return +h * 60 + +m; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
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

/* ── 线路列表 ─────────────────────────────────────────────────────── */
// 线路名后缀里的「服务变体」：夜班、定制。都是同一条线的另一套服务 —— 站表、首末班、
// lineId 都不一样，列表里合并成一条，靠标签行那颗芯片切换（6 路夜班就是这么处理的）。
// 夜班、定制都是同一条线在另一时段的服务，界面上统一按「日班/夜班」显示
const VARIANTS = [{ re: /路?(夜班|定制)$/, label: '夜班', base: '日班' }];

// 上游把营运状态塞进了线路名后缀（13（临时停运）、动车专线（22路）（临时停运））。
// 只认这几个已知状态词，不做通用「去掉尾部括号」—— 大容山专线（28路）、
// 广西先进制造城（玉林）公交快速专线 的括号是名字本身。
const LINE_TAG = /[（(](临时停运|临时绕行|暂停运营)[）)]$/;

// 上游没有「站点只在某时段启用」这个字段，只能人工标注（站点名全局唯一才敢只按名匹配，
// 玉林市第三人民医院（玉林市第十中学）只出现在 9 路两端，是首末站）。
const STOP_NOTES = { '玉林市第三人民医院（玉林市第十中学）': '仅学生上学、放学时段启用' };

// 条件启用站落在首末站上时，「首末站」显示真正的一天终点：9 路的第十中学那站只在学生
// 上下学停，其余班次到它前一站「火车站」为止。只改显示 —— 比对方向/找同名站仍用原名。
const TERMINUS_ALIAS = { '玉林市第三人民医院（玉林市第十中学）': '火车站' };
const endName = (s) => TERMINUS_ALIAS[s] || s;

function groupByName(ls) {
  const m = new Map();
  for (const l of ls) {
    const t = LINE_TAG.exec(l.name);
    const bare = t ? l.name.slice(0, t.index) : l.name;
    const v = VARIANTS.find((x) => x.re.test(bare));
    const base = v ? bare.replace(v.re, '') : bare;
    if (!m.has(base)) m.set(base, { name: base, dirs: [], alt: null, tag: null });
    const g = m.get(base);
    if (t) g.tag = t[1];
    if (v) (g.alt = g.alt || { label: v.label, base: v.base, dirs: [] }).dirs.push(l);
    else g.dirs.push(l);
  }
  return [...m.values()];
}

const favKey = 'bus.fav';
let favs = new Set(JSON.parse(localStorage.getItem(favKey) || '[]'));

// 列表上的异常标记。名字里带（临时停运）的用名字里的词；名字没带的（上游把运营状态
// 藏在实时接口里 —— 先进制造城专线就是这样，13 那种至少写进了名字）就看后台刷出来的
// 状态：整条线（含变体）都报 -2 才算，且只在该线路本该在跑的时段里标 —— 收班之后
// 上游也可能报 -2，那不是异常。末班已过(-3)不标：每天都会到。
function lineTag(r) {
  if (r.tag) return r.tag;
  const all = [...r.dirs, ...(r.alt ? r.alt.dirs : [])];
  if (!all.length || !all.every((d) => d.state === -2)) return null;
  const from = Math.min(...all.map((d) => hm(d.firstTime)));
  const to = Math.max(...all.map((d) => hm(d.lastTime)));
  if (!(from <= nowMin() && nowMin() <= to)) return null;   // 时段缺失/已收班 → 不标
  return (all.find((d) => d.desc) || {}).desc || '临时停运';
}

function renderLines(filter) {
  const f = (filter || '').trim().toLowerCase();
  const ul = $('#lines');
  ul.textContent = '';
  const hit = routes.filter((r) =>
    !f || r.name.toLowerCase().includes(f) ||
    (r.alt && (r.alt.label.includes(f) ||           // 搜「夜班」能找到
               r.alt.dirs.some((d) => d.name.includes(f)))) ||   // 搜「定制」也能（名称按上游原文）
    r.dirs.some((d) => endName(d.start).toLowerCase().includes(f) ||
                       endName(d.end).toLowerCase().includes(f)));
  // 收藏的排前面（sort 稳定，组内保持上游顺序）
  hit.sort((a, b) => (favs.has(b.name) ? 1 : 0) - (favs.has(a.name) ? 1 : 0));

  if (!hit.length) {
    ul.append(el('li', 'note', routes.length ? '没有匹配的线路' : '没有取到线路'));
    return;
  }
  for (const r of hit) {
    const li = el('li', r.name === current ? 'on' : null);
    const tag = lineTag(r);
    if (tag) li.classList.add('off');
    li.append(el('span', 'badge', r.name));
    li.append(el('span', 'to', `${endName(r.dirs[0].start)} → ${endName(r.dirs[0].end)}`));
    if (tag) li.append(el('span', 'tag', tag));
    // 两个方向的车辆数合计（含夜班/定制变体）
    const n = [...r.dirs, ...(r.alt ? r.alt.dirs : [])].reduce((s, d) => s + (d.count || 0), 0);
    li.append(el('span', 'n' + (n ? '' : ' zero'), String(n)));
    if (favs.has(r.name)) li.append(el('span', 'star', '★'));
    li.tabIndex = 0;
    li.addEventListener('click', () => openLine(r.name));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLine(r.name); }
    });
    ul.append(li);
  }
}

/* ── 视图切换（列表 ↔ 线路页）────────────────────────────────────────
   走 hash 而不是一个 hidden 变量：手机的系统返回键就能退回列表。 */
function onHash() {
  const n = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (n && routes.some((r) => r.name === n)) {
    $('#vList').hidden = true;
    $('#vDetail').hidden = false;
    select(n);
  } else {
    current = null;
    $('#vList').hidden = false;
    $('#vDetail').hidden = true;
  }
}
const openLine = (name) => {
  if (decodeURIComponent(location.hash.replace(/^#/, '')) === name) onHash();
  else location.hash = encodeURIComponent(name);   // 交给 hashchange
};

/* ── 线路页 ───────────────────────────────────────────────────────── */
const titleOf = (n) => (/路/.test(n) ? `${n}公交车` : `${n}路公交车`);

// 线路是双向的，页面一次只画一个方向。方向按优先级取：
// 选中的站（点走向条会选中）> 手动切的方向 > 第一个方向。
function focusDir() {
  const want = sel ? sel.lineId : focusId;
  if (want) {
    const d = detail.find((it) => it.dir.lineId === want);
    if (d) return d;
  }
  return detail[0];
}

// 默认选中的站：取「首车还在前面一站」的那站 —— 样张就是这个视角（还有 1 个站）。
// 没有在线车就退回首站。
function defaultStop(it) {
  const bs = it.rt.buses || [];
  if (!bs.length) return it.stops[0];
  const lead = Math.max(...bs.map((b) => b.order));
  return it.stops.find((s) => s.order === lead + 1) ||
         it.stops.find((s) => s.order === lead) || it.stops[0];
}

function ensureSel(it) {
  if (sel && sel.lineId === it.dir.lineId && it.stops.some((s) => s.order === sel.order)) return;
  sel = { lineId: it.dir.lineId, order: defaultStop(it).order };
}

// 反向的那条线路：起终点正好调过来。
function reverseDir(it) {
  return detail.find((x) => x !== it &&
    x.dir.start === it.dir.end && x.dir.end === it.dir.start) || null;
}

// 「反方向站点」找的是这一站在反向线路里的同一站，按站名找 —— 不是把方向一切了事。
// 上游两边站名偶尔差个括注（玉林技师学院 / 玉林技师学院（市一职中）），所以先精确
// 匹配、再去括注匹配，且只在反向线路里唯一命中才算数。找不到就是单边站，这功能不适用。
function oppositeStop(it, s) {
  const rev = reverseDir(it);
  if (!rev || !s) return null;
  let t = rev.stops.find((x) => x.name === s.name);
  if (!t) {
    const core = (n) => n.replace(/[（(][^）)]*[）)]/g, '').trim();
    const cand = rev.stops.filter((x) => core(x.name) === core(s.name));
    if (cand.length === 1) t = cand[0];
  }
  // ponytail: 同方向重复出现同名站（环线）时取第一个，玉林没有这种线
  return t ? { dir: rev, stop: t } : null;
}

// 变体切换（日班↔夜班、普通↔定制），按钮就在标签行里。变体是另一套 lineId ——
// 车辆、终点、首末班都不一样，日班/普通里看不到。
function setShift(s) {
  if (shift === s || !shifts[s].length) return;
  const was = detail.length ? focusDir().dir : null;
  shift = s;
  detail = shifts[s];
  // 变体方向的排列顺序跟基本班不一样（G02 定制先列总站→北站），按起终点把同一个
  // 走向找回来 —— 否则一点切换就翻到反方向去了
  // 没有完全同走向的（6 路的日班与夜班跑的是不同路段），就按终点找：至少方向朝哪边不变
  const keep = was && (detail.find((it) => it.dir.start === was.start && it.dir.end === was.end)
                    || detail.find((it) => it.dir.end === was.end));
  focusId = keep ? keep.dir.lineId : null;
  sel = null;
  busSel = null;
  railScrollPending = true;
  renderAll();
}

// 变体的起讫时间。优先取「终点与当前方向相同」的那条 —— 变体与基本班的方向集合
// 不一样（夜班只开到马尔代夫水上乐园），按序号对不上同一走向，只能按终点名找；
// 该变体没有这个走向就退回整变体的并集。
function spanOf(ls, end) {
  const same = ls.filter((d) => d.end === end);
  const use = same.length ? same : ls;
  return `${hhmm(Math.min(...use.map((d) => hm(d.firstTime))))}–` +
         `${hhmm(Math.max(...use.map((d) => hm(d.lastTime))))}`;
}

function renderHead(it) {
  $('#dTitle').textContent = titleOf(current);
  $('#dFrom').textContent = endName(it.dir.start);
  $('#dTo').textContent = endName(it.dir.end);
}

// 标签行：首末班 / 票价 / 总站数 / 变体切换 / 运营状态。
function renderTags(it) {
  const box = $('#tags');
  box.textContent = '';
  const g = routes.find((r) => r.name === current);
  box.append(el('span', 'tg f', `首 ${it.dir.firstTime}`));
  box.append(el('span', 'tg l', `末 ${it.dir.lastTime}`));
  if (it.rt.price) box.append(el('span', 'tg', `票价 ${it.rt.price}`));
  box.append(el('span', 'tg', `总共 ${it.stops.length} 站`));
  if (g && g.alt && g.alt.dirs.length) {
    const altOn = shift === 'alt';
    const b = el('button', 'tg act' + (altOn ? ' off' : ''),
      `${altOn ? g.alt.label : g.alt.base} ${spanOf(altOn ? g.alt.dirs : g.dirs, it.dir.end)}`);
    b.type = 'button';
    b.title = altOn ? `切成${g.alt.base}` : `切成${g.alt.label}`;
    b.addEventListener('click', () => setShift(altOn ? 'day' : 'alt'));
    box.append(b);
  }
  const [cls, txt] = stateOf(it.rt);
  if (cls === 'idle' || cls === 'off') box.append(el('span', 'tg ' + cls, txt));
}

// 样张那句「当前有 N 辆车在行驶」；这个方向没车时改说运营状态，不硬报 0。
function renderCount(it) {
  const box = $('#count');
  box.textContent = '';
  const buses = it.rt.buses || [];
  if (buses.length) {
    box.append(document.createTextNode('当前有 '), el('b', 'box', String(buses.length)),
               document.createTextNode(' 辆车在行驶'));
    return;
  }
  box.textContent = `当前${stateOf(it.rt)[1]}`;
}

// 最近一辆还没过该站的车，以及它离该站还有几站。
function upcoming(it, s) {
  let best = null;
  for (const b of (it.rt.buses || [])) {
    if (b.order > s.order) continue;              // 已过该站
    if (!best || b.order > best.order) best = b;
  }
  return best ? { bus: best, left: s.order - best.order } : null;
}

// 站点卡：样张里那块浅底卡片 —— 站名 +「下一辆还有 N 个站，到达该站！」。
// N = 站序 − 最近一辆没过该站的车的站序。车在「正在接近的站」上，所以差 1 就是
// 「还有 1 个站」。纯前端算，不多打请求。
function renderStation() {
  const box = $('#scard');
  box.textContent = '';
  box.classList.toggle('follow', !!busSel || busListOpen);
  if (!detail.length) return;
  const it = focusDir();
  ensureSel(it);   // sel 可能刚被清掉（点过车/从跟踪页返回），别退成一张空卡
  if (busSel && busSel.lineId === it.dir.lineId) return renderFollow(box, it, busSel.fleetNo);
  if (busListOpen) return renderBusList(box, it);

  const s = it.stops.find((x) => x.order === sel.order);
  if (!s) return;
  box.append(el('div', 'sn', s.name));
  if (STOP_NOTES[s.name]) box.append(el('div', 'sub note', STOP_NOTES[s.name]));

  const up = upcoming(it, s);
  const hint = el('div', 'hint');
  if (up && up.left > 0) {
    hint.append(document.createTextNode('下一辆还有 '), el('b', 'box', String(up.left)),
                document.createTextNode(' 个站，到达该站！'));
  } else if (up) {
    // 车在「本站」有两种：正在接近（state=0）和已经停下（state=1），
    // 上游给的 order 都一样，只能看 state。
    hint.textContent = up.bus.state === 1 ? '车辆已到站！' : '车辆正在进站！';
  } else {
    hint.classList.add('mute');
    hint.textContent = (it.rt.buses || []).length ? '当前车辆均已过该站' : `当前${stateOf(it.rt)[1]}`;
  }
  box.append(hint);

  // 点站后单独问一次上游（targetOrder 把 ETA 算到这一站），到了才出这条
  const rt = stopCache.get(`${it.dir.lineId}:${s.order}`);
  const b = rt && (rt.buses || []).filter((x) => x.order <= s.order && x.eta > 0)
    .sort((x, y) => etaKey(x) - etaKey(y))[0];
  if (b) box.append(el('div', 'sub', `${b.fleetNo} 号车 · ${mins(b.eta)}${b.arriveAt ? ` · ${b.arriveAt} 到` : ''}`));
}

// 车辆跟踪页：点走向条上的车进这里（替掉站点卡）。
// 上游 travels 一次只给一条（目标站），逐站 ETA 要按站问几十次 —— 不做。
// 这里只摆已有的事实：已过 / 正在接近（或已到站）/ 未到，加上车速与到终点的 ETA。
function renderFollow(box, it, fleetNo) {
  const back = el('button', 'back2');
  back.type = 'button';
  back.append(icon('M15 4 7 12l8 8'), el('span', null, busListOpen ? '返回车辆列表' : '返回站点'));
  back.addEventListener('click', () => { busSel = null; renderStation(); renderRail(); });
  box.append(back);

  const b = (it.rt.buses || []).find((x) => x.fleetNo === fleetNo);
  const h = el('div', 'h');
  h.append(el('b', null, `${fleetNo} 号车`), el('span', null, `开往 ${it.dir.end}`));
  box.append(h);
  if (!b) { box.append(el('div', 'sub', '这辆车已不在线上（收班或已到终点）。')); return; }

  const left = Math.max(0, it.stops.length - b.order);
  const sub = [b.state === 1 ? '已到站' : (b.speed > 0 ? `${b.speed.toFixed(1)} km/h` : '在途'),
               left > 0 ? `距终点 ${left} 站` : '已到终点'];
  if (b.eta > 0) {
    sub.push(mins(b.eta));                       // 默认请求下 ETA 是到终点的
    if (b.arriveAt) sub.push(`${b.arriveAt} 到`);
  }
  if (b.confidence === 'low') sub.push(`未知车牌 ${b.rawId}`);
  box.append(el('div', 'sub', sub.join(' · ')));

  const list = el('div', 'jrn');
  for (const s of it.stops) {
    const r = el('div', 'jrow' + (s.order < b.order ? ' pass' : s.order === b.order ? ' next' : ''));
    r.append(el('i', 'jdot'), el('span', 'jnm', s.name));
    if (s.order === b.order) r.append(el('span', 'at', b.state === 1 ? '已到站' : '正在接近'));
    list.append(r);
  }
  box.append(list);
  const cur = list.querySelector('.jrow.next');
  if (cur) cur.scrollIntoView({ block: 'center' });   // 40+ 站的长线，直接滚到它现在那段
}

// 车辆列表：以当前选中的站为准，一辆一行列出它到这个站的倒计时。
// 倒计时只能来自带 targetOrder 的那次请求（不带时 eta 的语义是「到终点」）——
// 正是点站时 selectStop 取回来的那份，缓存在 stopCache 里，这里不再打请求。
function renderBusList(box, it) {
  const back = el('button', 'back2');
  back.type = 'button';
  back.append(icon('M15 4 7 12l8 8'), el('span', null, '返回站点'));
  back.addEventListener('click', () => { busListOpen = false; renderStation(); });
  box.append(back);

  const s = it.stops.find((x) => x.order === sel.order);
  if (!s) return;
  const rt = stopCache.get(`${it.dir.lineId}:${s.order}`);
  const h = el('div', 'h');
  h.append(el('b', null, `到「${s.name}」`), el('span', null, `共 ${(rt && rt.buses || []).length} 辆`));
  box.append(h, el('div', 'sub', `开往 ${it.dir.end}`));
  if (!rt) { box.append(el('div', 'sub', '读取到站时间…')); return; }
  const bs = (rt.buses || []).slice();
  if (!bs.length) { box.append(el('div', 'sub', `当前${stateOf(rt)[1]}。`)); return; }

  // 没过该站的按到站先后排前面，已过的沉到最后
  const passed = (b) => b.order > s.order;
  bs.sort((a, b) => (passed(a) - passed(b)) || (etaKey(a) - etaKey(b)));

  for (const b of bs) {
    const over = passed(b);
    const left = s.order - b.order;
    const etaTxt = over ? '已过站' : b.eta > 0 ? mins(b.eta)
      : b.state === 1 ? '已到站' : '即将到站';
    const atStop = b.state === 1;   // 已到站由右边的倒计时列说，这里就不再重复
    const sub = [over ? '已过该站' : atStop ? null : (left > 0 ? `还有 ${left} 站` : '正在进站'),
                 atStop ? null : (b.speed > 0 ? `${b.speed.toFixed(1)} km/h` : '在途')].filter(Boolean);
    if (b.arriveAt) sub.push(`${b.arriveAt} 到`);
    if (b.confidence === 'low') sub.push(`未知车牌 ${b.rawId}`);
    const txt = el('div', 'vtxt');
    const top = el('div', 'vh');
    top.append(el('b', null, `${b.fleetNo} 号车`), el('span', 'eta', etaTxt));
    txt.append(top, el('div', 'vs', sub.join(' · ')));
    const row = el('button', 'vrow' + (over ? ' pass' : ''));
    row.type = 'button';
    row.append(busIcon(), txt);
    row.addEventListener('click', () => selectBus(it, b));   // 与点走向条上的车同一条路
    box.append(row);
  }
}

/* ── 走向条 ───────────────────────────────────────────────────────── */
/* 竖排站名 + 绿轴 + 车辆按 (order, pos) 插在两站之间。
   车辆 chip 挂在它「正在接近的站」那一格里，再用 --p 往左退回站间：
   p=1 落在站上，p=0 落在上一站。 */
function renderRail() {
  const rail = $('#rail');
  rail.textContent = '';
  if (!detail.length) return;
  const it = focusDir();
  const altOn = !!(altSvc && nowMin() >= altSvc.from && nowMin() <= altSvc.to);
  const byOrder = new Map();
  for (const b of (it.rt.buses || [])) {
    if (!byOrder.has(b.order)) byOrder.set(b.order, []);
    byOrder.get(b.order).push(b);
  }

  let selCell = null;
  for (const s of it.stops) {
    const skip = altOn && !altSvc.stops.has(s.name);
    const note = STOP_NOTES[s.name];
    const on = !!(sel && sel.lineId === it.dir.lineId && sel.order === s.order);
    const cell = el('div', 'stn' + (skip ? ' skip' : '') + (note ? ' cond' : '') + (on ? ' on' : ''));
    // 站点就是站点：方块里不放公交车图标，车才用那个图标（走向条上的色块、车辆列表）
    cell.append(el('i', 'bx'), el('span', 'nm', s.name));
    cell.title = skip ? `${s.name}（${altSvc.label}不停）` : (note ? `${s.name}（${note}）` : s.name);
    // 同站两辆车会叠在一起（没做纵向分道）—— 实际很少见，先不管
    for (const b of (byOrder.get(s.order) || [])) {
      const chip = el('span', 'bus' + (busSel && busSel.fleetNo === b.fleetNo ? ' on' : ''));
      chip.style.setProperty('--p', String(b.pos));
      chip.append(busIcon(), el('span', null, b.fleetNo));
      chip.title = `${b.fleetNo} · ${b.state === 1 ? '已到' : '前往'} ${s.name}`;
      chip.addEventListener('click', (e) => { e.stopPropagation(); selectBus(it, b); });
      cell.append(chip);
    }
    cell.tabIndex = 0;
    const pick = () => { busListOpen = false; selectStop(it, s); };   // 点站 = 要站点卡
    cell.addEventListener('click', pick);
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
    if (on) selCell = cell;
    rail.append(cell);
  }
  // 只在换线路/换班次/换方向时滚一次 —— 每 10 秒刷新都滚会把用户拖的横向位置拽回去。
  if (railScrollPending && selCell) {
    selCell.scrollIntoView({ inline: 'center', block: 'nearest' });
    railScrollPending = false;
  }
}

/* ── 交互 ─────────────────────────────────────────────────────────── */
// 点站：这站成为当前站，并单独问一次上游拿「到该站」的 ETA。
async function selectStop(it, s) {
  sel = { lineId: it.dir.lineId, order: s.order };
  busSel = null;
  focusId = it.dir.lineId;   // 点哪个方向上的站就把方向切过去
  renderAll();

  const key = `${it.dir.lineId}:${s.order}`;
  if (stopCache.has(key)) return;
  try {
    const rt = await api(`/lines/${encodeURIComponent(it.dir.lineId)}/realtime?targetOrder=${s.order}`);
    stopCache.set(key, rt);
    // 期间用户可能点了别的站，或换线路/刷新过（缓存会清空）
    if (!sel || sel.lineId !== it.dir.lineId || sel.order !== s.order) return;
    if (!stopCache.has(key)) return;
    renderStation();
  } catch (e) {
    $('#scard').append(el('div', 'sub', `取到站数据失败：${e.message}`));
  }
}

function selectBus(it, b) {
  busSel = { lineId: it.dir.lineId, fleetNo: b.fleetNo };
  sel = null;
  focusId = it.dir.lineId;
  renderStation();
  renderRail();
}

function toggleFav() {
  if (!current) return;
  if (favs.has(current)) favs.delete(current); else favs.add(current);
  localStorage.setItem(favKey, JSON.stringify([...favs]));
  renderFav();
  renderLines($('#q').value);
}

function renderFav() {
  const on = favs.has(current);
  $('#btnFav').classList.toggle('on', on);
  $('#favTxt').textContent = on ? '已收藏' : '收藏路线';
}

function renderAll() {
  if (!detail.length) return;
  const it = focusDir();
  ensureSel(it);
  renderHead(it);
  renderTags(it);
  renderCount(it);
  renderFav();
  // 换向按钮只在这条线根本没有反方向时才灰 —— 当前这站是单边站也照样可点（见 goOpposite），
  // 灰着会被当成「没这个功能」。
  const canFlip = !!reverseDir(it);
  $('#btnDir').disabled = !canFlip;
  $('#btnTurn').disabled = !canFlip;
  renderStation();
  renderRail();
}

/* ── 取数 ─────────────────────────────────────────────────────────── */
async function refresh() {
  if (!current) return;
  const g = routes.find((r) => r.name === current);
  if (!g) return;
  const wanted = g.name;
  try {
    // 日班与夜班一起取：夜班是另一套 lineId，不取就看不到夜班的车
    const all = [...g.dirs, ...(g.alt ? g.alt.dirs : [])];
    const got = await Promise.all(all.map(async (d) => {
      const [r, rt] = await Promise.all([
        api(`/lines/${encodeURIComponent(d.lineId)}`),
        api(`/lines/${encodeURIComponent(d.lineId)}/realtime`),
      ]);
      return { dir: d, stops: r.stops || [], rt };
    }));
    if (wanted !== current) return;   // 切线路时丢弃过期响应
    shifts = { day: got.slice(0, g.dirs.length), alt: got.slice(g.dirs.length) };
    if (!shifts[shift].length) shift = 'day';   // 这条线没有这个变体就回日班/普通
    detail = shifts[shift];
    stopCache.clear();                // 数据变了，到站缓存作废

    // 夜班站表直接从刚取到的夜班数据里来
    // 变体的服务时段与站表：标签行和走向条的「某站不停」标记都要用
    altSvc = g.alt && g.alt.dirs.length ? {
      label: g.alt.label,
      stops: new Set(shifts.alt.flatMap((it) => it.stops.map((s) => s.name))),
      from: Math.min(...g.alt.dirs.map((d) => hm(d.firstTime))),
      to: Math.max(...g.alt.dirs.map((d) => hm(d.lastTime))),
    } : null;

    $('#upd').className = 'upd';
    $('#upd').textContent = `数据更新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 车来了`;
    renderLines($('#q').value);
    renderAll();
    if (!sel) return;
    const it = detail.find((x) => x.dir.lineId === sel.lineId);
    const s = it && it.stops.find((x) => x.order === sel.order);
    if (s) await selectStop(it, s);   // 缓存已清，这里会重取一次该站的 ETA
    else sel = null;
  } catch (e) {
    $('#upd').className = 'upd bad';
    $('#upd').textContent = `取实时数据失败：${e.message}`;
    renderAll();
  }
}

async function select(name) {
  current = name;
  sel = null;
  busSel = null;
  busListOpen = false;
  focusId = null;         // 换线路后回到第一个方向
  shift = 'day';          // 以及回到日班/普通（变体的站表与时段都由 refresh 重建）
  detail = [];
  shifts = { day: [], alt: [] };
  stopCache.clear();
  railScrollPending = true;
  $('#dTitle').textContent = titleOf(name);
  $('#count').textContent = '加载中…';
  $('#scard').textContent = '';
  $('#rail').textContent = '';
  renderLines($('#q').value);
  await refresh();
}

async function boot() {
  $('#q').addEventListener('input', (e) => renderLines(e.target.value));
  $('#btnBack').addEventListener('click', () => history.back());
  $('#btnRefresh').addEventListener('click', () => { stopCache.clear(); refresh(); });
  // 底栏「换向」和卡片下的「反方向站点」是同一件事，共用一个 handler。
  // 有同名站就落到同名站；这站反向没有（单边站）就换向并落到那边的默认站 ——
  // 总之一定换得过去，不会点了没反应。
  const goOpposite = () => {
    const it = focusDir();
    const rev = reverseDir(it);
    if (!rev) return;
    const op = oppositeStop(it, it.stops.find((x) => x.order === sel.order));
    railScrollPending = true;      // 方向换了，把落点那站滚进视野
    selectStop(op ? op.dir : rev, op ? op.stop : defaultStop(rev));
  };
  $('#btnDir').addEventListener('click', goOpposite);
  $('#btnTurn').addEventListener('click', goOpposite);
  $('#btnBuses').addEventListener('click', () => {
    busListOpen = true;
    busSel = null;
    const it = focusDir();
    ensureSel(it);
    renderRail();       // 清掉走向条上那辆车的选中态
    selectStop(it, it.stops.find((x) => x.order === sel.order));   // 取「到该站」的倒计时
  });
  $('#btnFav').addEventListener('click', toggleFav);
  window.addEventListener('hashchange', onHash);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  try {
    routes = groupByName(await api('/lines'));
    renderLines('');
    onHash();     // 直接开在线路页（带 hash）也能回到那条线
    timer = setInterval(() => { if (current) refresh(); }, REFRESH_MS);
  } catch (e) {
    $('#lines').textContent = '';
    $('#lines').append(el('li', 'note bad', `取线路失败：${e.message}`));
  }
}

boot();
