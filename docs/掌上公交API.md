# 掌上公交（mygolbs）H5 接口文档

| 项目 | 内容 |
|---|---|
| 数据面 | 掌上公交官方 H5：`https://h5.mygolbs.com/ApiData.do` |
| 服务方 | 厦门搜谷信息科技（掌上公交 / 掌上出行，`com.mygolbs.mybus`） |
| 鉴权 | **无**。无签名、无 token、无 cookie、无时间戳 |
| 硬门槛 | 每个请求必须带 `Origin: https://h5.mygolbs.com` |
| 实测 | 2026-10-29 20:4x–21:0x CST（本文档复测）；覆盖矩阵/县级清单等历史数据标注了 2026-10-12 的采集时刻 |
| 代码 | `internal/mygolbs/mygolbs.go`（本仓只接了 `103` / `104`） |

本文档只讲掌上公交这一侧。车来了那侧见 `docs/车来了API.md`。

---

## 1. 全貌

| 项 | 值 |
|---|---|
| 入口 | `POST https://h5.mygolbs.com/ApiData.do` |
| 编码 | `Content-Type: application/x-www-form-urlencoded` |
| 参数 | 全部塞在**请求体**里，不是 query |
| 响应 | 裸 JSON（**没有包裹层**） |
| 城市选择 | `CITYCODE` 行政区划码（`450900` / `450981` / `450921`），`CITYNAME` 一起带 |
| 线路寻址 | `(CITYNAME, CITYCODE, LINENAME, DIRECTION)` —— 名字必须逐字节一致 |

---

## 2. 通用约定

### 2.1 请求头

| 头 | 值 | 缺了会怎样 |
|---|---|---|
| `Origin` | `https://h5.mygolbs.com` | **硬门槛**。缺了所有命令都返回同一个 47 字符网关串（HTTP 200、不是 JSON） |
| `Referer` | `https://h5.mygolbs.com/` | 建议带 |
| `Content-Type` | `application/x-www-form-urlencoded` | 必须 |
| `User-Agent` | 任意手机浏览器 UA | 实测手机 UA 即可 |

缺 `Origin` 的固定响应（47 字节，每次一模一样）：

```
0vx0czK73ykwCHaLBTiKh0iCXQINzRvSZw4+b/H8FgE52U=
```

**这个错误形态很好认**：不是 JSON、长度不到 50 字节，一眼就知道是缺头，不是没车。

### 2.2 业务状态码

成功与失败都是 HTTP 200，成败看 `status`：

| `status` | 类型 | 含义 |
|---|---|---|
| `1` | **数字** | 成功 |
| `"-1"` | **字符串** | 业务失败（无数据 / 参数不对），文案在 `msg` |
| `"-2"` | 字符串 | 城市不支持（`当前城市暂无法提供公交查询`） |
| `0` | 数字 | 少见的失败（如 `205` 校验不过） |

> ⚠️ **`status` 的类型不稳定**：成功是数字 `1`，失败是字符串 `"-1"`。
> 解析时必须按「去掉引号后等于 `1`」判断，不能 `status == 1` 直接比（Python 里 `"1" != 1`，
> Go 里要么 `json.Number` 要么 `json.RawMessage` —— 本仓用的是后者）。

常见 `msg`：

| msg | 触发 |
|---|---|
| `获取数据成功！` / `success` | 成功 |
| `暂无数据信息！` | 线路名不存在（`103`） |
| `获取线路数据失败！` | 缺 `DIRECTION`（`103`） |
| `当前城市暂无法提供公交查询` | `CITYCODE` 不存在 |
| `获取实时数据成功!` | `104` 成功（注意末尾是半角感叹号） |
| `获取经过该站点的线路列表成功` | `115` 成功 |

### 2.3 通用规则

- 所有坐标都是**字符串优先级不一**：`103` 里是数字，`106` / `115` 里是字符串，`104` 里是数字。
  解析别写死类型。
- 站序：`103.data[].stationOrder` 是 **1 基**；`104.list[].index` 是 **0 基**。
- 失败经常是**静默的**（`status=1` + 空数组），见 §6。

---

## 3. 命令总表

| CMD | 用途 | 数据键 | 状态 |
|---|---|---|---|
| `101` | 全国城市列表 | `data` | ✅ 实测（579 城） |
| `119` | 线路目录 | `buslines` | ✅ 实测（玉林 50 条 / 25 线） |
| `102` | 线路 + 站点搜索 | `buslines` `busstations` | ✅ 实测 |
| `114` | 线路搜索（多带 `routeBean`，含数字 `id`） | `buslines` | ✅ 实测 |
| `103` | 站序 / 首末班 / 票价 / 轨迹点 | `data` | ✅ 实测 ★ |
| `104` | 实时车辆 + 到站估计 | `list` `routeOnStationRTimeInfoList` | ✅ 实测 ★ |
| `106` | 周边站点（按坐标） | `data` | ✅ 实测 |
| `110` | 站点搜索（按关键字） | `busstations` | ✅ 实测 |
| `115` | 站点经停线路 | `data` | ✅ 实测 |
| `116` | 发车时刻（简版，带「下一班」标记） | `list` | ✅ 实测 |
| `207` | 发车时刻表（分组 + 每班状态） | `list` | ✅ 实测 |
| `205` | 校验 `CITYKEY` | `city` | ⚠️ 走 `CITYCODE` 后不必用 |
| `117` | 站牌二维码 → 线路 | — | ❌ 不可用 |
| `112` / `113` | 换乘方案 / 明细 | — | ⚠️ 未验证 |
| `120` | 批量线路信息 | — | ⚠️ 未验证 |
| `203` | 城市资讯 / 公告 | — | ⚠️ 未验证 |
| `209` | 站点搜索（带坐标） | — | ⚠️ 未验证 |

### 3.1 未验证 / 不可用接口的 bundle 调用参数

以下参数是从官方 H5 bundle（`js/mygolbs-mybus.js`）里**读出来的调用点**，不是实测结果：

| CMD | bundle 里的参数 | 实测结果 | 结论 |
|---|---|---|---|
| `117` | `CITYCODE` `STATIONID`（站牌二维码） | `{"status":"-1","desc":"暂无数据信息!"}` | **不可用**：`STATIONID` 无处可得（`103`/`110` 的 `stationId` 恒 0） |
| `112` | `CITYNAME` `REALLINE` `REALDIR` `STATIONORDER`（逗号连接） | 未测 | 换乘实时信息 |
| `113` | `CITYNAME` `REALLINE` `REALDIR` `STATIONORDER` `STATIONNAME`（`#` 连接） | 未测 | 换乘明细 |
| `120` | `CITYNAME` `LINELIST`（JSON 字符串） | 未测 | 批量线路信息 |
| `203` | `CITYNAME` `CITYKEY` | 未测 | 城市资讯，**要 `CITYKEY`** → 不宜用 |
| `209` | `CITYNAME` `STATIONNAME` `MYLAT` `MYLNG` `LAT` `LNG` | 未测 | 疑似 `110` + 坐标的合并版 |

另注：`117` 的错误响应用的是 `desc` 字段（不是 `msg`）—— 错误体格式在不同命令间也不统一。

**已排查、确认与城市凭据无关的旁路**（不必再看）：

- `wx.mygolbs.com/WxBusServer/ApiData.do` —— 只处理微信 JS-SDK 签名（`CMD=204` + `kkk` + `signurl`），
  `CMD=101`/`205` 返回空体；
- `reactivebus-web.mygolbs.com`、`microbus-web.mygolbs.com` —— 响应式公交 / 网约微巴下单页，
  bundle 里只有登录、订单、支付路径；
- `www.mygolbs.com`、`m.mygolbs.com` 的 bundle —— 只有 `CMD=204` 签名调用；
- `quanguo.mygolbs.com/MyBusServer` —— 空壳页面。

要用哪个未验证命令，先按 §9 的 curl 模板自己打一遍。

---

## 4. 城市与覆盖

### 4.1 覆盖矩阵（2026-10-12 全量实测）

