#!/usr/bin/env python3
"""车来了（Chelaile）玉林公交 H5 逆向采集器。

数据面：H5 (web.chelaile.net.cn/api) —— 非官方接口，低频自用。
    bus/cityLineList                      线路目录（明文）
    bus/line!lineRoute.action             线路走向折线 + 站点序列（明文）
    bus/line!encryptedLineDetail.action   线路详情 + 实时车辆（AES-256-ECB）

关键点（实测）：
  * 所有 /api 请求必须带 s=h5，否则返回空。
  * 实时车辆必须带 src=<渠道>，本例 src=wechat_yulingongjiao；
    不带 src 时线路状态一律 -1「等待发车」、buses 恒为空。
  * encryptedLineDetail 需 cryptoSign = MD5(json(去花括号) 的 ':'->'=' ','->'&' + "qwihrnbtmj")。
  * 响应体包在 **YGKJ{...}YGKJ## 里，取 .jsonr，status=="00" 才算成功。
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

BASE = "https://web.chelaile.net.cn/api/"
UA = "Mozilla/5.0 (Linux; Android 13; iPhone; CPU iPhone OS 16_6 like Mac OS X) MicroMessenger/8.0"
REFERER = "https://web.chelaile.net.cn/customer_ch5/"
AES_KEY = b"422556651C7F7B2B5C266EED06068230"
SIGN_SALT = "qwihrnbtmj"
CITY_ID = "440"  # 玉林


def _get(handler, params, retries=3):
    url = BASE + handler + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": REFERER})
    last = None
    for i in range(retries):
        try:
            return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        except Exception as e:  # 网络抖动重试
            last = e
            time.sleep(1 + i)
    raise last


def _unwrap(text):
    """剥掉 **YGKJ ... YGKJ## 包装，返回 jsonr 对象。"""
    if "**YGKJ" not in text:
        raise RuntimeError("响应不是 YGKJ 包装（可能缺 s 参数）: %r" % text[:120])
    body = json.loads(text.split("**YGKJ", 1)[1].rsplit("YGKJ##", 1)[0])
    jr = body["jsonr"]
    if jr.get("status") != "00":
        raise RuntimeError("业务失败 status=%s errmsg=%s" % (jr.get("status"), jr.get("errmsg")))
    return jr["data"]


def _decrypt(encrypt_result):
    """AES-256-ECB + PKCS7 去填充。"""
    raw = Cipher(algorithms.AES(AES_KEY), modes.ECB()).decryptor()
    data = raw.update(base64.b64decode(encrypt_result)) + raw.finalize()
    return json.loads(data[:-data[-1]].decode("utf-8"))


def _crypto_sign(data):
    """H5 的 cryptoSign：JSON 去掉最外层 {}，':'->'=' ','->'&'，追加固定盐，取 MD5。"""
    t = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return hashlib.md5((t[1:-1].replace(":", "=").replace(",", "&") + SIGN_SALT).encode()).hexdigest()


def _base_params(src):
    p = {"s": "h5", "v": "9.1.2", "vc": 1, "sign": "1",
         "userId": "", "h5Id": "", "cityId": CITY_ID}
    if src:
        p["src"] = src
    return p


def line_list(src=None):
    """全部线路目录：23 条线 × 2 个方向 = 46 条记录。"""
    return _unwrap(_get("bus/cityLineList", _base_params(src)))["allLines"]["all"]


def line_route(line_id, src=None):
    """线路走向：折线坐标 + 站点（sId/sn/lat/lng/order）+ 线路元数据。"""
    p = _base_params(src)
    p.update({"lineId": line_id})
    return _unwrap(_get("bus/line!lineRoute.action", p))


def line_detail(line_id, src=None):
    """线路详情 + 实时车辆（需 src，否则没有实时数据）。"""
    payload = {"lineId": line_id}
    payload["cryptoSign"] = _crypto_sign({"lineId": line_id})
    p = _base_params(src)
    p.update(payload)
    return _decrypt(_unwrap(_get("bus/line!encryptedLineDetail.action", p))["encryptResult"])


def fetch_all(outdir, src, delay=0.3):
    os.makedirs(outdir, exist_ok=True)
    lines = line_list(src)
    _dump(os.path.join(outdir, "lines.json"), lines)
    print("线路目录: %d 条记录 (%d 条线)" % (len(lines), len({l["lineName"] for l in lines})))

    routes, realtime = {}, {}
    for i, L in enumerate(lines, 1):
        lid = L["lineId"]
        try:
            routes[lid] = line_route(lid, src)
        except Exception as e:
            routes[lid] = {"error": str(e)}
        time.sleep(delay)
        try:
            d = line_detail(lid, src)
            realtime[lid] = {
                "line": d.get("line"),
                "buses": d.get("buses") or [],
                "targetOrder": d.get("targetOrder"),
                "depDesc": d.get("depDesc"),
                "realData": d.get("realData"),
            }
        except Exception as e:
            realtime[lid] = {"error": str(e)}
        time.sleep(delay)
        nb = len(realtime[lid].get("buses") or [])
        print("[%2d/%d] %-16s %-22s buses=%d" % (
            i, len(lines), L["lineName"], lid, nb))

    _dump(os.path.join(outdir, "routes.json"), routes)
    _dump(os.path.join(outdir, "realtime.json"), realtime)
    print("实时车辆合计: %d" % sum(len(v.get("buses") or []) for v in realtime.values()))
    return lines, routes, realtime


def _dump(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def _selftest():
    # 实测向量：lineId=775200849296 的 cryptoSign
    assert _crypto_sign({"lineId": "775200849296"}) == "3f2031d13050245b1d39d5e90a824eca"
    # AES 往返
    from cryptography.hazmat.primitives.padding import PKCS7
    pad = PKCS7(128).padder()
    pt = b'{"ok":1}'
    ct = pad.update(pt) + pad.finalize()
    enc = Cipher(algorithms.AES(AES_KEY), modes.ECB()).encryptor()
    blob = base64.b64encode(enc.update(ct) + enc.finalize()).decode()
    assert _decrypt(blob) == {"ok": 1}
    print("selftest ok")


def main():
    ap = argparse.ArgumentParser(description="车来了玉林公交 H5 采集器")
    ap.add_argument("cmd", nargs="?", default="all",
                    choices=["all", "lines", "route", "detail", "selftest"])
    ap.add_argument("--src", default="wechat_yulingongjiao",
                    help="渠道标识；实时数据必需，缺省为公众号渠道")
    ap.add_argument("--out", default="data", help="输出目录")
    ap.add_argument("--line-id", help="route/detail 子命令用")
    a = ap.parse_args()

    if a.cmd == "selftest":
        _selftest()
    elif a.cmd == "lines":
        print(json.dumps(line_list(a.src), ensure_ascii=False, indent=2))
    elif a.cmd == "route":
        print(json.dumps(line_route(a.line_id, a.src), ensure_ascii=False, indent=2))
    elif a.cmd == "detail":
        print(json.dumps(line_detail(a.line_id, a.src), ensure_ascii=False, indent=2))
    else:
        fetch_all(a.out, a.src)


if __name__ == "__main__":
    main()
