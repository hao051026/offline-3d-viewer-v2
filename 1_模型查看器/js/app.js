/* ============================================================
 * 小冉学长 · 离线三维模型查看器 —— 主逻辑
 * 纯离线：不请求任何在线影像/地形/ion/geocoder，全部走本机文件
 * ============================================================ */
(function () {
  "use strict";

  var CFG = window.VIEWER_CONFIG || {};
  var CES = window.Cesium;
  if (!CES) { document.getElementById("emptyTitle").textContent = "Cesium 库未加载成功"; return; }

  /* ------------------------------ 运行状态 ------------------------------ */
  var S = {
    viewer: null,
    tileset: null,             // 主模型（兼容旧代码；等于 models[0]）
    models: [],                // 多模型：每条 { id, name, url, type, tileset, baseCenter, offset, show, ready }
    modelDef: null,
    baseCenter: null,
    offset: { east: 0, north: 0, up: 0 },
    layers: [],                // 矢量图层
    userLabels: [],            // 用户手动添加的标签源（可持久化）
    measure: { mode: null, points: [], preview: null },
    measureDS: null,
    /* 标绘：在地图上点/画标签 */
    draw: { mode: null, points: [], preview: null, pending: null },
    drawDS: null,
    selected: null,
    watchTimer: null,
    modelReady: false,
    activePanel: null
  };

  var MEASURE_COLOR = CES.Color.fromCssColorString("#00d4aa");
  var LAYER_COLORS = ["#ff5b5b", "#ffc53d", "#4aa8ff", "#00d4aa", "#c77dff", "#ff8f4a"];

  /* ------------------------------ 小工具 ------------------------------ */
  /* 要素属性自己存：不依赖 Cesium 的 PropertyBag，KML/JSON 两条来源统一用这张表 */
  var PROPS = new WeakMap();
  function setProps(ent, obj) {
    if (!ent || !obj) return;
    var keys = Object.keys(obj);
    if (keys.length) PROPS.set(ent, obj);
  }

  function stripHtml(raw) {
    if (!raw) return "";
    return String(raw)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  /* KML 的 description 常是「病害等级：B / 长度：0.42m」这类键值文本，拆成属性表 */
  function propsFromDescription(raw) {
    var out = {};
    var text = stripHtml(raw);
    if (!text) return out;
    text.split("\n").forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var m = line.match(/^[-*•]?\s*([^:：=\t]{1,24})[:：=\t]\s*(.+)$/);
      if (m) out[m[1].trim()] = m[2].trim();
      else out["描述"] = (out["描述"] ? out["描述"] + "\n" : "") + line;
    });
    return out;
  }

  /* 统一加实体：防重复 id（同一个数据源里 id 撞车 Cesium 会抛错） */
  function addEntity(ds, opts, props) {
    var id = opts.id || "f-" + Math.random().toString(36).slice(2, 8);
    while (ds.entities.getById(id)) id = id + "-2";
    opts.id = id;
    var ent = ds.entities.add(opts);
    setProps(ent, props);
    return ent;
  }

  function $(id) { return document.getElementById(id); }
  function fmt(n, d) { return Number(n).toFixed(d === undefined ? 2 : d); }
  function deg(rad) { return CES.Math.toDegrees(rad); }

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (kind ? " " + kind : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "toast" + (kind ? " " + kind : ""); }, 3200);
  }

  function setModelState(kind, text) {
    var el = $("modelState");
    el.className = "pill " + (kind === "ok" ? "pill-ok" : kind === "err" ? "pill-err" : "pill-wait");
    el.textContent = text;
  }

  /* 只做存在性探测，不下载内容。
     优先问本地服务（/__model_status），这样模型还没到时不会反复刷 404；
     服务不支持时退回 HEAD 探测。 */
  function urlExists(url) {
    return fetch("__model_status?path=" + encodeURIComponent(url), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) return urlExistsRaw(url);
        return r.json().then(function (j) { return !!j.exists; });
      })
      .catch(function () { return urlExistsRaw(url); });
  }

  function urlExistsRaw(url) {
    return fetch(url, { method: "HEAD", cache: "no-store" })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }

  /* ------------------------------ 标签图标 ------------------------------ */
  /* 纯本地 canvas 绘制，不依赖任何图片素材。
     形状可在 features[].icon 或分组 color/icon 里指定，默认 pin。 */
  var ICON_SHAPES = ["pin", "arrow", "dot", "flag", "warn", "star", "cross", "square", "triangle"];
  var ICON_SHAPE_CN = {
    pin: "针形", arrow: "箭头", dot: "圆点", flag: "旗标", warn: "警告",
    star: "星标", cross: "叉号", square: "方块", triangle: "三角"
  };
  var iconCache = {};

  function iconUrl(color, shape) {
    shape = shape || "pin";
    var key = color + "|" + shape;
    if (iconCache[key]) return iconCache[key];

    var size = 64, c = document.createElement("canvas");
    c.width = size; c.height = size;
    var g = c.getContext("2d");
    g.lineWidth = 3;
    g.strokeStyle = "rgba(255,255,255,.85)";
    g.fillStyle = color;

    switch (shape) {
      case "arrow":
        // 向上的箭头（适合指示方向、车流）
        g.beginPath();
        g.moveTo(32, 6);           // 箭尖
        g.lineTo(52, 30);
        g.lineTo(41, 30);
        g.lineTo(41, 54);
        g.lineTo(23, 54);
        g.lineTo(23, 30);
        g.lineTo(12, 30);
        g.closePath();
        g.fill();
        g.stroke();
        break;

      case "dot":
        // 实心圆点（最轻量，适合大量点位）
        g.beginPath();
        g.arc(32, 32, 17, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.beginPath();
        g.arc(32, 32, 6, 0, Math.PI * 2);
        g.fillStyle = "rgba(255,255,255,.92)";
        g.fill();
        break;

      case "flag":
        // 旗杆 + 三角旗面（适合里程碑、节点）
        g.beginPath();
        g.moveTo(20, 8);
        g.lineTo(20, 56);
        g.stroke();
        g.beginPath();
        g.moveTo(22, 10);
        g.lineTo(52, 20);
        g.lineTo(22, 30);
        g.closePath();
        g.fill();
        g.stroke();
        break;

      case "warn":
        // 三角形警告（适合病害、隐患）
        g.beginPath();
        g.moveTo(32, 8);
        g.lineTo(56, 52);
        g.lineTo(8, 52);
        g.closePath();
        g.fill();
        g.stroke();
        g.fillStyle = "rgba(255,255,255,.95)";
        g.fillRect(29, 24, 6, 16);
        g.beginPath();
        g.arc(32, 45, 3.4, 0, Math.PI * 2);
        g.fill();
        break;

      case "star":
        // 五角星（适合重点、关注点）
        g.beginPath();
        for (var i = 0; i < 10; i++) {
          var r = (i % 2 === 0) ? 24 : 10;
          var a = -Math.PI / 2 + i * Math.PI / 5;
          var px = 32 + Math.cos(a) * r;
          var py = 32 + Math.sin(a) * r;
          if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.closePath();
        g.fill();
        g.stroke();
        break;

      case "cross":
        // 叉号（适合封闭、禁行）
        g.beginPath();
        g.moveTo(14, 14); g.lineTo(50, 50);
        g.moveTo(50, 14); g.lineTo(14, 50);
        g.lineWidth = 10;
        g.lineCap = "round";
        g.strokeStyle = color;
        g.stroke();
        g.lineWidth = 4;
        g.strokeStyle = "rgba(255,255,255,.9)";
        g.stroke();
        break;

      case "square":
        // 方块（适合设施、设备）
        g.beginPath();
        g.rect(14, 14, 36, 36);
        g.fill();
        g.stroke();
        g.beginPath();
        g.rect(24, 24, 16, 16);
        g.fillStyle = "rgba(255,255,255,.85)";
        g.fill();
        break;

      case "triangle":
        // 正三角（适合提示、单向）
        g.beginPath();
        g.moveTo(32, 10);
        g.lineTo(54, 50);
        g.lineTo(10, 50);
        g.closePath();
        g.fill();
        g.stroke();
        break;

      case "pin":
      default:
        // 针形标记（默认，最通用）
        g.beginPath();
        g.arc(32, 24, 14, Math.PI * 0.86, Math.PI * 0.14, false);
        g.lineTo(32, 58);
        g.closePath();
        g.fill();
        g.stroke();
        g.beginPath();
        g.arc(32, 24, 5.5, 0, Math.PI * 2);
        g.fillStyle = "rgba(255,255,255,.92)";
        g.fill();
        break;
    }

    iconCache[key] = c.toDataURL("image/png");
    return iconCache[key];
  }

  /* 图标锚点：针形/旗标底部固定在地面，其余居中 */
  function iconVerticalOrigin(shape) {
    return (shape === "pin" || shape === "flag") ? CES.VerticalOrigin.BOTTOM : CES.VerticalOrigin.CENTER;
  }

  /* ------------------------------ 初始化场景 ------------------------------ */
  function initViewer() {
    var v = new CES.Viewer("cesiumContainer", {
      baseLayer: false,              // 关键：不要任何在线影像
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: false,
      requestRenderMode: false,
      contextOptions: { webgl: { preserveDrawingBuffer: true } }   // 截图需要
    });
    S.viewer = v;

    var scene = v.scene;
    scene.globe.show = false;                 // 只显示模型，不要地球
    scene.skyBox.show = false;
    scene.sun.show = false;
    scene.moon.show = false;
    scene.skyAtmosphere.show = false;
    scene.backgroundColor = CES.Color.fromCssColorString(CFG.scene.background || "#0d1b2a");
    if (scene.fog) scene.fog.enabled = false;
    scene.screenSpaceCameraController.minimumZoomDistance = 0.5;
    scene.screenSpaceCameraController.maximumZoomDistance = 5000000;
    scene.screenSpaceCameraController.inertiaSpin = 0.82;
    scene.screenSpaceCameraController.inertiaZoom = 0.7;
    if (scene.postProcessStages && scene.postProcessStages.fxaa) scene.postProcessStages.fxaa.enabled = true;

    // 双击不要自动放大（会和测量抢操作）
    v.cesiumWidget.screenSpaceEventHandler.removeInputAction(CES.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    S.measureDS = new CES.CustomDataSource("measure");
    v.dataSources.add(S.measureDS);

    // 标绘数据源（与测量分开，结束时不互相清）
    S.drawDS = new CES.CustomDataSource("draw");
    v.dataSources.add(S.drawDS);

    // 现场排障用：浏览器控制台里可以 window.XZ3D.viewer / XZ3D.tileset 查内部状态
    window.XZ3D = {
      viewer: v,
      state: S,
      get tileset() { return S.tileset; },
      get models() { return S.models; },
      get layers() { return S.layers; },
      addModel: addModel,
      removeModel: removeModel,
      fitAll: viewModelDirect,
      fly: flyToModel,
      // 自检用：把内部函数暴露出来
      _internals: {
        iconUrl: iconUrl, ICON_SHAPES: ICON_SHAPES, ICON_SHAPE_CN: ICON_SHAPE_CN,
        detectModelType: detectModelType, nameFromUrl: nameFromUrl, uniqModelId: uniqModelId,
        sceneBoundingSphere: sceneBoundingSphere, applyLabelData: applyLabelData,
        removeLabelSource: removeLabelSource, openPanel: openPanel,
        openAddModelDialog: openAddModelDialog, closeAddModelDialog: closeAddModelDialog,
        openAddLabelDialog: openAddLabelDialog, closeAddLabelDialog: closeAddLabelDialog
      }
    };
    // 自检页用（避免多一层解引用）
    window.__XZ_iconUrl = iconUrl;
    window.__XZ_ICON_SHAPES = ICON_SHAPES;
    window.__XZ_detectModelType = detectModelType;
    window.__XZ_nameFromUrl = nameFromUrl;
    window.__XZ_uniqModelId = uniqModelId;
    window.__XZ_sceneBoundingSphere = sceneBoundingSphere;
    window.__XZ_applyLabelData = applyLabelData;
    window.__XZ_removeLabelSource = removeLabelSource;
    window.__XZ_openPanel = openPanel;
    window.__XZ_openAddModelDialog = openAddModelDialog;
    window.__XZ_closeAddModelDialog = closeAddModelDialog;
    window.__XZ_openAddLabelDialog = openAddLabelDialog;
    window.__XZ_closeAddLabelDialog = closeAddLabelDialog;
    window.__XZ_STATE = S;

    /* 诊断用：按路径加一份标签，返回 Promise<boolean> */
    window.__XZ_addLabelByPath = function (path, name) {
      var p = String(path || "").replace(/\\/g, "/").replace(/^\.?\//, "");
      var isKml = /\.kml$/i.test(p);
      return addLabelSource({
        id: "diag-" + Date.now().toString(36),
        name: name || nameFromUrl(p),
        url: p,
        type: isKml ? "kml" : "json",
        color: "#00d4aa"
      });
    };
    /* 诊断用：把 loadJSONLabels 的实现摘要出来 */
    window.__XZ_loadJSONLabelsSrc = (function () {
      var s = String(loadJSONLabels);
      if (s.indexOf("inlineData") >= 0) return "优先用 inlineData（内存数据），只有没有时才 fetch(def.url)";
      return "只走 fetch(def.url)";
    })();
    /* 导出用：暴露纯函数供自检 */
    window.__XZ_buildKML = buildKML;
    window.__XZ_kmlColor = kmlColor;
    window.__XZ_xmlEsc = xmlEsc;
    window.__XZ_featureToKML = featureToKML;
    window.__XZ_setFeatureEnabled = setFeatureEnabled;
    window.__XZ_setLayerEnabled = setLayerEnabled;
    window.__XZ_saveDrawnLabel = saveDrawnLabel;
    window.__XZ_setDrawMode = setDrawMode;
    window.__XZ_finishDraw = finishDraw;
    window.__XZ_drawClick = drawClick;

    bindPicking();
    bindCameraStatus();
  }

  function initialCamera() {
    // 万一模型没到，先给一个能看的角度，避免 NaN
    S.viewer.camera.setView({
      destination: CES.Cartesian3.fromDegrees(108.9, 34.0, 1600),
      orientation: { heading: 0, pitch: CES.Math.toRadians(-60), roll: 0 }
    });
  }

  /* ------------------------------ 模型加载（多模型） ------------------------------ */

  /* 判定一个路径是 3D Tiles 还是单文件 GLB */
  function detectModelType(url) {
    var u = String(url || "").toLowerCase().split("?")[0];
    if (/\.(glb|gltf)$/.test(u)) return "glb";
    return "tiles";
  }

  /* 从 URL 推断显示名（去掉路径和扩展名） */
  function nameFromUrl(url) {
    var s = String(url || "").replace(/\\/g, "/").split("/").filter(Boolean);
    var last = s.length ? s[s.length - 1] : "模型";
    var parent = s.length > 1 ? s[s.length - 2] : "";
    if (/^tileset\.json$/i.test(last) && parent) return parent;
    return last.replace(/\.(json|glb|gltf|b3dm)$/i, "") || "模型";
  }

  /* 找一个可用的模型 key（避免 id 冲突） */
  function uniqModelId(base) {
    var id = base || "model";
    var n = 1;
    while (S.models.some(function (m) { return m.id === id; })) {
      n++;
      id = base + "-" + n;
    }
    return id;
  }

  function findModel(id) {
    for (var i = 0; i < S.models.length; i++) {
      if (S.models[i].id === id) return S.models[i];
    }
    return null;
  }

  /* 场景里所有模型的总包围球（用于"回到全景"） */
  function sceneBoundingSphere() {
    var spheres = [];
    S.models.forEach(function (m) {
      if (m.tileset && m.tileset.show && m.tileset.boundingSphere) {
        spheres.push(m.tileset.boundingSphere);
      }
    });
    if (!spheres.length) return null;
    if (spheres.length === 1) return spheres[0];
    // 多个模型：取一个能包住全部的球
    var min = new CES.Cartesian3(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE);
    var max = new CES.Cartesian3(-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE);
    spheres.forEach(function (bs) {
      var r = bs.radius;
      var c = bs.center;
      min.x = Math.min(min.x, c.x - r); max.x = Math.max(max.x, c.x + r);
      min.y = Math.min(min.y, c.y - r); max.y = Math.max(max.y, c.y + r);
      min.z = Math.min(min.z, c.z - r); max.z = Math.max(max.z, c.z + r);
    });
    var center = new CES.Cartesian3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    var radius = CES.Cartesian3.distance(center, max);
    return new CES.BoundingSphere(center, radius);
  }

  /* 同步"主模型"指针，让旧代码（状态栏、快捷键）继续可用 */
  function syncPrimaryModel() {
    var first = S.models[0] || null;
    S.tileset = first ? first.tileset : null;
    S.modelDef = first ? first : null;
    S.baseCenter = first ? first.baseCenter : null;
    S.offset = first ? first.offset : { east: 0, north: 0, up: 0 };
    S.modelReady = S.models.some(function (m) { return m.ready; });
  }

  /* 加载一个模型并加入场景（不清理已有的） */
  function addModel(def, opts) {
    opts = opts || {};
    var type = def.type || detectModelType(def.url);
    var entry = {
      id: uniqModelId(def.id || "m"),
      name: def.name || nameFromUrl(def.url),
      url: def.url,
      type: type,
      tileset: null,
      baseCenter: null,
      offset: { east: 0, north: 0, up: 0 },
      show: true,
      ready: false,
      userAdded: !!def.userAdded,
      loading: true
    };
    S.models.push(entry);
    setModelState("wait", "加载中…");
    $("emptyState").classList.add("hidden");

    var url = encodeURI(def.url);
    var p;

    if (type === "glb") {
      // 单文件模型：用 Model.fromGltfAsync（新版）或 Model.fromGltf（老版）
      var modelOpts = {
        url: url,
        show: true,
        // 没有地理参照的 GLB 默认落在原点，这里给一个合理位置
        scale: def.scale || 1
      };
      if (def.position) {
        modelOpts.position = CES.Cartesian3.fromDegrees(
          def.position[0], def.position[1], def.position[2] || 0);
      }
      try {
        if (typeof CES.Model.fromGltfAsync === "function") {
          p = CES.Model.fromGltfAsync(modelOpts);
        } else {
          var md = CES.Model.fromGltf(modelOpts);
          p = md.readyPromise ? md.readyPromise : Promise.resolve(md);
        }
      } catch (e) {
        p = Promise.reject(e);
      }
    } else {
      var tsOpts = { maximumScreenSpaceError: CFG.scene.maxScreenSpaceError || 16 };
      try {
        if (typeof CES.Cesium3DTileset.fromUrl === "function") {
          p = CES.Cesium3DTileset.fromUrl(url, tsOpts);
        } else {
          var cand = new CES.Cesium3DTileset({ url: url, maximumScreenSpaceError: tsOpts.maximumScreenSpaceError });
          p = cand.readyPromise || Promise.resolve(cand);
        }
      } catch (e) {
        p = Promise.reject(e);
      }
    }

    return p.then(function (obj) {
      S.viewer.scene.primitives.add(obj);
      entry.tileset = obj;
      entry.loading = false;
      entry.ready = true;

      // 记录原始包围球中心（偏移量的基准）
      if (obj.boundingSphere) {
        entry.baseCenter = CES.Cartesian3.clone(obj.boundingSphere.center, new CES.Cartesian3());
      }

      if (type === "tiles" && obj.allTilesLoaded) {
        obj.allTilesLoaded.addEventListener(function () {
          if (entry === findModel(entry.id)) updateTileStat();
        });
      }

      syncPrimaryModel();
      setModelState("ok", S.models.length > 1 ? ("已加载 " + S.models.length + " 个") : "已加载");
      $("statTiles").className = "stat loading";
      $("statTiles").textContent = "瓦片 …";

      // 首个模型自动定位；后续添加的不抢镜头（除非明确要求）
      if (opts.zoom !== false && (S.models.length === 1 || opts.focus === true)) {
        viewModelDirect();
        setTimeout(ensureModelVisible, 500);
        setTimeout(ensureModelVisible, 1600);
      }

      toast("模型已加载：" + entry.name);
      saveUserModels();
      renderLayerPanel();
      return entry;
    }).catch(function (err) {
      entry.loading = false;
      entry.error = String(err && err.message || err);
      // 从列表里移除失败的
      S.models = S.models.filter(function (m) { return m !== entry; });
      syncPrimaryModel();
      if (!S.models.length) {
        setModelState("err", "加载失败");
        showEmpty("模型加载失败",
          (type === "glb" ? "GLB 读取失败：" : "tileset.json 读取失败：") + entry.error +
          "。常见原因：路径不对、文件没拷全，或没有通过本地服务打开（直接双击 index.html 会跨域失败）。");
        $("emptyNote").innerHTML = "当前路径：<code>" + escapeHtml(def.url) + "</code>";
      } else {
        setModelState("ok", "已加载 " + S.models.length + " 个");
      }
      renderLayerPanel();
      throw err;
    });
  }

  /* 从场景移除一个模型 */
  function removeModel(id, silent) {
    var m = findModel(id);
    if (!m) return;
    if (m.tileset) {
      try { S.viewer.scene.primitives.remove(m.tileset); } catch (e) { /* ignore */ }
    }
    S.models = S.models.filter(function (x) { return x !== m; });
    syncPrimaryModel();
    setModelState(S.models.length ? "ok" : "wait",
      S.models.length ? ("已加载 " + S.models.length + " 个") : "等待模型");
    if (!S.models.length) {
      $("statTiles").textContent = "瓦片 —";
      showEmpty("还没有检测到三维模型", "点「添加模型」选择本地 tileset.json 或 .glb 文件。");
    }
    if (!silent) { toast("已移除：" + m.name); saveUserModels(); }
    renderLayerPanel();
  }

  /* 清空全部模型（加载单个时用） */
  function clearAllModels() {
    S.models.slice().forEach(function (m) { removeModel(m.id, true); });
    S.models = [];
    syncPrimaryModel();
    $("statTiles").textContent = "瓦片 —";
  }

  /* 兼容旧接口：清空后加载单个模型 */
  function clearModel() {
    clearAllModels();
  }

  function loadModel(def, opts) {
    opts = opts || {};
    if (!CFG.multiModel) clearAllModels();
    return addModel(def, opts);
  }

  function updateTileStat() {
    if (!S.models.length) return;
    // 汇总所有模型的瓦片统计
    var show = 0, total = 0, any = false;
    S.models.forEach(function (m) {
      if (!m.tileset || !m.tileset.statistics) return;
      var st = m.tileset.statistics;
      if (typeof st.numberOfTilesSelected === "number") { show += st.numberOfTilesSelected; any = true; }
      if (typeof st.numberOfTilesTotal === "number") { total += st.numberOfTilesTotal; any = true; }
    });
    $("statTiles").textContent = any ? ("瓦片 " + show + " / " + total) : "瓦片 已加载";
  }

  /* 直接把相机摆到全部模型正南方的斜上方（不做动画）。
     弱显卡、后台窗口、动画被节流时也能保证一打开就看得见模型 */
  function viewModelDirect() {
    var bs = sceneBoundingSphere();
    if (!bs) return;
    var range = Math.max(bs.radius * 2.6, 60);
    var pitchDeg = Math.max(-89.5, Math.min(89.5, (CFG.autoFlyPitch === undefined ? -55 : CFG.autoFlyPitch)));
    var pitch = CES.Math.toRadians(pitchDeg);
    var enu = CES.Transforms.eastNorthUpToFixedFrame(bs.center);
    var local = new CES.Cartesian3(0, -range * Math.cos(pitch), -range * Math.sin(pitch));
    var offset = CES.Matrix4.multiplyByPointAsVector(enu, local, new CES.Cartesian3());
    var dest = CES.Cartesian3.add(bs.center, offset, new CES.Cartesian3());
    S.viewer.camera.setView({
      destination: dest,
      orientation: { heading: 0, pitch: pitch, roll: 0 }
    });
  }

  /* 摆位兜底：如果相机被摆到远超模型尺寸的地方（包围球当时还没就绪），重新摆一次 */
  function ensureModelVisible() {
    var bs = sceneBoundingSphere();
    if (!bs) return;
    var h = S.viewer.camera.positionCartographic.height;
    var limit = bs.radius * 4 + 2000;
    if (!isFinite(h) || h > limit) viewModelDirect();
  }

  function flyToModel(pitchDeg, duration) {
    var bs = sceneBoundingSphere();
    if (!bs) return;
    var pitch = CES.Math.toRadians(Math.max(-89.5, Math.min(89.5, pitchDeg === undefined ? -55 : pitchDeg)));
    var range = Math.max(bs.radius * 2.2, 40);
    S.viewer.camera.flyToBoundingSphere(bs, {
      offset: new CES.HeadingPitchRange(S.viewer.camera.heading, pitch, range),
      duration: duration === undefined ? 1.4 : duration
    });
  }

  /* 位置/高程微调：对指定模型（默认第一个）做 ENU 平移 */
  function applyOffset(modelId) {
    var m = modelId ? findModel(modelId) : (S.models[0] || null);
    if (!m || !m.tileset || !m.baseCenter) return;
    var o = m.offset;
    if (!o.east && !o.north && !o.up) {
      m.tileset.modelMatrix = CES.Matrix4.clone(CES.Matrix4.IDENTITY);
      return;
    }
    var enu = CES.Transforms.eastNorthUpToFixedFrame(m.baseCenter);
    var local = new CES.Cartesian3(o.east, o.north, o.up);
    var dEcef = CES.Matrix4.multiplyByPointAsVector(enu, local, new CES.Cartesian3());
    m.tileset.modelMatrix = CES.Matrix4.fromTranslation(dEcef);
  }

  function loadOffsetFromStorage() {
    try {
      var raw = localStorage.getItem((CFG.storage && CFG.storage.offset) || "xz3d.modelOffset");
      if (raw) {
        var o = JSON.parse(raw);
        S.offset = { east: +o.east || 0, north: +o.north || 0, up: +o.up || 0 };
      }
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------ 缺模型引导 ------------------------------ */
  function showEmpty(title, desc) {
    $("emptyTitle").textContent = title || "还没有检测到三维模型";
    if (desc) $("emptyDesc").textContent = desc;
    $("emptyState").classList.remove("hidden");
  }

  /* ------------------------------ 用户添加的模型/标签持久化 ------------------------------ */
  function saveUserModels() {
    if (!CFG.rememberAdded) return;
    try {
      var list = S.models.filter(function (m) { return m.userAdded; })
        .map(function (m) { return { id: m.id, name: m.name, url: m.url, type: m.type }; });
      localStorage.setItem("xz3d.userModels", JSON.stringify(list));
    } catch (e) { /* ignore */ }
  }

  function loadUserModels() {
    if (!CFG.rememberAdded) return [];
    try {
      var raw = localStorage.getItem("xz3d.userModels");
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function saveUserLabels() {
    if (!CFG.rememberAdded) return;
    try {
      var list = S.userLabels.map(function (d) {
        return { id: d.id, name: d.name, type: d.type, color: d.color, icon: d.icon, data: d.data, url: d.url };
      });
      localStorage.setItem("xz3d.userLabels", JSON.stringify(list));
    } catch (e) { /* 标签数据可能很大，超限就放弃记忆 */ }
  }

  function loadUserLabels() {
    if (!CFG.rememberAdded) return [];
    try {
      var raw = localStorage.getItem("xz3d.userLabels");
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  /* ------------------------------ 添加本地模型 ------------------------------ */
  var modelDlg = null;

  function openAddModelDialog() {
    if (!modelDlg) buildModelDialog();
    modelDlg.classList.remove("hidden");
    var inp = $("dlgModelPath");
    if (inp) { inp.value = ""; inp.focus(); }
    fillKnownModels();
  }

  /* 列出 config 里已配置的模型，点一下填进路径框 */
  function fillKnownModels() {
    var box = $("dlgModelKnown");
    if (!box) return;
    var items = (CFG.models || []).slice();
    if (!items.length) {
      box.innerHTML = '<p class="hint" style="margin:0">config.js 里没有预置模型。' +
        '手动填路径，或把 tileset.json / .glb 放进 data/model/ 下。</p>';
      return;
    }
    var html = "";
    items.forEach(function (m) {
      html += '<div class="known-item" data-url="' + escapeHtml(m.url) + '">' +
        '<span class="known-name">' + escapeHtml(m.name) + '</span>' +
        '<code class="known-path">' + escapeHtml(m.url) + '</code>' +
        '</div>';
    });
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll(".known-item"), function (el) {
      el.onclick = function () {
        var u = el.getAttribute("data-url");
        var inp = $("dlgModelPath");
        if (inp) { inp.value = u; inp.focus(); }
        var nm = $("dlgModelName");
        if (nm && !nm.value) nm.value = nameFromUrl(u);
        Array.prototype.forEach.call(box.querySelectorAll(".known-item"), function (x) {
          x.classList.toggle("sel", x === el);
        });
      };
    });
  }

  function closeAddModelDialog() {
    if (modelDlg) modelDlg.classList.add("hidden");
  }

  /* 有没有任何对话框开着 */
  function isAnyDialogOpen() {
    return !!document.querySelector(".modal:not(.hidden)");
  }

  /* 关掉所有对话框（Esc 用） */
  function closeAllDialogs() {
    Array.prototype.forEach.call(document.querySelectorAll(".modal"), function (m) {
      m.classList.add("hidden");
    });
  }

  function buildModelDialog() {
    var div = document.createElement("div");
    div.id = "addModelDlg";
    div.className = "modal hidden";
    div.innerHTML =
      '<div class="modal-card">' +
        '<div class="modal-head"><b>添加本地模型</b>' +
          '<button class="icon-btn" id="dlgModelClose" title="关闭">' +
          '<svg viewBox="0 0 20 20"><path d="M6 6 L14 14 M14 6 L6 14" stroke-width="1.7"/></svg></button></div>' +
        '<div class="modal-body">' +
          '<p class="hint">支持 <b>3D Tiles</b>（tileset.json 的路径）和单文件 <b>GLB / glTF</b>。' +
          '路径相对于 index.html，例如 <code>data/model/教室/tileset.json</code>。</p>' +
          '<div class="form-row"><label>路径</label>' +
            '<input type="text" id="dlgModelPath" placeholder="从下方「已有模型」里选，或手填" ' +
            'style="flex:1;background:#0c141c;color:#dbe6f0;border:1px solid #1e2c3a;border-radius:6px;padding:8px 10px;font-size:12.5px;font-family:inherit;outline:none">' +
          '</div>' +
          '<div class="sec" style="margin-top:10px"><div class="sec-title"><span>已有模型</span></div>' +
            '<div id="dlgModelKnown" class="known-list"></div>' +
          '</div>' +
          '<div class="form-row"><label>名称</label>' +
            '<input type="text" id="dlgModelName" placeholder="留空则自动命名" ' +
            'style="flex:1;background:#0c141c;color:#dbe6f0;border:1px solid #1e2c3a;border-radius:6px;padding:8px 10px;font-size:12.5px;font-family:inherit;outline:none">' +
          '</div>' +
          '<div class="sec" style="margin-top:14px"><div class="sec-title"><span>可选：地理定位（仅 GLB 需要）</span></div>' +
          '<div class="form-row"><label>经度</label><input type="number" id="dlgModelLon" step="0.000001" placeholder="108.9" style="flex:1;background:#0c141c;color:#dbe6f0;border:1px solid #1e2c3a;border-radius:6px;padding:7px 9px"><span class="unit">°</span></div>' +
          '<div class="form-row"><label>纬度</label><input type="number" id="dlgModelLat" step="0.000001" placeholder="34.0" style="flex:1;background:#0c141c;color:#dbe6f0;border:1px solid #1e2c3a;border-radius:6px;padding:7px 9px"><span class="unit">°</span></div>' +
          '<div class="form-row"><label>高程</label><input type="number" id="dlgModelH" step="1" placeholder="500" style="flex:1;background:#0c141c;color:#dbe6f0;border:1px solid #1e2c3a;border-radius:6px;padding:7px 9px"><span class="unit">m</span></div>' +
          '</div>' +
          '<div class="empty-actions" style="margin-top:16px">' +
            '<button class="btn btn-primary" id="dlgModelAdd">添加并加载</button>' +
            '<button class="btn" id="dlgModelCancel">取消</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(div);
    modelDlg = div;

    $("dlgModelClose").onclick = closeAddModelDialog;
    $("dlgModelCancel").onclick = closeAddModelDialog;
    div.onclick = function (e) { if (e.target === div) closeAddModelDialog(); };

    $("dlgModelAdd").onclick = function () {
      var p = ($("dlgModelPath").value || "").trim();
      if (!p) { toast("先填模型路径", "warn"); return; }
      p = p.replace(/\\/g, "/").replace(/^\.?\//, "");
      var nm = ($("dlgModelName").value || "").trim();
      var lon = $("dlgModelLon").value, lat = $("dlgModelLat").value, h = $("dlgModelH").value;
      var def = {
        id: "user-" + Date.now().toString(36),
        name: nm || nameFromUrl(p),
        url: p,
        userAdded: true
      };
      if (lon !== "" && lat !== "") {
        def.position = [+lon, +lat, h === "" ? 0 : +h];
      }
      closeAddModelDialog();
      addModel(def, { focus: true }).catch(function () { /* 错误已在 addModel 内提示 */ });
    };

    $("dlgModelPath").onkeydown = function (e) {
      if (e.key === "Enter") $("dlgModelAdd").click();
    };
  }

  /* ------------------------------ 添加本地标签 ------------------------------ */
  var labelDlg = null;

  function openAddLabelDialog() {
    if (!labelDlg) buildLabelDialog();
    labelDlg.classList.remove("hidden");
    var f = $("dlgLabelFile");
    if (f) f.value = "";
    var t = $("dlgLabelName");
    if (t) t.value = "";
    var p = $("dlgLabelPath");
    if (p) p.value = "";
    fillKnownLabelFiles();
  }

  /* 列出 config 里配置的标签文件，以及探测到的 data/vector 下常见文件。
     点一下就能填进路径框，避免用户手打错名字。 */
  function fillKnownLabelFiles() {
    var box = $("dlgLabelKnown");
    if (!box) return;

    var items = [];
    // 1. config 里明确写了的
    (CFG.labels || []).forEach(function (d) {
      if (d.url) items.push({ url: d.url, name: d.name || nameFromUrl(d.url), src: "配置" });
    });

    var render = function () {
      if (!items.length) {
        box.innerHTML = '<p class="hint" style="margin:0">没有找到可用的标签文件。' +
          '可以把 .json / .kml 直接拖进窗口，或用上面的「选择文件」。</p>';
        return;
      }
      var html = "";
      items.forEach(function (it) {
        html += '<div class="known-item" data-url="' + escapeHtml(it.url) + '">' +
          '<span class="known-name">' + escapeHtml(it.name) + '</span>' +
          '<code class="known-path">' + escapeHtml(it.url) + '</code>' +
          '<span class="known-src">' + escapeHtml(it.src) + '</span>' +
          '</div>';
      });
      box.innerHTML = html;
      Array.prototype.forEach.call(box.querySelectorAll(".known-item"), function (el) {
        el.onclick = function () {
          var u = el.getAttribute("data-url");
          var inp = $("dlgLabelPath");
          if (inp) { inp.value = u; inp.focus(); }
          var nm = $("dlgLabelName");
          if (nm && !nm.value) nm.value = nameFromUrl(u);
          Array.prototype.forEach.call(box.querySelectorAll(".known-item"), function (x) {
            x.classList.toggle("sel", x === el);
          });
        };
      });
    };

    // 2. 探测几个常见文件名是否存在
    var guesses = ["data/vector/labels.json", "data/vector/自检标签.json", "data/vector/拥堵路段.json"];
    var chain = Promise.resolve();
    guesses.forEach(function (g) {
      if (items.some(function (x) { return x.url === g; })) return;
      chain = chain.then(function () {
        return urlExists(g).then(function (ok) {
          if (ok) items.push({ url: g, name: nameFromUrl(g), src: "探测到" });
        });
      });
    });
    chain.then(render);
  }

  function closeAddLabelDialog() {
    if (labelDlg) labelDlg.classList.add("hidden");
  }

  /* 标签形状选择器：一排小按钮，点一下切换 */
  function buildShapePicker(containerId, current) {
    var html = '<div class="shape-picker" id="' + containerId + '">';
    ICON_SHAPES.forEach(function (s) {
      html += '<button type="button" class="shape-btn' + (s === current ? " active" : "") +
        '" data-shape="' + s + '" title="' + ICON_SHAPE_CN[s] + '">' +
        '<img src="' + iconUrl("#dbe6f0", s) + '" alt="' + s + '"></button>';
    });
    html += "</div>";
    return html;
  }

  function buildLabelDialog() {
    var div = document.createElement("div");
    div.id = "addLabelDlg";
    div.className = "modal hidden";
    div.innerHTML =
      '<div class="modal-card">' +
        '<div class="modal-head"><b>添加本地标签</b>' +
          '<button class="icon-btn" id="dlgLabelClose" title="关闭">' +
          '<svg viewBox="0 0 20 20"><path d="M6 6 L14 14 M14 6 L6 14" stroke-width="1.7"/></svg></button></div>' +
        '<div class="modal-body">' +
          '<p class="hint">支持 <b>标签 JSON</b>（本项目的格式）和 <b>KML</b>。' +
          '也可以直接填写路径，或把文件拖进窗口。</p>' +
          '<div class="form-row"><label>文件</label>' +
            '<input type="file" id="dlgLabelFile" accept=".json,.kml,.geojson" ' +
            'style="flex:1;color:#dbe6f0;font-size:12px">' +
          '</div>' +
          '<div class="form-row"><label>或路径</label>' +
            '<input type="text" id="dlgLabelPath" placeholder="从下方「可用的标签文件」里选一个" ' +
            'style="flex:1;background:#0c141c;color:#dbe6f0;border:1px solid #1e2c3a;border-radius:6px;padding:8px 10px;font-size:12.5px;font-family:inherit;outline:none">' +
          '</div>' +
          '<div class="sec" style="margin-top:10px"><div class="sec-title"><span>可用的标签文件</span></div>' +
            '<div id="dlgLabelKnown" class="known-list"></div>' +
          '</div>' +
          '<div class="form-row"><label>名称</label>' +
            '<input type="text" id="dlgLabelName" placeholder="留空则自动命名" ' +
            'style="flex:1;background:#0c141c;color:#dbe6f0;border:1px solid #1e2c3a;border-radius:6px;padding:8px 10px;font-size:12.5px;font-family:inherit;outline:none">' +
          '</div>' +
          '<div class="form-row"><label>颜色</label>' +
            '<input type="color" id="dlgLabelColor" value="#00d4aa" ' +
            'style="width:52px;height:30px;padding:2px;background:#0c141c;border:1px solid #1e2c3a;border-radius:6px;cursor:pointer">' +
            '<span class="unit" style="width:auto">点击选色</span>' +
          '</div>' +
          '<div class="sec" style="margin-top:12px"><div class="sec-title"><span>图标形状</span></div>' +
            buildShapePicker("dlgLabelShapes", "pin") +
          '</div>' +
          '<div class="empty-actions" style="margin-top:16px">' +
            '<button class="btn btn-primary" id="dlgLabelAdd">添加标签</button>' +
            '<button class="btn" id="dlgLabelCancel">取消</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(div);
    labelDlg = div;

    // 形状选择交互
    var picked = "pin";
    Array.prototype.forEach.call(div.querySelectorAll(".shape-btn"), function (btn) {
      btn.onclick = function () {
        picked = btn.getAttribute("data-shape");
        Array.prototype.forEach.call(div.querySelectorAll(".shape-btn"), function (b) {
          b.classList.toggle("active", b === btn);
        });
      };
    });
    div._pickedShape = function () { return picked; };

    $("dlgLabelClose").onclick = closeAddLabelDialog;
    $("dlgLabelCancel").onclick = closeAddLabelDialog;
    div.onclick = function (e) { if (e.target === div) closeAddLabelDialog(); };

    $("dlgLabelAdd").onclick = function () {
      var fileInput = $("dlgLabelFile");
      var pathVal = ($("dlgLabelPath").value || "").trim();
      var nm = ($("dlgLabelName").value || "").trim();
      var color = $("dlgLabelColor").value || "#00d4aa";
      var shape = div._pickedShape();

      var finish = function (def) {
        def.color = color;
        def.icon = shape;
        addLabelSource(def);
        closeAddLabelDialog();
      };

      // 优先用文件
      if (fileInput.files && fileInput.files.length) {
        readLabelFile(fileInput.files[0], function (def, err) {
          if (err) { toast("读取失败：" + err, "err"); return; }
          if (nm) def.name = nm;
          finish(def);
        });
        return;
      }

      // 其次用路径
      if (!pathVal) { toast("请选择文件或填写路径", "warn"); return; }
      var p = pathVal.replace(/\\/g, "/").replace(/^\.?\//, "");
      var isKml = /\.kml$/i.test(p);
      finish({
        id: "userlabel-" + Date.now().toString(36),
        name: nm || nameFromUrl(p),
        url: p,
        type: isKml ? "kml" : "json",
        userAdded: true
      });
    };
  }

  /* 读一个本地文件，返回可用的 def（JSON 直接解析，KML 走 url） */
  function readLabelFile(file, cb) {
    var name = file.name || "label";
    var isKml = /\.kml$/i.test(name);
    var fr = new FileReader();

    if (isKml) {
      // KML 交给 Cesium 的 KmlDataSource 解析，用 blob URL
      fr.onload = function () {
        var blob = new Blob([fr.result], { type: "application/vnd.google-earth.kml+xml" });
        cb({
          id: "userlabel-" + Date.now().toString(36),
          name: name.replace(/\.kml$/i, ""),
          url: URL.createObjectURL(blob),
          type: "kml",
          userAdded: true,
          isBlob: true
        });
      };
      fr.onerror = function () { cb(null, fr.error); };
      fr.readAsText(file, "utf-8");
      return;
    }

    fr.onload = function () {
      var data;
      try {
        data = JSON.parse(fr.result);
      } catch (e) {
        cb(null, "不是合法的 JSON");
        return;
      }
      cb({
        id: "userlabel-" + Date.now().toString(36),
        name: name.replace(/\.json$/i, ""),
        type: "json",
        data: data,
        userAdded: true
      });
    };
    fr.onerror = function () { cb(null, fr.error); };
    fr.readAsText(file, "utf-8");
  }

  /* 把一份标签源加入场景（文件/路径/KML 三种都走这里） */
  function addLabelSource(def) {
    var task;
    if (def.type === "kml") {
      task = loadKML(def);
    } else {
      task = loadJSONLabels(def, def.data);
    }
    return task.then(function () {
      S.userLabels.push(def);
      saveUserLabels();
      renderLayerPanel();
      toast("标签已添加：" + def.name);
      return true;
    }).catch(function (err) {
      toast("标签加载失败：" + (err && err.message || err), "err");
      throw err;
    });
  }

  /* 移除一整份标签源（包含它的所有分组） */
  function removeLabelSource(sourceId) {
    var removed = S.layers.filter(function (l) { return l.sourceId === sourceId; });
    removed.forEach(function (l) {
      if (l.ds) { try { S.viewer.dataSources.remove(l.ds, true); } catch (e) { /* ignore */ } }
    });
    S.layers = S.layers.filter(function (l) { return l.sourceId !== sourceId; });
    S.userLabels = S.userLabels.filter(function (d) { return d.id !== sourceId; });
    saveUserLabels();
    renderLayerPanel();
  }

  /* ------------------------------ 导出 KML ------------------------------ */

  function xmlEsc(s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  /* #RRGGBB -> KML 的 aabbggrr（不透明） */
  function kmlColor(hex, alpha) {
    var h = String(hex || "#00d4aa").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var a = Math.round((alpha === undefined ? 1 : alpha) * 255).toString(16);
    if (a.length < 2) a = "0" + a;
    return (a + h.substring(4, 6) + h.substring(2, 4) + h.substring(0, 2)).toLowerCase();
  }

  /* 一个要素 -> KML 的 Placemark 片段 */
  function featureToKML(f, color) {
    var name = f.name || f.id || "未命名";
    var desc = "";
    var props = f.properties || {};
    var keys = Object.keys(props);
    if (keys.length) {
      desc += "<![CDATA[<table border='1' cellspacing='0' cellpadding='4'>";
      keys.forEach(function (k) {
        desc += "<tr><td><b>" + xmlEsc(k) + "</b></td><td>" + xmlEsc(props[k]) + "</td></tr>";
      });
      desc += "</table>]]>";
    }

    var geom = "";
    var coords = f.coordinates;

    if (f.type === "point") {
      var c = coords || [0, 0, 0];
      geom = "<Point><coordinates>" +
        (c[0]) + "," + (c[1]) + "," + (c[2] || 0) +
        "</coordinates></Point>";
    } else if (f.type === "polyline") {
      var pts = (coords || []).map(function (p) {
        return p[0] + "," + p[1] + "," + (p[2] || 0);
      }).join(" ");
      geom = "<LineString><tessellate>1</tessellate><coordinates>" + pts +
        "</coordinates></LineString>";
    } else if (f.type === "polygon") {
      var ring = (coords || []).map(function (p) {
        return p[0] + "," + p[1] + "," + (p[2] || 0);
      });
      // KML 的多边形要求首尾闭合
      if (ring.length && ring[0] !== ring[ring.length - 1]) ring.push(ring[0]);
      geom = "<Polygon><outerBoundaryIs><LinearRing><coordinates>" +
        ring.join(" ") + "</coordinates></LinearRing></outerBoundaryIs></Polygon>";
    } else {
      return "";
    }

    var style = "";
    if (f.type === "point") {
      style = "#" + "pin-" + color;
    } else if (f.type === "polyline") {
      style = "#line-" + color;
    } else {
      style = "#poly-" + color;
    }

    return "    <Placemark>\n" +
      "      <name>" + xmlEsc(name) + "</name>\n" +
      (desc ? "      <description>" + desc + "</description>\n" : "") +
      "      <styleUrl>" + style + "</styleUrl>\n" +
      "      " + geom + "\n" +
      "    </Placemark>\n";
  }

  /* 一组图层 + 分组 -> 完整 KML 文本 */
  function buildKML(title, layers) {
    var styles = {};
    var body = "";

    layers.forEach(function (l) {
      var color = l.color || "#00d4aa";
      // 收集本层用到的样式
      if (!styles["pin-" + color]) {
        styles["pin-" + color] =
          '    <Style id="pin-' + color + '">\n' +
          '      <IconStyle><color>' + kmlColor(color) + '</color>' +
          '<scale>1.0</scale></IconStyle>\n' +
          '      <LabelStyle><scale>0.85</scale></LabelStyle>\n' +
          '    </Style>\n';
      }
      if (!styles["line-" + color]) {
        styles["line-" + color] =
          '    <Style id="line-' + color + '">\n' +
          '      <LineStyle><color>' + kmlColor(color) + '</color>' +
          '<width>3</width></LineStyle>\n' +
          '    </Style>\n';
      }
      if (!styles["poly-" + color]) {
        styles["poly-" + color] =
          '    <Style id="poly-' + color + '">\n' +
          '      <LineStyle><color>' + kmlColor(color) + '</color>' +
          '<width>2</width></LineStyle>\n' +
          '      <PolyStyle><color>' + kmlColor(color, 0.32) + '</color></PolyStyle>\n' +
          '    </Style>\n';
      }

      var feats = l.rawFeatures || [];
      if (!feats.length) return;

      body += "  <Folder>\n" +
        "    <name>" + xmlEsc(l.name) + "</name>\n" +
        "    <open>1</open>\n";
      feats.forEach(function (f) {
        body += featureToKML(f, color);
      });
      body += "  </Folder>\n";
    });

    if (!body) return null;

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<kml xmlns="http://www.opengis.net/kml/2.2">\n' +
      '<Document>\n' +
      '  <name>' + xmlEsc(title) + '</name>\n' +
      '  <description>由离线三维模型查看器导出</description>\n' +
      Object.keys(styles).map(function (k) { return styles[k]; }).join("") +
      body +
      '</Document>\n' +
      '</kml>\n';
  }

  /* 触发浏览器下载 */
  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1500);
  }

  function stamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /* 导出指定图层集合为 KML */
  function exportKML(layers, title) {
    var text = buildKML(title || "标签导出", layers || S.layers);
    if (!text) {
      toast("没有可导出的要素（只支持点/线/面，且需要有坐标数据）", "warn");
      return false;
    }
    var n = layers.reduce(function (a, l) { return a + (l.rawFeatures || []).length; }, 0);
    downloadText("标签导出_" + stamp() + ".kml", text, "application/vnd.google-earth.kml+xml");
    toast("已导出 KML（" + n + " 个要素）");
    return true;
  }

  /* 导出一整份标签源（它下面的所有分组） */
  function exportLabelSource(sourceId) {
    var ls = S.layers.filter(function (l) { return l.sourceId === sourceId; });
    if (!ls.length) { toast("找不到这份标签", "warn"); return; }
    var name = ls[0].name || "标签";
    exportKML(ls, name);
  }

  /* ------------------------------ 矢量标签 ------------------------------ */
  function entityLabelOpts(text, color) {
    return {
      text: text,
      font: (CFG.label && CFG.label.font) || '500 13px "Microsoft YaHei", sans-serif',
      style: CES.LabelStyle.FILL_AND_OUTLINE,
      fillColor: CES.Color.WHITE,
      outlineColor: CES.Color.fromCssColorString("#0a0f16"),
      outlineWidth: (CFG.label && CFG.label.outlineWidth) || 3,
      verticalOrigin: CES.VerticalOrigin.BOTTOM,
      pixelOffset: new CES.Cartesian2(0, -22),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition: new CES.DistanceDisplayCondition(0, (CFG.label && CFG.label.hideTextDistance) || 1500),
      scale: (CFG.label && CFG.label.scale) || 1.0,
      scaleByDistance: new CES.NearFarScalar(400, 1.0, 2500, 0.55)
    };
  }

  function createFeatureEntity(ds, f, color, groupName) {
    var lc = CFG.label || {};
    var props = f.properties || {};
    var text = f.showLabel === false ? null : (f.label || f.name || f.id);

    if (f.type === "polyline") {
      var pts = (f.coordinates || []).map(function (c) {
        // 抬高 0.5 m，避免与模型路面共面打架（司空2 的线高程常常只比路面低一两米）
        return CES.Cartesian3.fromDegrees(c[0], c[1], (c[2] || 0) + (lc.lineLiftM || 0.5));
      });
      if (pts.length < 2) return null;
      return addEntity(ds, {
        id: f.id,
        name: f.name || f.id,
        polyline: {
          positions: pts,
          width: lc.lineWidth || 3,
          material: new CES.ColorMaterialProperty(CES.Color.fromCssColorString(color)),
          clampToGround: false,
          // 3DTiles 上没地形，线一旦略低于路面就会被深度测试吃掉，直接关闭深度测试
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      }, props);
    }

    if (f.type === "polygon") {
      var ring = (f.coordinates || []).map(function (c) { return CES.Cartesian3.fromDegrees(c[0], c[1], c[2] || 0); });
      if (ring.length < 3) return null;
      return addEntity(ds, {
        id: f.id,
        name: f.name || f.id,
        polygon: {
          hierarchy: new CES.PolygonHierarchy(ring),
          perPositionHeight: true,
          material: CES.Color.fromCssColorString(color).withAlpha(0.32),
          outline: true,
          outlineColor: CES.Color.fromCssColorString(color),
          arcType: CES.ArcType.NONE
        }
      }, props);
    }

    /* point / 默认 */
    var coord = f.coordinates || [0, 0, 0];
    var pos = CES.Cartesian3.fromDegrees(coord[0], coord[1], coord[2] || 0);
    var opts = {
      id: f.id,
      name: f.name || f.id,
      position: pos
    };
    // 形状优先级：要素自带 icon > 分组 icon > 默认 pin
    var shape = f.icon || f.iconShape || "pin";
    var img = f.iconImage || f.icon || null;

    // f.icon 既可能是形状名也可能是图片路径，这里区分
    if (typeof f.icon === "string" && /\.(png|jpg|jpeg|gif|svg|webp)(\?|$)/i.test(f.icon)) {
      img = f.icon;
      shape = "pin";
    } else {
      img = f.iconImage || null;
    }

    opts.billboard = {
      image: img || iconUrl(color, shape),
      scale: (lc.iconScale || 0.55) * (f.iconScale || 1),
      verticalOrigin: img ? CES.VerticalOrigin.BOTTOM : iconVerticalOrigin(shape),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new CES.NearFarScalar(300, 1.15, 3000, 0.6)
    };
    // 形状对应的图标高度（针形/旗标是底部锚点，文字要再往上一点）
    var anchorY = (shape === "pin") ? -22 : (shape === "flag" ? -34 : -20);
    if (text) {
      opts.label = entityLabelOpts(text, color);
      opts.label.pixelOffset = new CES.Cartesian2(0, anchorY);
    }
    return addEntity(ds, opts, props);
  }

  /* 核心：把一份标签 JSON 渲染到场景里
     data 可以是已经解析好的对象，也可以是 null（此时从 def.url 拉取） */
  function applyLabelData(def, data) {
    var groups = {};
    (data.groups || []).forEach(function (g) { groups[g.id] = g; });

    var usedGroups = {};
    (data.features || []).forEach(function (f, i) {
      var gid = f.group || "default";
      var gdef = groups[gid] || {};
      if (!usedGroups[gid]) {
        usedGroups[gid] = {
          id: gid,
          name: gdef.name || (gid === "default" ? def.name : gid),
          color: gdef.color || def.color || LAYER_COLORS[0],
          icon: gdef.icon || def.icon || "pin",     // 分组级图标形状
          ds: null,
          entities: [],
          rawFeatures: []                            // 保留原始数据，供导出
        };
      }
      var bucket = usedGroups[gid];
      if (!bucket.ds) {
        bucket.ds = new CES.CustomDataSource(def.id + "-" + gid);
        S.viewer.dataSources.add(bucket.ds);
        // 分组可声明 visible:false，默认不显示，图层面板里还能再打开
        bucket.ds.show = !(gdef.visible === false);
      }
      f.id = f.id || (def.id + "-" + (i + 1));
      // 要素没指定 icon 时继承分组图标
      if (!f.icon && !f.iconShape) f.icon = bucket.icon;
      var ent = createFeatureEntity(bucket.ds, f, bucket.color, bucket.name);
      if (ent) {
        bucket.entities.push(ent);
        // 原始坐标/属性/名称留着，导出时原样写回去；entity 用于单条显隐
        bucket.rawFeatures.push({
          id: f.id,
          name: f.name || f.label || f.id,
          type: f.type,
          coordinates: f.coordinates,
          properties: f.properties || {},
          showLabel: f.showLabel !== false,
          icon: f.iconShape || (typeof f.icon === "string" ? f.icon : ""),
          entity: ent,          // 绑定的 Cesium 实体，用于单条显隐
          visible: true
        });
      }
    });

    Object.keys(usedGroups).forEach(function (gid) {
      var b = usedGroups[gid];
      S.layers.push({
        id: def.id + "-" + gid,
        sourceId: def.id,
        name: b.name,
        type: "矢量",
        color: b.color,
        icon: b.icon,
        count: b.entities.length,
        enabled: b.ds.show,
        entities: b.entities,
        ds: b.ds,
        missing: false,
        userAdded: !!def.userAdded,
        /* 保留原始要素数据，导出 KML / JSON 时用（Cesium 实体里拿不到原始坐标与属性） */
        rawFeatures: b.rawFeatures || []
      });
    });
    if (!Object.keys(usedGroups).length) {
      S.layers.push({
        id: def.id, sourceId: def.id, name: def.name, type: "矢量",
        color: def.color, count: 0, enabled: false, missing: true,
        note: "文件里没有要素", rawFeatures: []
      });
    }
    return Object.keys(usedGroups).length > 0;
  }

  function loadJSONLabels(def, inlineData) {
    var p;
    if (inlineData) {
      p = Promise.resolve(inlineData);
    } else if (!def.url) {
      p = Promise.reject(new Error("没有指定文件路径"));
    } else {
      p = fetch(encodeURI(def.url), { cache: "no-store" }).then(function (r) {
        if (r.status === 404) {
          throw new Error("找不到文件 " + def.url + "（检查文件名和相对路径，区分大小写）");
        }
        if (!r.ok) throw new Error("HTTP " + r.status + "：" + def.url);
        return r.json().catch(function () {
          throw new Error("不是合法的 JSON：" + def.url);
        });
      });
    }
    return p.then(function (data) {
      applyLabelData(def, data);
      return true;
    });
  }

  /* KML（司空2 直接导出）：保留原始点位，样式统一成本地图标，避免引用外网图标 */
  function loadKML(def) {
    var camera = S.viewer.scene.camera, canvas = S.viewer.scene.canvas;
    var ds = new CES.KmlDataSource({ camera: camera, canvas: canvas });
    return ds.load(encodeURI(def.url), { clampToGround: false }).catch(function (err) {
      // Cesium 报的错比较含糊，这里补一句人话
      var msg = String(err && err.message || err);
      if (/404|not found|failed to fetch/i.test(msg)) {
        throw new Error("找不到文件 " + def.url + "（检查文件名和相对路径，区分大小写）");
      }
      throw err;
    }).then(function () {
      S.viewer.dataSources.add(ds);
      var color = def.color || "#ff5b5b";
      var entities = [];
      var fixed = 0;

      ds.entities.values.forEach(function (e) {
        entities.push(e);

        // 属性：ExtendedData + description 里的「键：值」都收进本地属性表
        var merged = {};
        try {
          var ext = (e.properties && e.properties.getValue) ? e.properties.getValue(CES.JulianDate.now()) : null;
          if (ext && typeof ext === "object") {
            Object.keys(ext).forEach(function (k) { merged[k] = ext[k]; });
          }
        } catch (err) { /* ignore */ }
        try {
          var desc = (e.description && e.description.getValue) ? e.description.getValue(CES.JulianDate.now()) : "";
          var parsedDesc = propsFromDescription(desc);
          Object.keys(parsedDesc).forEach(function (k) { if (merged[k] === undefined) merged[k] = parsedDesc[k]; });
        } catch (err2) { /* ignore */ }
        setProps(e, merged);
        // 1) 图标：KML 常引用外网 href，离线会变成白图标/报错 —— 换成本地图标
        if (e.billboard) {
          var img = e.billboard.image && e.billboard.image.getValue && e.billboard.image.getValue(CES.JulianDate.now());
          if (!img || /^http/i.test(String(img))) {
            e.billboard.image = iconUrl(color);
            fixed++;
          }
          e.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
          if (!e.billboard.scaleByDistance) e.billboard.scaleByDistance = new CES.NearFarScalar(300, 1.15, 3000, 0.6);
        }
        if (e.point) {
          e.point.color = CES.Color.fromCssColorString(color);
          e.point.outlineColor = CES.Color.fromCssColorString("#0a0f16");
          e.point.outlineWidth = 2;
          e.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
          if (!e.point.pixelSize) e.point.pixelSize = (CFG.label && CFG.label.pointPixelSize) || 9;
        }
        if (e.polyline) {
          e.polyline.width = e.polyline.width && e.polyline.width.getValue(CES.JulianDate.now()) || 3;
          e.polyline.material = new CES.ColorMaterialProperty(CES.Color.fromCssColorString(color));
          e.polyline.disableDepthTestDistance = Number.POSITIVE_INFINITY;
        }
        if (e.polygon) {
          e.polygon.material = CES.Color.fromCssColorString(color).withAlpha(0.3);
          e.polygon.outline = true;
          e.polygon.outlineColor = CES.Color.fromCssColorString(color);
        }
        // 2) 文字：没标签的补一个（KML 的 name 就是要素名）
        if (!e.label && (e.billboard || e.point) && e.name) {
          e.label = new CES.LabelGraphics(entityLabelOpts(e.name, color));
        } else if (e.label) {
          e.label.disableDepthTestDistance = Number.POSITIVE_INFINITY;
          e.label.distanceDisplayCondition = new CES.DistanceDisplayCondition(0, (CFG.label && CFG.label.hideTextDistance) || 1500);
          e.label.scaleByDistance = new CES.NearFarScalar(400, 1.0, 2500, 0.55);
        }
      });

      S.layers.push({
        id: def.id,
        sourceId: def.id,
        name: def.name,
        type: "KML",
        color: color,
        count: entities.length,
        enabled: true,
        entities: entities,
        ds: ds,
        missing: false,
        note: fixed ? ("已本地化 " + fixed + " 个外网图标") : "",
        /* KML 来源没有原始 JSON，导出时从实体反推坐标 */
        rawFeatures: entitiesToRaw(entities)
      });
      return true;
    });
  }

  /* 从 Cesium 实体反推原始要素结构（KML 来源导出时用） */
  function entitiesToRaw(entities) {
    var out = [];
    entities.forEach(function (e) {
      var now = CES.JulianDate.now();
      var rec = null;

      try {
        if (e.position) {
          var p = e.position.getValue(now) ||
            (e.billboard && e.billboard.position ? e.billboard.position.getValue(now) : null);
          if (p) {
            var c = CES.Cartographic.fromCartesian(p);
            rec = {
              id: e.id, name: e.name || e.id, type: "point",
              coordinates: [deg(c.longitude), deg(c.latitude), c.height],
              properties: entityProps(e)
            };
          }
        }
        if (!rec && e.polyline && e.polyline.positions && e.polyline.positions.getValue) {
          var arr = e.polyline.positions.getValue(now);
          if (arr && arr.length >= 2) {
            rec = {
              id: e.id, name: e.name || e.id, type: "polyline",
              coordinates: arr.map(function (x) {
                var c2 = CES.Cartographic.fromCartesian(x);
                return [deg(c2.longitude), deg(c2.latitude), c2.height];
              }),
              properties: entityProps(e)
            };
          }
        }
        if (!rec && e.polygon && e.polygon.hierarchy && e.polygon.hierarchy.getValue) {
          var h = e.polygon.hierarchy.getValue(now);
          var pos = h && h.positions ? h.positions : h;
          if (pos && pos.length >= 3) {
            rec = {
              id: e.id, name: e.name || e.id, type: "polygon",
              coordinates: pos.map(function (x) {
                var c3 = CES.Cartographic.fromCartesian(x);
                return [deg(c3.longitude), deg(c3.latitude), c3.height];
              }),
              properties: entityProps(e)
            };
          }
        }
      } catch (err) { /* 单个要素失败不影响其它 */ }

      if (rec) {
        // 绑定 Cesium 实体，单条显隐时用
        rec.entity = e;
        rec.visible = true;
        out.push(rec);
      }
    });
    return out;
  }

  function loadAllLabels() {
    var defs = CFG.labels || [];
    var chain = Promise.resolve();
    defs.forEach(function (def) {
      chain = chain.then(function () {
        return urlExists(def.url).then(function (ok) {
          if (!ok) {
            S.layers.push({
              id: def.id, name: def.name, type: def.type.toUpperCase(),
              color: def.color, count: 0, enabled: false, missing: true,
              note: "文件未找到：" + def.url
            });
            return null;
          }
          if (def.type === "kml") return loadKML(def);
          return loadJSONLabels(def);
        });
      }).then(function (res) {
        if (res) {
          var layer = S.layers[S.layers.length - 1];
          if (def.enabled === false) setLayerEnabled(layer, false);
        }
      }).catch(function (err) {
        S.layers.push({
          id: def.id, name: def.name, type: String(def.type).toUpperCase(),
          color: def.color, count: 0, enabled: false, missing: true,
          note: "读取失败：" + (err && err.message || err)
        });
      });
    });
    return chain.then(function () { renderLayerPanel(); });
  }

  function setLayerEnabled(layer, on) {
    layer.enabled = on;
    if (layer.ds) layer.ds.show = on;
    // 整层开关：每条实体的显示 = 层开关 && 该条自己的 visible
    (layer.rawFeatures || []).forEach(function (feat) {
      var ent = feat && feat.entity;
      if (ent) ent.show = !!(on && feat.visible);
    });
    // 兜底：没有 rawFeatures 时（异常情况）直接切实体
    if (!(layer.rawFeatures || []).length) {
      (layer.entities || []).forEach(function (e) {
        if (!e.isCesium3DTileset) e.show = on;
      });
    }
  }

  /* 单个标签显隐：实体显示 = 层开关 && 本标签开关 */
  function setFeatureEnabled(layer, idx, on) {
    var feats = layer.rawFeatures || [];
    if (!feats[idx]) return;
    feats[idx].visible = on;
    var ent = feats[idx].entity;
    if (ent) ent.show = !!(layer.enabled && on);
    // 没绑实体时（KML 来源）用实体 id 兜底
    if (!ent && layer.entities) {
      var fid = feats[idx].id;
      (layer.entities || []).forEach(function (e) {
        if (String(e.id) === String(fid)) e.show = !!(layer.enabled && on);
      });
    }
  }

  function setAllLayers(on) {
    S.layers.forEach(function (l) { if (!l.missing) setLayerEnabled(l, on); });
    renderLayerPanel();
  }

  /* ------------------------------ 拾取与属性 ------------------------------ */
  function bindPicking() {
    var handler = new CES.ScreenSpaceEventHandler(S.viewer.scene.canvas);
    S.handler = handler;

    handler.setInputAction(function (movement) {
      if (S.draw.mode) { drawClick(movement.position); return; }
      if (S.measure.mode) { measureClick(movement.position); return; }
      var picked = S.viewer.scene.pick(movement.position);
      if (CES.defined(picked)) {
        if (picked.id instanceof CES.Entity) { selectEntity(picked.id); return; }
        if (typeof CES.Cesium3DTileFeature !== "undefined" && picked instanceof CES.Cesium3DTileFeature) {
          showTileFeature(picked); return;
        }
        if (picked.primitive && picked.primitive.isCesium3DTileset) {
          showPointCoord(movement.position, "三维模型表面");
          return;
        }
      }
      showPointCoord(movement.position, "三维空间");
    }, CES.ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction(function (movement) {
      if (S.draw.mode) { finishDraw(); return; }
      if (S.measure.mode) { finishMeasure(); return; }
    }, CES.ScreenSpaceEventType.RIGHT_CLICK);

    handler.setInputAction(function (movement) {
      if (S.draw.mode) { drawMove(movement.endPosition); return; }
      if (S.measure.mode) measureMove(movement.endPosition);
    }, CES.ScreenSpaceEventType.MOUSE_MOVE);

    S.viewer.scene.canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  }

  function pickWorld(position) {
    var scene = S.viewer.scene;
    var p = null;
    if (scene.pickPositionSupported) {
      p = scene.pickPosition(position);
      if (p && CES.defined(p)) return p;
    }
    return scene.camera.pickEllipsoid(position, CES.Ellipsoid.WGS84) || null;
  }

  function showPointCoord(pos, where) {
    var world = pickWorld(pos);
    if (!world) { toast("该位置没有可拾取的面", "warn"); return; }
    var c = CES.Cartographic.fromCartesian(world);
    S.selected = null;
    openPanel("info");
    $("panelBody").innerHTML =
      '<div class="info-head"><h3>' + (where || "点位") + '</h3>' +
      '<p>点击模型或标签可查看其属性</p></div>' +
      '<table class="kv-table">' +
      row("经度", deg(c.longitude).toFixed(8) + " °") +
      row("纬度", deg(c.latitude).toFixed(8) + " °") +
      row("椭球高", fmt(c.height, 2) + " m") +
      '</table>' +
      '<p class="hint" style="margin-top:12px">高程为 <b>WGS84 椭球高（HAE）</b>，不是海拔（ASL）。两者在你所在地区可能相差 30~50 m，做病害台账时别混用。</p>';
  }

  function row(k, v) {
    return "<tr><td>" + k + "</td><td>" + v + "</td></tr>";
  }

  function propsToPairs(props) {
    var pairs = [];
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === "") return;
      if (typeof v === "object" && v.getValue) { try { v = v.getValue(CES.JulianDate.now()); } catch (e) { v = String(v); } }
      if (typeof v === "object") v = JSON.stringify(v);
      pairs.push([k, String(v)]);
    });
    return pairs;
  }

  function valueCell(v) {
    var s = String(v);
    if (/^(data:image\/|\.?\/?[^\s]*\.(jpg|jpeg|png|webp))$/i.test(s) || /\.(jpg|jpeg|png|webp)(\?|$)/i.test(s)) {
      return '<a href="' + s + '" target="_blank" rel="noopener">' + escapeHtml(s) + '</a><img class="kv-img" src="' + s + '" loading="lazy" onerror="this.style.display=\'none\'">';
    }
    return escapeHtml(s);
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function entityProps(entity) {
    var mine = PROPS.get(entity);
    if (mine) return mine;
    var out = {};
    try {
      if (entity.properties && entity.properties.getValue) {
        var val = entity.properties.getValue(CES.JulianDate.now());
        if (val && typeof val === "object") out = val;
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function selectEntity(entity) {
    S.selected = entity;
    var pairs = propsToPairs(entityProps(entity));

    var title = entity.name || entity.id || "未命名要素";
    var html = '<div class="info-head"><h3>' + escapeHtml(title) + '</h3>' +
      '<p>要素 ID：' + escapeHtml(String(entity.id)) + '</p></div>';

    if (pairs.length) {
      html += '<table class="kv-table">';
      pairs.forEach(function (p) { html += "<tr><td>" + escapeHtml(p[0]) + "</td><td>" + valueCell(p[1]) + "</td></tr>"; });
      html += "</table>";
    } else {
      html += '<p class="hint">该要素没有附加属性。<br>司空2 的病害属性写在 KML 的 <b>ExtendedData</b> 里；若为空，请在司空2 导出时勾选"包含标注属性"，或用 <b>kml转标签json.py</b> 把描述拆成属性。</p>';
    }

    html += '<div style="margin-top:14px;display:flex;gap:8px">' +
      '<button class="btn btn-sm" id="btnFlyToSel">飞到该要素</button>' +
      '<button class="btn btn-sm" id="btnHideSel">隐藏该要素</button></div>';

    openPanel("info");
    $("panelBody").innerHTML = html;
    $("btnFlyToSel").onclick = function () { flyToEntity(entity); };
    $("btnHideSel").onclick = function () {
      entity.show = false;
      toast("已隐藏：" + title);
      renderLayerPanel();
    };
  }

  function showTileFeature(feature) {
    var pairs = [];
    try {
      feature.getPropertyIds().forEach(function (id) {
        var v = feature.getProperty(id);
        if (v !== undefined && v !== null && v !== "") pairs.push([id, String(v)]);
      });
    } catch (e) { /* ignore */ }
    var html = '<div class="info-head"><h3>模型构件</h3><p>来自 3DTiles 瓦片自带属性表（batch table）</p></div>';
    if (pairs.length) {
      html += '<table class="kv-table">';
      pairs.forEach(function (p) { html += "<tr><td>" + escapeHtml(p[0]) + "</td><td>" + valueCell(p[1]) + "</td></tr>"; });
      html += "</table>";
    } else {
      html += '<p class="hint">这个瓦片没有构件属性，是纯几何网格（司空2 的倾斜/单体模型通常如此）。</p>';
    }
    S.selected = null;
    openPanel("info");
    $("panelBody").innerHTML = html;
  }

  function flyToEntity(entity) {
    if (!entity) return;
    try {
      S.viewer.flyTo(entity, {
        duration: 1.5,
        offset: new CES.HeadingPitchRange(0, CES.Math.toRadians(-45), 45)
      });
    } catch (e) { toast("无法定位该要素", "warn"); }
  }

  /* ------------------------------ 标绘（在地图上点/画标签） ------------------------------ */

  function setDrawMode(mode) {
    // 关掉任何进行中的测量，避免互相抢
    if (S.measure.mode) clearMeasure();
    S.draw.points = [];
    S.draw.preview = null;
    if (S.drawDS) S.drawDS.entities.removeAll();
    S.draw.mode = mode;
    S.draw.pending = null;

    if (!mode) {
      S.viewer.scene.canvas.style.cursor = "default";
      $("statHint").textContent = "鼠标左键旋转，滚轮缩放，右键平移";
      return;
    }
    S.viewer.scene.canvas.style.cursor = "crosshair";
    var tip = mode === "point"
      ? "标点：左键在地图上单击落点，右键结束"
      : (mode === "polyline"
        ? "画线：左键依次点击转折点，右键结束"
        : "画面：左键依次点击多边形顶点，右键闭合");
    $("statHint").textContent = tip;
  }

  function drawClick(pos) {
    var world = pickWorld(pos);
    if (!world) { toast("该位置没有可拾取的面", "warn"); return; }
    var mode = S.draw.mode;
    if (mode === "point") {
      // 点标签：单击即完成
      S.draw.points = [world];
      finishDraw();
      return;
    }
    S.draw.points.push(world);
    drawPreview();
  }

  function drawMove(pos) {
    if (S.draw.mode !== "polyline" && S.draw.mode !== "polygon") return;
    if (!S.draw.points.length) return;
    var world = pickWorld(pos);
    if (!world) return;
    if (S.draw.preview) S.drawDS.entities.remove(S.draw.preview);
    var pts = S.draw.points.concat([world]);
    S.draw.preview = S.drawDS.entities.add({
      polyline: {
        positions: pts,
        width: 1.5,
        material: new CES.PolylineDashMaterialProperty({
          color: CES.Color.WHITE.withAlpha(0.6), dashLength: 10
        }),
        clampToGround: false,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
  }

  function drawPreview() {
    if (S.drawDS) S.drawDS.entities.removeAll();
    S.draw.preview = null;
    var pts = S.draw.points;
    if (!pts.length) return;
    // 顶点标记
    pts.forEach(function (p, i) {
      S.drawDS.entities.add({
        position: p,
        point: {
          pixelSize: 8, color: MEASURE_COLOR,
          outlineColor: CES.Color.fromCssColorString("#0a0f16"), outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: String(i + 1),
          font: '600 11px "Microsoft YaHei", sans-serif',
          fillColor: MEASURE_COLOR,
          pixelOffset: new CES.Cartesian2(0, -14),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
    });
    if (pts.length >= 2) {
      var pos = pts;
      if (S.draw.mode === "polygon") pos = pts.concat([pts[0]]);
      S.drawDS.entities.add({
        polyline: {
          positions: pos,
          width: 2.5,
          material: new CES.ColorMaterialProperty(MEASURE_COLOR.withAlpha(0.9)),
          clampToGround: false,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
    }
    if (S.draw.mode === "polygon" && pts.length >= 3) {
      S.drawDS.entities.add({
        polygon: {
          hierarchy: new CES.PolygonHierarchy(pts),
          perPositionHeight: true,
          material: MEASURE_COLOR.withAlpha(0.16),
          outline: true,
          outlineColor: MEASURE_COLOR.withAlpha(0.6),
          arcType: CES.ArcType.NONE
        }
      });
    }
  }

  function finishDraw() {
    var pts = S.draw.points;
    if (S.draw.preview) { S.drawDS.entities.remove(S.draw.preview); S.draw.preview = null; }
    var mode = S.draw.mode;
    if (!mode || !pts.length) { setDrawMode(null); return; }

    // 点：1 个点；线：>=2；面：>=3
    var valid = mode === "point" ? pts.length === 1
      : mode === "polyline" ? pts.length >= 2
      : pts.length >= 3;
    if (!valid) {
      if (mode === "point") toast("没点到位，重新试", "warn");
      else toast((mode === "polyline" ? "线" : "面") + "至少需要 " + (mode === "polyline" ? 2 : 3) + " 个点", "warn");
      setDrawMode(null);
      return;
    }

    // 收集坐标（cartesian -> lon/lat/h）
    var coords = pts.map(function (p) {
      var c = CES.Cartographic.fromCartesian(p);
      return [deg(c.longitude), deg(c.latitude), c.height];
    });
    if (mode === "point") coords = coords[0];

    // 弹出命名面板
    S.draw.pending = { mode: mode, coords: coords };
    renderDrawDlg(mode, coords);
    setDrawMode(null);   // 结束绘制，但保留 drawDS 上的预览直到命名
  }

  /* 标绘画板主入口：选择要画点/线/面（由 openPanel("draw") 调用，勿再调 openPanel 以免递归） */
  function openDrawPanel() {
    // 有 pending 时（正在命名）不覆盖
    if (S.draw.pending) { renderDrawDlg(S.draw.pending.mode, S.draw.pending.coords); return; }
    if (S.draw.mode) { showDrawActive(); return; }

    var html = '<div class="sec"><div class="sec-title"><span>在地图上绘制标签</span></div>' +
      '<p class="hint">点一个点生成<b>点标签</b>，画一条线生成<b>线标签</b>，' +
      '画一个多边形生成<b>面标签</b>。画完会弹出命名窗口，保存后就是一个独立的标签。</p></div>' +
      '<div class="sec">' +
      '<button class="btn btn-block" style="margin-bottom:8px" id="btnDrawPoint">' +
      '<svg viewBox="0 0 20 20" style="width:14px;height:14px;vertical-align:-2px"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="2.5" fill="currentColor"/></svg> ' +
      '标点</button>' +
      '<button class="btn btn-block" style="margin-bottom:8px" id="btnDrawLine">' +
      '<svg viewBox="0 0 20 20" style="width:14px;height:14px;vertical-align:-2px"><path d="M3 15 L17 5" stroke="currentColor" stroke-width="1.8"/></svg> ' +
      '画线</button>' +
      '<button class="btn btn-block" id="btnDrawPoly">' +
      '<svg viewBox="0 0 20 20" style="width:14px;height:14px;vertical-align:-2px"><path d="M4 6 L10 3 L17 8 L14 16 L6 15 Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg> ' +
      '画面</button>' +
      '</div>' +
      '<div class="sec"><div class="sec-title"><span>说明</span></div>' +
      '<p class="hint">左键落点，右键结束。画的过程中按 <b>Esc</b> 取消当前绘制。<br>' +
      '保存的点/线会作为独立标签出现在「图层」面板，可单条显隐、可导出 KML。</p></div>';

    $("panelBody").innerHTML = html;
    $("btnDrawPoint").onclick = function () { setDrawMode("point"); showDrawActive(); };
    $("btnDrawLine").onclick = function () { setDrawMode("polyline"); showDrawActive(); };
    $("btnDrawPoly").onclick = function () { setDrawMode("polygon"); showDrawActive(); };
  }

  /* 绘制中的提示面板 */
  function showDrawActive() {
    var tip = S.draw.mode === "point" ? "正在标点：在地图上单击，右键完成"
      : S.draw.mode === "polyline" ? "正在画线：左键加转折点，右键完成"
      : "正在画面：左键加顶点，右键闭合";
    $("panelBody").innerHTML =
      '<div class="result-card"><div class="rlabel">绘制中</div>' +
      '<div class="rvalue" style="font-size:15px">' + tip + '</div>' +
      '<div class="rsub">已取点 ' + S.draw.points.length + ' 个</div></div>' +
      '<div class="empty-actions" style="margin-top:10px">' +
      '<button class="btn btn-danger" id="btnDrawCancel2">取消绘制</button></div>';
    $("btnDrawCancel2").onclick = function () {
      setDrawMode(null);
      S.drawDS.entities.removeAll();
      openDrawPanel();
    };
  }

  /* 绘制完成后的命名/保存对话框 */
  function renderDrawDlg(mode, coords) {
    var shapeCn = { point: "点", polyline: "线", polygon: "面" };
    var html = '<div class="sec"><div class="sec-title"><span>保存为新标签</span>' +
      '<span class="tagm">' + shapeCn[mode] + "</span></div>" +
      '<div class="form-row"><label>名称</label>' +
        '<input type="text" id="drawName" placeholder="标签名称" autofocus ' +
        'style="flex:1;background:#0c141c;color:#dbe6f0;border:1px solid #1e2c3a;border-radius:6px;padding:8px 10px;font-size:12.5px;font-family:inherit;outline:none">' +
      '</div>' +
      '<div class="form-row"><label>颜色</label>' +
        '<input type="color" id="drawColor" value="#00d4aa" ' +
        'style="width:52px;height:30px;padding:2px;background:#0c141c;border:1px solid #1e2c3a;border-radius:6px;cursor:pointer">' +
      '</div>' +
      '<div class="sec" style="margin-top:8px"><div class="sec-title"><span>图标形状（仅点）</span></div>' +
        buildShapePicker("drawShapes", mode === "point" ? "pin" : "pin") +
      '</div>' +
      '<div class="empty-actions" style="margin-top:14px">' +
        '<button class="btn btn-primary" id="btnDrawSave">保存</button>' +
        '<button class="btn" id="btnDrawCancel">取消</button>' +
        '<button class="btn" id="btnDrawClear" style="margin-left:auto">重新画</button>' +
      '</div>';

    openPanel("draw");
    $("panelBody").innerHTML = html;

    var shape = "pin";
    Array.prototype.forEach.call(document.querySelectorAll(".shape-btn"), function (b) {
      b.onclick = function () {
        shape = b.getAttribute("data-shape");
        Array.prototype.forEach.call(document.querySelectorAll(".shape-btn"), function (x) {
          x.classList.toggle("active", x === b);
        });
      };
    });

    var nameEl = $("drawName");
    nameEl.focus();

    $("btnDrawSave").onclick = function () {
      if (!S.draw.pending) { closePanel(); return; }
      var p = S.draw.pending;
      var nm = (nameEl.value || "").trim() || ("新标签-" + (Date.now() % 10000));
      var color = $("drawColor").value || "#00d4aa";
      saveDrawnLabel(p.mode, p.coords, nm, color, shape);
      S.draw.pending = null;
      S.drawDS.entities.removeAll();
      closePanel();
    };
    $("btnDrawCancel").onclick = function () {
      S.draw.pending = null;
      S.drawDS.entities.removeAll();
      closePanel();
    };
    $("btnDrawClear").onclick = function () {
      S.draw.pending = null;
      S.drawDS.entities.removeAll();
      setDrawMode(p.mode);
      openPanel("draw");
      $("panelBody").innerHTML = '<p class="hint">重新绘制：左键落点，右键结束。</p>' +
        '<div class="empty-actions" style="margin-top:12px">' +
        '<button class="btn" id="btnDrawStop">停止标绘</button></div>';
      $("btnDrawStop").onclick = function () { setDrawMode(null); closePanel(); };
    };
    nameEl.onkeydown = function (e) { if (e.key === "Enter") $("btnDrawSave").click(); };
  }

  /* 把画好的几何保存成一个新的标签层（复用 applyLabelData） */
  function saveDrawnLabel(type, coords, name, color, icon) {
    var def = {
      id: "drawn-" + Date.now().toString(36),
      name: name,
      color: color,
      icon: icon || "pin",
      userAdded: true
    };
    var data = {
      version: 1,
      name: name,
      groups: [{ id: "main", name: name, color: color, icon: icon || "pin" }],
      features: [{
        id: "drawn-" + (Date.now() % 100000),
        group: "main",
        name: name,
        type: type,
        coordinates: coords,
        label: name,
        showLabel: true,
        properties: { 类型: type === "point" ? "点" : type === "polyline" ? "线" : "面", 来源: "手动标绘" }
      }]
    };
    applyLabelData(def, data);
    // 记入 userLabels，可持久化
    S.userLabels.push({ id: def.id, name: def.name, type: "json", color: color, icon: icon, data: data });
    saveUserLabels();
    renderLayerPanel();
    toast("已保存标签：" + name);
  }

  /* ------------------------------ 测量 ------------------------------ */
  function setMeasureMode(mode) {
    S.measure.mode = mode;
    S.measure.points = [];
    S.measureDS.entities.removeAll();
    if (!mode) {
      S.viewer.scene.canvas.style.cursor = "default";
      openPanel("measure");
      return;
    }
    S.viewer.scene.canvas.style.cursor = "crosshair";
    $("statHint").textContent = mode === "distance"
      ? "测距中：左键依次点选，右键结束"
      : "测面积中：左键依次点选多边形顶点，右键结束";
    openPanel("measure");
    renderMeasurePanel();
  }

  function measureClick(pos) {
    var world = pickWorld(pos);
    if (!world) { toast("该位置没有可拾取的面", "warn"); return; }
    S.measure.points.push(world);
    drawMeasure();
    renderMeasurePanel();
  }

  function measureMove(pos) {
    if (!S.measure.points.length) return;
    var world = pickWorld(pos);
    if (!world) return;
    if (S.measure.preview) S.measureDS.entities.remove(S.measure.preview);
    var pts = S.measure.points.concat([world]);
    S.measure.preview = S.measureDS.entities.add({
      polyline: {
        positions: pts,
        width: 2,
        material: new CES.PolylineDashMaterialProperty({ color: MEASURE_COLOR.withAlpha(0.7), dashLength: 12 }),
        clampToGround: false,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
  }

  function drawMeasure() {
    S.measureDS.entities.removeAll();
    S.measure.preview = null;
    var pts = S.measure.points;
    if (!pts.length) return;

    pts.forEach(function (p, i) {
      S.measureDS.entities.add({
        position: p,
        point: {
          pixelSize: 7, color: MEASURE_COLOR,
          outlineColor: CES.Color.fromCssColorString("#0a0f16"), outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: String(i + 1),
          font: '600 11px "Microsoft YaHei", sans-serif',
          fillColor: MEASURE_COLOR,
          showBackground: false,
          pixelOffset: new CES.Cartesian2(0, -14),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new CES.NearFarScalar(200, 1, 1200, 0.5)
        }
      });
    });

    if (S.measure.mode === "area") {
      if (pts.length >= 3) {
        S.measureDS.entities.add({
          polygon: {
            hierarchy: new CES.PolygonHierarchy(pts),
            perPositionHeight: true,
            material: MEASURE_COLOR.withAlpha(0.2),
            outline: true,
            outlineColor: MEASURE_COLOR,
            arcType: CES.ArcType.NONE
          }
        });
      }
      if (pts.length >= 2) {
        S.measureDS.entities.add({
          polyline: {
            positions: pts.concat([pts[0]]),
            width: 2, material: new CES.ColorMaterialProperty(MEASURE_COLOR),
            clampToGround: false, disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        });
      }
    } else if (pts.length >= 2) {
      S.measureDS.entities.add({
        polyline: {
          positions: pts,
          width: 2.5, material: new CES.ColorMaterialProperty(MEASURE_COLOR),
          clampToGround: false, disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      for (var i = 1; i < pts.length; i++) {
        var a = pts[i - 1], b = pts[i];
        var len = CES.Cartesian3.distance(a, b);
        var mid = CES.Cartesian3.midpoint(a, b, new CES.Cartesian3());
        S.measureDS.entities.add({
          position: mid,
          label: {
            text: len >= 1000 ? fmt(len / 1000, 2) + " km" : fmt(len, 2) + " m",
            font: '600 11px "Microsoft YaHei", sans-serif',
            fillColor: MEASURE_COLOR,
            outlineColor: CES.Color.fromCssColorString("#0a0f16"),
            outlineWidth: 3,
            style: CES.LabelStyle.FILL_AND_OUTLINE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new CES.NearFarScalar(200, 1, 1500, 0.55)
          }
        });
      }
    }
  }

  function measureTotals() {
    var pts = S.measure.points;
    if (S.measure.mode === "area") {
      if (pts.length < 3) return { area: 0, perimeter: 0 };
      var area = polygonArea(pts);
      var per = 0;
      for (var i = 0; i < pts.length; i++) per += CES.Cartesian3.distance(pts[i], pts[(i + 1) % pts.length]);
      return { area: area, perimeter: per };
    }
    var d = 0;
    for (var j = 1; j < pts.length; j++) d += CES.Cartesian3.distance(pts[j - 1], pts[j]);
    return { distance: d };
  }

  /* 面积：投影到首点 ENU 平面后用鞋带公式，适合常规巡检范围 */
  function polygonArea(positions) {
    var origin = positions[0];
    var enu = CES.Transforms.eastNorthUpToFixedFrame(origin);
    var inv = CES.Matrix4.inverseTransformation(enu, new CES.Matrix4());
    var pts = positions.map(function (p) { return CES.Matrix4.multiplyByPoint(inv, p, new CES.Cartesian3()); });
    var sum = 0;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  }

  function finishMeasure() {
    if (!S.measure.mode) return;
    var mode = S.measure.mode;
    var t = measureTotals();
    S.viewer.scene.canvas.style.cursor = "default";
    $("statHint").textContent = "鼠标左键旋转，滚轮缩放，右键平移";
    S.measure.mode = null;
    if (mode === "distance" && (!t.distance || t.distance <= 0)) { toast("没有量到长度", "warn"); }
    renderMeasurePanel(mode === "area"
      ? ("面积 " + fmt(t.area, 1) + " m² · 周长 " + fmt(t.perimeter, 1) + " m")
      : ("距离 " + fmt(t.distance || 0, 2) + " m"));
  }

  function clearMeasure() {
    S.measure.mode = null;
    S.measure.points = [];
    S.measureDS.entities.removeAll();
    S.viewer.scene.canvas.style.cursor = "default";
    $("statHint").textContent = "鼠标左键旋转，滚轮缩放，右键平移";
    renderMeasurePanel();
  }

  /* ------------------------------ 面板渲染 ------------------------------ */
  function openPanel(name) {
    S.activePanel = name;
    var titles = { layer: "图层管理", info: "要素属性", measure: "测量", offset: "位置校正", draw: "标绘" };
    $("panelTitle").textContent = titles[name] || "";
    $("panel").classList.remove("panel-hidden");
    Array.prototype.forEach.call(document.querySelectorAll(".rail-btn"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-panel") === name);
    });
    if (name === "layer") renderLayerPanel();
    if (name === "measure") renderMeasurePanel();
    if (name === "offset") renderOffsetPanel();
    if (name === "draw") openDrawPanel();
    if (name === "info" && !S.selected) {
      $("panelBody").innerHTML = '<div class="info-empty"><b>还没有选中要素</b>在三维视图里左键点一下病害标签或模型面，这里会显示它的属性、照片和坐标。</div>';
    }
  }

  function closePanel() {
    $("panel").classList.add("panel-hidden");
    S.activePanel = null;
    Array.prototype.forEach.call(document.querySelectorAll(".rail-btn"), function (b) { b.classList.remove("active"); });
  }

  function renderLayerPanel() {
    if (S.activePanel !== "layer") return;
    var total = 0;
    S.layers.forEach(function (l) { total += l.count || 0; });

    /* ---------- 模型区：多模型列表 ---------- */
    var html = '<div class="sec"><div class="sec-title"><span>模型（' + S.models.length + '）</span>' +
      '<span class="mini"><a href="#" id="lnkAddModel" style="color:#00d4aa;text-decoration:none">+ 添加</a></span></div>';

    if (S.models.length) {
      S.models.forEach(function (m) {
        var shown = m.tileset ? m.tileset.show : false;
        html += '<div class="layer-row' + (m.userAdded ? " user-added" : "") + '" data-model="' + escapeHtml(m.id) + '">' +
          '<span class="chk"' + (shown ? "" : ' style="opacity:.35"') + '></span>' +
          '<span class="swatch" style="background:#4aa8ff"></span>' +
          '<span class="lname">' + escapeHtml(m.name) + '</span>' +
          (m.loading ? '<span class="tagm">加载中</span>' :
            '<span class="lcount">' + (m.type === "glb" ? "GLB" : "3DTiles") + '</span>') +
          '<button class="mini-x" data-model-del="' + escapeHtml(m.id) + '" title="移除此模型（会再确认一次）">×</button>' +
          '</div>';
      });
    } else {
      html += '<p class="hint">还没有模型。点上面的「+ 添加」选择本地 <b>tileset.json</b> 或 <b>.glb</b> 文件。</p>';
    }
    html += "</div>";

    /* ---------- 标签区 ---------- */
    html += '<div class="sec"><div class="sec-title"><span>矢量标签</span>' +
      '<span class="mini">共 ' + total + ' 个要素 · ' +
      '<a href="#" id="lnkAddLabel" style="color:#00d4aa;text-decoration:none">+ 添加</a></span></div>';

    if (!S.layers.length) {
      html += '<p class="hint">还没有标签。点上面的「+ 添加」选择标签 JSON 或 KML 文件。</p>';
    } else {
      S.layers.forEach(function (l, i) {
        var cls = "layer-row" + (l.enabled ? "" : " off") + (l.missing ? " dead" : "");
        var iconPrev = (l.count && !l.missing) ?
          '<img class="layer-icon" src="' + iconUrl(l.color || "#888", l.icon || "pin") + '" alt="">' : '';
        var canExport = !l.missing && (l.rawFeatures || []).length > 0;
        // 展开箭头（有子条目才显示）
        var arrow = (l.rawFeatures && l.rawFeatures.length > 1) ?
          '<button class="mini-fold' + (l._expanded ? " folded" : "") + '" data-fold-layer="' + i + '" title="展开/收起单个标签">▸</button>' : "";
        html += '<div class="layer-row' + (l._expanded ? " expanded" : "") + '" data-layer="' + i + '">' +
          '<span class="chk"' + (l.missing ? ' style="opacity:.35"' : "") + '></span>' +
          '<span class="swatch" style="background:' + (l.color || "#888") + '"></span>' +
          '<span class="lname">' + escapeHtml(l.name) + '</span>' +
          arrow +
          iconPrev +
          (l.missing ? '<span class="tagm">未提供</span>' : '<span class="lcount">' + l.count + "</span>") +
          (canExport ? '<button class="mini-dl" data-export-layer="' + i + '" ' +
            'title="把这一层导出成 KML">↓</button>' : "") +
          '</div>';

        // 展开后：逐个条目渲染，每个可单独勾选
        if (l._expanded && (l.rawFeatures || []).length) {
          html += '<div class="layer-children" data-children="' + i + '">';
          l.rawFeatures.forEach(function (f, j) {
            var fcls = "child-row" + (f.visible ? "" : " off");
            var favatar = '<img class="layer-icon" src="' +
              iconUrl(l.color || "#888", f.icon || l.icon || "pin") + '" alt="">';
            html += '<div class="' + fcls + '" data-feat="' + i + '" data-fi="' + j + '">' +
              '<span class="chk"' + (f.visible ? "" : ' style="opacity:.35"') + '></span>' +
              favatar +
              '<span class="lname">' + escapeHtml(f.name || f.id || ("要素 " + (j + 1))) + '</span>' +
              '<span class="tagm">' + (f.type === "point" ? "点" : f.type === "polyline" ? "线" : f.type === "polygon" ? "面" : "?") + '</span>' +
              '</div>';
          });
          html += '</div>';
        }

        if (l.note) html += '<p class="hint" style="margin:-2px 0 8px">' + escapeHtml(l.note) + "</p>";
      });
    }
    html += "</div>";

    /* ---------- 批量显隐 ---------- */
    html += '<div class="sec">' +
      '<div class="form-row" style="gap:8px">' +
      '<button class="btn btn-sm" style="flex:1" id="btnAllOn">全部显示</button>' +
      '<button class="btn btn-sm" style="flex:1" id="btnAllOff">全部隐藏</button></div>' +
      '<div class="form-row" style="gap:8px;margin-top:8px">' +
      '<button class="btn btn-sm" style="flex:1" id="btnModelsOn">模型全显</button>' +
      '<button class="btn btn-sm" style="flex:1" id="btnModelsOff">模型全隐</button></div>' +
      '<div class="form-row" style="gap:8px;margin-top:8px">' +
      '<button class="btn btn-sm btn-primary" style="flex:1" id="btnExportKML" ' +
      'title="把当前所有标签导出成 KML 文件，可直接导入奥维/谷歌地球/司空2">导出全部为 KML</button></div>' +
      "</div>";

    /* ---------- 定位 ---------- */
    html += '<div class="sec"><div class="sec-title"><span>定位要素</span></div>' +
      '<div class="form-row"><input type="text" id="findInput" placeholder="输入编号或名称，如 XS-001 / K1+000" ' +
      'style="flex:1;background:#0c141c;color:#dbe6f0;border:1px solid #1e2c3a;border-radius:6px;padding:8px 10px;font-size:12.5px;font-family:inherit;outline:none">' +
      '<button class="btn btn-sm" id="btnFind" style="flex:none">定位</button></div>' +
      '<p class="hint">输入编号/名称后点定位，会直接飞到对应要素并打开属性。</p></div>';

    $("panelBody").innerHTML = html;
    bindLayerPanelEvents();
  }

  function bindLayerPanelEvents() {
    var body = $("panelBody");

    // 添加入口
    var addM = $("lnkAddModel");
    if (addM) addM.onclick = function (e) { e.preventDefault(); openAddModelDialog(); };
    var addL = $("lnkAddLabel");
    if (addL) addL.onclick = function (e) { e.preventDefault(); openAddLabelDialog(); };

    // 单击模型行 = 显隐切换
    Array.prototype.forEach.call(body.querySelectorAll("[data-model]"), function (row) {
      row.onclick = function (e) {
        if (e.target.getAttribute && e.target.getAttribute("data-model-del")) return;
        var m = findModel(row.getAttribute("data-model"));
        if (!m || !m.tileset) return;
        m.tileset.show = !m.tileset.show;
        renderLayerPanel();
      };
    });

    // 移除模型（点一次变成"确认移除"，再点才真删，避免误点）
    Array.prototype.forEach.call(body.querySelectorAll("[data-model-del]"), function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var id = btn.getAttribute("data-model-del");
        var m = findModel(id);
        if (!m) return;

        if (btn.getAttribute("data-armed") !== "1") {
          // 第一次点击：变成确认态，3 秒后自动复原
          btn.setAttribute("data-armed", "1");
          btn.textContent = "确认";
          btn.classList.add("armed");
          btn.title = "再点一次真的移除「" + m.name + "」";
          setTimeout(function () {
            if (!btn.isConnected) return;
            btn.removeAttribute("data-armed");
            btn.textContent = "×";
            btn.classList.remove("armed");
            btn.title = "移除此模型";
          }, 3000);
          return;
        }

        removeModel(id);
      };
    });

    // 标签行 = 显隐切换（除导出/折叠按钮外）
    Array.prototype.forEach.call(body.querySelectorAll("[data-layer]"), function (rowEl) {
      rowEl.onclick = function (e) {
        // 点折叠箭头或导出按钮不切换显隐
        var t = e.target;
        if (t.getAttribute && (
            t.getAttribute("data-export-layer") !== null ||
            t.getAttribute("data-fold-layer") !== null)) return;
        var l = S.layers[+rowEl.getAttribute("data-layer")];
        if (!l || l.missing) return;
        setLayerEnabled(l, !l.enabled);
        renderLayerPanel();
      };
    });

    // 折叠箭头：展开/收起单个标签列表
    Array.prototype.forEach.call(body.querySelectorAll("[data-fold-layer]"), function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var li = +btn.getAttribute("data-fold-layer");
        var l = S.layers[li];
        if (!l) return;
        l._expanded = !l._expanded;
        renderLayerPanel();
      };
    });

    // 单条标签 = 单独显隐
    Array.prototype.forEach.call(body.querySelectorAll("[data-feat]"), function (row) {
      row.onclick = function () {
        var li = +row.getAttribute("data-feat");
        var fi = +row.getAttribute("data-fi");
        var l = S.layers[li];
        if (!l) return;
        setFeatureEnabled(l, fi, !((l.rawFeatures[fi] || {}).visible));
        renderLayerPanel();
      };
    });

    // 单层导出
    Array.prototype.forEach.call(body.querySelectorAll("[data-export-layer]"), function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var l = S.layers[+btn.getAttribute("data-export-layer")];
        if (!l || l.missing) return;
        exportKML([l], l.name);
      };
    });

    // 全部导出
    var btnAll = $("btnExportKML");
    if (btnAll) {
      btnAll.onclick = function () {
        var exportable = S.layers.filter(function (l) {
          return !l.missing && (l.rawFeatures || []).length > 0;
        });
        if (!exportable.length) {
          toast("没有可导出的标签（需要先添加含点/线/面的标签）", "warn");
          return;
        }
        exportKML(exportable, "全部标签");
      };
    }

    $("btnAllOn").onclick = function () {
      setAllLayers(true);
      S.models.forEach(function (m) { if (m.tileset) m.tileset.show = true; });
      renderLayerPanel();
    };
    $("btnAllOff").onclick = function () {
      setAllLayers(false);
      renderLayerPanel();
    };
    $("btnModelsOn").onclick = function () {
      S.models.forEach(function (m) { if (m.tileset) m.tileset.show = true; });
      renderLayerPanel();
    };
    $("btnModelsOff").onclick = function () {
      S.models.forEach(function (m) { if (m.tileset) m.tileset.show = false; });
      renderLayerPanel();
    };

    var input = $("findInput");
    $("btnFind").onclick = function () { doFind(input.value); };
    input.onkeydown = function (e) { if (e.key === "Enter") doFind(input.value); };
  }

  function doFind(q) {
    q = String(q || "").trim();
    if (!q) { toast("先输入要查找的编号或名称", "warn"); return; }
    var ql = q.toLowerCase();
    var hit = null;
    outer:
    for (var i = 0; i < S.layers.length; i++) {
      var ents = S.layers[i].entities || [];
      for (var j = 0; j < ents.length; j++) {
        var e = ents[j];
        var name = (e.name || "") + "";
        if (name.toLowerCase().indexOf(ql) >= 0 || String(e.id).toLowerCase().indexOf(ql) >= 0) { hit = e; break outer; }
        var ep = entityProps(e);
        if (Object.keys(ep).length && JSON.stringify(ep).toLowerCase().indexOf(ql) >= 0) { hit = e; break outer; }
      }
    }
    if (!hit) { toast("没有找到匹配的要素：" + q, "warn"); return; }
    selectEntity(hit);
    flyToEntity(hit);
  }

  function renderMeasurePanel(result) {
    if (S.activePanel !== "measure") return;
    var t = measureTotals();
    var html = "";

    if (S.measure.mode === "distance") {
      html += '<div class="result-card"><div class="rlabel">测距（累计）</div>' +
        '<div class="rvalue">' + fmt(t.distance || 0, 2) + ' m</div>' +
        '<div class="rsub">已点 ' + S.measure.points.length + " 个点 · 右键结束</div></div>";
    } else if (S.measure.mode === "area") {
      html += '<div class="result-card"><div class="rlabel">测面积</div>' +
        '<div class="rvalue">' + fmt(t.area || 0, 1) + ' m²</div>' +
        '<div class="rsub">周长 ' + fmt(t.perimeter || 0, 1) + " m · 已点 " + S.measure.points.length + " 个点 · 右键结束</div></div>";
    } else if (result) {
      html += '<div class="result-card"><div class="rlabel">上次测量结果</div>' +
        '<div class="rvalue" style="font-size:15px">' + escapeHtml(result) + "</div></div>";
    }

    html += '<div class="sec"><div class="sec-title"><span>开始测量</span></div>' +
      '<button class="btn btn-block" id="btnMeasDist" style="margin-bottom:8px"' + (S.measure.mode ? " disabled" : "") + '>测距（多点折线）</button>' +
      '<button class="btn btn-block" id="btnMeasArea" style="margin-bottom:8px"' + (S.measure.mode ? " disabled" : "") + '>测面积（多边形）</button>' +
      '<button class="btn btn-block btn-danger" id="btnMeasClear">清空测量</button></div>';

    html += '<div class="sec"><div class="sec-title"><span>说明</span></div>' +
      '<p class="hint">左键依次点选节点，<b>右键结束</b>。距离按模型真实三维长度计算（斜距），面积按投影到水平面计算。<br>' +
      "测量只在本机计算，不联网、不写回模型。</p></div>";

    $("panelBody").innerHTML = html;
    $("btnMeasDist").onclick = function () { setMeasureMode("distance"); };
    $("btnMeasArea").onclick = function () { setMeasureMode("area"); };
    $("btnMeasClear").onclick = clearMeasure;
  }

  function renderOffsetPanel() {
    if (S.activePanel !== "offset") return;
    var o = S.offset;
    var html = '<div class="sec"><div class="sec-title"><span>模型平移微调</span></div>' +
      '<div class="form-row"><label>东向 +</label><input type="number" id="offEast" step="0.5" value="' + o.east + '"><span class="unit">m</span></div>' +
      '<div class="form-row"><label>北向 +</label><input type="number" id="offNorth" step="0.5" value="' + o.north + '"><span class="unit">m</span></div>' +
      '<div class="form-row"><label>高程 +</label><input type="number" id="offUp" step="0.5" value="' + o.up + '"><span class="unit">m</span></div>' +
      '<button class="btn btn-primary btn-block" id="btnOffApply" style="margin-bottom:8px">应用偏移</button>' +
      '<div class="form-row" style="gap:8px">' +
      '<button class="btn btn-sm" style="flex:1" id="btnOffReset">归零</button>' +
      '<button class="btn btn-sm" style="flex:1" id="btnOffSave">记住这组值</button></div>' +
      "</div>";

    html += '<div class="sec"><div class="sec-title"><span>用途</span></div>' +
      '<p class="hint">司空2 导出的高程是 <b>椭球高 HAE</b>；如果你按实测海拔（ASL）对过点位，模型会整体浮起或压进地面——用"高程"往下压 30~50 m 就能对齐。<br>' +
      "东向/北向用于处理个别测段整体错位。<br>" +
      "<b>只影响本查看器显示，不改原始文件</b>；记住的值存在本机浏览器里，下次打开自动套用。</p></div>";

    $("panelBody").innerHTML = html;

    $("btnOffApply").onclick = function () {
      S.offset = {
        east: +$("offEast").value || 0,
        north: +$("offNorth").value || 0,
        up: +$("offUp").value || 0
      };
      applyOffset();
      toast("已应用：东 " + S.offset.east + " m / 北 " + S.offset.north + " m / 高 " + S.offset.up + " m");
    };
    $("btnOffReset").onclick = function () {
      S.offset = { east: 0, north: 0, up: 0 };
      applyOffset();
      renderOffsetPanel();
      toast("已归零");
    };
    $("btnOffSave").onclick = function () {
      try {
        localStorage.setItem((CFG.storage && CFG.storage.offset) || "xz3d.modelOffset", JSON.stringify(S.offset));
        toast("已记住当前偏移（下次打开自动套用）");
      } catch (e) { toast("保存失败：" + e.message, "err"); }
    };
  }

  /* ------------------------------ 顶栏 / 工具条交互 ------------------------------ */
  /* 顶栏模型选择器：选中即"加入场景"（多模型时不清空已有的） */
  function setupModels() {
    var sel = $("modelSelect");
    sel.innerHTML = "";
    var opt0 = document.createElement("option");
    opt0.value = "-1";
    opt0.textContent = "— 选择一个模型加入 —";
    sel.appendChild(opt0);

    (CFG.models || []).forEach(function (m, i) {
      var opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = m.name;
      sel.appendChild(opt);
    });
    sel.value = "-1";

    sel.onchange = function () {
      if (sel.value === "-1") return;
      var m = CFG.models[+sel.value];
      if (!m) return;
      try { localStorage.setItem((CFG.storage && CFG.storage.lastModel) || "xz3d.lastModel", m.id); } catch (e) {}
      // 已经加过就不重复加，只做显隐/定位
      var exist = S.models.filter(function (x) { return x.url === m.url; })[0];
      if (exist) {
        if (exist.tileset) exist.tileset.show = true;
        toast("模型已在场景中：" + exist.name);
        renderLayerPanel();
        return;
      }
      tryLoadSelected(m);
      sel.value = "-1";
    };
    return -1;
  }

  function tryLoadSelected(modelDef) {
    urlExists(modelDef.url).then(function (ok) {
      if (ok) {
        loadModel(modelDef, { focus: true });
      } else {
        toast("没找到模型文件：" + modelDef.url, "warn");
        if (!S.models.length) {
          S.modelDef = modelDef;
          setModelState("wait", "等待模型");
          $("statTiles").textContent = "瓦片 —";
          showEmpty("还没有检测到三维模型",
            "点「+ 添加」选择本地模型，或把文件放进 data/model/ 后刷新。");
          $("emptyNote").innerHTML = "当前路径：<code>" + escapeHtml(modelDef.url) + "</code>";
        }
      }
    });
  }

  function setupUI() {
    $("appTitle").textContent = CFG.appName || $("appTitle").textContent;
    $("appSub").textContent = CFG.appSub || $("appSub").textContent;

    Array.prototype.forEach.call(document.querySelectorAll(".rail-btn[data-panel]"), function (btn) {
      btn.onclick = function () {
        var name = btn.getAttribute("data-panel");
        if (S.activePanel === name) { closePanel(); return; }
        openPanel(name);
        if (name === "layer") renderLayerPanel();
        if (name === "measure") renderMeasurePanel();
        if (name === "offset") renderOffsetPanel();
        if (name === "draw") openDrawPanel();
        if (name === "info" && !S.selected) {
          $("panelBody").innerHTML = '<div class="info-empty"><b>还没有选中要素</b>在三维视图里左键点一下病害标签或模型面，这里会显示它的属性、照片和坐标。</div>';
        }
      };
    });

    $("btnPanelClose").onclick = closePanel;
    $("btnReloadModel").onclick = function () {
      // 重新加载所有当前模型
      var snap = S.models.map(function (m) { return { id: m.id, name: m.name, url: m.url, type: m.type, userAdded: m.userAdded }; });
      if (!snap.length) return;
      clearAllModels();
      var chain = Promise.resolve();
      snap.forEach(function (d) {
        chain = chain.then(function () { return addModel(d, { zoom: false }); }).catch(function () {});
      });
      chain.then(function () {
        viewModelDirect();
        toast("已重新加载 " + S.models.length + " 个模型");
      });
    };
    $("btnFullscreen").onclick = function () {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(function () { toast("浏览器不允许全屏", "warn"); });
      } else {
        document.exitFullscreen().catch(function () {});
      }
    };
    $("btnShot").onclick = takeShot;
    $("btnRecheck").onclick = function () {
      openAddModelDialog();
    };
    /* 正式模型还没到位时，一键切到自检模型，验证查看器本身是否正常 */
    $("btnTrySelf").onclick = function () {
      var list = CFG.models || [];
      var self = null;
      list.forEach(function (m) { if (m.id === "selftest") self = m; });
      if (!self) { toast("js/config.js 里没有 id 为 selftest 的模型条目", "warn"); return; }
      var exist = S.models.filter(function (x) { return x.url === self.url; })[0];
      if (exist) { if (exist.tileset) exist.tileset.show = true; toast("自检模型已在场景中"); return; }
      tryLoadSelected(self);
    };
    $("btnTypePath").onclick = function () {
      openAddLabelDialog();
    };
    $("emptyPath").textContent = "1_模型查看器\\data\\model\\";

    document.addEventListener("keydown", function (e) {
      // 对话框开着时：Esc 关闭它，其余快捷键全部让位（否则在输入框里打字会触发镜头飞行）
      if (isAnyDialogOpen()) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeAllDialogs();
        }
        return;
      }
      if (e.key === "Escape") {
        if (S.draw.mode) { setDrawMode(null); S.drawDS.entities.removeAll(); openPanel("draw"); return; }
        if (S.measure.mode) { finishMeasure(); return; }
        if (!$("panel").classList.contains("panel-hidden")) closePanel();
      }
      // 在输入框里打字时，不要触发 1/2/3 快捷键
      var tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      if (e.key === "1") flyToModel(CFG.autoFlyPitch, 1.2);
      if (e.key === "2") flyToModel(-89, 1.2);
      if (e.key === "3") flyToModel(-25, 1.2);
    });
  }

  function takeShot() {
    try {
      S.viewer.render();
      var canvas = S.viewer.scene.canvas;
      canvas.toBlob(function (blob) {
        if (!blob) { toast("截图失败（浏览器不支持）", "err"); return; }
        var a = document.createElement("a");
        var d = new Date();
        var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") +
          "_" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0") + String(d.getSeconds()).padStart(2, "0");
        a.href = URL.createObjectURL(blob);
        a.download = "三维_截图_" + stamp + ".png";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1200);
        toast("已导出截图：" + a.download);
      }, "image/png");
    } catch (e) {
      toast("截图失败：" + e.message, "err");
    }
  }

  /* ------------------------------ 状态栏 ------------------------------ */
  function bindCameraStatus() {
    var frames = 0, last = performance.now();
    function tick() {
      frames++;
      var now = performance.now();
      if (now - last >= 1000) {
        $("statFps").textContent = "FPS " + Math.round(frames * 1000 / (now - last));
        frames = 0; last = now;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    setInterval(function () {
      if (!S.viewer) return;
      var c = S.viewer.camera.positionCartographic;
      $("statCam").textContent = deg(c.longitude).toFixed(6) + "°, " + deg(c.latitude).toFixed(6) + "° · 高 " + fmt(c.height, 1) + " m";

      if (!S.models.length) return;
      var shown = S.models.filter(function (m) { return m.tileset && m.tileset.show; });
      if (!shown.length) {
        $("statTiles").className = "stat";
        $("statTiles").textContent = "模型 已隐藏";
        return;
      }
      // 汇总所有可见模型的瓦片进度
      var done = 0, all = 0, hasStats = false;
      shown.forEach(function (m) {
        var st = m.tileset.statistics;
        if (!st) return;
        if (typeof st.numberOfTilesWithContentReady === "number") { done += st.numberOfTilesWithContentReady; hasStats = true; }
        if (typeof st.numberOfTilesTotal === "number") { all += st.numberOfTilesTotal; }
      });
      if (hasStats && all > 0) {
        $("statTiles").textContent = (S.models.length > 1 ? "模型 " + shown.length + " · " : "") +
          "瓦片 " + done + " / " + all;
        $("statTiles").className = (done >= all) ? "stat ready" : "stat loading";
      }
    }, 400);
  }

  /* ------------------------------ 拖放导入 ------------------------------ */
  function bindDropZone() {
    var el = document.body;
    var overlay = document.createElement("div");
    overlay.className = "drop-overlay hidden";
    overlay.innerHTML = '<div class="drop-inner">松开即可添加<br><span>支持 tileset.json / .glb / 标签 JSON / KML</span></div>';
    document.body.appendChild(overlay);

    var depth = 0;

    el.addEventListener("dragenter", function (e) {
      if (!e.dataTransfer || !e.dataTransfer.types) return;
      if (e.dataTransfer.types.indexOf("Files") < 0) return;
      e.preventDefault();
      depth++;
      overlay.classList.remove("hidden");
    });

    el.addEventListener("dragover", function (e) {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf("Files") >= 0) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    });

    el.addEventListener("dragleave", function (e) {
      depth--;
      if (depth <= 0) { depth = 0; overlay.classList.add("hidden"); }
    });

    el.addEventListener("drop", function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      depth = 0;
      overlay.classList.add("hidden");

      Array.prototype.forEach.call(e.dataTransfer.files, function (file) {
        var name = (file.name || "").toLowerCase();
        if (/\.(json|glb|gltf|kml)$/.test(name)) {
          handleDroppedFile(file);
        } else {
          toast("不支持的文件类型：" + file.name, "warn");
        }
      });
    });
  }

  /* 拖进来的文件：JSON 可能是标签也可能是 tileset，自动判断 */
  function handleDroppedFile(file) {
    var name = file.name.toLowerCase();

    // KML → 标签
    if (/\.kml$/.test(name)) {
      readLabelFile(file, function (def, err) {
        if (err) { toast("KML 读取失败：" + err, "err"); return; }
        addLabelSource(def);
      });
      return;
    }

    // GLB / glTF → 模型
    if (/\.(glb|gltf)$/.test(name)) {
      var url = URL.createObjectURL(new Blob([""], { type: "model/gltf-binary" }));
      // 浏览器无法直接把本地 glb 交给 Cesium 读磁盘，必须走服务路径
      toast("GLB 需要通过本地服务路径添加（拖入的临时文件无法持久引用）。请用「+ 添加」填写路径。", "warn");
      URL.revokeObjectURL(url);
      openAddModelDialog();
      return;
    }

    // JSON → 看是 tileset 还是 label
    var fr = new FileReader();
    fr.onload = function () {
      var data;
      try { data = JSON.parse(fr.result); }
      catch (e) { toast("不是合法的 JSON：" + file.name, "err"); return; }

      // 3D Tiles 的 tileset.json 一定有 root
      if (data && data.root && (data.asset || data.geometricError !== undefined)) {
        toast("这是 tileset.json，请用「+ 添加」填写它在服务里的路径（拖入无法直接引用）。", "warn");
        openAddModelDialog();
        return;
      }

      // 否则按标签处理
      if (data && (data.features || data.groups)) {
        addLabelSource({
          id: "userlabel-" + Date.now().toString(36),
          name: file.name.replace(/\.json$/i, ""),
          type: "json",
          data: data,
          color: "#00d4aa",
          userAdded: true
        });
        return;
      }

      toast("无法识别这个 JSON 的用途：" + file.name, "warn");
    };
    fr.onerror = function () { toast("读取失败：" + file.name, "err"); };
    fr.readAsText(file, "utf-8");
  }

  /* ------------------------------ 启动 ------------------------------ */
  function boot() {
    initViewer();
    initialCamera();
    loadOffsetFromStorage();
    setupUI();
    setupModels();
    bindDropZone();

    // 1. 加载配置里的标签
    loadAllLabels().then(function () {
      // 2. 恢复用户上次手动添加的标签
      var remembered = loadUserLabels();
      var chain = Promise.resolve();
      remembered.forEach(function (d) {
        chain = chain.then(function () {
          return addLabelSource(d).catch(function () { /* 单个失败不影响其它 */ });
        });
      });
      return chain;
    }).then(function () {
      renderLayerPanel();

      // 3. 恢复用户上次手动添加的模型
      var rememberedModels = loadUserModels();
      var mchain = Promise.resolve();
      rememberedModels.forEach(function (d) {
        mchain = mchain.then(function () {
          return addModel(d, { zoom: false }).catch(function () {});
        });
      });
      return mchain;
    }).then(function () {
      // 4. 如果还没有任何模型，尝试加载配置里的第一个（默认行为）
      if (S.models.length) {
        viewModelDirect();
        return;
      }
      var first = (CFG.models || [])[0];
      if (!first) {
        showEmpty("还没有三维模型",
          "点「+ 添加」选择本地 tileset.json 或 .glb 文件，也可以直接双击 启动查看器.bat 后把文件拖进窗口。");
        return;
      }
      tryLoadSelected(first);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