| 行政区 | 自己的 `CITYCODE` | 自有线路 | 在 `450900` 目录内 | 实时 | 结论 |
|---|---|---|---|---|---|
| 玉林市区（含玉州区 `450902`） | `450900`（25 线 / 50 向） | 25 | — | ✅ | 可用 |
| 北流市 | `450981`（3 线 / 6 向） | 3 | `北流105路` + 2 条城际线 | ✅ 6/6 向 | **可用（双入口）** |
| 容县 | `450921`（16 线 / 32 向） | 16 | **无**（`KEY=容县` 返回 0） | ✅ 32/32 向 | **可用（唯一入口）** |
| 陆川县 | ❌ `450922` → `-2` | — | `陆川1路` | ✅ 2/2 向 | **可用（仅经 `450900`）** |
| 福绵区 | ❌ `450903` → `-2` | — | `玉林总站-福绵新滔工业园` | ✅ 2/2 向 | **可用（仅经 `450900`）** |
| 玉州区（市区主体） | ❌ `450902` → `-2` | — | 市区线路即在其下 | ✅ | 用 `450900` |
| 博白县 | ❌ `450923` → `-2` | — | **无** | ❌ | **平台侧无数据** |
| 兴业县 | ❌ `450924` → `-2` | — | **无** | ❌ | **平台侧无数据** |

县市级线路合计 **44 条 / 88 个方向**（`450900` 25 + `450981` 3 + `450921` 16），
去重后 43 条（`北流105路` 重复）。**48/48 个县级方向实测 `hasReal=1`。**

失败响应固定为 `{"status":"-2","msg":"当前城市暂无法提供公交查询"}`。

⚠️ **不要把 `-2` 读成「该县没有实时公交」**。它只说明「这个县没有独立城市码」；
陆川、福绵、玉州区的车都在 `450900` 下面。
**判覆盖的唯一可靠办法：拿 `450900` 的目录 grep 线路名**（`CMD=119` + `KEY=<县名>`）。

反过来也不成立：**博白、兴业是真的没有** —— 三个目录（`450900`/`450981`/`450921`）里
都搜不到，自有码 `450923`/`450924` 也都是 `-2`。**别拿陆川去推它们。**

### 4.2 玉林市 `450900` 的 25 条线（实测）

```
1路 2路 3路 4路 6路 6路夜班 7路 8路 9路 11路 17路 23路 26路
G01路 G02路
北流105路
陆川1路
十字街-园博园文旅专线
大容山旅游专线（28路）
广西先进装备制造城（玉林）专线
玉林北站定制夜班车
玉林总站-福绵新滔工业园
玉林旅游客运站至北流成南站公交线路
玉林至北流城际公交线路
碧桂园学生专线
```

与车来了侧（23 线 / 46 向）的差异：掌上公交多出来的主要是**非公交公司常规线路**
（文旅专线、旅游专线、园区专线、学生专线、城际线、定制夜班车）以及 `G01路` ——
这部分是接这条数据面最直接的增量。

### 4.3 跨城市码重叠与去重

实测两类情况：

- **整条线重复**：`北流105路` 同时在 `450900` 和 `450981` 目录里，两个入口返回的车辆**逐一致**
  （同 `routeId=40105`，同一批车牌 `桂K08258D / 桂KR8698 / 桂KU0806 / 桂KU1899`）；
- **只在一个入口**：`陆川1路`、`玉林总站-福绵新滔工业园`、两条北流城际线**只**在 `450900` 下；
  容县的 16 条线**只**在 `450921` 下。

**合并多个城市码的目录时必须按 `(lineName, from, to)` 去重**，否则会出现重复线路。
重复的是同源数据，选一个入口即可，不需要字段级合并。

拉几个城市码取决于要覆盖谁：

| 要覆盖 | 拉这些 `CITYCODE` | 结果 |
|---|---|---|
| 玉林全域（含县级） | `450900` + `450981` + `450921` | 25 + 3 + 16 = **44 条线**（去重 43） |
| 市区 + 县级线（含陆川、福绵） | `450900` | 25 条线 |
| 只要容县 | `450921` | 16 条线 |

三个码**必须都拉**才叫全覆盖：`450900` 里没有容县的线，`450981`/`450921` 里没有陆川和福绵的线。

### 4.4 县级实时数据挂在上级地级市下面 ⚠️

这是这条数据面最容易踩的坑，也是 §4.1 那列 `-2` 的正确读法。

实测（2026-10-12 07:46 CST，`陆川`）：

| 项 | 值 |
|---|---|
| `CITYCODE=450922` | `{"status":"-2","msg":"当前城市暂无法提供公交查询"}` |
| `CMD=101` 城市列表 | **不含**陆川 |
| `CMD=119` `CITYCODE=450900` `KEY=陆川` | **有** `陆川1路`，2 个方向 |
| `CMD=103` `LINENAME=陆川1路` `DIRECTION=1` | `routeId=1011`，19 站，`firstLast` `06:00`/`21:00`，`县瓷厂` ↔ `沙湖镇政府` |
| `CMD=104` 方向 1 | `hasReal=1`，1 辆 `桂K11819D` |
| `CMD=104` 方向 2 | `hasReal=1`，1 辆 `桂K09778D` |

两次采样相隔约 1 分钟，**车的站名都动了** —— 活的实时流，不是静态快照。

三条推论：

1. **城市码缺失 ≠ 无实时。** 判覆盖只能在上级地级市目录里 grep 线路名，别在 `450922` 上判死刑。
2. **`CMD=101` 的城市列表既不是「有实时」的充分条件也不是必要条件。**
   北流在列表里且有数据；陆川**不在列表里**却有实时数据。这个列表只能当城市名字典。
3. **县级线路的 `company` 是简称，不能当工商登记名**：`陆川1路` 的
   `routeBean.company = "玉林公交"`；`北流101/102/105路` 都写 `北流市公交`，
   而北流105路的实际运营主体是**广西北流市益业公共汽车有限公司**。

**设计后果**：只按「县市自己的城市码」拉目录会漏掉没有城市码的县级车队（陆川就是）。
正确做法是**从地级市目录 `450900` 里搜线路名**来判覆盖，把县市当**线路名的前缀标签**
（`陆川`、`北流`、`容县`）；有独立城市码的（`450981`、`450921`）再按需补拉，靠
`(lineName, from, to)` 去重。

⚠️ `CITYCODE` 存的是**「调用时要用哪个城市码」，不是地理归属**。`陆川1路` 必须用 `450900` 调。
这个值只能从目录来源带着走，**不要按线路名里的县名反推城市码**。

### 4.5 玉林全域县级线路清单（2026-10-12 实测）

`103` + `104` 逐方向扫描，**48/48 方向 `hasReal=1`**。「城市码」列是该线**必须用哪个码调**：

| 城市码 | 线路 | `routeId` | 站数（向1/向2） | 首末班（向1） |
|---|---|---|---|---|
| `450981` | `北流101路` | `40101` | 16 / 16 | 06:40–17:50 |
| `450981` | `北流102路` | `40102` | 22 / 22 | 07:35–17:30 |
| `450981` | `北流105路` | `40105` | 24 / 24 | 07:00–18:00 |
| `450921` | `容县3路` | `20031` | 11 / 11 | 07:00–18:05 |
| `450921` | `容县7路` | `20071` | 13 / 13 | 07:15–16:40 |
| `450921` | `容县11路` | `20111` | 21 / 21 | 07:00–17:00 |
| `450921` | `容县12路` | `20121` | 14 / 14 | 07:00–17:00 |
| `450921` | `容县13路` | `20131` | 22 / 22 | 07:00–17:10 |
| `450921` | `容县15路` | `20151` | 20 / 20 | 07:20–16:00 |
| `450921` | `容县16路` | `20161` | 14 / 14 | 07:00–16:30 |
| `450921` | `容县17路` | `20171` | 18 / 18 | 07:30–16:20 |
| `450921` | `容县18路` | `20181` | 11 / 11 | 07:10–17:15 |
| `450921` | `容县19-1路` | `20191` | 14 / 14 | 07:10–15:20 |
| `450921` | `容县19路` | `20192` | 11 / 11 | 07:50–16:20 |
| `450921` | `容县20路` | `20201` | 22 / 22 | 07:00–17:00 |
| `450921` | `容县21路` | `20211` | **11 / 13** | 07:00–15:00 |
| `450921` | `容县23路` | `20231` | 15 / 15 | 07:00–16:00 |
| `450921` | `容县25路` | `20251` | 16 / 16 | 07:30–15:30 |
| `450921` | `容县26路` | `20261` | 18 / 18 | 07:30–15:40 |
| `450900` | `陆川1路` | `1011` | 19 / 19 | 06:00–21:00 |
| `450900` | `玉林总站-福绵新滔工业园` | `151` | **29 / 32** | 06:30–18:50 |
| `450900` | `玉林至北流城际公交线路` | `131` | 33 / 33 | 06:10–19:20 |
| `450900` | `玉林旅游客运站至北流成南站公交线路` | `141` | 32 / 33 | 06:20–18:20 |
| `450900` | `北流105路`（与 `450981` 同一条） | `40105` | 24 / 24 | 07:00–18:00 |

