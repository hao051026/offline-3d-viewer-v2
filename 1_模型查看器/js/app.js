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
    tileset: null,
    modelDef: null,
    baseCenter: null,          // 模型原始包围球中心（ECEF），偏移量以此为基准
    offset: { east: 0, north: 0, up: 0 },
    layers: [],                // 图层条目
    measure: { mode: null, points: [], preview: null },
    measureDS: null,
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

  /* 生成标签图标（纯本地 canvas 绘制，不依赖任何图片素材） */
  var iconCache = {};
  function iconUrl(color) {
    if (iconCache[color]) return iconCache[color];
    var size = 64, c = document.createElement("canvas");
    c.width = size; c.height = size;
    var g = c.getContext("2d");
    // 针形标记
    g.beginPath();
    g.arc(32, 24, 14, Math.PI * 0.86, Math.PI * 0.14, false);
    g.lineTo(32, 58);
    g.closePath();
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = "rgba(255,255,255,.85)";
    g.stroke();
    // 内白点
    g.beginPath();
    g.arc(32, 24, 5.5, 0, Math.PI * 2);
    g.fillStyle = "rgba(255,255,255,.92)";
    g.fill();
    iconCache[color] = c.toDataURL("image/png");
    return iconCache[color];
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

    // 现场排障用：浏览器控制台里可以 window.XZ3D.viewer / XZ3D.tileset 查内部状态
    window.XZ3D = {
      viewer: v,
      state: S,
      get tileset() { return S.tileset; }
    };

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

  /* ------------------------------ 模型加载 ------------------------------ */
  function clearModel() {
    if (S.tileset) {
      S.viewer.scene.primitives.remove(S.tileset);
      S.tileset = null;
    }
    S.baseCenter = null;
    S.modelReady = false;
    $("statTiles").textContent = "瓦片 —";
  }

  function loadModel(def, opts) {
    opts = opts || {};
    clearModel();
    S.modelDef = def;
    setModelState("wait", "加载中…");
    $("emptyState").classList.add("hidden");

    var url = encodeURI(def.url);
    // 只用最稳的默认遍历（不做 skipLevelOfDetail 跳过式细化）：
    // 跳过式细化在瓦片层级浅、几何误差为 0 的 tileset 上会漏选根瓦片，画面直接全黑
    var tsOpts = {
      maximumScreenSpaceError: CFG.scene.maxScreenSpaceError || 16
    };

    var ready = null;
    try {
      // 新版 Cesium 用 fromUrl；老版用 readyPromise。两条路都兼容
      if (typeof CES.Cesium3DTileset.fromUrl === "function") {
        ready = CES.Cesium3DTileset.fromUrl(url, tsOpts);
      } else {
        var cand = new CES.Cesium3DTileset({ url: url, maximumScreenSpaceError: tsOpts.maximumScreenSpaceError });
        ready = cand.readyPromise || Promise.resolve(cand);
        S.viewer.scene.primitives.add(cand);
      }
    } catch (e) {
      setModelState("err", "加载失败");
      showEmpty("模型加载出错", String(e && e.message || e));
      startWatch();
      return;
    }

    ready.then(function (ts) {
      S.viewer.scene.primitives.add(ts);
      S.tileset = ts;
      S.baseCenter = CES.Cartesian3.clone(ts.boundingSphere.center, new CES.Cartesian3());
      S.modelReady = true;
      applyOffset();
      setModelState("ok", "已加载");
      $("statTiles").className = "stat loading";
      $("statTiles").textContent = "瓦片 …";
      $("emptyState").classList.add("hidden");
      stopWatch();

      ts.allTilesLoaded.addEventListener(function () {
        $("statTiles").className = "stat ready";
        updateTileStat();
      });

      // 首屏定位
      if (CFG.defaultView) {
        S.viewer.camera.flyTo({
          destination: CES.Cartesian3.fromDegrees(CFG.defaultView.lon, CFG.defaultView.lat, CFG.defaultView.height || 800),
          orientation: {
            heading: CES.Math.toRadians(CFG.defaultView.heading || 0),
            pitch: CES.Math.toRadians(CFG.defaultView.pitch || -45),
            roll: 0
          },
          duration: 1.6
        });
      } else if (opts.zoom !== false) {
        viewModelDirect();
        // 防御：tileset 刚创建时包围球可能还是默认值，这时摆位会飞到太空
        setTimeout(ensureModelVisible, 500);
        setTimeout(ensureModelVisible, 1600);
      }

      toast("模型已加载：" + def.name);
    }).catch(function (err) {
      clearModel();
      setModelState("err", "加载失败");
      showEmpty("模型加载失败",
        "tileset.json 读取失败：" + String(err && err.message || err) +
        "。常见原因：tileset.json 不在指定路径、瓦片文件没拷全，或没有通过本地服务打开（直接双击 index.html 会跨域失败）。");
      $("emptyNote").innerHTML = "当前路径：<code>" + def.url + "</code>";
      startWatch();
    });
  }

  function updateTileStat() {
    if (!S.tileset) return;
    var st = S.tileset.statistics || {};
    var show = st.numberOfTilesSelected;
    var total = st.numberOfTilesTotal;
    if (typeof show === "number" && typeof total === "number") {
      $("statTiles").textContent = "瓦片 " + show + " / " + total;
    } else {
      $("statTiles").textContent = "瓦片 已加载";
    }
  }

  /* 直接把相机摆到模型正南方的斜上方（不做动画）。
     弱显卡、后台窗口、动画被节流时也能保证一打开就看得见模型 */
  function viewModelDirect() {
    if (!S.tileset) return;
    var bs = S.tileset.boundingSphere;
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
    if (!S.tileset) return;
    var bs = S.tileset.boundingSphere;
    var h = S.viewer.camera.positionCartographic.height;
    var limit = bs.radius * 4 + 2000;
    if (!isFinite(h) || h > limit) viewModelDirect();
  }

  function flyToModel(pitchDeg, duration) {
    if (!S.tileset) return;
    var bs = S.tileset.boundingSphere;
    var pitch = CES.Math.toRadians(Math.max(-89.5, Math.min(89.5, pitchDeg === undefined ? -55 : pitchDeg)));
    var range = Math.max(bs.radius * 2.2, 40);
    S.viewer.camera.flyToBoundingSphere(bs, {
      offset: new CES.HeadingPitchRange(S.viewer.camera.heading, pitch, range),
      duration: duration === undefined ? 1.4 : duration
    });
  }

  /* 位置/高程微调：以模型原始包围球中心为基准做 ENU 平移 */
  function applyOffset() {
    if (!S.tileset || !S.baseCenter) return;
    var o = S.offset;
    if (!o.east && !o.north && !o.up) {
      S.tileset.modelMatrix = CES.Matrix4.clone(CES.Matrix4.IDENTITY);
      return;
    }
    var enu = CES.Transforms.eastNorthUpToFixedFrame(S.baseCenter);
    var local = new CES.Cartesian3(o.east, o.north, o.up);
    var dEcef = CES.Matrix4.multiplyByPointAsVector(enu, local, new CES.Cartesian3());
    S.tileset.modelMatrix = CES.Matrix4.fromTranslation(dEcef);
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

  /* ------------------------------ 缺模型引导 + 自动监听 ------------------------------ */
  function showEmpty(title, desc) {
    $("emptyTitle").textContent = title || "还没有检测到三维模型";
    if (desc) $("emptyDesc").textContent = desc;
    $("emptyState").classList.remove("hidden");
  }

  function startWatch() {
    stopWatch();
    S.watchTimer = setInterval(function () {
      if (S.modelReady || !S.modelDef) return;
      urlExists(S.modelDef.url).then(function (ok) {
        if (ok) {
          toast("检测到模型文件，正在自动加载…");
          loadModel(S.modelDef);
        }
      });
    }, 5000);
  }

  function stopWatch() {
    if (S.watchTimer) { clearInterval(S.watchTimer); S.watchTimer = null; }
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
    var anchorOffset = new CES.Cartesian2(0, -22);

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
    if (f.icon) {
      opts.billboard = {
        image: f.icon,
        scale: (lc.iconScale || 0.55) * (f.iconScale || 1),
        verticalOrigin: CES.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new CES.NearFarScalar(300, 1.15, 3000, 0.6)
      };
    } else {
      opts.billboard = {
        image: iconUrl(color),
        scale: (lc.iconScale || 0.55) * (f.iconScale || 1),
        verticalOrigin: CES.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new CES.NearFarScalar(300, 1.15, 3000, 0.6)
      };
    }
    if (text) {
      opts.label = entityLabelOpts(text, color);
      opts.label.pixelOffset = anchorOffset;
    }
    return addEntity(ds, opts, props);
  }

  function loadJSONLabels(def) {
    return fetch(def.url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      var groups = {};
      (data.groups || []).forEach(function (g) { groups[g.id] = g; });

      var usedGroups = {};
      (data.features || []).forEach(function (f, i) {
        var gid = f.group || "default";
        if (!usedGroups[gid]) {
          usedGroups[gid] = { id: gid, name: (groups[gid] && groups[gid].name) || (gid === "default" ? def.name : gid), color: (groups[gid] && groups[gid].color) || def.color || LAYER_COLORS[0], ds: null, entities: [] };
        }
        var bucket = usedGroups[gid];
        if (!bucket.ds) {
          // 注意：dataSources.add() 返回 Promise，不能直接当数据源用
          bucket.ds = new CES.CustomDataSource(def.id + "-" + gid);
          S.viewer.dataSources.add(bucket.ds);
          // 分组可声明 visible:false（比如司空2 里标在模型范围之外的那批），
          // 默认不显示，图层面板里还能再打开
          bucket.ds.show = !(groups[gid] && groups[gid].visible === false);
        }
        f.id = f.id || (def.id + "-" + (i + 1));
        var ent = createFeatureEntity(bucket.ds, f, bucket.color, bucket.name);
        if (ent) bucket.entities.push(ent);
      });

      Object.keys(usedGroups).forEach(function (gid, idx) {
        var b = usedGroups[gid];
        S.layers.push({
          id: def.id + "-" + gid,
          name: b.name,
          type: "矢量",
          color: b.color,
          count: b.entities.length,
          enabled: b.ds.show,
          entities: b.entities,
          ds: b.ds,
          missing: false
        });
      });
      if (!Object.keys(usedGroups).length) {
        S.layers.push({ id: def.id, name: def.name, type: "矢量", color: def.color, count: 0, enabled: false, missing: true, note: "文件里没有要素" });
      }
      return true;
    });
  }

  /* KML（司空2 直接导出）：保留原始点位，样式统一成本地图标，避免引用外网图标 */
  function loadKML(def) {
    var camera = S.viewer.scene.camera, canvas = S.viewer.scene.canvas;
    var ds = new CES.KmlDataSource({ camera: camera, canvas: canvas });
    return ds.load(encodeURI(def.url), { clampToGround: false }).then(function () {
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
        name: def.name,
        type: "KML",
        color: color,
        count: entities.length,
        enabled: true,
        entities: entities,
        ds: ds,
        missing: false,
        note: fixed ? ("已本地化 " + fixed + " 个外网图标") : ""
      });
      return true;
    });
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
    (layer.entities || []).forEach(function (e) { if (!e.isCesium3DTileset) e.show = on; });
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
      if (S.measure.mode) { finishMeasure(); return; }
    }, CES.ScreenSpaceEventType.RIGHT_CLICK);

    handler.setInputAction(function (movement) {
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
    var titles = { layer: "图层管理", info: "要素属性", measure: "测量", offset: "位置校正" };
    $("panelTitle").textContent = titles[name] || "";
    $("panel").classList.remove("panel-hidden");
    Array.prototype.forEach.call(document.querySelectorAll(".rail-btn"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-panel") === name);
    });
    if (name === "layer") renderLayerPanel();
    if (name === "measure") renderMeasurePanel();
    if (name === "offset") renderOffsetPanel();
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

    var html = '<div class="sec"><div class="sec-title"><span>模型</span><span class="mini" id="layerModelName">' +
      escapeHtml(S.modelDef ? S.modelDef.name : "—") + "</span></div>";

    if (S.tileset) {
      html += '<div class="layer-row" data-model-toggle="1"><span class="chk"></span>' +
        '<span class="swatch" style="background:#4aa8ff"></span>' +
        '<span class="lname">三维模型（3DTiles）</span><span class="lcount">' +
        (S.tileset.show ? "显示中" : "已隐藏") + "</span></div>";
    } else {
      html += '<div class="layer-row dead"><span class="chk" style="opacity:.4"></span>' +
        '<span class="lname">三维模型未加载</span></div>';
    }
    html += "</div>";

    html += '<div class="sec"><div class="sec-title"><span>矢量标签</span><span class="mini">共 ' + total + " 个要素</span></div>";
    if (!S.layers.length) {
      html += '<p class="hint">还没有加载标签。把司空2 导出的 KML 放到 <b>data/vector/defect.kml</b>，或把标签 JSON 放到 <b>data/vector/labels.json</b>，刷新即生效。</p>';
    } else {
      S.layers.forEach(function (l, i) {
        var cls = "layer-row" + (l.enabled ? "" : " off") + (l.missing ? " dead" : "");
        html += '<div class="' + cls + '" data-layer="' + i + '">' +
          '<span class="chk"' + (l.missing ? ' style="opacity:.35"' : "") + '></span>' +
          '<span class="swatch" style="background:' + (l.color || "#888") + '"></span>' +
          '<span class="lname">' + escapeHtml(l.name) + "</span>" +
          (l.missing ? '<span class="tagm">未提供</span>' : '<span class="lcount">' + l.count + "</span>") +
          "</div>";
        if (l.note) html += '<p class="hint" style="margin:-2px 0 8px">' + escapeHtml(l.note) + "</p>";
      });
    }
    html += "</div>";

    html += '<div class="sec">' +
      '<div class="form-row" style="gap:8px">' +
      '<button class="btn btn-sm" style="flex:1" id="btnAllOn">全部显示</button>' +
      '<button class="btn btn-sm" style="flex:1" id="btnAllOff">全部隐藏</button></div>' +
      "</div>";

    html += '<div class="sec"><div class="sec-title"><span>定位要素</span></div>' +
      '<div class="form-row"><input type="text" id="findInput" placeholder="输入编号或名称，如 XS-001 / K1+000" ' +
      'style="flex:1;background:#0c141c;color:#dbe6f0;border:1px solid #1e2c3a;border-radius:6px;padding:8px 10px;font-size:12.5px;font-family:inherit;outline:none">' +
      '<button class="btn btn-sm" id="btnFind" style="flex:none">定位</button></div>' +
      '<p class="hint">输入编号/名称后点定位，会直接飞到对应病害点并打开属性。</p></div>';

    $("panelBody").innerHTML = html;

    var modelRow = $("panelBody").querySelector('[data-model-toggle="1"]');
    if (modelRow) modelRow.onclick = function () {
      S.tileset.show = !S.tileset.show;
      renderLayerPanel();
    };

    Array.prototype.forEach.call($("panelBody").querySelectorAll("[data-layer]"), function (rowEl) {
      rowEl.onclick = function () {
        var l = S.layers[+rowEl.getAttribute("data-layer")];
        if (!l || l.missing) return;
        setLayerEnabled(l, !l.enabled);
        renderLayerPanel();
      };
    });

    $("btnAllOn").onclick = function () {
      setAllLayers(true);
      if (S.tileset) S.tileset.show = true;
      renderLayerPanel();
    };
    $("btnAllOff").onclick = function () {
      setAllLayers(false);
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
  function setupModels() {
    var sel = $("modelSelect");
    sel.innerHTML = "";
    (CFG.models || []).forEach(function (m, i) {
      var opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = m.name;
      sel.appendChild(opt);
    });

    var lastId = null;
    try { lastId = localStorage.getItem((CFG.storage && CFG.storage.lastModel) || "xz3d.lastModel"); } catch (e) {}
    var idx = 0;
    if (lastId) {
      (CFG.models || []).forEach(function (m, i) { if (m.id === lastId) idx = i; });
    }
    sel.value = String(idx);

    sel.onchange = function () {
      var m = CFG.models[+sel.value];
      try { localStorage.setItem((CFG.storage && CFG.storage.lastModel) || "xz3d.lastModel", m.id); } catch (e) {}
      tryLoadSelected(m);
    };
    return idx;
  }

  function tryLoadSelected(modelDef) {
    urlExists(modelDef.url).then(function (ok) {
      if (ok) {
        loadModel(modelDef);
      } else {
        S.modelDef = modelDef;
        setModelState("wait", "等待模型");
        $("statTiles").textContent = "瓦片 —";
        showEmpty("还没有检测到三维模型",
          "模型可能还在下载/解压。查看器每 5 秒自动检测一次，文件一到就自动加载，不需要你手动重启。");
        $("emptyNote").innerHTML = "当前等待路径：<code>" + escapeHtml(modelDef.url) + "</code>";
        startWatch();
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
        if (name === "info" && !S.selected) {
          $("panelBody").innerHTML = '<div class="info-empty"><b>还没有选中要素</b>在三维视图里左键点一下病害标签或模型面，这里会显示它的属性、照片和坐标。</div>';
        }
      };
    });

    $("btnPanelClose").onclick = closePanel;
    $("btnReloadModel").onclick = function () {
      if (!S.modelDef) return;
      loadModel(S.modelDef);
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
      if (!S.modelDef) return;
      urlExists(S.modelDef.url).then(function (ok) {
        if (ok) loadModel(S.modelDef);
        else toast("还是没找到：" + S.modelDef.url + "（确认 tileset.json 层级是否正确）", "warn");
      });
    };
    /* 正式模型还没到位时，一键切到自检模型，验证查看器本身是否正常 */
    $("btnTrySelf").onclick = function () {
      var list = CFG.models || [];
      var i = -1;
      list.forEach(function (m, k) { if (m.id === "selftest") i = k; });
      if (i < 0) { toast("js/config.js 里没有 id 为 selftest 的模型条目", "warn"); return; }
      $("modelSelect").value = String(i);
      try { localStorage.setItem((CFG.storage && CFG.storage.lastModel) || "xz3d.lastModel", list[i].id); } catch (e) {}
      tryLoadSelected(list[i]);
    };
    $("btnTypePath").onclick = function () {
      var p = window.prompt("输入 tileset.json 的相对路径（相对 index.html）", (S.modelDef && S.modelDef.url) || "data/model/tileset/tileset.json");
      if (!p) return;
      p = p.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
      if (CFG.models && CFG.models.length) CFG.models[0].url = p;
      S.modelDef = CFG.models[0];
      try { localStorage.setItem((CFG.storage && CFG.storage.lastModel) || "xz3d.lastModel", S.modelDef.id); } catch (e) {}
      urlExists(p).then(function (ok) {
        if (ok) loadModel(S.modelDef);
        else { showEmpty("路径下没有找到 tileset.json", "再核对一下路径：" + p); $("emptyNote").innerHTML = "当前路径：<code>" + escapeHtml(p) + "</code>"; }
      });
    };
    $("emptyPath").textContent = "1_模型查看器\\data\\model\\tileset\\";

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (S.measure.mode) { finishMeasure(); return; }
        if (!$("panel").classList.contains("panel-hidden")) closePanel();
      }
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
      if (S.tileset && S.modelReady && !S.tileset.show) {
        $("statTiles").className = "stat";
        $("statTiles").textContent = "瓦片 已隐藏";
      } else if (S.tileset && S.modelReady && $("statTiles").textContent === "瓦片 …") {
        // allTilesLoaded 迟迟不触发时，也把加载进度显示出来，别让状态栏一直停在省略号
        var st = S.tileset.statistics || {};
        var done = st.numberOfTilesWithContentReady, all = st.numberOfTilesTotal;
        if (typeof done === "number" && typeof all === "number" && all > 0) {
          $("statTiles").textContent = "瓦片 " + done + " / " + all;
          if (done >= all) $("statTiles").className = "stat ready";
        }
      }
    }, 400);
  }

  /* ------------------------------ 启动 ------------------------------ */
  function boot() {
    initViewer();
    initialCamera();
    loadOffsetFromStorage();
    setupUI();
    var idx = setupModels();

    loadAllLabels().then(function () {
      renderLayerPanel();
      var modelDef = (CFG.models || [])[idx];
      if (!modelDef) {
        showEmpty("配置里没有模型", "请在 js/config.js 的 models 里填一条 tileset.json 路径。");
        return;
      }
      tryLoadSelected(modelDef);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
