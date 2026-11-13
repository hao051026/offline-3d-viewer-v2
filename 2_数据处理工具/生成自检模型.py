#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成"自检模型"：一个 20 米见方的立方体 3DTiles（3D Tiles 1.1 + glTF）
=================================================
用途：模型还没下载到位、或者怀疑查看器本身有问题时，用这个最小模型
      验证"能不能加载、能不能飞过去、标签能不能点"。

不依赖任何第三方库，纯标准库生成 GLB + tileset.json。

用法（在 2_数据处理工具 目录里）：
    python 生成自检模型.py
输出：
    1_模型查看器\\data\\model\\_自检模型\\tileset.json
    1_模型查看器\\data\\model\\_自检模型\\content.glb
    1_模型查看器\\data\\vector\\自检标签.json
然后在查看器里"手动指定 tileset.json"输入 data/model/_自检模型/tileset.json
"""

import json
import math
import os
import struct

A = 6378137.0
B = 6356752.314245
E2 = 1 - (B * B) / (A * A)

LON = 108.900000
LAT = 34.000000
HEIGHT = 1600.0
HALF = 10.0   # 立方体半边长，米

HERE = os.path.dirname(os.path.abspath(__file__))
VIEWER = os.path.normpath(os.path.join(HERE, "..", "1_模型查看器"))


def enu_matrix():
    """以经纬度点为原点的 东-北-天 坐标系矩阵（Cesium 要求列主序 16 个数）"""
    phi = math.radians(LAT)
    lam = math.radians(LON)
    n = A / math.sqrt(1 - E2 * math.sin(phi) ** 2)
    x = (n + HEIGHT) * math.cos(phi) * math.cos(lam)
    y = (n + HEIGHT) * math.cos(phi) * math.sin(lam)
    z = (n * (1 - E2) + HEIGHT) * math.sin(phi)

    east = (-math.sin(lam), math.cos(lam), 0.0)
    north = (-math.sin(phi) * math.cos(lam), -math.sin(phi) * math.sin(lam), math.cos(phi))
    up = (math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi))

    m = list(east) + [0.0] + list(north) + [0.0] + list(up) + [0.0] + [x, y, z, 1.0]
    return [round(v, 10) for v in m]


def build_glb():
    """20 米立方体（局部坐标），带法线、索引、单色材质"""
    h = HALF
    # 6 个面，每面 4 个顶点
    faces = [
        ((0, 0, 1), [(-h, -h, h), (h, -h, h), (h, h, h), (-h, h, h)]),      # 顶
        ((0, 0, -1), [(-h, h, -h), (h, h, -h), (h, -h, -h), (-h, -h, -h)]),  # 底
        ((0, -1, 0), [(-h, -h, -h), (h, -h, -h), (h, -h, h), (-h, -h, h)]),  # 北
        ((0, 1, 0), [(-h, h, h), (h, h, h), (h, h, -h), (-h, h, -h)]),       # 南
        ((-1, 0, 0), [(-h, -h, -h), (-h, -h, h), (-h, h, h), (-h, h, -h)]),   # 西
        ((1, 0, 0), [(h, -h, h), (h, -h, -h), (h, h, -h), (h, h, h)]),        # 东
    ]

    positions, normals, indices = [], [], []
    for normal, quad in faces:
        base = len(positions)
        for v in quad:
            positions.append(list(v))
            normals.append(list(normal))
        indices += [base, base + 1, base + 2, base, base + 2, base + 3]

    pos_bytes = b"".join(struct.pack("<3f", *p) for p in positions)
    nrm_bytes = b"".join(struct.pack("<3f", *n) for n in normals)
    idx_bytes = b"".join(struct.pack("<H", i) for i in indices)

    views = [
        {"buffer": 0, "byteOffset": 0, "byteLength": len(pos_bytes), "target": 34962},
        {"buffer": 0, "byteOffset": len(pos_bytes), "byteLength": len(nrm_bytes), "target": 34962},
        {"buffer": 0, "byteOffset": len(pos_bytes) + len(nrm_bytes), "byteLength": len(idx_bytes), "target": 34963},
    ]
    bin_blob = pos_bytes + nrm_bytes + idx_bytes
    if len(bin_blob) % 4:
        bin_blob += b"\x00" * (4 - len(bin_blob) % 4)

    gltf = {
        "asset": {"version": "2.0", "generator": "xizhen offline viewer self-test"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "self-test-cube"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "material": 0}]}],
        "materials": [{
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.18, 0.72, 0.60, 1.0],
                "metallicFactor": 0.05,
                "roughnessFactor": 0.75
            },
            "doubleSided": True
        }],
        "buffers": [{"byteLength": len(bin_blob)}],
        "bufferViews": views,
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(positions), "type": "VEC3",
             "min": [-h, -h, -h], "max": [h, h, h]},
            {"bufferView": 1, "componentType": 5126, "count": len(normals), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5123, "count": len(indices), "type": "SCALAR"}
        ]
    }

    json_chunk = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)

    total = 12 + 8 + len(json_chunk) + 8 + len(bin_blob)
    out = bytearray()
    out += b"glTF" + struct.pack("<II", 2, total)
    out += struct.pack("<I", len(json_chunk)) + b"JSON" + json_chunk
    out += struct.pack("<I", len(bin_blob)) + b"BIN\x00" + bin_blob
    return bytes(out)


def build_b3dm(glb_bytes):
    """把 GLB 包成一个 3D Tiles 1.0 的 b3dm 瓦片（司空2 导出的就是这种格式）。

    b3dm 头 28 字节 + FeatureTable JSON + BatchTable JSON + 内嵌 GLB。
    这里 BATCH_LENGTH=0（没有按要素分批），并保证内嵌 GLB 落在 8 字节边界上。
    """
    ft = b'{"BATCH_LENGTH":0}'
    while (28 + len(ft)) % 8:          # 让 glTF 起点对齐到 8 字节
        ft += b" "
    byte_length = 28 + len(ft) + len(glb_bytes)
    header = struct.pack("<4sIIIIII", b"b3dm", 1, byte_length,
                         len(ft), 0, 0, 0)
    return header + ft + glb_bytes


def build_tileset():
    return {
        "asset": {"version": "1.0", "generator": "xizhen offline viewer self-test"},
        # 注意：tileset 级 geometricError 必须是正数，全 0 的话 Cesium 不会去请求瓦片内容
        "geometricError": 100,
        "root": {
            "transform": enu_matrix(),
            "refine": "REPLACE",
            "geometricError": 0,
            "boundingVolume": {
                "box": [0, 0, 0, HALF, 0, 0, 0, HALF, 0, 0, 0, HALF]
            },
            "content": {"uri": "content.b3dm"}
        }
    }


def lon_of_meters(east_m):
    return LON + east_m / (111320.0 * math.cos(math.radians(LAT)))


def lat_of_meters(north_m):
    return LAT + north_m / 110574.0


def build_labels():
    pts = [
        ("自检-顶面", 0.0, 0.0, HEIGHT + HALF, "顶面中心，验证标签是否落在模型上", "#2fd6a4"),
        ("自检-东角", HALF, 0.0, HEIGHT, "东侧棱，验证横向定位", "#4aa8ff"),
        ("自检-南角", 0.0, -HALF, HEIGHT - 4, "南侧 4 米高处", "#ffc53d"),
    ]
    features = []
    for i, (name, e, n, h, note, color) in enumerate(pts, 1):
        features.append({
            "id": "TEST-%03d" % i,
            "group": "selftest",
            "name": name,
            "type": "point",
            "coordinates": [round(lon_of_meters(e), 8), round(lat_of_meters(n), 8), round(h, 2)],
            "label": name,
            "showLabel": True,
            "properties": {
                "编号": "TEST-%03d" % i,
                "说明": note,
                "高程基准": "WGS84 椭球高(HAE)",
                "颜色": color
            }
        })
    return {
        "_说明": "查看器自检用标签，配合 data/model/_自检模型 使用。真实项目请换成司空2 导出的数据。",
        "version": 1,
        "name": "自检标签",
        "groups": [{"id": "selftest", "name": "自检标签", "color": "#2fd6a4"}],
        "features": features
    }


def main():
    model_dir = os.path.join(VIEWER, "data", "model", "_自检模型")
    vector_dir = os.path.join(VIEWER, "data", "vector")
    os.makedirs(model_dir, exist_ok=True)
    os.makedirs(vector_dir, exist_ok=True)

    glb = build_glb()
    if glb[:4] != b"glTF":
        raise RuntimeError("GLB 头写错了")

    b3dm = build_b3dm(glb)
    if b3dm[:4] != b"b3dm":
        raise RuntimeError("b3dm 头写错了")

    with open(os.path.join(model_dir, "content.glb"), "wb") as fh:
        fh.write(glb)
    with open(os.path.join(model_dir, "content.b3dm"), "wb") as fh:
        fh.write(b3dm)
    with open(os.path.join(model_dir, "tileset.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(build_tileset(), fh, ensure_ascii=False, indent=2)
    with open(os.path.join(vector_dir, "自检标签.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(build_labels(), fh, ensure_ascii=False, indent=2)

    print("自检模型已生成：")
    print("  %s" % os.path.join(model_dir, "tileset.json"))
    print("  %s（%.1f KB，司空2 同款瓦片格式）" % (os.path.join(model_dir, "content.b3dm"), len(b3dm) / 1024.0))
    print("  %s（%.1f KB，排障时可直接当 Model 加载）" % (os.path.join(model_dir, "content.glb"), len(glb) / 1024.0))
    print("  %s" % os.path.join(vector_dir, "自检标签.json"))
    print()
    print("在查看器里点「手动指定 tileset.json」，输入：")
    print("  data/model/_自检模型/tileset.json")
    print("然后把 自检标签.json 加到 config.js 的 labels 里（或直接改 data/vector/labels.json）。")


if __name__ == "__main__":
    main()
