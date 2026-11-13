# 维护守则

> 给后续维护者（包括 AI 助手）的交接说明。改代码前先看这一页。

---

## 一、绝对红线

### 1. 不得提交真实项目信息

本仓库是 **Public** 的。任何提交前必须确认没有以下内容：

| 禁止项 | 举例 |
| --- | --- |
| 真实高速公路名称 | 具体路线名、路段名 |
| 甲方 / 业主单位名 | 交通投资集团、管理处、养护中心 |
| 桩号 | 形如 `K9xx+xxx` 的里程标注 |
| 精确经纬度 | 真实工程坐标（示例统一用 `120.000000,30.000000`） |
| 省市地域线索 | 「某某省一带」→ 改为「你所在地区」 |
| 个人邮箱 | 用 GitHub noreply 地址 |
| 真实模型资源 | `.blend` / `.glb` / `.max` / `.b3dm` 一律不进仓库 |

提交前跑一次自检：

```bash
# 工作区
git grep -n -E "路名|单位名|K[0-9]{2,3}\\+[0-9]{3}|真实经度" -- . ":(exclude)1_模型查看器/lib/cesium"

# 全历史（更严格，含已删除文件）
git log -p --all | grep -n -E "路名|单位名|K[0-9]{2,3}\\+"
```

**一旦敏感内容进了历史，普通 commit 删不掉**，必须改写历史并强推（见第四节）。
所以：**宁可在提交前多检查一次**。

### 2. 不要动 Cesium 库内部文件

`1_模型查看器/lib/cesium/` 是 CesiumJS 1.147 原样分发，遵循 Apache-2.0。

- `LICENSE.md` **必须保留**（Apache-2.0 第 4 条强制要求，删了就是许可证违规）
- 不要格式化、压缩或"优化" `Cesium.js`
- 升级 Cesium 时同步替换 `LICENSE.md` 并检查 `ThirdParty/` 里的版权声明

### 3. 不要转换坐标系

全程 **WGS84 经纬度 + 椭球高（HAE）**。
转成局部 ENU 或投影坐标会同时毁掉模型 LOD 和标签对齐，且不可逆。

---

## 二、提交规范

- 提交信息用中文，首行说明「做了什么」，正文说「为什么」
- 提交者必须是 `hao051026 <200072337+hao051026@users.noreply.github.com>`
  （本地 `git config user.email` 已设好，**不要改**，否则真实邮箱会再次泄露）
- 一次提交只做一件事，便于回滚

---

## 三、验收清单

改完代码**必须实测**，不能只看语法：

```bash
cd 1_模型查看器
py -3 serve.py --port 8810 --no-browser
```

然后确认：

| 项 | 期望 |
| --- | --- |
| `index.html` / `app.js` / `config.js` / `css` | HTTP 200 |
| `lib/cesium/Cesium.js` | HTTP 200，约 6 MB |
| 顶栏下拉框 | 有「小镇」「教室」「自检模型」三项 |
| 三维视图 | 模型可见，状态栏「瓦片 已加载」 |
| 图层面板 | 共 76 个要素 |
| 浏览器控制台 | 无红色报错 |

> 注意：`data/model/` 与 `data/vector/` 被 gitignore 排除，
> **本地有数据不代表仓库里有**。首次克隆的人需要自己放数据。

---

## 四、历史改写流程（仅在误提交敏感信息时使用）

```bash
# 0. 先备份
Compress-Archive -Path .git -DestinationPath ..\backup_$(date).zip

# 1. 安装工具
py -3 -m pip install git-filter-repo

# 2. 清洗（替换表要先长后短，否则短词会吃掉长词）
git filter-repo --replace-text scrub.txt --force

# 3. 若文件是 UTF-16 编码，--replace-text 会完全失效
#    必须用 --commit-callback 直接删除旧版本，或先转码

# 4. 清掉备份 ref 与 reflog（否则旧提交仍可访问）
git update-ref -d refs/original/refs/heads/main
git reflog expire --expire=now --all
git gc --prune=now --aggressive

# 5. 强推（filter-repo 会删掉 remote，要先加回来）
git remote add origin https://github.com/hao051026/offline-3d-viewer.git
git push --force origin main
```

**踩过的坑（别再犯）：**

1. **替换顺序**：短词规则写在长词规则之前，会导致长词被拆碎。
   必须严格「先长后短」排序。
2. **UTF-16 是黑洞**：`--replace-text` 按 UTF-8 处理，UTF-16 文件一个字符都换不掉，
   而且不报错。用 `--commit-callback` 删掉旧版本更可靠。
3. **`refs/original/` 不清，等于没改**：GitHub 上旧提交仍可通过哈希访问。
4. **PowerShell 管道会破坏二进制**：`git cat-file blob X | Out-String` 会吞字节，
   造成"blob 是 UTF-16"的假象。验证用 `cmd /c "git cat-file blob X > f.bin"` 或 Python。

---

## 五、项目结构要点

```
1_模型查看器/
  js/config.js        ← 唯一的配置文件（模型列表、标签列表、配色、性能参数）
  js/app.js           ← 主逻辑，改之前先读懂状态对象 S
  serve.py            ← 有 Python 时走这条
  serve.ps1           ← 无 Python 时走这条，行为必须与 serve.py 对齐
  data/model/         ← 模型（gitignore）
  data/vector/        ← 标注（gitignore）
  lib/cesium/         ← 第三方库，别动内部
2_数据处理工具/
  blend转3dtiles.py   ← .blend → GLB + tileset.json（依赖 bpy）
  kml转标签json.py    ← 司空2 KML → 标注 JSON
  检查tileset.py      ← tileset 体检
  修复司空2_tileset.py ← 修 LOD 断档
  生成自检模型.py      ← 生成 20m 立方体
```

**改 `config.js` 时注意**：里面的 `url` 必须与磁盘上的实际文件名**完全一致**
（含中文、全角括号）。改过名就要同步改引用，否则那一层会静默加载失败。

**`serve.py` 与 `serve.ps1` 必须保持行为一致**：同样的 MIME 表、同样的
`no-store` 策略、同样的 `/__model_status` 探针。只改一个会造成"有 Python 能开、
没 Python 白屏"的诡异问题。

---

## 六、`.blend` 转换环境

`bpy` 的 wheel 有 Python 版本限制（5.x 需要 Python 3.13+）。

```powershell
# 一次性环境（约 750 MB，只在转换机上需要）
uv python install 3.13
uv venv .venv_bpy --python 3.13
uv pip install --python .venv_bpy\Scripts\python.exe `
    --index-url https://pypi.tuna.tsinghua.edu.cn/simple bpy

# 转换
.venv_bpy\Scripts\python.exe "2_数据处理工具\blend转3dtiles.py" `
    "模型.blend" --lon 108.9 --lat 34.0 --height 500
```

**用国内镜像**：从 PyPI 官方源拉 bpy 只有约 0.13 MB/s，
换清华源后 27 秒就下载完。

---

## 七、已知限制

- `.max`（3ds Max）**无法转换**：OLE2 容器 + 私有序列化，没有可用开源解析器。
  需要在 Max 里导出 glTF/FBX 中转。
- 模型数据不在仓库里，克隆后需自行准备，或查看 Release/网盘链接。
- 查看器只读，不能新增病害回写司空2。
