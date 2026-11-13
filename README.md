# 离线三维模型查看器（Offline 3D Viewer）

> **小冉学长** · 大疆司空2 3DTiles + 本地矢量标签，全程不联网，双击即用。

一个能拷进 U 盘带到工地现场的**离线三维查看器**：不需要装 Python、不需要联网、
不需要任何服务端。插上 U 盘双击 `启动查看器.bat` 就能打开 3D 模型、叠加病害标注、
量长度面积、出截图。

配套还带一套 Python 数据处理工具：司空2 KML 转标注、tileset 体检、
LOD 断档修复、以及把 Blender 模型转成 3D Tiles。

---

## 这个仓库包含什么

本仓库**只包含代码、工具和文档**（约 15 MB，其中 12.5 MB 是内置的 Cesium 引擎）。
3D 模型数据、KML 标注、`.blend`/`.max` 源文件**不在仓库里**（约 190 MB），
需要自己放入对应目录，见下方「准备数据」。

```
├─ 1_模型查看器/              离线查看包（可直接拷走）
│   ├─ 启动查看器.bat         ← 双击这个启动
│   ├─ serve.py               本地只读服务（Python 版）
│   ├─ serve.ps1              本地只读服务（免 Python 版）
│   ├─ index.html css/ js/    界面与逻辑（config.js 是唯一的配置文件）
│   ├─ lib/cesium/            内置 CesiumJS 1.147，无 CDN 依赖
│   ├─ data/model/            ← 模型放这里（git 忽略）
│   └─ data/vector/           ← KML / 标注 JSON 放这里（git 忽略）
├─ 2_数据处理工具/            Python 工具集
│   ├─ kml转标签json.py       司空2 KML → 标注 JSON（自动拆属性、分组、按范围切分）
│   ├─ 检查tileset.py         tileset 体检（缺文件 / LOD 断档一眼看出）
│   ├─ 修复司空2_tileset.py   修司空2 导出的 LOD 断档（备份可回滚）
│   ├─ blend转3dtiles.py      .blend → GLB + tileset.json（bpy 驱动，免装 Blender）
│   └─ 生成自检模型.py        生成 20m 立方体自检模型
├─ 3_成果输出/                截图、报告
├─ MAINTAINING.md             ← 维护守则（改代码前必读）
├─ README.完整手册.md         原版现场操作手册（含 10 GB 完整包说明）
└─ LICENSE                    MIT（内置 Cesium 为 Apache-2.0）
```

> ⚠️ **本仓库是 Public 的。** 提交前请先读 [MAINTAINING.md](MAINTAINING.md)，
> 里面列了不能提交的内容（真实项目名、桩号、精确坐标、个人邮箱）。
> 敏感信息一旦进了历史，普通提交删不掉，必须改写历史并强推。

---

## 快速开始

### 1. 启动查看器

双击：

```
1_模型查看器\启动查看器.bat
```

会自动起一个本机服务并打开浏览器（默认 `http://127.0.0.1:8765/index.html`）。
**关闭黑色命令行窗口 = 停止服务。**

启动脚本会按顺序找路，两条路行为完全一致：

| 顺序 | 用什么 | 说明 |
| --- | --- | --- |
| 1 | `py` / `python` | 有 Python 3 就走 `serve.py` |
| 2 | Windows 内置组件 | 没 Python 自动用 `serve.ps1`（优先 http.sys，被组策略限制时退回手写 TCP） |

**两种都不需要管理员权限，都不需要装任何东西。**

> ⚠️ **不要双击 `index.html`。** `file://` 协议下浏览器会拦截本地瓦片读取，
> 模型永远加载不出来——这是这类离线三维包最常见的"打不开"原因。

### 2. 准备数据

模型和标注不在仓库里，按需放入：

| 要放的 | 放到哪 | 说明 |
| --- | --- | --- |
| 司空2 导出的 3DTiles | `1_模型查看器/data/model/tileset/` | `tileset.json` 必须在**最外层**，不要把整个文件夹再套一层 |
| Blender 模型 | 用 `blend转3dtiles.py` 转换 | 见下方「Blender 模型转换」 |
| 司空2 导出的 KML | `1_模型查看器/data/vector/` | 用 `kml转标签json.py` 转成标注 JSON |

