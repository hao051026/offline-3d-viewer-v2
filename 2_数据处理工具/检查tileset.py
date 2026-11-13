#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
司空2 3DTiles 导出包体检
=================================================
模型拷过来加载不出来，九成是这几件事：tileset.json 层级放错、瓦片没拷全、
子 tileset 引用路径断开。这个脚本不开浏览器就能查出问题。

用法（在 2_数据处理工具 目录里）：
    python 检查tileset.py ..\\1_模型查看器\\data\\model\\tileset\\tileset.json

输出：版本、根包围体中心经纬度/范围、引用瓦片数量、缺失文件清单、总体积。
"""

import json
import math
import os
import sys
from collections import Counter

# ---------------------------------------------------------------- WGS84 反算

A = 6378137.0
B = 6356752.314245
E2 = 1 - (B * B) / (A * A)


def ecef_to_geodetic(x, y, z):
    """ECEF -> (经度°, 纬度°, 椭球高 m)，不依赖 pyproj"""
    lon = math.atan2(y, x)
    p = math.sqrt(x * x + y * y)
    lat = math.atan2(z, p * (1 - E2))
    for _ in range(6):
        n = A / math.sqrt(1 - E2 * math.sin(lat) ** 2)
        h = p / math.cos(lat) - n
        lat = math.atan2(z, p * (1 - E2 * n / (n + h)))
    n = A / math.sqrt(1 - E2 * math.sin(lat) ** 2)
    h = p / math.cos(lat) - n
    return math.degrees(lon), math.degrees(lat), h


def describe_bounding_volume(bv):
    if not bv:
        return "（无包围体）"
    if "region" in bv:
        w, s, e, n, hmin, hmax = bv["region"]
        return "region 经纬度 %.6f~%.6f / %.6f~%.6f，高程 %.1f~%.1f m" % (
            math.degrees(w), math.degrees(e), math.degrees(s), math.degrees(n), hmin, hmax)
    if "box" in bv:
        v = bv["box"]
        cx, cy, cz = v[0], v[1], v[2]
        lon, lat, h = ecef_to_geodetic(cx, cy, cz)
        half = [math.sqrt(v[3 + i] ** 2 + v[6 + i] ** 2 + v[9 + i] ** 2) for i in range(3)]
        return "box 中心 %.6f°, %.6f°, 高 %.1f m；半轴 %.1f / %.1f / %.1f m" % (lon, lat, h, half[0], half[1], half[2])
    if "sphere" in bv:
        c = bv["sphere"]
        lon, lat, h = ecef_to_geodetic(c[0], c[1], c[2])
        return "sphere 中心 %.6f°, %.6f°, 高 %.1f m；半径 %.1f m" % (lon, lat, h, c[3])
    return "未知包围体类型"


# ---------------------------------------------------------------- 遍历

CONTENT_EXTS = (".b3dm", ".pnts", ".i3dm", ".cmpt", ".glb")
stats = {"tiles": 0, "contents": 0, "external": 0, "missing": [], "by_ext": Counter(), "bytes": 0, "max_error": 0.0}


class _NoFiles(Exception):
    pass


def resolve(base_dir, uri):
    return os.path.normpath(os.path.join(base_dir, uri.replace("\\", "/")))


def walk_node(node, base_dir, depth=0):
    if node is None:
        return
    stats["tiles"] += 1
    ge = node.get("geometricError")
    if isinstance(ge, (int, float)):
        stats["max_error"] = max(stats["max_error"], float(ge))

    content = node.get("content") or {}
    uri = content.get("uri") or content.get("url")
    if uri:
        stats["contents"] += 1
        stats["by_ext"][os.path.splitext(uri)[1].lower()] += 1
        path = resolve(base_dir, uri)
        if os.path.isfile(path):
            try:
                stats["bytes"] += os.path.getsize(path)
            except OSError:
                pass
        else:
            stats["missing"].append((depth, uri))
        # 外部 tileset：继续往里走
        if uri.lower().endswith(".json") or uri.lower().endswith(".geojson"):
            if os.path.isfile(path):
                stats["external"] += 1
                try:
                    with open(path, "r", encoding="utf-8") as fh:
                        sub = json.load(fh)
                    walk_node(sub.get("root"), os.path.dirname(path), depth + 1)
                except Exception as e:
                    stats["missing"].append((depth, uri + "（读取失败：%s）" % e))

    for child in node.get("children", []) or []:
        walk_node(child, base_dir, depth + 1)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if len(sys.argv) < 2:
        print("用法：python 检查tileset.py <tileset.json 路径>")
        print("例：  python 检查tileset.py ..\\1_模型查看器\\data\\model\\tileset\\tileset.json")
        return 2

    path = sys.argv[1]
    if not os.path.isfile(path):
        print("[错误] 找不到文件：%s" % path)
        print("       模型可能还在下载；或者 tileset.json 被解压到了更深一层目录（常见：导出包/tileset/tileset.json）")
        return 3

    base_dir = os.path.dirname(path)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except Exception as e:
        print("[错误] tileset.json 不是合法 JSON：%s" % e)
        return 4

    root = doc.get("root")
    if root is None:
        print("[错误] tileset.json 里没有 root 节点，不是标准 3DTiles")
        return 5

    walk_node(root, base_dir)

    print("=" * 62)
    print("  3DTiles 体检：%s" % path)
    print("=" * 62)
    print("  规范版本   : %s" % (doc.get("asset", {}).get("version", "?")))
    print("  根包围体   : %s" % describe_bounding_volume(root.get("boundingVolume")))
    print("  最大几何误差: %.2f（根节点值，一般约等于模型半幅尺寸）" % stats["max_error"])
    print("  节点数     : %d（其中外部 tileset %d 个）" % (stats["tiles"], stats["external"]))
    print("  引用瓦片   : %d 个" % stats["contents"])
    for ext, n in stats["by_ext"].most_common():
        print("               %-6s %d" % (ext or "(无扩展名)", n))
    print("  已找到体积 : %.1f MB" % (stats["bytes"] / (1024.0 * 1024.0)))

    # LOD 断档检查：顶层容器节点自己不带几何，几何误差却写得很小，
    # Cesium 远距离时会认为"已经够精细"而停在这里 → 画面整片空白、瓦片 0 就绪
    kids = root.get("children") or []
    rge = float(doc.get("geometricError") or root.get("geometricError") or 0)
    tiny = [k for k in kids
            if "content" not in k
            and isinstance(k.get("geometricError"), (int, float))
            and rge and float(k["geometricError"]) < rge * 0.02]
    if tiny:
        print("  LOD 断档   : %d/%d 个顶层容器节点 geometricError 过小（如 %.2f，根节点 %.2f）"
              % (len(tiny), len(kids), float(tiny[0]["geometricError"]), rge))
        print("               现象：相机在整体高度看时整片消失、瓦片一直 0 就绪，凑近才出图。")
        print("               修法：py -3 修复司空2_tileset.py（会先备份原始文件）")


    if stats["missing"]:
        print("  缺失文件   : %d 个（前 8 条）" % len(stats["missing"]))
        for depth, uri in stats["missing"][:8]:
            print("               [层%d] %s" % (depth, uri))
        print("  结论       : 瓦片没拷全，模型会加载出一块空心或直接失败。请整包重新拷贝。")
    else:
        print("  缺失文件   : 无")
        print("  结论       : 文件完整，可以直接在查看器里打开。")

    print("-" * 62)
    print("  提醒：司空2 导出是 WGS84 经纬度 + 椭球高(HAE)，不要再转局部坐标，")
    print("        否则标签和模型一定对不上。")
    print("=" * 62)

    return 0 if not stats["missing"] else 1


if __name__ == "__main__":
    sys.exit(main())
