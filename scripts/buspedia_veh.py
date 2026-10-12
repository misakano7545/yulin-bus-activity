#!/usr/bin/env python3
"""从 buspedia 免登录端点收「自编号 ↔ 车牌」，并跟 plate_map.json 对差。

不用逐张截图：comp/{slug} 给出全部线路，line/photos/{slug} 每张照片带
veh 字段形如 "430 / 桂K 08807D"。玉林公交的 slug 是 cnvy82。

    ./buspedia_veh.py            # 只报差异
    ./buspedia_veh.py --write    # 把新对写进 plate_map.json（有冲突就停手）

接口响应是裸 zlib 流（Content-Type 却写 application/octet-stream），自己解压。
"""
import argparse, collections, json, re, sys, time, urllib.parse, urllib.request, zlib

API = "https://api.buspedia.top/"
SLUG = "cnvy82"                                    # 玉林市公共汽车公司
MAP = "plate_map.json"
VEH = re.compile(r'^\s*(\w+)\s*/\s*([\u4e00-\u9fff]\s*[A-Z]\s*[0-9A-Z]{4,6})\s*$')


def get(path):
    req = urllib.request.Request(API + path, headers={
        "Origin": "https://buspedia.top", "Referer": "https://buspedia.top/",
        "Accept": "*/*", "User-Agent": "Mozilla/5.0 (Linux; Android 13) Mobile MicroMessenger/8.0"})
    b = urllib.request.urlopen(req, timeout=25).read()
    try:
        b = zlib.decompress(b)
    except zlib.error:
        pass
    return json.loads(b)


def harvest():
    comp = get("comp/" + SLUG)
    slugs = [l["id"] for grp in comp["lines"][1] for l in [grp]]
    pairs = collections.defaultdict(collections.Counter)
    for s in slugs:
        for p in get("line/photos/" + s) or []:
            m = VEH.match(p.get("veh") or "")
            if m:
                pairs[m.group(1)][m.group(2).replace(" ", "")] += 1
        time.sleep(0.3)
    return pairs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="把新对写进 plate_map.json")
    a = ap.parse_args()

    pairs = harvest()
    clash = {no: dict(v) for no, v in pairs.items() if len(v) > 1}
    if clash:
        sys.exit(f"一个自编号读到多块车牌，先人工看：{clash}")

    tab = json.load(open(MAP))
    inv = {v: k for k, v in tab.items()}
    add, agree = {}, 0
    for no, cnt in pairs.items():
        plate = list(cnt)[0]
        if plate in tab or no in inv:
            if tab.get(plate) != no or inv.get(no) != plate:
                sys.exit(f"与表冲突：{no} / {plate}（表里 {tab.get(plate) or inv.get(no)}）")
            agree += 1
        else:
            add[plate] = no

    print(f"扫到 {len(pairs)} 对；与表一致 {agree} 对；表里没有 {len(add)} 对")
    for no, plate in sorted(add.items(), key=lambda kv: int(kv[1])):
        print(f"  {plate} = {no}")
    if not a.write or not add:
        return
    tab.update(add)
    json.dump(dict(sorted(tab.items(), key=lambda kv: int(kv[1]))), open(MAP, "w"), ensure_ascii=False, indent=2)
    open(MAP, "a").write("\n")
    print(f"已写入 {MAP}：{len(tab)} 条")


if __name__ == "__main__":
    main()
