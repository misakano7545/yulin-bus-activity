"""玉林公交实时查询：掌上公交（mygolbs）H5 接口，纯标准库。

两跳：
  CMD=103  站序（起点/终点/站数），线路级数据，缓存 1 小时
  CMD=104  在途车辆（车号、所在站、距站米数），缓存 20 秒

接口细节见本仓 docs/掌上公交API.md；缺 Origin 头会返回 47 字节非 JSON 网关串。
"""

import json
import time
import urllib.parse
import urllib.request

API = "https://h5.mygolbs.com/ApiData.do"
HEADERS = {
    "Origin": "https://h5.mygolbs.com",
    "Referer": "https://h5.mygolbs.com/",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "Mozilla/5.0 (Linux; Android 12) Mobile Safari/537.36",
}
CITY = {"CITYNAME": "玉林市", "CITYCODE": "450900"}
ROUTE_TTL = 3600
LIVE_TTL = 20

_cache: dict = {}


def _post(params, timeout=6):
    body = urllib.parse.urlencode({**CITY, **params}).encode()
    req = urllib.request.Request(API, data=body, headers=HEADERS, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _cached(key, ttl, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    val = fn()
    _cache[key] = (time.time(), val)
    return val


def _stations(line, direction):
    """该方向站名序列；线路不存在时为空。"""
    got = _post({"CMD": "103", "LINENAME": line, "DIRECTION": direction}).get("data") or []
    return [s["stationName"] for s in got]


def _cars(line, direction):
    return _post(
        {"CMD": "104", "LINENAME": line, "DIRECTION": direction, "STATIONORDER": "1"}
    ).get("list") or []


def answer(line):
    """把查询结果拼成一段给群友看的话。"""
    routes = {
        d: _cached(("r", line, d), ROUTE_TTL, lambda d=d: _stations(line, d))
        for d in ("1", "2")
    }
    if not routes["1"] and not routes["2"]:
        return f"玉林没有查到「{line}」这条线"

    lines, total = [], 0
    for d, stops in routes.items():
        if not stops:
            continue
        head = f"往 {stops[-1]}"
        cars = _cached(("l", line, d), LIVE_TTL, lambda d=d: _cars(line, d))
        if not cars:
            lines.append(f"{head}：暂无车")
            continue
        total += len(cars)
        for c in cars:
            left = max(len(stops) - int(c.get("index") or 0), 0)
            dist = round(float(c.get("busToStationNiheDistance") or 0))
            where = f"正在 {c.get('stationName')}" if dist < 50 else f"快到 {c.get('stationName')}（距站 {dist}m）"
            lines.append(f"{head}：{c.get('busNumber')} {where}，还有 {left} 站到终点")

    head = f"玉林 {line} 现在 {total} 辆车在路上" if total else f"玉林 {line} 现在没有车在路上"
    return head + "\n" + "\n".join(lines)


if __name__ == "__main__":
    # 自检：python3 bus.py G02路
    import sys

    print(answer(sys.argv[1] if len(sys.argv) > 1 else "G02路"))