读表要点：

- **`routeId` 是分区命名，不是全局连号**：市区短线 `1`、`G01路=701`；专线/城际 `131`/`141`/`151`；
  陆川 `1011`；北流 `401xx`；容县 `200xx`–`202xx`。**别按大小猜归属。**
- **容县 `19-1路`（`20191`）的 `routeId` 比 `19路`（`20192`）小** —— 后缀 `-1` 的变体先占号。
- **双向站数可以不等**：`容县21路` 11/13、福绵线 29/32。
  **不要假设两个方向站表等长**；`STATIONORDER` 只对当前方向有效。
- **空车 ≠ 没数据**：`容县17路`、`容县26路` 两个方向在线车都是 0，但 `hasReal=1`
  （当天有排班，只是此刻没有车在路上）。
- `北流105路` 在 `450900` 与 `450981` 下**完全同源** —— 去重规则最直接的证据。

### 4.6 跨城验证：南宁市 `450100`（2026-11-03 19:38 CST）

以南宁为样本复核「换个城市这套接口还成不成立」，全部走同一套 CMD，无新增参数：

| 步 | 请求 | 结果 |
|---|---|---|
| 目录 | `CMD=119` `CITYNAME=南宁市` `CITYCODE=450100` | `status=1`，749 条方向 / 376 个线路名 |
| 站序 | `CMD=103` `LINENAME=1路` `DIRECTION=1` | 35 站，`亭江白沙路口` ↔ `中泰桂雅路口`，`routeId=1` |
| 实时 | `CMD=104` `LINENAME=1路` `STATIONORDER=1` | `hasReal=1`，6 辆（`桂A08221D` 在 `亭江亭洪路口`） |

10 条主干线（1/2/5/6/8/9/31/32/36/39 路）逐条 `103`+`104`：**10/10 `hasReal=1`**，
在线车 1–7 辆不等，站数 15–36。与玉林同口径，无需改代码。

目录里 `company` 一栏暴露的运营主体比玉林多：

- `南宁公共交通集团有限公司` 282 条线名
- `南宁白马公共交通有限公司` 57 条
- `南宁市武鸣泰禾公共交通有限公司` 12 条 + `武鸣市公交` 5 条 —— **以 `武鸣` 开头的 15 条线名（`武鸣4路`/`武鸣10路`…`武鸣107路`，含乡镇线 `武鸣-灵马`）挂在市级目录下**，
  又一次印证 §4.4：区县线路在地级市目录里，别去单独找区县城市码。抽 `武鸣4路`/`武鸣-灵马`/`武鸣107路` 三条，
  `103` 都出站表（20/6/21 站），`104` 回 `hasReal=1`/`1`/`0` 但都是 0 车，与「空车 ≠ 没数据」（§4.5）同一现象。
- `轨道集团` 5 条（地铁接驳）、`南宁吴圩国际机场` 5 条（机场巴士）。

⚠️ 南宁下辖的**横州、宾阳、上林、马山、隆安**在 `CMD=101` 城市列表里没有独立条目，
`450100` 目录里也 grep 不到以这些县名开头的线路 —— 这几家的车不在掌上公交这条数据面上。
只有武鸣区（已改区）有。

---

## 5. 逐命令详规

### 5.1 `CMD=101` — 全国城市列表

请求：`CMD=101`

响应：

```json
{"data":[{"cityname":"贵阳市"}, ...], "status":1, "msg":"success"}
```

| 字段 | 说明 |
|---|---|
| `data[].cityname` | 城市名，**只有名字，没有城市码** |

实测 579 个城市。要用它拿 `CITYCODE` 还得再走 `205`（已不必要），
实践上直接按行政区划码试 + 用 `119` 验。

**全国枚举（2026-11-03 全量实测，579 个城市逐个拉 `CMD=119`）**：

- **552 个有目录**，目录合计 **144,443 条方向记录**（每条含 `lineName`/`upperOrDown`）；
- **27 个 `status=1` 但目录为空**（真没数据，不是失败）：西宁、北海、遂宁、辽阳、
  本溪、昭通、葫芦岛、阜新、盘锦、晋城、武威、普洱、乌苏、五家渠、临湘、崇州、莱阳、
  长兴县、涞源县、灵寿县、安宁区、龙泉驿区、角美台商投资区（两种写法）、
  巴音郭楞蒙古自治州、锡林郭勒盟、西双版纳傣族自治州；
- **0 个请求失败** —— 579 个城市名全部能作为 `CITYNAME` 直接用；
- 名单构成：420 市 + 94 县 + 19 区 + 21 州 + 4 旗 + 2 盟 + 19 其他。**县级就占 98 条**，
  `长宁县`（40 向，`hasReal=1`，实测回 `川Q62721` 一辆在途车）、`永嘉县`（625 向）、
  `盐城市滨海县`（721 向）都在列 —— **「下属县城、辖区」不需要任何额外入口，
  `CMD=101` 的名单本身就是全国含县级的清单**，逐个 `CMD=119&CITYNAME=<cityname>` 即可；
- `CITYCODE` 完全可以不传或乱填（香港 `999999` 照常回 1725 条）—— **目录按 `CITYNAME` 走**；
- 城市名有重复（`角美台商投资区` 两种写法），去重后再扫；
- 逐城结果存档：`docs/data/mygolbs_city_sweep.json`（city/status/rows/msg）。

抽查过的跨城实时（`CMD=104`）：义乌 `2路`（`02106D` 在途）、长宁县 `1路`、香港 `1` 路
（`hasReal=0`，港线不走这个平台的车机）—— 与玉林同参数格式，无需任何适配。

---

### 5.2 `CMD=119` — 线路目录

请求：`CMD=119&CITYNAME=玉林市&CITYCODE=450900[&KEY=北流]`

`KEY` 是**包含匹配**的关键字过滤，空串 = 全部。

响应 `buslines[]`（实测玉林市 50 条 = 25 线 × 2 方向）：

| 字段 | 说明 |
|---|---|
| `lineName` | 线路名。**`103` / `104` 的 `LINENAME` 必须与它逐字节一致** |
| `upperOrDown` | `"1"` / `"2"` → `DIRECTION` |
| `from` / `to` | 起讫站 |
| `beginTime` / `endTime` | 实测常为空 —— 首末班以 `103.firstLast` 为准 |
| `comments` | 备注，实测常空（票价在 `103.commonts`） |
| `company` | 运营公司，实测常空（`114.routeBean.company` 更可靠） |
| `routeNameUp` / `routeNameDown` | 变体方向展示名，实测常空 |
| `neartext` / `nexttext` / `nearnum` / `neardis` / `neartime` / `distance` | 附近/距离相关，无坐标时为空 |
| `stationName` / `stationID` / `commentStationName` / `stationOrder` | 站点相关上下文，目录查询下为空 |

实测 `KEY=北流` 命中 6 个方向：

```
玉林至北流城际公交线路 dir1/2     汽车总站 ⇄ 北流汽车总站
玉林旅游客运站至北流成南站公交线路 dir1/2   旅游汽车客运站 ⇄ 北流城南站
北流105路 dir1/2                北流城南站 ⇄ 玉林北站
```