放好后在 `1_模型查看器/js/config.js` 的 `models` 里加一条，重启服务即可。

没有模型也能先验软件：点引导页的**「先看自检模型」**，或用
`生成自检模型.py` 现场生成一个 20 米立方体。

---

## 支持的数据格式

| 格式 | 支持 | 说明 |
| --- | --- | --- |
| 3D Tiles（`.b3dm` + `tileset.json`） | ✅ 原生 | 司空2 导出的标准格式，带 LOD |
| glTF / GLB（`.glb` / `.gltf`） | ✅ 原生 | 单文件模型，需配一个最简 `tileset.json` |
| KML | ✅ 原生 | 查看器会自动把外网图标替换成本地图标 |
| Blender（`.blend`） | ⚠️ 需转换 | 用 `blend转3dtiles.py`，**不需要装 Blender** |
| 3ds Max（`.max`） | ❌ 不支持 | OLE2 私有格式，无可用开源解析器。请在 Max 里导出 glTF/FBX 中转 |
| OBJ / FBX / STL | ⚠️ 需转换 | 先用 Blender 导入再导出 GLB |

---

## 数据处理工具

### KML → 标注 JSON

```powershell
cd 2_数据处理工具
py -3 kml转标签json.py "..\1_模型查看器\data\vector\defect.kml" `
    -o "..\1_模型查看器\data\vector\labels.json" --name "病害标注"
```

司空2 导出的 KML 常常混着点、长线、一堆同名短线段。脚本支持按类型、
名称正则、地理范围拆分分组，同一条 KML 跑几遍 `--append` 追加到同一个 JSON：

```powershell
# 只收点要素，并按模型范围切分内外（lon,lat,半径米 换成你自己的模型中心）
py -3 kml转标签json.py $kml -o $out --only-type point --clip "120.000000,30.000000,5000"
py -3 kml转标签json.py $kml -o $out --append --only-type polyline --no-line-labels `
    --clip "120.000000,30.000000,5000" --clip-mode outside --hidden
```

<details>
<summary>完整参数表</summary>

| 参数 | 作用 |
| --- | --- |
| `--only-type point/polyline/polygon` | 只收某一类几何 |
| `--name-re` / `--exclude-re` | 按名称正则收 / 排 |
| `--no-line-labels` | 线/面不打文字标签（避免同名短线糊屏） |
| `--clip lon,lat,半径米` + `--clip-mode inside/outside` | 按范围切分模型内/外 |
| `--hidden` | 该分组默认隐藏，图层面板可再打开 |
| `--append` | 追加到已有 JSON，不清空 |
| `--group-id` / `--color` | 分组 id 与颜色 |

</details>

### tileset 体检与 LOD 修复

司空2 导出的一个通病：**远看整片空白，凑近才出图**。
原因是顶层容器节点的 `geometricError` 写得太小，Cesium 远距离时不再往下钻，
而容器本身没有几何。

```powershell
py -3 检查tileset.py "..\1_模型查看器\data\model\tileset\tileset.json"
py -3 修复司空2_tileset.py     # 会自动备份成 tileset.json.原始.json
py -3 修复司空2_tileset.py --revert   # 回滚
```

修复只做两件事：把顶层容器节点的 `geometricError` 提到根节点的一半，
并给 `root` 补 `refine: REPLACE`。**不动瓦片文件、不动坐标、不动层级。**

### Blender 模型转换

`.blend` 不能直接看，要先转 3D Tiles。**不需要装图形界面 Blender**——
用 `bpy` 这个 Python 模块（本质是 Blender 本体）在命令行里转：

```powershell
# 一次性装好（约 750 MB，只在转换这台机器上需要）
uv pip install --python .venv_bpy\Scripts\python.exe `
    --index-url https://pypi.tuna.tsinghua.edu.cn/simple bpy

