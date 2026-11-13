#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小冉学长 · 离线三维模型查看器 —— 本地静态服务
=================================================
为什么需要它：Cesium 要用 fetch / Worker 读本地 3DTiles 瓦片，
直接双击 index.html（file:// 协议）会被浏览器跨域拦死，模型一定加载不出来。
这个脚本在本机起一个只读的 HTTP 服务，全程不联网、不对外网开放。

用法：
    python serve.py                 # 自动选端口并打开浏览器
    python serve.py --port 8765     # 指定端口
    python serve.py --no-browser    # 不起浏览器（现场演示用）
"""

import argparse
import json
import os
import socket
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

# 3DTiles / Cesium 需要的 MIME（Windows 自带的表里没有这些，缺了会白屏或 Draco 解码失败）
EXTRA_TYPES = {
    ".b3dm": "application/octet-stream",
    ".pnts": "application/octet-stream",
    ".i3dm": "application/octet-stream",
    ".cmpt": "application/octet-stream",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".bin": "application/octet-stream",
    ".terrain": "application/vnd.quantized-mesh",
    ".wasm": "application/wasm",
    ".json": "application/json; charset=utf-8",
    ".geojson": "application/json; charset=utf-8",
    ".kml": "application/vnd.google-earth.kml+xml; charset=utf-8",
    ".kmz": "application/vnd.google-earth.kmz",
    ".svg": "image/svg+xml",
    ".ktx2": "image/ktx2",
    ".webp": "image/webp",
}


class Handler(SimpleHTTPRequestHandler):
    """只读静态服务：补 MIME、禁缓存源码、安静日志"""

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("directory", HERE)
        super().__init__(*args, **kwargs)

    # ---- 模型状态探测：避免查看器反复 HEAD 404 刷控制台 ----
    def _model_status(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        rel = (qs.get("path", [""])[0] or "").lstrip("/")
        target = os.path.normpath(os.path.join(HERE, rel)) if rel else HERE
        inside = os.path.abspath(target).startswith(os.path.abspath(HERE))
        exists = inside and os.path.isfile(target)
        body = json.dumps({"exists": exists, "path": rel, "size": os.path.getsize(target) if exists else 0}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/__model_status"):
            self._model_status()
            return
        super().do_GET()

    def do_HEAD(self):
        if self.path.startswith("/__model_status"):
            self._model_status()
            return
        super().do_HEAD()

    def guess_type(self, path):
        ext = os.path.splitext(str(path).split("?")[0])[1].lower()
        if ext in EXTRA_TYPES:
            return EXTRA_TYPES[ext]
        return super().guess_type(path)

    def end_headers(self):
        # 源码与配置必须每次取最新（否则改了 config.js 刷新还看不到变化），瓦片可以缓存
        target = self.path.lower().split("?")[0]
        if target.endswith((".json", ".kml", ".js", ".css", ".html", ".htm")):
            self.send_header("Cache-Control", "no-store")
        else:
            self.send_header("Cache-Control", "public, max-age=3600")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 正常访问不刷屏，只在出错时打一行
        code = args[1] if len(args) > 1 else ""
        if str(code).startswith(("4", "5")):
            sys.stderr.write("[HTTP %s] %s\n" % (code, args[0]))


def find_free_port(start=8765, tries=60):
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("8765~%d 端口都占用了，请先关掉别的服务" % (start + tries))


def model_report():
    """启动时顺手体检一下模型目录，让操作员一眼知道模型到没到。
    只看 tileset.json 与分块目录数：以前这里递归数 5 万个瓦片，
    在 U 盘上要走十几秒到几分钟，期间服务不监听端口，看着像“起不来”。"""
    ts = os.path.join(HERE, "data", "model", "tileset", "tileset.json")
    if not os.path.isfile(ts):
        return "未检测到模型（data/model/tileset/tileset.json 不存在）—— 查看器会每 5 秒自动检测"
    base = os.path.dirname(ts)
    try:
        ts_size = os.path.getsize(ts)
        blocks = 0
        for name in os.listdir(base):
            if os.path.isdir(os.path.join(base, name)):
                blocks += 1
    except OSError:
        return "已检测到 tileset.json；瓦片数由查看器自己统计"
    return "已检测到 tileset.json（%.0f KB），%d 个分块目录；瓦片数由查看器自己统计" % (ts_size / 1024.0, blocks)


def main():
    ap = argparse.ArgumentParser(description="离线三维查看器 本地服务")
    ap.add_argument("--port", type=int, default=0, help="端口，默认自动选择")
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = ap.parse_args()

    port = args.port or find_free_port()
    url = "http://127.0.0.1:%d/index.html" % port

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    print("=" * 62)
    print("  小冉学长 · 离线三维模型查看器")
    print("=" * 62)
    print("  服务地址 : %s" % url)
    print("  工作目录 : %s" % HERE)
    print("  模型状态 : %s" % model_report())
    print("-" * 62)
    print("  关闭这个窗口 = 停止服务。演示时不联网也能正常用。")
    print("=" * 62)

    if not args.no_browser:
        threading.Timer(0.9, lambda: webbrowser.open(url)).start()

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止服务。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