要点：

- **一个 `lineName` 出现两次**（上行 + 下行），唯一键是 `(lineName, upperOrDown)`。
- 无匹配 → `{"buslines":[],"status":1,"msg":"success"}`，**空数组不是错误**。
- `busstations` 在 `119` 里实测恒为空。

### 5.2.1 目录里有真地铁线

`119` 不只收公交，真地铁线也在里面，`lineName` 形如 `地铁10号线` / `轨道交通1号线`
（重庆、南宁、东莞用「轨道交通」）/ `地铁广佛线`：

| 城市 | 目录里认得出的真地铁线 | 例 |
|---|---|---|
| 北京 | 21 | `地铁10号线`（46 站，04:37–22:31） |
| 上海 | 18 | `地铁1号线`（28 站，05:30–22:32） |
| 广州 | 17 | `地铁1号线`（16 站，06:00–22:55） |
| 成都 / 深圳 | 16 / 14 | `地铁18号线` |
| 重庆 | 12 | `轨道交通2号线`（25 站） |
| 南宁 | 5 | `轨道交通1号线`（25 站，06:30–23:00） |
| 佛山 / 东莞 | 1 / 2 | `地铁广佛线`、`轨道交通1号线` |

- `103` 对地铁照常返回站序、`firstLast`，**站名带「（地铁站）」后缀**，`routeId` 是占位值 `123456`。
- `104` 对地铁一律 `hasReal=0`、`list` 空（北京 `地铁1号线` 直接 HTTP 500）→ **只有站表和时间，没有车机位置**。
- `company` 有值（`广州地铁`、`轨道集团`），`114.routeBean.companyMobile` 也能给地铁热线（`广州地铁:020-96891`）。
- 名字里带「地铁」的**接驳线**（`地铁快巴2路`、`919地铁接驳专线`）是普通公交，`hasReal` 正常。
- 车来了没有真地铁：`bus/cityLineList` 全是公交，`line.isSubway` 字段恒为假值。

---

### 5.3 `CMD=102` / `CMD=114` — 线路搜索

请求：`CMD=102&CITYNAME=玉林市&CITYCODE=450900&KEYWORD=1`

两者响应形状一致，**`114` 多带 `routeBean`**：

| 键 | 说明 |
|---|---|
| `buslines[]` | 线路命中（实测 `KEYWORD=1` → 12 条） |
| `busstations[]` | 站点命中（实测 38 条），字段同 `110` |

`buslines[]` 记录键（实测 24 个）：
`beginTime cityName commentStationName comments distance endTime from lineName neardis nearnum neartext neartime nexttext number routeBean routeNameDown routeNameUp shortName stationID stationName stationOrder to upperOrDown`

`routeBean`（`114` 才有）关键字段：

| 字段 | 说明 |
|---|---|
| `id` | **线路数字 ID**，与 `103.routeId` 同一命名空间（`北流105路` 两处都是 `40105`）→ `207` / `116` 的入参 |
| `cityName` | 城市名 |
| `routeName` | 线路名 |
| `suTime` / `euTime` | 上行首末（`06:03` / `22:20`） |
| `sdTime` / `edTime` | 下行首末 |
| `comments` | 票价 + 首末班文案（结构化字段缺失时的兜底） |
| `company` | 运营公司简称（实测 `玉林公交`、`北流市公交`） |
| `hasReal` | 该线路是否有实时（`"1"` / `"0"`） |
| `loopType` / `routeLevel` / `runType` / `routeType` | 线路属性，本仓不用 |

**要线路 ID 就用 `114`。**

---

### 5.4 `CMD=103` — 站序 / 首末班 / 票价 / 轨迹点 ★

请求：

```
CMD=103&CITYNAME=玉林市&CITYCODE=450900&LINENAME=1路&DIRECTION=1
```

| 参数 | 必需 | 说明 |
|---|---|---|
| `CMD` | ✅ | `103` |
| `CITYNAME` | ✅ | 城市名 |
| `CITYCODE` | ➖ | 推荐带；`玉林市` 不带也通（实测） |
| `LINENAME` | ✅ | 与 `119` 的 `lineName` 逐字节一致 |
| `DIRECTION` | ✅ | `1` / `2` |
| `ROUTEID` | ❌ | **`103` 不认 `routeId`**，只给 `ROUTEID` → `-1 获取线路数据失败` |

响应顶层（实测 `1路` 方向 1）：

```json
{
  "routeName": "1路", "upperOrDown": "1",
  "beginTime": "06:03", "endTime": "22:20", "planTime": "", "routeColor": "",
  "commonts": "票价：2元/人次",
  "routeId": 1, "loopType": "1", "showDepart": 1, "routeName2": "",
  "telephoneTips": "咨询电话",
  "firstLast": [{"first": "06:30", "last": "20:25"}],
  "companys": [],
  "data": [{"stationId":0, "stationName":"玉林火车站",
            "station_lon":110.15834768, "station_lat":22.59757448,
            "stationOrder":1, "showName":"玉林火车站",
            "come":0, "arrive":0, "stationsStatus":1, "StationNihePointIndex":0}],
  "nihelist": [{"lat":"22.597572","lng":"110.158356"}],
  "StationRelatedRouteName": [],
  "status": 1, "msg": "获取数据成功！"
}
```

顶层字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `routeId` | number | **线路数字 ID** → `207` / `116` 的入参（`1路`=1、`G01路`=701、`北流105路`=40105） |
| `firstLast[].first/last` | string | **页面上显示的首末班用这个**（`06:30` / `20:25`） |
| `beginTime` / `endTime` | string | 另一套口径（`06:03` / `22:20`），**与 `firstLast` 不一致，别混用** |
| `commonts` | string | **拼写是两个 m**（不是 `comments`）。票价、备注都在这句里 |
| `showDepart` | number | `1` = 该线路有发车时刻表（可调 `207` / `116`） |
| `routeName` / `upperOrDown` | string | 回显线路名与方向 |
| `nihelist[]` | array | **拟合轨迹点**（字符串坐标），画线用；`StationNihePointIndex` 把站映射进这个数组 |
| `loopType` / `routeLevel` / `showDepart` / `planTime` / `routeColor` / `companys` / `routeName2` / `telephoneTips` / `StationRelatedRouteName` | — | 线路属性，本仓基本不用 |

`data[]` 每站：

| 字段 | 类型 | 说明 |
|---|---|---|
| `stationName` | string | 站名（跨方向匹配用真名，不要用 `showName`） |
| `showName` | string | 展示名，实测与 `stationName` 相同 |
| `station_lat` / `station_lon` | number | **真实坐标**（`115` 必须用这两个值） |
| `stationOrder` | number | **1 基站序**，数组已按它升序 |
| `stationsStatus` | number | 站点标记，见下表 |
| `StationNihePointIndex` | number | 该站在 `nihelist` 里的起始下标 |
| `come` / `arrive` | number | 到站/进站标记，静态查询下为 `0` |
| `stationId` | number | **实测恒为 0，不可用** |

#### 5.4.1 `stationsStatus` 对照表

上游没有 code→文案的接口，只有官方 H5 `js/mybus.js` 里那份 `switch`：

| 值 | 文案 |
|---|---|
| `1` | 正常（不渲染任何标） |
| `0` | **临时不停靠** |
| `2` | 只上不下 |
| `3` | 只下不上 |
| `4` | 临时停靠 |
| `5` | 响应式停靠 |
| `6` | 响铃式停靠 |
| `7` | 招手即停 |
| `8` | 大站车停靠 |
| 其它（实测有 `9`） | 官方也不渲染，**语义未知，不要猜** |

实测分布（2026-10-12，玉林市 50 个方向 2668 个站）：`{1: 2644, 9: 16, 0: 24, 5: 4}`。
`0`（临时不停靠）只有「玉林总站-福绵新滔工业园」（`routeId=151`）一条线有。

`104` 与 `110` 都**不带**这个字段 —— 只有 `103` 有。

---

### 5.5 `CMD=104` — 实时车辆 + 到站估计 ★

请求：

