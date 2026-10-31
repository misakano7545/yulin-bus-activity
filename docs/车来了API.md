# 车来了（Chelaile）H5 接口文档

| 项目 | 内容 |
|---|---|
| 数据面 | 车来了 H5：`https://web.chelaile.net.cn/api/` |
| 服务方 | 车来了（`chelaile.net.cn`），玉林城市码 `cityId=440` |
| 鉴权 | 无 token / cookie；实时接口有 MD5 入参签名 + AES 出参加密 |
| 实测 | 2026-10-29 20:35–21:05 CST（末班车后，仍在跑的 1/11 路可对照） |
| 代码 | `internal/upstream/{client,wire,model}.go`（实现即本文档的权威） |
| 采集器 | `scripts/chelaile.py`（Python 版同源实现，带 selftest） |

本文档只讲车来了这一侧。掌上公交那侧见 `docs/掌上公交API.md`。

---

## 1. 全貌

| 项 | 值 |
|---|---|
| Base URL | `https://web.chelaile.net.cn/api/` |
| 方法 | 全部 `GET`，参数走 query string |
| 请求头 `User-Agent` | `Mozilla/5.0 (Linux; Android 13) Mobile MicroMessenger/8.0`（任意手机微信 UA 均可） |
| 请求头 `Referer` | `https://web.chelaile.net.cn/customer_ch5/` |
| 响应包裹 | `**YGKJ{...}YGKJ##` |
| 玉林规模 | 23 条线 × 2 方向 = **46 条目录记录**（实测 2026-10-29） |

本仓只用到 4 个端点：

| 端点 | 用途 | 加密封装 |
|---|---|---|
| `bus/cityLineList` | 线路目录 | 明文 |
| `bus/line!lineRoute.action` | 走向折线 + 站表 | 明文 |
| `bus/line!busList.action` | 在途车辆（轻量，无站表） | AES 出参 |
| `bus/line!encryptedLineDetail.action` | 站表 + 在途车辆 + 到站估计 | AES 出参 |

---

## 2. 通用约定

### 2.1 公共参数（每个请求都带）

| 参数 | 值 | 缺了会怎样 |
|---|---|---|
| `s` | `h5` | **返回空 body（HTTP 200、长度 0）**，不是报错。这是最常见的「接口挂了」错觉 |
| `v` | `9.1.2` | 客户端版本 |
| `vc` | `1` | 版本码 |
| `sign` | `1` | 静态占位，**不是签名**（真签名是 `cryptoSign`） |
| `userId` | 空 | 不带登录态 |
| `h5Id` | 空 | 同上 |
| `cityId` | `440` | 玉林 |
| `src` | `wechat_yulingongjiao` | 实时接口**缺了会静默返假数据**，见 §2.3 |

非玉林城市把 `cityId` 换掉即可（`cityLineList` 的城市码就是车来了自己的编号，不是行政区划码）。

### 2.2 响应包裹与剥壳

整段 body 外面裹着垃圾字符：

```
**YGKJ{"jsonr":{"status":"00","errmsg":"","data":{...}}}YGKJ##
```

剥壳规则（三条缺一不可）：

1. 取第一个 `**YGKJ` 之后、**最后一个** `YGKJ##` 之前的内容；
2. `json.loads` 得到 `{jsonr: {status, errmsg, data}}`；
3. `status == "00"` 才成功，`data` 是业务负载；否则按 `errmsg` 报错。

`status` 是**字符串**。实测非零取值：

| status | errmsg | 场景 |
|---|---|---|
| `10004` | 线路已变更，重新搜索试试吧 | `lineId` 不存在 / 已下线 |
| `12009` | 该接口已不提供服务 | 打到了废弃端点（如 `bus/line!lineDetail.action`） |

HTTP 状态码本身几乎恒为 200，业务失败只能靠 `jsonr.status` 判。

### 2.3 `src` —— 最阴的一个坑

`src` 决定实时接口能不能拿到真数据。同一时刻、同一条线、只改这一个参数的 A/B（实测 2026-10-29 20:5x）：

