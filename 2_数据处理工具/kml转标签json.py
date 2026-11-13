#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
司空2 导出的 KML  ->  查看器用的标签 JSON
=================================================
为什么要转：KML 里的图标指向外网、属性藏在 description 的 HTML 里，
离线环境下图标会裂、属性看不出来。转成 JSON 后：坐标不变、属性表格化、
图标换成本地方案自带的标记，点一下就能看到病害等级和照片。

用法（在 2_数据处理工具 目录里）：
    python kml转标签json.py ..\\1_模型查看器\\data\\vector\\defect.kml
    python kml转标签json.py defect.kml -o ..\\1_模型查看器\\data\\vector\\labels.json --name "小冉学长病害"

参数：
    input.kml            司空2 导出的 KML
    -o, --output         输出 JSON（默认与输入同名的 .json）
    --name               分组显示名（默认取文件名）
    --color              分组颜色（默认 #ff5b5b）
    --group-id           分组 id（默认 kml）
    --append             不清空原有 features，追加进已有 JSON（同一批多次导出时用）
    --only-type          只收某一类：point / polyline / polygon（可多次调用拆成多个分组）
    --name-re            只收名称匹配该正则的要素（如 "应急车道|LED"）
    --exclude-re         排除名称匹配该正则的要素（如 "建模范围"）
    --no-line-labels     线/面要素不显示文字标签（一批同名的短线段时避免糊屏）
    --clip               "lon,lat,半径米" 地理范围，配合 --clip-mode 只留范围内/外
    --clip-mode          inside（默认，要素全部落在范围内）/ outside（完全落在范围外）
