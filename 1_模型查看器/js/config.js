/* ============================================================
 * 小冉学长 · 离线三维模型查看器 —— 配置文件
 * 只改这个文件就能换模型、换标签，不用碰 app.js
 * 所有路径都相对 index.html，且必须是本地文件（离线优先）
 * ============================================================ */

window.VIEWER_CONFIG = {

  /* 应用标题（显示在顶栏） */
  appName: "小冉学长 · 离线三维模型查看器",
  appSub: "大疆司空2 3DTiles / 本地矢量标签",

  /* ---------------- 模型：司空2 导出的 3DTiles ---------------- */
  /* 一个测段一条记录；解压后把 tileset.json 所在的整个文件夹放进 data/model/ 下
     然后在这里把 url 指向该文件夹里的 tileset.json */
  models: [
    {
      id: "xiaozhen",
      name: "小镇（Blender 转换）",
      url: "data/model/小镇（blend）/tileset.json"
    },
    {
      id: "jiaoshi",
      name: "教室（Blender 转换）",
      url: "data/model/教室/tileset.json"
    },
    {
      id: "selftest",
      name: "自检模型（演示）",
      url: "data/model/_自检模型/tileset.json"
    }
    /* 多测段时的写法，解压后照此追加即可：
    ,{ id: "seg-02", name: "测段 02", url: "data/model/tileset-02/tileset.json" }
    */
  ],

  /* ---------------- 矢量标签 ---------------- */
  /* type: "kml" 直接读司空2导出的KML；"json" 读自定义标签（字段见 labels.json 注释）
     icon: 可选，图标形状（pin / arrow / dot / flag / warn / star / cross / square / triangle）
     不填则用 pin（针形标记）。形状在 js/app.js 的 ICON_SHAPES 里可以继续加。 */
  labels: [
    { id: "congestion", name: "小冉拥堵路段标注", type: "json", url: "data/vector/拥堵路段.json", enabled: true,  color: "#00d4aa" },
    { id: "dj-kml", name: "司空2 标注（KML 原样）", type: "kml",  url: "data/vector/重点拥堵路段.kml", enabled: false, color: "#ff5b5b" },
    { id: "survey", name: "病害标签（JSON）",   type: "json", url: "data/vector/labels.json",  enabled: false, color: "#ffc53d" },
    { id: "selftest", name: "自检标签",         type: "json", url: "data/vector/自检标签.json", enabled: false, color: "#00d4aa" }
  ],

  /* ---------------- 多模型同时显示 ---------------- */
  /* true = 允许多个模型同时在场景里（默认开启）
     顶栏选择器选中模型时默认"加入场景"，图层面板可单独移除 */
  multiModel: true,

  /* 新增模型时的默认缩放（米），只对 .glb 单模型生效 */
  glbDefaultSize: 100,

  /* ---------------- 本地记忆 ---------------- */
  /* 用户手动添加的模型/标签记在浏览器里，下次打开自动恢复 */
  rememberAdded: true,

  /* ---------------- 默认视角 ---------------- */
  /* 留 null 则每次加载模型后自动飞到模型整体范围（推荐）
     需要固定开机视角时，填入 {lon, lat, height, heading, pitch}  */
  defaultView: null,
  /* 自动飞行到模型的俯仰角（-90 = 正俯视，-45 = 45°斜视） */
  autoFlyPitch: -55,

  /* ---------------- 场景 ---------------- */
  scene: {
    background: "#0d1b2a",       // 三维背景色（离线无影像底图时用纯色更干净）
    fog: false,                   // 关闭雾效，近处清晰
    maxScreenSpaceError: 16,      // 瓦片精细度：越小越清晰越吃性能，8~24 之间调
    showGizmo: false
  },

  /* ---------------- 标签样式 ---------------- */
  label: {
    font: '500 13px "Microsoft YaHei", "Segoe UI", sans-serif',
    scale: 1.0,
    outlineWidth: 3,
    hideTextDistance: 1500,       // 超过该距离（米）只留图标不留文字，省性能
    iconScale: 0.55,              // 图标大小系数
    pointPixelSize: 9,            // 无图标时默认标点大小（像素）
    lineWidth: 3,                 // 线要素宽度（像素）
    lineLiftM: 0.5                // 线要素整体抬高（米），防止埋在路面里
  },

  /* ---------------- 本地记忆的键名（模型偏移等） ---------------- */
  storage: {
    offset: "xz3d.modelOffset",
    lastModel: "xz3d.lastModel"
  }
};