| 线路 | 带 `src` | 缺 `src` |
|---|---|---|
| `1` 方向 2 | `state=0`，buses=2 | `state=-1`，buses=0 |
| `11` 方向 1 | `state=0`，buses=1 | `state=-3`，buses=0 |
| `11` 方向 2 | `state=0`，buses=3 | `state=-1`，buses=0 |

结论：**缺 `src` 时 `buses` 恒空，`state` 退化成按时刻表硬推**（可能是 `-1` 也可能是 `-3`），
看起来像「今天全线停运」，实际上只是少了个参数。**它不报错、不告警、HTTP 200。**

---

## 3. `cryptoSign` 入参签名

算法（H5 里 `cryptoSign` 的实现）：

```
payload = {"lineId":"775200849296"}          # 只放业务参数
text    = json.dumps(payload) 去掉最外层 {}    # → "lineId":"775200849296"
text    = text 里 ':' → '='  ',' → '&'        # → lineId=775200849296
sign    = md5(text + "qwihrnbtmj")            # 小写 hex
```

- 盐：`qwihrnbtmj`（固定字符串）
- 多参数也照此拼：`{"lineId":X,"targetOrder":10}` → `lineId=X&targetOrder=10`

**实测向量**（必须一致，否则说明你的 JSON 序列化带了空格或者键序不同）：

```
cryptoSign({"lineId":"775200849296"}) == 3f2031d13050245b1d39d5e90a824eca
```

⚠️ **注意实测事实**：本仓测试时把 `cryptoSign` 换成 32 个 `0` 仍然成功返回，
`bus/line!busList.action` 甚至完全不带 `cryptoSign` 也能用。
**上游目前没校验这个签名。** 但算法照算 —— 它随时可能变成硬校验，且算错的成本只是一次 md5。

---

## 4. 出参加密（AES-256-ECB）

加密端点（`busList` / `encryptedLineDetail`）的 `data` 里只有一个字段：

```json
{ "encryptResult": "ZB9eiIh9ayNTLYE4mAQ23cDF9Rf..." }
```

解密步骤：

1. `base64` 解码；
2. **AES-256-ECB**，密钥 `422556651C7F7B2B5C266EED06068230`（32 字节 ASCII，即 AES-256）；
3. 无 IV，逐块解密；
4. 取 PKCS7 填充：末字节 `n` 即填充长度，`out[:len-n]`；
5. 剩下的是 UTF-8 JSON。

校验点：密文长度必须是 16 的整数倍，`n ∈ (0,16]`，否则直接判错 —— 不要静默吞掉。

---

## 5. 端点详规

### 5.1 `bus/cityLineList` — 线路目录（明文）

```
GET /api/bus/cityLineList?s=h5&v=9.1.2&vc=1&sign=1&userId=&h5Id=&cityId=440&src=wechat_yulingongjiao
```

响应 `data.allLines.all[]`，实测 46 条（23 线 × 2 方向）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `lineId` | string | **不透明 ID，一个方向一个**。面板主键，也是后面所有接口的入参 |
| `lineName` | string | 线路名（`1`、`11`、`13（临时停运）`、`G02路定制`） |
| `startStopName` | string | 首站 |
| `endStopName` | string | 末站 |
| `firstTime` / `lastTime` | string | 首末班 `HH:MM`（实测 `1` 路 `06:30` / `20:25`） |
| `tagName` / `type` | string / number | 分组标签，本仓不用 |

实测样本：

```json
{"endStopName":"汽车总站（二医院）","firstTime":"06:30","lastTime":"20:25",
 "lineId":"775200849296","lineName":"1","startStopName":"玉林火车站",
 "tagName":"all","type":0}
```

要点：

- **目录里没有运营状态、没有车辆数**，那两个只能从实时接口拿（做法见 §8）。
- 停运线路的「停运」有时直接写在 `lineName` 里（`13（临时停运）`），不能当正常名字用。
- 记录只有 8 个键，没有坐标、没有站表。

### 5.2 `bus/line!lineRoute.action` — 走向折线 + 站表（明文）

```
GET /api/bus/line!lineRoute.action?...公共参数...&lineId=775200849296
```

响应顶层 4 个键：`route`、`line`、`stations`、`gpstype`。