# 只看结构，不导出
.venv_bpy\Scripts\python.exe blend转3dtiles.py "模型.blend" --no-export

# 正式转换
.venv_bpy\Scripts\python.exe blend转3dtiles.py "模型.blend" `
    --lon 108.9 --lat 34.0 --height 500
```

转换器自动处理三个容易踩的坑：

1. **按真实包围盒算 tileset** — `boundingVolume.box` 用实测半轴，并让模型
   **底面**落在 `--height` 上，而不是中心落地（否则一半埋进地里）
2. **排掉装饰物体** — `clouds*`/`mist*`/`fog*` 以及 ≤2 面且面积巨大的贴图板
   在 GIS 里只会挡住视线，默认删掉（`--keep-plates` 可保留）
3. **中文路径** — 全程 UTF-8，目录名带中文或全角括号也能跑

> `bpy` 的 wheel 有 Python 版本限制（5.x 需要 3.13）。装不上时先确认 Python 版本。

---

## 已知的坑

### 高程基准

司空2 导出的是 **WGS84 椭球高（HAE）**，不是台账用的**海拔（ASL）**，
两者在你的地区可能差 **30~50 m**（具体差值取决于当地大地水准面差距）。

- 只看模型形状：不受影响
- 标实测海拔的病害点：标签会整体飘在模型上方约 40 m
- 修法：用左侧「校正」面板把高程往下压到贴合

### 线要素被路面吃掉

司空2 的线高程常比路面低一两米，直接画会被深度测试裁掉。
查看器已默认对线关闭深度测试并抬高 `label.lineLiftM`（0.5 m）。

### 换模型后必须重启服务

免 Python 版启动时会把 `data/model/tileset/` 下的层级 JSON 预读进内存，
好让瓦片快速就绪。**换模型后不重启就会继续用旧的层级表。**

---

## 快捷键与操作

| 想干什么 | 操作 |
| --- | --- |
| 转视角 / 平移 / 缩放 | 左键拖 / 右键拖 / 滚轮 |
| 回到模型全景 | 按 `1` |
| 正俯视看平面 | 按 `2` |
| 低角度看侧立面 | 按 `3` |
| 看要素属性、照片 | 左键点标签 → 右侧属性面板 |
| 按类型显隐 | 左工具条「图层」→ 点分组行 |
| 量长度 / 面积 | 左工具条「测量」→ 左键点节点、**右键结束** |
| 按编号定位 | 「图层」面板底部 → 输入编号或桩号 |
| 模型整体浮起或错位 | 左工具条「校正」→ 东/北/高 微调 |
| 出汇报图 | 左工具条「截图」，PNG 存到下载目录 |

---

## 技术说明

- **不联网**：不请求任何在线影像、地形、ion 服务、geocoder。
  代价是没有影像底图，模型之外是纯色背景——这是刻意的，现场网络不可靠。
- **不转坐标系**：全程 WGS84 经纬度 + 椭球高。
  转局部 ENU 会同时毁掉模型 LOD 和标签对齐。
- **只读查看**：能看、能量、能出图、能显隐，不能在这里新增病害回写司空2。
- 服务只监听 `127.0.0.1`，补了 `.b3dm/.glb/.wasm` 的 MIME，
  源码与 JSON 一律 `no-store`（改了配置刷新即生效）。

---

## License

本项目代码以 [MIT](LICENSE) 许可发布。

### 第三方组件

`1_模型查看器/lib/cesium/` 内置了 **CesiumJS 1.147**，遵循 **Apache License 2.0**，
许可证全文见 `1_模型查看器/lib/cesium/LICENSE.md`。

CesiumJS 还捆绑了若干第三方库（Draco 解码器、Basis Universal 转码器、
Google Earth DB 解析器等，位于 `lib/cesium/ThirdParty/`），它们各自带有自己的
开源许可证，原始版权声明保留在对应文件中。

> 说明：本项目未修改 CesiumJS 源码，仅作原样分发，符合 Apache-2.0 的要求。
> 如果你要替换为其他版本的 Cesium，请一并保留其 `LICENSE` 与版权声明。