"""

import argparse
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
from html import unescape

# ---------------------------------------------------------------- 工具函数

def localname(tag):
    return tag.split("}")[-1] if "}" in tag else tag


def find_all(elem, name):
    """按本地名找子元素（忽略 KML 命名空间）"""
    return [e for e in elem if localname(e.tag) == name]


def find_one(elem, name):
    for e in elem.iter():
        if localname(e.tag) == name:
            return e
    return None


def iter_placemarks(elem):
    for e in elem.iter():
        if localname(e.tag) == "Placemark":
            yield e


def text_of(elem, name):
    node = find_one(elem, name)
    return (node.text or "").strip() if node is not None and node.text else ""


def parse_coords(raw):
    """'lon,lat,alt lon,lat,alt' -> [(lon,lat,alt), ...]"""
    out = []
    for token in (raw or "").replace("\n", " ").replace("\r", " ").replace("\t", " ").split():
        parts = token.split(",")
        if len(parts) < 2:
            continue
        try:
            lon = float(parts[0])
            lat = float(parts[1])
            alt = float(parts[2]) if len(parts) >= 3 and parts[2] != "" else 0.0
        except ValueError:
            continue
        if -180 <= lon <= 180 and -90 <= lat <= 90:
            out.append([round(lon, 8), round(lat, 8), round(alt, 3)])
    return out


def strip_html(raw):
    if not raw:
        return ""
    s = raw.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n")
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", s, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", "\n", s)
    s = unescape(s)
    s = re.sub(r"[ \t\u00a0]+", " ", s)
    s = re.sub(r"\n{2,}", "\n", s)
    return s.strip()


KV_RE = re.compile(r"^[\-\*\u2022]?\s*([^:：=\t]{1,24})[:：=\t]\s*(.*)$")


def props_from_description(desc):
    """司空2 的描述常是 '病害等级: B\\n长度: 0.42m' 或一段 HTML，尽量拆成键值"""
    props = {}
    text = strip_html(desc)
    if not text:
        return props
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        m = KV_RE.match(line)
        if m:
            k, v = m.group(1).strip(), m.group(2).strip()
            if v and len(k) <= 20:
                props[k] = v
                continue
        # 没有冒号的行先攒着，最后并到"描述"
        props["描述"] = (props.get("描述", "") + ("" if "描述" not in props else "\n") + line).strip()
    return props


def props_from_extended(placemark):
    props = {}
    for e in placemark.iter():
        if localname(e.tag) == "Data":
            key = e.get("name") or ""
            val = ""
            for c in e:
                if localname(c.tag) == "value" and c.text:
                    val = c.text
                    break
            if key:
                props[key.strip()] = strip_html(val)
        elif localname(e.tag) == "SimpleData":
            key = e.get("name") or ""
            if key:
                props[key.strip()] = strip_html(e.text or "")
    return props


def geometry_of(placemark):
    """返回 (type, coordinates)"""
    poly = find_one(placemark, "Polygon")
    if poly is not None:
        for e in poly.iter():
            if localname(e.tag) in ("outerBoundaryIs", "innerBoundaryIs"):
                ring = None
                for c in e.iter():
                    if localname(c.tag) in ("LinearRing", "LineString"):
                        ring = parse_coords(text_of(c, "coordinates"))
                        break
                if ring and len(ring) >= 3:
                    # 去掉首尾重复点（GeoJSON 风格闭合，查看器不需要）
                    if len(ring) > 3 and ring[0] == ring[-1]:
                        ring = ring[:-1]
                    return "polygon", ring

    line = find_one(placemark, "LineString")
    if line is not None:
        pts = parse_coords(text_of(line, "coordinates"))
        if len(pts) >= 2:
            return "polyline", pts

    point = find_one(placemark, "Point")
    if point is not None:
        pts = parse_coords(text_of(point, "coordinates"))
        if pts:
            return "point", pts[0]

    return None, None


# ---------------------------------------------------------------- 主流程

def convert(kml_path, only_type="", name_re="", exclude_re="", no_line_labels=False,
            clip="", clip_mode="inside"):
    tree = ET.parse(kml_path)
    root = tree.getroot()
    features = []
    skipped = 0
    filtered = 0
    keep = re.compile(name_re) if name_re else None
    drop = re.compile(exclude_re) if exclude_re else None

    c_lon = c_lat = c_r = None
    if clip:
        try:
            c_lon, c_lat, c_r = [float(x) for x in clip.split(",")]
        except ValueError:
            print("[错误] --clip 格式应为 lon,lat,半径米")
            return [], 0, 0

    def in_clip(lon, lat):
        dx = (lon - c_lon) * 111320.0 * math.cos(math.radians(c_lat))
        dy = (lat - c_lat) * 110574.0
        return math.hypot(dx, dy) <= c_r

    for pm in iter_placemarks(root):
        name = text_of(pm, "name")
        gtype, coords = geometry_of(pm)
        if not gtype:
            skipped += 1
            continue
        if only_type and gtype != only_type:
            filtered += 1
            continue
        if keep and not keep.search(name or ""):
            filtered += 1
            continue
        if drop and drop.search(name or ""):
            filtered += 1
            continue
        if c_r is not None:
            pts = [coords] if gtype == "point" else coords
            near = sum(1 for p in pts if in_clip(p[0], p[1]))
            if clip_mode == "inside" and near != len(pts):
                filtered += 1
                continue
            if clip_mode == "outside" and near > 0:
                filtered += 1
                continue

        props = props_from_extended(pm)
        desc = text_of(pm, "description")
        parsed = props_from_description(desc)
        for k, v in parsed.items():
            props.setdefault(k, v)

        fid = text_of(pm, "styleUrl").rstrip("#") if find_one(pm, "styleUrl") is not None else ""
        base_id = re.sub(r"[^\w\-]+", "-", name)[:48] if name else ""
        # 优先用名称做 id：同一批 KML 里 styleUrl 往往只有一个，全用它会变成一堆 dji_style_xxx-2/3/4
        fid = base_id or fid

        f = {
            "id": fid or ("KML-%03d" % (len(features) + 1)),
            "name": name or "未命名要素",
            "type": gtype,
            "coordinates": coords,
            "label": name or "",
            "showLabel": not (no_line_labels and gtype != "point"),
            "properties": props,
        }
        features.append(f)

    # 同名 styleUrl 造成 id 冲突时补序号
    seen = {}
    for f in features:
        if f["id"] in seen:
            seen[f["id"]] += 1
            f["id"] = "%s-%d" % (f["id"], seen[f["id"]])
        else:
            seen[f["id"]] = 1

    return features, skipped, filtered


def bbox(features):
    lons, lats = [], []
    for f in features:
        c = f["coordinates"]
        pts = [c] if f["type"] == "point" else c
        for p in pts:
            lons.append(p[0])
            lats.append(p[1])
    if not lons:
        return None
    return (min(lons), min(lats), max(lons), max(lats))


def main():
    ap = argparse.ArgumentParser(description="司空2 KML -> 查看器标签 JSON")
    ap.add_argument("kml", help="输入 KML 文件")
    ap.add_argument("-o", "--output", help="输出 JSON（默认同名 .json）")
    ap.add_argument("--name", default="", help="分组显示名")
    ap.add_argument("--color", default="#ff5b5b", help="分组颜色")
    ap.add_argument("--group-id", default="kml", help="分组 id")
    ap.add_argument("--append", action="store_true", help="追加到已有 JSON")
    ap.add_argument("--only-type", default="", choices=["", "point", "polyline", "polygon"],
                    help="只收某一类几何")
    ap.add_argument("--name-re", default="", help="只收名称匹配该正则的要素")
    ap.add_argument("--exclude-re", default="", help="排除名称匹配该正则的要素")
    ap.add_argument("--no-line-labels", action="store_true",
                    help="线/面要素不显示文字标签")
    ap.add_argument("--clip", default="", help='"lon,lat,半径米" 地理范围')
    ap.add_argument("--clip-mode", default="inside", choices=["inside", "outside"],
                    help="只留范围内(inside) / 范围外(outside)")
    ap.add_argument("--hidden", action="store_true", help="该分组默认隐藏（图层面板可再打开）")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if not os.path.isfile(args.kml):
        print("[错误] 找不到文件：%s" % args.kml)
        return 2

    features, skipped, filtered = convert(args.kml, args.only_type, args.name_re,
                                          args.exclude_re, args.no_line_labels,
                                          args.clip, args.clip_mode)
    if not features:
        print("[错误] KML 里没有解析到任何点/线/面（Placemark 是否包含几何？）")
        return 3

    out_path = args.output or (os.path.splitext(args.kml)[0] + ".json")
    group_name = args.name or os.path.splitext(os.path.basename(args.kml))[0]

    doc = {"version": 1, "name": group_name, "groups": [], "features": []}
    if args.append and os.path.isfile(out_path):
        try:
            with open(out_path, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
        except Exception as e:
            print("[警告] 旧 JSON 读取失败，改为新建：%s" % e)
            doc = {"version": 1, "name": group_name, "groups": [], "features": []}

    groups = doc.setdefault("groups", [])
    gid = args.group_id
    if not any(g.get("id") == gid for g in groups):
        groups.append({"id": gid, "name": group_name, "color": args.color,
                       "visible": not args.hidden})

    existing_ids = {f.get("id") for f in doc.setdefault("features", [])}
    added = 0
    for f in features:
        fid = f["id"]
        n = 1
        while fid in existing_ids:
            n += 1
            fid = "%s-%d" % (f["id"], n)
        f["id"] = fid
        f["group"] = gid
        existing_ids.add(fid)
        doc["features"].append(f)
        added += 1

    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)

    by_type = {"point": 0, "polyline": 0, "polygon": 0}
    for f in features:
        by_type[f["type"]] = by_type.get(f["type"], 0) + 1

    bb = bbox(features)
    print("-" * 58)
    print("  转换完成：%s" % os.path.basename(args.kml))
    print("  要素：点 %d / 线 %d / 面 %d（无几何 %d，被筛选掉 %d）" % (by_type["point"], by_type["polyline"], by_type["polygon"], skipped, filtered))
    if bb:
        print("  范围：经度 %.6f ~ %.6f，纬度 %.6f ~ %.6f" % (bb[0], bb[2], bb[1], bb[3]))
        print("  中心：%.6f, %.6f" % ((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2))
    print("  输出：%s（本次新增 %d 条，累计 %d 条）" % (out_path, added, len(doc["features"])))
    print("-" * 58)
    print("  下一步：把 %s 放到 1_模型查看器\\data\\vector\\ 下，刷新查看器即可。" % os.path.basename(out_path))
    print("  若标签整体偏移，多半是高程用错基准（司空2是椭球高HAE，实测海拔是ASL）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