| 键 | 说明 |
|---|---|
| `route[]` | 折线点 `{lng, lat, distance, stopOrder}`；`stopOrder > 0` 表示「这个点就是第 N 站」，其余为 `0` |
| `stations[]` | 站表，见下 |
| `line` | **只有 `{lineId, name}`**，票价/状态/描述都不在这里 |
| `gpstype` | 实测恒为 `"bd"`；**传 `gpstype=wgs` 不生效，返回仍为 bd** |

`stations[]` 字段（实测 2026-10-29，1 路方向 1，`lineId=775200849296`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `sId` | string | 站 ID（`440-185`），跨方向稳定 |
| `sn` | string | 站名 |
| `order` | number | **1 基站序**，与 `buses[].order` 同口径 |
| `lat` / `lng` | number | 坐标，**bd（百度）基准** |
| `gpsType` | string | 恒 `"bd"` |
| `distanceToSp` | number | 距上一站距离（米） |

⚠️ **这个接口的 station 只有 `lat/lng`，没有 `wgsLat/wgsLng`。**
`wgsLat/wgsLng` 只在 `encryptedLineDetail` 的 `stations[]` 里出现（见 §5.4）。本仓的 `wireStop`
结构两边共用，所以明文路径下这两个字段是 0 —— 拿它插值会把车钉到几内亚湾。

实测规模：1 路方向 1（`lineId=775200849296`）共 170 个折线点，其中 13 个带 `stopOrder`
（14 站里有 13 站落在折线点上）。

```json
{"distance":0.0,"lng":110.243623,"stopOrder":1,"lat":22.724425}
```

### 5.3 `bus/line!busList.action` — 在途车辆（轻量，加密）

```
GET /api/bus/line!busList.action?...公共参数...&lineId=775200849278
```

参数只要 `lineId`（`cryptoSign` 可省）。解密后 3 个键：

| 键 | 说明 |
|---|---|
| `line` | `{lineId, name, lineNo, state, desc, startSn, endSn, direction, type}` |
| `targetOrder` | 上游默认的目标站序（不传 `targetOrder` 时是终点站） |
| `buses[]` | 车辆数组，字段与 §6 完全一致（含 `travels`） |

实测（11 路方向 1，21:00）：

```json
{"targetOrder":22,
 "buses":[{"licence":"417","busId":"417","state":1,"order":7,
           "lat":22.63298891303303,"lng":110.14673595496753,"speed":9.4,
           "travels":[{"order":22,"travelTime":1151,"recommTip":"21:03",
                       "arrivalTime":1793278987243,"optArrivalTime":1793278987243,
                       "optimisticTime":1151,"distance":0,"pRate":-1.0,
                       "debusTime":0,"debusCost":0}],
           "distanceToSc":0,"busDesc":""}]}
```

**什么时候用它而不是 `encryptedLineDetail`：**

- 只要「这条线现在有几辆车、什么状态」→ `busList`，体积只有 detail 的几分之一；
- 本仓的线路状态巡检（46 条 × 每 5 分钟）现在走的是 detail，其实用 `busList` 更省（历史原因没换）。

**它没有 `stations[]`**，所以拿不到 `wgs` 站坐标 → 无法做车标插值投影，只有车辆原始坐标。

### 5.4 `bus/line!encryptedLineDetail.action` — 站表 + 车辆 + 到站估计（加密）

```
GET /api/bus/line!encryptedLineDetail.action?...公共参数...
    &lineId=775200849296&cryptoSign=3f2031d13050245b1d39d5e90a824eca&targetOrder=6
```

| 参数 | 必需 | 说明 |
|---|---|---|
| `lineId` | ✅ | 目录里的 ID |
| `cryptoSign` | ➖ | 算法见 §3（实测未校验，但照算） |
| `targetOrder` | ➖ | 目标站序（1 基）。给了就让每辆车的 ETA 指向该站；不给则指向终点 |

解密后**顶层 46 个键**，本仓只挑 4 类用：