```
CMD=104&CITYNAME=玉林市&CITYCODE=450900&LINENAME=1路&DIRECTION=1&STATIONORDER=10
```

| 参数 | 必需 | 说明 |
|---|---|---|
| `LINENAME` | ✅ | **不存在 → HTTP 500**（`103` 是 `-1`，`104` 是 500，两者不一样） |
| `DIRECTION` | ✅ | `1` / `2`；缺 → `-1` |
| `STATIONORDER` | ➖ | **目标站序（1 基）**，只驱动 `routeOnStationRTimeInfoList`；不传则该数组为空 |

响应（样本取自 2026-10-12 08:0x 实测，字段结构于 2026-10-29 21:0x 复测一致；`1路` 方向 1，`STATIONORDER=10`）：

```json
{
  "hasReal": 1, "runState": 0, "exceptionFlag": false,
  "list": [{
    "stationName":"禾力塘", "statusType":"2", "index":3,
    "station_lat":22.61059046, "station_lng":110.15714862,
    "bus_lat":22.608687461668524, "bus_lng":110.15728181037417,
    "busNumber":"桂K08842D", "busToStationNiheDistance":219.83,
    "nihePointIndex":37, "angle":94.38, "_recTime":1791759539926,
    "crowdStatus":"", "busType":"", "runType":"", "sectionStation":"",
    "personNumOnBus":"", "busRaoXingTips":"", "abnormal":""
  }],
  "data": [{"stationName":"汽车总站（二医院）","index":13,"arrive":0,"come":1,"showType":1}],
  "dislist": [{"d":813.01}],
  "speedlist": [{"co":"red","speed":194.0}],
  "routeOnStationRTimeInfoList": [{
    "routeName":"1路", "upperOrDown":"1",
    "stationName":"东成派出所", "stationIndex":"9",
    "frmStationName":"玉林火车站", "toStationName":"汽车总站（二医院）",
    "busToStationCount":4, "busToStationTime":4.0, "busToStationDistance":1600,
    "busToStationTips":"4站", "busToStationTimeTips":"5分钟",
    "busToStationDistanceTips":"1.6公里", "busToStationName":"人民公园南",
    "busNumber":"桂K08842D",
    "stationLat":"22.6310337", "stationLng":"110.1607228"
  }],
  "plantimeSimpleVectorMain": [], "plantimeSimpleVectorSub": [],
  "status": 1, "msg": "获取实时数据成功!"
}
```

顶层：

| 字段 | 类型 | 说明 |
|---|---|---|
| `list[]` | array | **车辆数组**（这才是车） |
| `data[]` | array | 逐站到站向量 `{stationName,index,arrive,come,showType}`，**不是车辆** |
| `routeOnStationRTimeInfoList[]` | array | **到站估计**，一条 = 一辆正在接近目标站的车 |
| `hasReal` | number | `1` = 本方向有实时数据；`0` = 未开通 |
| `runState` | number | `1` = 该线路已停运 |
| `exceptionFlag` | bool | 异常标记（实测 `false`） |
| `dislist[]` | array | 站间距离 `{d}`（米） |
| `speedlist[]` | array | 速度色带 `{co,speed}`（`speed` 数值语义未确认，本仓不用） |
| `plantimeSimpleVectorMain/Sub` | array | 实测为空 |

`list[]` 车辆字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `busNumber` | string | **车牌**（`桂K08842D`）—— 与车来了的 `licence` 是两套标识空间 |
| `bus_lat` / `bus_lng` | number | 车辆坐标，**与 `station_lat/lon` 同基准**（可直接投影插值） |
| `index` | number | **0 基**，车辆正在接近的那一站 → 面板站序 = `index + 1` |
| `stationName` / `station_lat` / `station_lng` | — | 正在接近的那一站 |
| `statusType` | string | **`"0"` = 已到站**（官方包：到站车辆直接归属最近站）；其余为在途。其余取值语义未确认，别按含义写死 |
| `_recTime` | number | 上报时刻，**13 位毫秒** |
| `busToStationNiheDistance` | number | 到最近拟合点的距离（米）→ 配合 `nihePointIndex` 可把车画在轨迹线上 |
| `nihePointIndex` | number | 在 `103.nihelist` 里的下标 |
| `angle` | number | 车头方向角（度） |
| `crowdStatus` / `personNumOnBus` | string | 拥挤度 / 车上人数，实测**恒为空** |
| `busType` / `runType` / `sectionStation` / `busRaoXingTips` / `abnormal` | string | 实测恒为空，保留字段 |

`routeOnStationRTimeInfoList[]` 到站估计：

| 字段 | 类型 | 说明 |
|---|---|---|
| `stationName` | string | **目标站**（= 你传的 `STATIONORDER` 对应站） |
| `stationIndex` | **string** | 目标站序号，**0 基**（传 `10` → `"9"`） |
| `busNumber` | string | 给出该估计的车牌。**等待发车那种记录里没有此字段** |
| `busToStationCount` | number | 还差几站；**无车时 `-1`** |
| `busToStationTime` | number | **还差几分钟（浮点）**；无车时 `0.0` |
| `busToStationDistance` | number | 还差几米 |
| `busToStationTips` | string | `"4站"` / `"即将到站"` / **`"等待发车"`** |
| `busToStationTimeTips` | string | `"5分钟"` / `"小于1分钟"` / 空 |
| `busToStationDistanceTips` | string | `"1.6公里"` / `"230米"` |
| `busToStationName` | string | 参考站名（最近站） |
| `stationLat` / `stationLng` | **string** | 目标站坐标 |
| `frmStationName` / `toStationName` | string | 本方向起讫站 |
| `planTime` / `routeNameUp` / `routeNameDown` | string | 实测为空 |

行为要点：

- **一条记录 = 一辆在接近目标站的车**；目标站是终点时可能多条（实测 `STATIONORDER=14` 得 2 条：
  一辆「还有 1 站」、一辆「还有 8 站」）。
- **`busToStationCount = -1` + `busToStationTips = "等待发车"`** = 当前没有车在接近
  （首班未发或已收班）。**这不是接口错误**，别当失败处理。
- `STATIONORDER` 超出站数（`1路` 14 站传 `99`）→ 该数组为空，其余照常。
- `STATIONORDER` 对 `list` / `data` / `dislist` / `speedlist` **无影响**（实测传 `None`/`1`/`10`/`14`
  四次调用这几个数组完全一致）。**它只影响 `routeOnStationRTimeInfoList`。**
- **每站最多给最近 2 辆车的预测** —— 第三个以后的车没有 ETA，透 0 让前端显示「无预测」，
  不要猜成「即将到站」。
- **空 `list` 有三种正常情况**，都不是解析问题：停运（`runState=1`）、未开通实时（`hasReal=0`）、
  收班或大间隔线路的空窗期（`hasReal=1` 但此刻没车）。

**端到端实测样本**（`陆川1路` `routeId=1011`，2026-10-12 08:06–08:07 CST）：

| 方向 | `STATIONORDER` | 结果 |
|---|---|---|
| 1 | 不传 | `routeOnStationRTimeInfoList` 为空 |
| 1 | `1`（始发站） | `等待发车`，`busToStationCount=-1` |
| 1 | `5`（`火车站（陆川）`） | **2 站 / 2 分钟**，`桂K12620D` |
| 1 | `19`（`沙湖镇政府`） | **16 站 / 29 分钟 / 11.8 公里**，`桂K12620D` |
| 2 | `5`（`岭南医院`） | 2 站 / 10 分钟，`桂K03281D` |
| 2 | `19`（`县瓷厂`） | 16 站 / 32 分钟，`桂K03281D` |
| 任一 | `99`（越界） | 空数组 |

⚠️ **始发站（`STATIONORDER=1`）恒返回 `-1 / 等待发车`，即使同方向已有车在路上**
（实测 08:06 时 `桂K12620D` 已经过第 5 站，始发站仍是 `等待发车`）。渲染始发站时别当异常。

---

### 5.6 `CMD=106` — 周边站点

请求：`CMD=106&CITYNAME=玉林市&CITYCODE=450900&LAT=22.6293&LNG=110.1512`

响应（实测 16 条，已按距离升序）：

