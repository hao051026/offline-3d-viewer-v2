#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
.blend / .max  ->  3D Tiles（Cesium 离线查看器可直接加载）
================================================================
在 bpy（Blender 的 Python 模块，无需装图形界面 Blender）环境里运行。

做三件事：
  1. 打开 .blend，统计物体/网格/三角面数，打印真实包围盒（米）
  2. 导出 GLB（应用修改器、切线、材质贴图打包进 GLB）
  3. 按真实包围盒生成 tileset.json（ENU 定位矩阵 + 精确 boundingVolume）

用法（在项目根目录，用装了 bpy 的 venv）：
    .venv_bpy\\Scripts\\python.exe 工具\\blend转3dtiles.py "data/model/小镇（blend）\\小镇.blend"
    ... --lon 108.9 --lat 34.0 --height 500
    ... --no-export          # 只看统计，不导出

默认把 GLB 和 tileset.json 写在 .blend 旁边。
"""

import argparse
import json
import math
import os
import sys

# ---------------------------------------------------------------- WGS84

A = 6378137.0
B = 6356752.314245
E2 = 1 - (B * B) / (A * A)


def enu_matrix(lon, lat, height):
    """经纬度点 -> ECEF 的 东-北-天 矩阵（列主序 16 数，Cesium 要的格式）"""
    phi = math.radians(lat)
    lam = math.radians(lon)
    n = A / math.sqrt(1 - E2 * math.sin(phi) ** 2)
    x = (n + height) * math.cos(phi) * math.cos(lam)
    y = (n + height) * math.cos(phi) * math.sin(lam)
    z = (n * (1 - E2) + height) * math.sin(phi)

    east = (-math.sin(lam), math.cos(lam), 0.0)
    north = (-math.sin(phi) * math.cos(lam), -math.sin(phi) * math.sin(lam), math.cos(phi))
    up = (math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi))

    m = list(east) + [0.0] + list(north) + [0.0] + list(up) + [0.0] + [x, y, z, 1.0]
    return [round(v, 10) for v in m]


# ---------------------------------------------------------------- 场景处理

def clean_scene():
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)


def open_blend(path):
    import bpy
    clean_scene()
    bpy.ops.wm.open_mainfile(filepath=path)
    return bpy.context.scene


# Blender 场景里的装饰元素：背景板、云片、雾板。放进 GIS 查看器只会挡住视线。
# 按名字正则排除，默认就是这套（这是 bpy 直接跑出来的通用结论）。
DEFAULT_EXCLUDE = r"^(clouds|mist|fog)|^Plane\.004$"
# 这些是"疑似背景板"的判据：三角面 <=2 且面积特别大
PLATE_MAX_TRIS = 2
PLATE_MIN_FOOTPRINT = 20000.0   # 平方米


def is_backdrop_plate(o, excl_names):
    """判断是不是一块超大的贴图背景板（没有实体，只有 2 个三角面）"""
    from mathutils import Vector
    me = o.data
    if not me.vertices:
        return False
    me.calc_loop_triangles()
    if len(me.loop_triangles) > PLATE_MAX_TRIS:
        return False
    vmin = Vector((float("inf"),) * 3)
    vmax = Vector((float("-inf"),) * 3)
    for v in me.vertices:
        w = o.matrix_world @ v.co
        for i in range(3):
            vmin[i] = min(vmin[i], w[i])
            vmax[i] = max(vmax[i], w[i])
    size = vmax - vmin
    foot = max(size[0] * size[1], size[0] * size[2], size[1] * size[2])
    return foot >= PLATE_MIN_FOOTPRINT


def apply_exclusions(exclude_re, drop_plates):
    """按规则删除物体，返回被删掉的名字列表"""
    import bpy
    import re

    removed = []
    pat = re.compile(exclude_re) if exclude_re else None

    for o in list(bpy.context.scene.objects):
        if o.type != "MESH":
            continue
        hit = False
        if pat and pat.search(o.name):
            hit = True
        elif drop_plates and is_backdrop_plate(o, exclude_re):
            hit = True
        if not hit:
            continue
        removed.append(o.name)
        me = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        # 网格数据没人用了就一起清掉，别让 GLB 把无用顶点带进去
        try:
            if me.users == 0:
                bpy.data.meshes.remove(me)
        except Exception:
            pass
    return removed


def scene_stats():
    """统计物体/网格/面数，并算出世界坐标包围盒"""
    import bpy
    from mathutils import Vector

    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    total_tris = 0
    vmin = Vector((float("inf"),) * 3)
    vmax = Vector((float("-inf"),) * 3)
    found = False

    for o in objs:
        me = o.data
        me.calc_loop_triangles()
        total_tris += len(me.loop_triangles)
        for v in me.vertices:
            w = o.matrix_world @ v.co
            for i in range(3):
                if w[i] < vmin[i]:
                    vmin[i] = w[i]
                if w[i] > vmax[i]:
                    vmax[i] = w[i]
            found = True

    if not found:
        return {"objects": len(objs), "tris": 0, "empty": True}

    size = vmax - vmin
    center = (vmax + vmin) / 2.0
    return {
        "objects": len(objs),
        "tris": total_tris,
        "empty": False,
        "min": [round(v, 4) for v in vmin],
        "max": [round(v, 4) for v in vmax],
        "center": [round(v, 4) for v in center],
        "size": [round(v, 4) for v in size],
        "radius": round(max(size) / 2.0, 4),
    }


def export_glb(out_path, draco=False, apply_modifiers=True):
    import bpy
    bpy.ops.object.select_all(action="SELECT")
    kwargs = dict(
        filepath=out_path,
        export_format="GLB",
        export_apply=apply_modifiers,
        export_tangents=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
    )
    if draco:
        kwargs["export_draco_mesh_compression_enable"] = True
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        kwargs.pop("export_tangents", None)
        kwargs.pop("export_apply", None)
        bpy.ops.export_scene.gltf(**kwargs)
    return os.path.isfile(out_path)


# ---------------------------------------------------------------- tileset

def build_tileset(glb_name, stats, lon, lat, height, scale=1.0, up_axis="Z"):
    """按模型真实包围盒生成 tileset.json

    模型局部坐标原点在包围盒中心，所以 box 只有半轴、transform 里带上
    "把包围盒中心放到地面" 的偏移。这里让模型的底面落在 height 上，
    而不是让模型中心落在 height 上 —— 否则一半会埋进地里。
    """
    half = [s / 2.0 * scale for s in stats["size"]]
    center = [c * scale for c in stats["center"]]

    if up_axis == "Z":
        # Blender 是 Z-up；导出 GLB 时 export_yup=True 会转成 Y-up
        # Cesium 里对齐到 ENU 后局部坐标又是 Z-up，这里按 Z-up 算
        lift = half[2] - center[2]
    else:
        lift = half[1] - center[1]

    ts = {
        "asset": {"version": "1.0", "generator": "blend转3dtiles.py"},
        "geometricError": max(1.0, stats["radius"] * scale * 4),
        "root": {
            "transform": enu_matrix(lon, lat, height),
            "refine": "REPLACE",
            "geometricError": 0,
            "boundingVolume": {
                "box": [
                    -center[0] * scale, -center[1] * scale, lift,
                    half[0], 0, 0,
                    0, half[1], 0,
                    0, 0, half[2],
                ]
            },
            "content": {"uri": glb_name},
        },
    }
    return ts


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser(description=".blend -> 3D Tiles")
    ap.add_argument("blend", help=".blend 文件路径")
    ap.add_argument("-o", "--out-dir", help="输出目录（默认 .blend 所在目录）")
    ap.add_argument("--glb-name", help="输出 GLB 文件名（默认与 .blend 同名）")
    ap.add_argument("--lon", type=float, default=108.9)
    ap.add_argument("--lat", type=float, default=34.0)
    ap.add_argument("--height", type=float, default=500.0, help="模型底面所在椭球高（米）")
    ap.add_argument("--scale", type=float, default=1.0, help="模型缩放系数")
    ap.add_argument("--draco", action="store_true", help="开启 Draco 压缩")
    ap.add_argument("--no-export", action="store_true", help="只看统计，不导出")
    ap.add_argument("--exclude", default=DEFAULT_EXCLUDE,
                    help="按物体名正则排除（默认排掉 clouds/mist/fog）")
    ap.add_argument("--keep-plates", action="store_true",
                    help="保留超大背景板（默认自动排掉 <=2 面且面积巨大的平面）")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    blend = os.path.abspath(args.blend)
    if not os.path.isfile(blend):
        print("[错误] 找不到文件：%s" % blend)
        return 2

    out_dir = os.path.abspath(args.out_dir or os.path.dirname(blend))
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(blend))[0]
    glb_name = args.glb_name or (stem + ".glb")
    glb_path = os.path.join(out_dir, glb_name)
    ts_path = os.path.join(out_dir, "tileset.json")

    print("=" * 62)
    print("  .blend -> 3D Tiles")
    print("=" * 62)
    print("  源文件 : %s" % blend)
    print("  输出   : %s" % out_dir)
    print("-" * 62)

    try:
        open_blend(blend)
    except Exception as e:
        print("[错误] 打开 .blend 失败：%s" % e)
        return 3

    before = scene_stats()
    print("  原始场景 : %d 个网格 / %s 三角面" % (before["objects"], format(before.get("tris", 0), ",")))

    removed = apply_exclusions(args.exclude, not args.keep_plates)
    if removed:
        preview = "、".join(removed[:8]) + ("…" if len(removed) > 8 else "")
        print("  已排除   : %d 个装饰物体（%s）" % (len(removed), preview))
    else:
        print("  已排除   : 无")

    st = scene_stats()
    if st.get("empty"):
        print("[错误] 排除之后没有网格物体了（--exclude 是否太宽？）")
        return 4

    print("  网格物体 : %d 个" % st["objects"])
    print("  三角面   : %s" % format(st["tris"], ","))
    print("  包围盒   : X %.1f ~ %.1f m" % (st["min"][0], st["max"][0]))
    print("             Y %.1f ~ %.1f m" % (st["min"][1], st["max"][1]))
    print("             Z %.1f ~ %.1f m" % (st["min"][2], st["max"][2]))
    print("  尺寸     : %.1f x %.1f x %.1f m" % tuple(st["size"]))
    print("  中心     : (%.1f, %.1f, %.1f)" % tuple(st["center"]))
    print("-" * 62)

    if args.no_export:
        print("  （--no-export，只看统计，未导出）")
        return 0

    print("  正在导出 GLB ...")
    try:
        ok = export_glb(glb_path, draco=args.draco)
    except Exception as e:
        print("[错误] 导出 GLB 失败：%s" % e)
        return 5
    if not ok:
        print("[错误] 导出 GLB 失败（文件未生成）")
        return 5
    size_mb = os.path.getsize(glb_path) / (1024.0 * 1024.0)
    print("  GLB 已生成：%s（%.2f MB）" % (glb_path, size_mb))

    ts = build_tileset(glb_name, st, args.lon, args.lat, args.height, args.scale)
    with open(ts_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(ts, f, ensure_ascii=False, indent=2)
    print("  tileset.json 已生成：%s" % ts_path)
    print("-" * 62)
    print("  定位：%.6f°, %.6f°, 底面椭球高 %.1f m" % (args.lon, args.lat, args.height))
    print("  下一步：把这一条加进 js/config.js 的 models：")
    rel = os.path.relpath(ts_path, os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))))))
    print('    { id: "%s", name: "%s", url: "data/model/%s/tileset.json" }'
          % (stem, stem, os.path.basename(os.path.dirname(ts_path))))
    print("  然后重启服务（双击启动查看器.bat），顶栏下拉切换即可。")
    print("=" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main())