| 路径 | 说明 |
|---|---|
| `line` | `{lineId, name, price, state, desc, startSn, endSn, direction, firstTime, lastTime, hasBusInfo, ...}` |
| `buses[]` | 在途车辆，字段见 §6 |
| `stations[]` | 站表，比明文版多两个字段：`wgsLat` / `wgsLng`；另有 `special` / `specialOrder` |
| `targetOrder` | 回显你问的目标站序（没传就是终点站序） |

其余 `depTable`、`depTableDiversionApp`、`roads`、`traffic`、`displayPolicy`、`feed`、`preArrivalTime`
等 40 余个键本仓**均未验证语义**，不要照着猜。

`stations[]` 字段（实测，与明文版差异标粗）：

| 字段 | 说明 |
|---|---|
| `sId` / `sn` / `order` | 同明文版 |
| `lat` / `lng` | **bd 基准** |
| **`wgsLat` / `wgsLng`** | **WGS 基准，与车辆 `lat/lng` 同系** —— 插值只能用这一对 |
| `distanceToSp` | 距上一站距离 |
| `physicalStId` / `namesakeStId` | 物理站 / 同名站 ID（本仓不用） |
| `special` / `specialOrder` | 站点特殊标记（语义未验证） |
| `metros` | 地铁换乘（玉林恒空） |

---

## 6. 车辆对象（`buses[]`）

`busList` 与 `encryptedLineDetail` 返回的是同一个结构，40 余个键，本仓用到的：

| 字段 | 类型 | 说明 |
|---|---|---|
| `licence` | string | **车辆标识，口径不稳定**：老车给自编号（`417`、`435`），新车给车牌（`桂K12685D`）。本仓用 `plate_map.json` 归一 |
| `busId` | string | 内部 ID，通常与 `licence` 同值 —— 别依赖 |
| `state` | number | **`0` 在途 / `1` 已到站**（H5 的 `BUS_STATE`）。「车是不是停在站上」以它为准，不要用投影比例反推 |
| `order` | number | **正在接近的站**的 1 基站序。在途车实际位于 `order-1 → order` 之间 |
| `lat` / `lng` | number | **WGS** 坐标（与 `wgsLat/wgsLng` 同系，与 `stations[].lat/lng` 差约 500m） |
| `speed` | number | km/h，站停 / 无信号为 `0` |
| `travels[]` | array | 到站估计，见下 |

`travels[]`（每车一条，`travels[0]` 是有效的那条）：

| 字段 | 说明 |
|---|---|
| `order` | 目标站序（= 你问的 `targetOrder`，没问就是终点） |
| `travelTime` | **到目标站秒数**（`1151` = 19 分钟） |
| `recommTip` | 到达时刻 `HH:MM`（`21:03`），本仓直接透出成 `arriveAt` |
| `arrivalTime` / `optArrivalTime` | 13 位毫秒时间戳，与 `recommTip` 同义 |
| `optimisticTime` | 乐观估计秒数（通常与 `travelTime` 同值） |
| `distance` / `debusTime` / `debusCost` / `pRate` | 本仓不用 |

**注意**：`travels` 在收班后或信号丢失时可能是空数组（`[]`），此时 ETA 缺失，前端应显示「无预测」
而不是「0 分钟」。

---

## 7. `line.state` —— 列表页那枚状态标

只有实时接口带运营状态，目录接口不带。

| 值 | 含义 | 面板处理 |
|---|---|---|
| `0` | 正常运营 | 不标 |
| `-1` | 等待发车（**也可能是缺 `src` 造成的假象**，见 §2.3） | 不标 |
| `-2` | 临时停运，`desc` 常为 `临时停运` | 标「停运」 |
| `-3` | 末班已过，`desc` 为 `本线路末班时间已过` | 不标 |

实测（2026-10-29 20:4x，同一次扫描）：

| 线路 | state | desc | price | buses |
|---|---|---|---|---|
| `1` 方向 1 | `-3` | 本线路末班时间已过 | `2元` | 0 |
| `1` 方向 2 | `0` | — | `2元` | 2 |
| `11` 方向 1/2 | `0` | — | `2元` | 1 / 3 |
| `13（临时停运）` 两向 | `-2` | 临时停运 | `2元` | 0 |
| `15（临时停运）` 两向 | `-2` | 临时停运 | `2元` | 0 |