```json
{"data":[{"name":"宁屋角","lat":"22.6290880025","lon":"110.1498110918",
          "dis":144,"sameNum":0}], "status":1, "msg":"success"}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 站名（**是 `name`，不是 `stationName`**） |
| `lat` / `lon` | **string** | 坐标；注意是 `lon` 不是 `lng` |
| `dis` | number | 距中心点米数 |
| `sameNum` | number | 同名站数量 |

返回的 `name` 可以直接喂 `115`（但坐标要用 `103` 的，见 §5.8）。

---

### 5.7 `CMD=110` — 站点搜索

请求：`CMD=110&CITYNAME=玉林市&CITYCODE=450900&KEYWORD=火车站`

响应（实测 4 条）：

```json
{"busstations":[{"stationId":0,"stationName":"玉林火车站",
                 "station_lon":0.0,"station_lat":0.0,
                 "stationOrder":0,"sameNameNum":0}],
 "status":1,"msg":"success"}
```

| 字段 | 说明 |
|---|---|
| 键名 | **`busstations`，不是 `data`** |
| `stationName` | 站名 |
| `station_lon` / `station_lat` | **恒为 `0.0`** —— 搜索索引不带坐标 |
| `stationId` | **恒为 `0`**，不可用 |
| `sameNameNum` | 同名站数量 |

**`110` 只给名字。** 要坐标得走 `103`（或 `106`，但 `106` 的坐标喂 `115` 会静默失败）。

---

### 5.8 `CMD=115` — 站点经停线路

请求：

```
CMD=115&CITYNAME=玉林市&CITYCODE=450900&STATIONNAME=玉林火车站
       &MYLAT=22.59757448&MYLNG=110.15834768&ALL=1
```

| 参数 | 必需 | 说明 |
|---|---|---|
| `STATIONNAME` | ✅ | 站名 |
| `MYLAT` / `MYLNG` | ✅ | **必须是该站真实坐标**（取自 `103` 的 `station_lat/station_lon`） |
| `ALL` | ➖ | `"1"` 两个方向都返，`"0"` 只返同向 |

响应：

```json
{"data":[{"lineName":"1路","upperOrDown":"2","from":"","to":"玉林火车站",
          "number":"","cityName":""}],
 "type":0, "status":1, "msg":"获取经过该站点的线路列表成功"}
```

| 字段 | 说明 |
|---|---|
| `lineName` / `upperOrDown` | 线路名 + 在该站的方向 → 直接喂 `104` / `103` |
| `stationOrder` | 该站在本方向上的站序（部分记录带） |
| `routeBean` | 部分记录带（含 `id`） |
| `type` | 实测恒 `0`，语义未确认 |

⚠️ **坐标传错会静默返回空**（`status=1` + `data: []`），实测对照：

| 站名 | 坐标 | `ALL=1` | `ALL=0` |
|---|---|---|---|
| `玉林火车站` | `22.59757448, 110.15834768`（取自 `103`） | 9 条 | 4 条 |
| `玉林火车站` | `22.6036, 110.1578`（估算值） | **0 条** | **0 条** |
| `金城商厦（市中医院）` | 取自 `103` | 7 条 | 4 条 |
| `金城商厦（市中医院）` | `22.6293, 110.1482`（估算值） | **0 条** | **0 条** |

本文档写作时（21:0x）用估算坐标实测确实拿到 `data: []` + `status=1` —— 这个坑现在还在。
**必须先用 `103` 取真实坐标，不要用 `106` 的坐标或估算值。**

---

### 5.9 `CMD=207` — 发车时刻表（分组 + 每班状态）

请求：`CMD=207&CITYNAME=玉林市&CITYCODE=450900&ROUTEID=1&DIRECTION=1`

| 参数 | 必需 | 说明 |
|---|---|---|
| `ROUTEID` | ✅ | 取自 `103.routeId`（或 `114.routeBean.id`），**不是线路名** |
| `DIRECTION` | ✅ | 一个 `routeId` 覆盖两个方向，必须配方向才唯一 |
| `CITYCODE` | ➖ | 有效；`CITYNAME` 单给可能 `-2` |
| `CITYKEY` | ❌ | 可以完全省略，实测不影响 |

响应：

```json
{"list":[{"group":"06:32~10:00",
          "times":[{"time":"06:32","status":1,"notes":"","isDelete":0,"noteText":""},
                   {"time":"08:30","status":2,"notes":"","isDelete":0,"noteText":""},
                   {"time":"08:50","status":3,"notes":"","isDelete":0,"noteText":""}]}],
 "special":"0", "nextTime":"", "status":1}
```

| 字段 | 说明 |
|---|---|
| `list[].group` | 时间段标题，可直接显示。**分组数不固定**（实测有 3 组也有 4 组） |
| `list[].times[].time` | 发车时刻 `HH:MM`，组内升序 |
| `list[].times[].status` | **`1` 已发车 / `2` 下一班 / `3` 未发车** |
| `list[].times[].notes` / `noteText` | 备注（实测空） |
| `list[].times[].isDelete` | `0` = 有效 |
| `special` | 实测 `"0"`，语义未确认 |
| `nextTime` | 实测 `""`；下一班时刻以 `status=2` 为准 |

`status` 语义的两条独立证据：

1. 本地 08:07 时，`陆川1路` 组 1 为 `…08:00=1, 08:30=2, 08:50=3…`；`1路` 为 `…07:56=1, 08:08=2, 08:11=3…`
   —— 两条线的 `2` 都是 now 之后的第一个时刻；
2. `116` 用 `●` 标下一班时，`●` 恰好落在 `status=2` 那一班上。
   （本文档写作时 21:0x 复测 `1路`：59 班全部 `status=1`，符合「全已发车」。）

要点：

- **失败是静默的**：`ROUTEID=999999` 与 `DIRECTION=9` 都返回 `{"list":[],"status":1}`。
  `207` 的非法 `DIRECTION` **不会**像 `103`/`104` 那样给 HTTP 500 —— 只能看空 `list`。
- ⚠️ **时刻表可能不是全天完整班表**：`陆川1路` 的 `103.firstLast` 写 `06:00/21:00`，
  但 `207` 只排到 `17:30`。**不要用 `207` 的末组当收班时间**，两个口径不同。
- ⚠️ **整分钟边界上 `207` 与 `116` 可能差一班**：`容县11路` 两次调用相隔约 1 秒，
  `207` 说下一班是 `08:14`，`116` 已把 `08:14` 划走、`●` 落到 `08:26`（当时正处在 08:14 这一分钟）。
  这不是数据不一致，是采样跨过了发车点。**要显示「下一班」就只取一条命令的结果，不要交叉断言。**

---

### 5.10 `CMD=116` — 发车时刻（简版，带标记）

请求：同 `207`（`ROUTEID` + `DIRECTION` + 城市）。

响应：

```json
{"list":[{"group":"06:37~10:00",
          "times":["06:37","07:10","07:26","08:00","08:30●","08:50"],
          "isNow":1}],
 "special":"0", "status":1}
