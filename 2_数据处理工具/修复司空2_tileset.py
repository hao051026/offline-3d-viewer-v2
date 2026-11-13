#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
修复 OSGBLab / 司空2 导出的 3DTiles：远距离整片消失、瓦片一直 0 就绪
=====================================================================
症状：相机在整体高度（几公里）看，画面全空，状态栏"瓦片 0 / N"；
      把相机压到单块上方（几百米）才出图。
原因：这类导出的顶层 tileset.json 里，每个分块的节点是一个**纯容器**
      （content 指向该分块的子 tileset .json，自己不带几何），
      但它的 geometricError 只有 3~170 米。Cesium 的细化逻辑是
      "屏幕误差 ≤ maximumScreenSpaceError(默认16) 就不再往下钻"，
      于是远距离时它认为"这个容器已经够精细了"，停在那儿 —— 而容器没有几何，
      画面就空着。子节点的真实几何要再往下一层才够得着。
做法：把顶层每个容器节点的 geometricError 提到 ≈ 根节点的 1/2，
      保证任何可见距离都会继续下钻到真正带 b3dm 的节点；
      同时给 root 补上 refine: REPLACE。
      原始文件备份为 tileset.原始.json，可随时回滚。

用法（在 2_数据处理工具 目录里）：
    python 修复司空2_tileset.py                 # 默认修 ../1_模型查看器/data/model/tileset
    python 修复司空2_tileset.py <tileset.json 路径>
    python 修复司空2_tileset.py --revert        # 回滚到备份
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TS = os.path.normpath(os.path.join(
    HERE, "..", "1_模型查看器", "data", "model", "tileset", "tileset.json"))
BACKUP_SUFFIX = ".原始.json"


def load(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save(path, obj):
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))


def is_container(node):
    """容器节点：自己不带 content（不带几何），只靠 children 往下分发"""
    return "content" not in node and bool(node.get("children"))


def patch(path):
    backup = path + BACKUP_SUFFIX
    if not os.path.exists(backup):
        with open(path, "rb") as src, open(backup, "wb") as dst:
            dst.write(src.read())
        print("已备份原始文件：%s" % backup)

    ts = load(path)
    root = ts.get("root") or {}
    rge = float(ts.get("geometricError") or root.get("geometricError") or 0)

    if not rge:
        print("tileset 的 geometricError 是 0，无法推断阶梯，已退出。")
        return 1

    if root.get("refine") != "REPLACE":
        root["refine"] = "REPLACE"
        print("root.refine 缺失 -> 补为 REPLACE")

    target = round(rge * 0.5, 5)
    changed = 0
    for ch in root.get("children") or []:
        if not is_container(ch):
            continue
        old = ch.get("geometricError")
        if old != target:
            ch["geometricError"] = target
            changed += 1
            if changed <= 3:
                sub = (ch.get("children") or [{}])[0]
                print("  容器节点 %s：geometricError %s -> %s"
                      % (str((sub.get("content") or {}).get("uri"))[:44], old, target))

    if changed == 0:
        print("顶层容器节点已经是修补过的值（%s）。" % target)
    else:
        print("已修补：%d 个顶层容器节点，geometricError 统一为 %.3f（根节点 %.3f 的一半）"
              % (changed, target, rge))

    save(path, ts)
    print("已写入：%s" % path)
    return 0


def revert(path):
    backup = path + BACKUP_SUFFIX
    if not os.path.exists(backup):
        print("没有找到备份文件：%s" % backup)
        return 1
    with open(backup, "rb") as src, open(path, "wb") as dst:
        dst.write(src.read())
    print("已回滚：%s -> %s" % (backup, path))
    return 0


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    path = args[0] if args else DEFAULT_TS
    if not os.path.isfile(path):
        print("找不到 tileset.json：%s" % path)
        return 1
    if "--revert" in sys.argv[1:]:
        return revert(path)
    return patch(path)


if __name__ == "__main__":
    raise SystemExit(main())