---

## 8. 缓存与轮询（本仓做法，可直接照抄）

| 数据 | 键 | TTL | 理由 |
|---|---|---|---|
| 目录 | `lines` | 1h | 线路一天不变 |
| 站表 + 折线 | `route:<lineId>` | 1h | 静态 |
| 实时 | `rt:<lineId>:<targetOrder>` | 10s | 面板最短 15 秒一刷（见 README「自动刷新」）；留 10 秒是为了几个客户端并发时能并成一趟 |
| 线路状态表 | `lineStates` | 5m | 后台刷，请求只读缓存 |

线路状态是**专门的后台循环**：46 条方向并发 6 拉一遍实时，结果塞缓存；
`/lines` 只在命中的条目上贴 `state/desc/数量`。为什么要这么做而不是在 `/lines` 里同步拉：
46 次加密调用串起来会让首屏卡好几秒，而状态本身变得极慢（停运一次好几天）。

单条失败就跳过（不猜状态），全失败才留旧值。

---

## 9. 陷阱清单

| 现象 | 真实原因 | 处理 |
|---|---|---|
| HTTP 200、body 为空 | 缺 `s=h5` | 加上；空 body 一律当参数错误，不是网络问题 |
| 全线「等待发车」、`buses` 全空 | 缺 `src` | 加上 §2.1 里那个渠道串 |
| 车标飘到海里 / 偏移约 500m | 把 `stations[].lat/lng`（bd）当 WGS 用了 | 车标插值只用 `wgsLat/wgsLng`；折线画图才用 bd |
| 明文站表里 `wgsLat=0` | `lineRoute` 本来就不给 WGS | 要 WGS 必须走 `encryptedLineDetail` |
| 签名算错也能通 | 上游当前未校验 `cryptoSign` | 照算、别依赖「不校验」 |
| `status=10004` 线路已变更 | `lineId` 过期（车来了会换 ID） | 重新拉目录取 ID，别把 ID 写死进配置 |
| `status=12009` 该接口已不提供服务 | 打到了废弃端点（`bus/line!lineDetail.action`） | 用 §5.3 / §5.4 |
| HTTP 404 | 端点名不存在（`bus/station!stationDetail.action`、`bus/line!lineStnInfo.action`） | 别猜端点名 |
| 折线上「出去又折回」的伪迹 | 上游 gpstype 数据本身带 240~350m 来回段 | 本仓逐条列表修正（`trackCutFix`），通用规则会误删真实绕行 |
| 站名带多余右括号 | 上游笔误（`高新产业园（玉林职业技术学院））`） | 逐条映射修正（`stopNameFix`） |

---

## 10. 代码映射

| 本文档章节 | Go 文件 / 符号 |
|---|---|
| §2.1 公共参数 | `internal/upstream/client.go` `baseParams()` |
| §2.2 剥壳 | `client.go` `get()` |
| §3 `cryptoSign` | `client.go` `cryptoSign()` |
| §4 AES 解密 | `client.go` `decryptECB()` |
| §5.1 目录 | `client.go` `Lines()` + `wire.go` `wireLine` |
| §5.2 走向 | `client.go` `Route()` + `wire.go` `wireRoute/wireStop/wirePoint` |
| §5.3 / §5.4 实时 | `client.go` `Realtime()` + `wire.go` `wireDetail/wireBus` |
| §6 车辆归一 | `client.go` `Realtime()` 里的 `bus` 组装 + `internal/plate` `FleetNo()` |
| §8 状态巡检 | `client.go` `StartLineStateLoop()` / `refreshLineStates()` |
| 对外模型 | `internal/upstream/model.go`（`Line/Route/Stop/Bus/Realtime/StopPos`） |

---

## 11. 复现命令