```

| 字段 | 说明 |
|---|---|
| `times[]` | **字符串数组**。`●` 后缀标记「下一班」 |
| `isNow` | `1` = 当前所处时段（08:07 → 组 1） |

> ⚠️ **`●` 不是「已发车」标记。** 实测 08:07 时 `08:30` 带 `●`（未来 23 分钟）、
> `1路` 同一时刻 `08:08` 带 `●`（未来 1 分钟）。按「已发车」渲染会把还没走的班画成已走。

- 注意 `116` 的响应**没有 `msg` 字段**（只有 `list` / `special` / `status`）。
- 想要「还有几分钟」不要用 `116` 自己算：用 `207` 的 `status=2` 定位下一班，
  再用 `104` 的 `routeOnStationRTimeInfoList` 的分钟数交叉。

---

### 5.11 `CMD=205` / `CITYKEY` — 已作废的一条老路

请求：`CMD=205&CITYKEY=玉林`

实测 `CITYKEY=玉林` → `{"status":0,"msg":...}`，`city` 为空。**这条路子已经不好走**：
`CITYCODE` 直接可用，`205` 没有存在价值，本仓未使用。

**两条已经失效的历史结论（不要再照着做）**：

1. **「`CITYKEY` 必填，是接入的唯一阻塞」—— 作废。**
   现在的门槛是请求头 `Origin`，不是 `CITYKEY`。用 `CITYCODE` 完全绕开了它。
2. **「某个 `CITYKEY` 表可以复用」—— 作废，且会长久腐烂。**
   实测：旧的第三方表里的 `nn771801`（南宁）与掌上公交自家 bundle 里的 `nanning920901`
   **都已失效**，而 `CITYCODE=450100` 正常工作。猜格式同样无效：
   `yl775801`、`yl450900`、`bl775801`、`rx775801` 全部被拒。
   **`CITYKEY` 会轮换 → 任何硬编码 key 的表都是定时炸弹。**

---

## 6. 错误形态与静默失败

| 现象 | 原因 | 处理 |
|---|---|---|
| 47 字节非 JSON 串 | 缺 `Origin` 头 | 加上；这是唯一「一眼可见」的错 |
| HTTP 500 + 空 body | `104` 的 `LINENAME` 不存在 | 用 `119` 的 `lineName` 原值，别自己拼 |
| `status="-1"` + `暂无数据信息！` | `103` 的线路名不存在 | 同上 |
| `status="-1"` + `获取线路数据失败！` | 缺 `DIRECTION` | 补 |
| `status="-2"` | 城市码不支持 | 换 `CITYCODE`（见 §4） |
| `status=1` + `list:[]` | 停运 / 未开通 / 收班 / 空窗期 / `STATIONORDER` 越界 | 看 `runState` 与 `hasReal` 再判断，别一律当「没车」 |
| `status=1` + `data:[]`（`115`） | 坐标不是该站真值 | 用 `103` 的坐标 |
| `status=1` + `list:[]`（`207`） | `ROUTEID` / `DIRECTION` 非法 | 只能靠空数组判断 |
| `busToStationCount=-1` | 没有车在接近目标站 | `busToStationTips` 会是「等待发车」 |

**记住这一条**：掌上公交的失败大多是「HTTP 200 + `status=1` + 空数组」，
所以**「没数据」和「参数错了」长得一样**。参数校验要自己做。

---

## 7. 字段陷阱汇总

### 7.1 恒为空 / 恒为 0 的字段（不要用）

| 字段 | 出现位置 | 实测值 |
|---|---|---|
| `stationId` | `103.data[]` / `110.busstations[]` | 恒 `0` |
| `station_lat` / `station_lon` | `110.busstations[]` | 恒 `0.0` |
| `busstations` | `119` 顶层 | 恒 `[]` |
| `crowdStatus`、`personNumOnBus`、`busType`、`runType`、`sectionStation`、`busRaoXingTips`、`abnormal` | `104.list[]` | 恒空串 |
| `company` | `119.buslines[]` | 常为空（用 `114.routeBean.company` 代替） |
| `routeNameUp` / `routeNameDown` / `stationName` / `stationID` / `stationOrder` | `119.buslines[]` | 为空（线路级信息走 `103`） |
| `planTime` | `103` / `104` | 为空 |
| `beginTime` / `endTime` | `119.buslines[]` | 常为空（首末班走 `103.firstLast`） |
| `plantimeSimpleVectorMain/Sub` | `104` | 恒 `[]` |

`117` 依赖 `STATIONID`，而所有路径拿到的 `stationId` 都是 `0` → **`117` 在当前数据面下不可用**。

### 7.2 其余陷阱

| 坑 | 说明 |
|---|---|
| `commonts` | 拼写就是两个 `m`；票价只藏在这句文案里，正则 `票价[:：]\s*([^\s，,]+)` 抠 |
| `stationId` | `103` / `110` 里恒为 `0`，不可当主键；站标识用 `(lineName, direction, stationOrder)` 或站名+坐标 |
| 站序基数 | `103.stationOrder` 1 基；`104.list[].index` **0 基**；`104...stationIndex` 是**字符串**且 0 基 |
| 坐标类型 | `103`/`104` 是 number，`106`/`115`/`207…` 里坐标常是 **string** |
| `lat` vs `lon` vs `lng` | `106` 用 `lat`/`lon`；`104` 用 `station_lat`/`station_lng`；`115` 入参是 `MYLAT`/`MYLNG` |
| `beginTime/endTime` vs `firstLast` | 两套口径，显示用 `firstLast` |
| `busNumber` | 是**车牌**，不是自编号；要用自编号得查 `plate_map.json` |
| `runState`/`hasReal` | `runState=1` 停运；`hasReal=0` 未开通实时。两者都不是错误 |
| `data[]`（`104`） | 是逐站到站向量，**不是车辆列表** |
| `110` 的 `busstations` | 键名不是 `data` |
| `116` 无 `msg` | 只有 `list`/`special`/`status` |

---

## 8. 缓存与轮询（本仓做法）

| 数据 | 键 | TTL | 说明 |
|---|---|---|---|
| `103` 原始响应 | `routes[lineId]` | 1h | 站表/首末站/票价/`routeId` 都在这一份里 |
| 目录（含车辆数） | `lines` | 1m | 失败沿用上一次，避免抖动导致线路从列表里消失 |

- `103` 与 `104` 的 HTTP 超时分别按 10s；响应体按 `1MB` 截断读。
- `hasReal=0` 或 `runState=1` 时 `list` 必然为空 —— 前端要显示原因，不能显示「0 辆在途」当正常。

---

## 9. 复现命令

```sh
H=(-H 'Origin: https://h5.mygolbs.com'
   -H 'Referer: https://h5.mygolbs.com/'
   -H 'Content-Type: application/x-www-form-urlencoded')

# 城市列表
curl -s -X POST 'https://h5.mygolbs.com/ApiData.do' "${H[@]}" --data 'CMD=101' | head -c 200

# 玉林线路目录（50 条 = 25 线 × 2 向）
curl -s -X POST 'https://h5.mygolbs.com/ApiData.do' "${H[@]}" \
  --data 'CMD=119&CITYNAME=玉林市&CITYCODE=450900' | head -c 400

# 线路搜索（带 routeBean）
curl -s -X POST 'https://h5.mygolbs.com/ApiData.do' "${H[@]}" \
  --data 'CMD=114&CITYNAME=玉林市&CITYCODE=450900&KEYWORD=1' | head -c 400

# 站序（14 站）
curl -s -X POST 'https://h5.mygolbs.com/ApiData.do' "${H[@]}" \
  --data 'CMD=103&CITYNAME=玉林市&CITYCODE=450900&LINENAME=1路&DIRECTION=1' | head -c 400

# 实时 + 到第 10 站的估计
curl -s -X POST 'https://h5.mygolbs.com/ApiData.do' "${H[@]}" \
  --data 'CMD=104&CITYNAME=玉林市&CITYCODE=450900&LINENAME=1路&DIRECTION=1&STATIONORDER=10' | head -c 600

# 周边站点
curl -s -X POST 'https://h5.mygolbs.com/ApiData.do' "${H[@]}" \
  --data 'CMD=106&CITYNAME=玉林市&CITYCODE=450900&LAT=22.6293&LNG=110.1512'

# 站点搜索 / 经停线路
curl -s -X POST 'https://h5.mygolbs.com/ApiData.do' "${H[@]}" \
  --data 'CMD=110&CITYNAME=玉林市&CITYCODE=450900&KEYWORD=火车站'

curl -s -X POST 'https://h5.mygolbs.com/ApiData.do' "${H[@]}" \
  --data 'CMD=115&CITYNAME=玉林市&CITYCODE=450900&STATIONNAME=玉林火车站&MYLAT=22.59757448&MYLNG=110.15834768&ALL=1'

# 发车时刻表 / 简版
curl -s -X POST 'https://h5.mygolbs.com/ApiData.do' "${H[@]}" \
  --data 'CMD=207&CITYNAME=玉林市&CITYCODE=450900&ROUTEID=1&DIRECTION=1'

curl -s -X POST 'https://h5.mygolbs.com/ApiData.do' "${H[@]}" \
  --data 'CMD=116&CITYNAME=玉林市&CITYCODE=450900&ROUTEID=1&DIRECTION=1'