```sh
UA='Mozilla/5.0 (Linux; Android 13) Mobile MicroMessenger/8.0'
REF='Referer: https://web.chelaile.net.cn/customer_ch5/'
BASE='s=h5&v=9.1.2&vc=1&sign=1&userId=&h5Id=&cityId=440&src=wechat_yulingongjiao'

# 目录（明文）
curl -s -A "$UA" -H "$REF" \
  "https://web.chelaile.net.cn/api/bus/cityLineList?$BASE" | head -c 400

# 走向 + 站表（明文）
curl -s -A "$UA" -H "$REF" \
  "https://web.chelaile.net.cn/api/bus/line!lineRoute.action?$BASE&lineId=775200849296" | head -c 400

# 车辆（加密）：算签名 → 解 AES
python3 scripts/chelaile.py selftest                        # 校验签名向量 + AES 往返
python3 scripts/chelaile.py lines                           # 目录（明文）
python3 scripts/chelaile.py route  --line-id 775200849296   # 站表 + 折线（明文）
python3 scripts/chelaile.py detail --line-id 775200849296   # 详细实时（加密，含站表）
```

采集器目前**没有** `buslist` 子命令（`choices` 只有 `all/lines/route/detail/selftest`）。
要单独试 `bus/line!busList.action`，用下面这段十行脚本，或者给它提个 PR 加个子命令。

最小 Python 复现（含签名与解密）：

```python
import base64, hashlib, json, urllib.parse, urllib.request
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

KEY  = b"422556651C7F7B2B5C266EED06068230"
SALT = "qwihrnbtmj"
UA   = "Mozilla/5.0 (Linux; Android 13) Mobile MicroMessenger/8.0"
REF  = "https://web.chelaile.net.cn/customer_ch5/"

def sign(d):
    t = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
    return hashlib.md5((t[1:-1].replace(":", "=").replace(",", "&") + SALT).encode()).hexdigest()

def call(handler, **extra):
    p = {"s": "h5", "v": "9.1.2", "vc": 1, "sign": "1", "userId": "", "h5Id": "",
         "cityId": "440", "src": "wechat_yulingongjiao", **extra}
    url = "https://web.chelaile.net.cn/api/" + handler + "?" + urllib.parse.urlencode(p)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": REF})
    txt = urllib.request.urlopen(req, timeout=25).read().decode()
    jr = json.loads(txt.split("**YGKJ", 1)[1].rsplit("YGKJ##", 1)[0])["jsonr"]
    assert jr["status"] == "00", jr
    return jr["data"]

def decrypt(b64):
    d = Cipher(algorithms.AES(KEY), modes.ECB()).decryptor()
    out = d.update(base64.b64decode(b64)) + d.finalize()
    return json.loads(out[:-out[-1]].decode())

lid = "775200849296"
data = call("bus/line!encryptedLineDetail.action",
            lineId=lid, cryptoSign=sign({"lineId": lid}), targetOrder="6")
detail = decrypt(data["encryptResult"])
print(detail["line"]["state"], len(detail["buses"]))
```

---

## 附录 A：废弃 / 未验证端点

| 端点 | 实测结果 | 结论 |
|---|---|---|
| `bus/line!lineDetail.action` | `status=12009`「该接口已不提供服务」 | 已下线，别用 |
| `bus/station!stationDetail.action` | HTTP 404 | 端点名不存在 |
| `bus/line!lineStnInfo.action` | HTTP 404 | 端点名不存在 |
| `gpstype` 参数 | 传 `wgs` 无效，返回仍为 bd | 参数被忽略 |

车来了 H5 bundle 里还能读到别的调用点，但**本仓未验证的一律不写进文档** —— 猜端点名只会浪费一轮调试。

## 附录 B：与掌上公交的口径差异（速查）

| 维度 | 车来了 | 掌上公交 |
|---|---|---|
| 车辆标识 | `licence`：自编号或车牌混着给 | `busNumber`：恒为车牌 |
| 坐标 | 站两套（bd + wgs），车 WGS | 只有一套，站车同基准 |
| 站序 | `order` 1 基 | `stationOrder` 1 基，但车辆 `index` **0 基** |
| ETA | `travels[0].travelTime` 秒 | `busToStationTime` 分钟 |
| 状态 | `line.state` `0/-1/-2/-3` | `runState`/`hasReal` → 映射 |
| 故障形态 | 缺 `src` **静默假数据**（最难发现） | 缺 `Origin` 固定 47 字节网关串（一眼可见） |

详细版见 `docs/掌上公交API.md`。