# 反例：缺 Origin（应得到那 47 字节网关串）
curl -s -X POST 'https://h5.mygolbs.com/ApiData.do' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'CMD=103&CITYNAME=玉林市&CITYCODE=450900&LINENAME=1路&DIRECTION=1'
```

---

## 10. 代码映射

| 本文档章节 | 代码 |
|---|---|
| `103` | `internal/mygolbs/mygolbs.go` `routeData()` + `wireRoute` |
| `104` | `mygolbs.go` `Realtime()` + `wireRealtime/wireBus/wireETA` |
| 目录拼装（`103` + `104`） | `mygolbs.go` `buildLines()` / `Lines()` |
| 状态映射 | `mygolbs.go` `lineState()`（`runState=1`→`-2`，`hasReal=0`→`1`+desc） |
| 票价 | `mygolbs.go` `priceOf()`（正则抠 `commonts`） |
| 站点标记 | `mygolbs.go` `stationStatus` / `statusLabel()` |
| 车标插值 | `mygolbs.go` `segPos()`（与 `internal/upstream` 那份同算法，两份实现） |
| 线路清单（要加线改这里） | `mygolbs.go` `catalog`（`spec` 结构，`lineId = "mg" + routeId + "-" + 方向`） |
| 面板分派 | `internal/server/server.go`（`mygolbs.Handles(id)`） |

---

## 11. 落地记录：本仓为什么没照「最小接口面」做

接到本仓时（2026-10-12）跟上面的通用建议有几处**没照做**，都是实施后实测改的，
记在这里免得后人以为漏了：

- **没用 `CMD=119` 当目录。** 只接几条线时按名字寻址更省事也更稳：线路表写在 Go 里
  （`catalog`：`CITYCODE` + `CITYNAME` + 线路名 + 方向），站表/首末班/票价一律从 `103` 现取并缓存 1 小时。
  要接的线路多起来再换回 `119` 拉目录。
- **寻址方式按命令分**：`103`/`104` 只认 `LINENAME`（给 `ROUTEID` → `-1`），`207`/`116` 只认 `ROUTEID`。
  `CITYNAME` 哪个命令都不能省（缺了给 `ROUTEID` 会 HTTP 500）。
- **`陆川1路` 挂 `450900`**：陆川没有自己的城市码，所以 `catalog` 里城市码写 `450900`、
  城市名写 `玉林市`，线路名仍按目录原样（`陆川1路`）。
- **`nihelist` 没用上。** 面板的走向条只按「站序 + 站间比例」画，不需要折线，
  `103` 里那 300~400 个点白拿不用。
- **每站最多 2 条预测**：按「有预测就透出、没有就给 0」处理，界面显示「无预测」，
  **不要**用 `busToStationCount > 0` 反推一个分钟数 —— 那是编的。
- **`busNumber` 是车牌**，所以跟车来了那面一样过一遍 `plate_map.json` 归一成自编号
  （表里没有的原样透出车牌，`confidence` 仍 `high` —— 车牌本身就是稳定标识）。
- **显示名用简称**：上游那几个长名字在列表那一格放不下，面板显示 `玉北1` / `玉北2` / `玉樟`；
  `LINENAME` 请求参数仍是上游原名，两者别混。
- **`玉樟`（routeId 151）班次间隔大，空窗期 0 辆**：实测 16:41 一班、17:27 下一班（46 分钟），
  中间那段 `104` 回 `hasReal=1`、`status=1`、msg「获取实时数据成功！」而 `list` 为空；
  17:10–17:15 稳定 1 辆。**空窗里的 0 辆别当成解析 bug。**
- **站点标记（`stationsStatus`）已上屏**：`1` 与表里没有的 `9` 留空，其余翻成文案落到
  `upstream.Stop.Status`；面板走向条把带标的站画成空心方块，站点卡另起一行写出来。
- 抓包存在 `internal/mygolbs/testdata/`（2026-10-12 08:30 CST），单测按它断字段映射。

---

## 12. 风险与合规

| 风险 | 等级 | 说明与对策 |
|---|---|---|
| **未授权使用** | 高 | 私有客户端接口，无公开文档与授权。**对外发布/商用前必须取得运营方（掌上公交 / 玉林市公共汽车公司）授权**。个人出行辅助查询是当前的默认定位 |
| 接口随时变更 | 中 | 无版本承诺。对策：不要硬编码 `CITYKEY`；对 `status` 新增值做宽容处理 |
| 静默失败 | 中 | `115` 坐标不符、`117` 无 ID 都返回「成功 + 空数据」。对策：把 §6 / §7 的判据写成断言或日志 |
| 上游限流 / 封 IP | 中 | 服务端未声明限流。对策：保持 ≥2s 间隔，不并发，做本地缓存 |
| 数据准确性 | 中 | 车载设备老化（玉林调度一体机约 2018 年装），`_recTime` 会比请求时刻晚 1–2 分钟。**不要把 ETA 当准点表** |
| 双源不一致 | 低 | 两套数据面上游厂商不同，站序/首末班可能不一致。对策：不 merge，做展示侧对照 |

---

## 附录 A：玉林市 `450900` 目录（实测 2026-10-29 21:0x）

`CMD=119` 返回 **50 条 = 25 条线 × 2 方向**，方向值只有 `"1"` / `"2"`。
`KEY=北流` 命中 6 个方向（3 条跨县线）。

本仓实际接的 10 个方向（`catalog`）：

| 面板 `lineId` | `LINENAME` | `CITYCODE` | 方向 | 面板名 |
|---|---|---|---|---|
| `mg40105-1/2` | `北流105路` | `450981` | 1/2 | 北流105路 |
| `mg1011-1/2` | `陆川1路` | `450900` | 1/2 | 陆川1路 |
| `mg131-1/2` | `玉林至北流城际公交线路` | `450900` | 1/2 | 玉北1 |
| `mg141-1/2` | `玉林旅游客运站至北流成南站公交线路` | `450900` | 1/2 | 玉北2 |
| `mg151-1/2` | `玉林总站-福绵新滔工业园` | `450900` | 1/2 | 玉樟 |

## 附录 B：与车来了的口径差异（速查）

| 维度 | 掌上公交 | 车来了 |
|---|---|---|
| 鉴权 | 无 | MD5 签名 + AES 出参（签名当前未校验） |
| 响应 | 裸 JSON | `**YGKJ{...}YGKJ##` |
| 车辆标识 | `busNumber`：恒为车牌 | `licence`：自编号或车牌 |
| 站序 | `stationOrder` 1 基 / `index` 0 基 | 全部 1 基 |
| 坐标 | 一套，站车同基准 | 站两套（bd+wgs），车 WGS |
| ETA | 分钟（浮点），每站最多 2 辆 | 秒 + 文案，每车一条 |
| 折线 | `nihelist`（拟合点，无 `stopOrder` 标记） | `route[]`（带 `stopOrder`，可按站切段） |
| 失败形态 | 空数组（静默） | 缺 `src` 静默假数据 / 缺 `s` 空 body |

详细版见 `docs/车来了API.md`。

## 附录 C：旁证材料去哪找

本文档所有「实测」结论都来自直接打上游，不是抄的。以下是**可复现**的东西：

| 项 | 位置 |
|---|---|
| H5 调用点全集（命令 / 参数 / 数据键） | 官方 bundle `js/mygolbs-mybus.js`，**本地副本，未入库**（`.gitignore` 里 `js/`） |
| H5 加密文件（**当前未使用**） | `js/mygolbs-encrypt-decrypt.js`（DES `strEnc`/`strDec`，`ApiData.do` 未调用它） |
| 抓包固件 | `internal/mygolbs/testdata/*.json`（**已入库**，单测按它断映射） |
| 车来了侧对照 | `docs/车来了API.md`、`scripts/chelaile.py` |

`js/` 与 `ref/` 都在 `.gitignore` 里 —— 别人 clone 下来没有这两个目录，
所以本文档**不依赖**它们：需要 bundle 时自己去 `h5.mygolbs.com` 取一份。
