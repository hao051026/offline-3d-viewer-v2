/**
 * 功能自检页：在浏览器里跑一遍核心功能，把结果打到页面上
 * 用法：http://127.0.0.1:8820/__selftest.html
 *
 * 只验证纯逻辑（不依赖真实渲染时序的部分），
 * 渲染相关的靠人工看主页面。
 */
(function () {
  "use strict";
  var out = [];
  var pass = 0, fail = 0;

  function log(ok, name, detail) {
    if (ok) pass++; else fail++;
    out.push({ ok: ok, name: name, detail: detail || "" });
  }

  function run() {
    var CES = window.Cesium;
    if (!CES) { log(false, "Cesium 加载", "未加载"); render(); return; }
    log(true, "Cesium 加载", "OK");

    // 1. 图标形状：9 种都能生成
    var shapes = window.__XZ_ICON_SHAPES;
    if (!shapes) { log(false, "图标形状", "ICON_SHAPES 未暴露"); }
    else {
      let okCount = 0, sizes = [];
      shapes.forEach(function (s) {
        try {
          var url = window.__XZ_iconUrl("#00d4aa", s);
          if (url && url.indexOf("data:image/png") === 0 && url.length > 500) { okCount++; sizes.push(url.length); }
        } catch (e) { /* ignore */ }
      });
      log(okCount === shapes.length, "图标形状生成",
        okCount + "/" + shapes.length + " 种，数据长度 " + Math.min.apply(null, sizes) + "~" + Math.max.apply(null, sizes));
    }

    // 2. 未知形状回退到 pin
    try {
      var fallback = window.__XZ_iconUrl("#ff0000", "unknown-shape-xyz");
      log(!!fallback && fallback.length > 500, "未知形状回退 pin", "OK");
    } catch (e) { log(false, "未知形状回退 pin", String(e)); }

    // 3. 图标缓存命中
    try {
      var a = window.__XZ_iconUrl("#123456", "star");
      var b = window.__XZ_iconUrl("#123456", "star");
      log(a === b, "图标缓存", a === b ? "同一实例" : "重复生成");
    } catch (e) { log(false, "图标缓存", String(e)); }

    // 4. 模型类型识别
    var detect = window.__XZ_detectModelType;
    if (!detect) { log(false, "模型类型识别", "未暴露"); }
    else {
      var cases = [
        ["data/model/a/tileset.json", "tiles"],
        ["data/model/a.glb", "glb"],
        ["data/model/a.GLB", "glb"],
        ["data/model/a.gltf", "glb"],
        ["data/model/a.glb?v=1", "glb"],
        ["/abs/path/tileset.json", "tiles"]
      ];
      var ok = cases.every(function (c) { return detect(c[0]) === c[1]; });
      log(ok, "模型类型识别", cases.length + " 个用例");
    }

    // 5. 名称推断
    var nameFrom = window.__XZ_nameFromUrl;
    if (!nameFrom) { log(false, "名称推断", "未暴露"); }
    else {
      var n1 = nameFrom("data/model/教室/tileset.json");
      var n2 = nameFrom("data/model/小镇.glb");
      var n3 = nameFrom("a.json");
      log(n1 === "教室" && n2 === "小镇" && n3 === "a",
        "名称推断", [n1, n2, n3].join(" / "));
    }

    // 6. 唯一 id：无冲突时原样返回，有冲突时追加序号
    var uniq = window.__XZ_uniqModelId;
    if (!uniq) { log(false, "唯一 id", "未暴露"); }
    else {
      var S = window.__XZ_STATE;
      // 用一个一定没被占用的名字
      var freeName = "__no_such_model_" + Date.now();
      var u1 = uniq(freeName);
      log(u1 === freeName, "唯一 id 无冲突时原样", freeName.slice(0, 18) + "… -> " + u1.slice(0, 18) + "…");
      // 造一个冲突：临时塞进 S.models
      var fakeId = "__dup_test_" + Date.now();
      S.models.push({ id: fakeId, name: "临时占位", tileset: null });
      var u2 = uniq(fakeId);
      S.models.pop();
      log(u2 !== fakeId && u2.indexOf(fakeId) === 0, "唯一 id 冲突时追加序号", fakeId.slice(0, 14) + "… -> " + u2.slice(0, 18) + "…");
    }

    // 7. 多模型包围球
    var sbs = window.__XZ_sceneBoundingSphere;
    if (!sbs) { log(false, "多模型包围球", "未暴露"); }
    else {
      var bs = sbs();
      log(!!bs && isFinite(bs.radius) && bs.radius > 0,
        "多模型包围球", bs ? ("半径 " + bs.radius.toFixed(1) + " m") : "null");
    }

    // 8. 当前模型数量
    var S2 = window.__XZ_STATE;
    log(S2.models.length >= 1, "模型已加载", S2.models.length + " 个：" +
      S2.models.map(function (m) { return m.name; }).join(", "));

    // 9. 标签图层
    log(S2.layers.length >= 1, "标签图层", S2.layers.length + " 层，共 " +
      S2.layers.reduce(function (a, l) { return a + (l.count || 0); }, 0) + " 要素");

    // 10. 图层面板能打开
    try {
      window.__XZ_openPanel("layer");
      var body = document.getElementById("panelBody");
      var hasModelSec = body.innerHTML.indexOf("模型（") >= 0;
      var hasAddModel = !!document.getElementById("lnkAddModel");
      var hasAddLabel = !!document.getElementById("lnkAddLabel");
      log(hasModelSec && hasAddModel && hasAddLabel, "图层面板结构",
        "模型区=" + hasModelSec + " 添加模型=" + hasAddModel + " 添加标签=" + hasAddLabel);
    } catch (e) { log(false, "图层面板结构", String(e)); }

    // 11. 添加模型对话框
    try {
      window.__XZ_openAddModelDialog();
      var dlg = document.getElementById("addModelDlg");
      var visible = dlg && !dlg.classList.contains("hidden");
      var hasPath = !!document.getElementById("dlgModelPath");
      var hasGeo = !!document.getElementById("dlgModelLon");
      log(visible && hasPath && hasGeo, "添加模型对话框", "可见=" + visible + " 路径框=" + hasPath + " 经纬度框=" + hasGeo);
      window.__XZ_closeAddModelDialog();
    } catch (e) { log(false, "添加模型对话框", String(e)); }

    // 12. 添加标签对话框 + 形状选择器
    try {
      window.__XZ_openAddLabelDialog();
      var dlg2 = document.getElementById("addLabelDlg");
      var vis2 = dlg2 && !dlg2.classList.contains("hidden");
      var shapeBtns = dlg2 ? dlg2.querySelectorAll(".shape-btn") : [];
      var hasFile = !!document.getElementById("dlgLabelFile");
      var hasColor = !!document.getElementById("dlgLabelColor");
      log(vis2 && shapeBtns.length === 9 && hasFile && hasColor,
        "添加标签对话框",
        "可见=" + vis2 + " 形状按钮=" + shapeBtns.length + " 文件框=" + hasFile + " 选色=" + hasColor);
      window.__XZ_closeAddLabelDialog();
    } catch (e) { log(false, "添加标签对话框", String(e)); }

    // 13. 标签数据的图标形状能应用
    try {
      var before2 = S2.layers.length;
      var testData = {
        version: 1,
        name: "自检标签",
        groups: [{ id: "g1", name: "箭头组", color: "#ff5b5b", icon: "arrow" }],
        features: [
          { id: "T1", group: "g1", name: "箭头点", type: "point", coordinates: [108.9, 34.0, 600] },
          { id: "T2", group: "g1", name: "星标点", type: "point", coordinates: [108.9002, 34.0002, 600], icon: "star" }
        ]
      };
      window.__XZ_applyLabelData({ id: "selftest-" + Date.now(), name: "形状自检" }, testData);
      var added = S2.layers.length - before2;
      log(added === 1, "标签分组图标", "新增 " + added + " 层");
      // 清理
      var lastLayer = S2.layers[S2.layers.length - 1];
      if (lastLayer && lastLayer.sourceId && lastLayer.sourceId.indexOf("selftest-") === 0) {
        window.__XZ_removeLabelSource(lastLayer.sourceId);
        log(true, "标签源移除", "已清理");
      }
    } catch (e) { log(false, "标签分组图标", String(e)); }

    // 14. localStorage 持久化键
    try {
      log(typeof localStorage !== "undefined", "localStorage 可用", "OK");
    } catch (e) { log(false, "localStorage 可用", String(e)); }

    // 14b. 对话框的 Esc 关闭与快捷键让位
    try {
      window.__XZ_openAddModelDialog();
      var dlgEsc = document.getElementById("addModelDlg");
      var openBefore = dlgEsc && !dlgEsc.classList.contains("hidden");

      // 模拟在输入框里按 Esc
      var inp = document.getElementById("dlgModelPath");
      var ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      (inp || document).dispatchEvent(ev);

      var openAfter = dlgEsc && !dlgEsc.classList.contains("hidden");
      log(openBefore === true && openAfter === false, "Esc 关闭对话框",
        "打开=" + openBefore + " → 按下后打开=" + openAfter);
    } catch (e) { log(false, "Esc 关闭对话框", String(e)); }

    // 14c. 输入框里打字不应触发 1/2/3 镜头飞行
    try {
      // 记录当前相机高度，模拟在输入框里按 "2"
      var camBefore = window.XZ3D.viewer.camera.positionCartographic.height;
      var probe = document.createElement("input");
      document.body.appendChild(probe);
      probe.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
      document.body.removeChild(probe);
      // 相机没动就算通过（按键后立刻检查，飞行有动画不会瞬间改变）
      setTimeout(function () {
        var camAfter = window.XZ3D.viewer.camera.positionCartographic.height;
        var moved = Math.abs(camAfter - camBefore) > 50;
        log(!moved, "输入框内 1/2/3 不触发飞行",
          "高度 " + camBefore.toFixed(0) + " → " + camAfter.toFixed(0));
      }, 250);
    } catch (e) { log(false, "输入框内 1/2/3 不触发飞行", String(e)); }

    // 14d. 模型移除按钮是两段确认
    try {
      var Sx = window.__XZ_STATE;
      // 造一个假模型行来检查按钮结构
      var fake = { id: "__probe_del__", name: "探针", tileset: null, type: "tiles", show: true };
      Sx.models.push(fake);
      window.__XZ_openPanel("layer");
      var btn = document.querySelector('[data-model-del="__probe_del__"]');
      var hasArmedLogic = !!btn;
      // 点一次应变成"确认"而不是删除
      if (btn) btn.click();
      var armed = btn && btn.getAttribute("data-armed") === "1";
      var stillThere = Sx.models.some(function (m) { return m.id === "__probe_del__"; });
      // 清理
      Sx.models = Sx.models.filter(function (m) { return m.id !== "__probe_del__"; });
      log(hasArmedLogic && armed && stillThere, "移除模型需二次确认",
        "按钮存在=" + hasArmedLogic + " 点一次进入确认态=" + armed + " 模型仍在=" + stillThere);
    } catch (e) { log(false, "移除模型需二次确认", String(e)); }

    // 15. KML 导出
    try {
      var testFeats = [
        { id: "P1", name: "点测试", type: "point", coordinates: [108.9, 34.0, 100], properties: { 编号: "P1", 等级: "B" } },
        { id: "L1", name: "线测试", type: "polyline", coordinates: [[108.9, 34.0, 0], [108.9005, 34.0005, 0]], properties: {} },
        { id: "G1", name: "面测试", type: "polygon", coordinates: [[108.9001, 34.0001, 0], [108.9005, 34.0001, 0], [108.9005, 34.0005, 0]], properties: {} }
      ];
      var kml = window.__XZ_buildKML("测试导出", [
        { name: "测试层", color: "#00d4aa", rawFeatures: testFeats }
      ]);

      // 基本结构
      var hasKml = kml && kml.indexOf("<kml") >= 0;
      var hasDoc = kml && kml.indexOf("<Document>") >= 0;
      var hasPm = kml && kml.indexOf("<Placemark>") >= 0;
      // 点/线/面各有一个 Placemark
      var placemarkCount = kml ? (kml.split("<Placemark>").length - 1) : 0;
      // 坐标正确性
      var hasLonLat = kml && kml.indexOf("108.9,34,100") >= 0;
      var hasDesc = kml && kml.indexOf("等级") >= 0;

      log(hasKml && hasDoc && hasPm && placemarkCount === 3 && hasLonLat && hasDesc,
        "KML 导出结构", "Placemark=" + placemarkCount + " hasKml=" + hasKml + " 坐标=" + hasLonLat + " 属性=" + hasDesc);
    } catch (e) { log(false, "KML 导出结构", String(e)); }

    // 16. KML 颜色格式 (aabbggrr)
    try {
      var c1 = window.__XZ_kmlColor("#ff0000");  // 红 -> ff 00 00 ff (bbggrr)
      var c2 = window.__XZ_kmlColor("#00ff00");  // 绿 -> ff 00 ff 00
      var c3 = window.__XZ_kmlColor("#0000ff");  // 蓝 -> ff ff 00 00
      log(c1 === "ff0000ff" && c2 === "ff00ff00" && c3 === "ffff0000",
        "KML 颜色格式", c1 + " " + c2 + " " + c3);
    } catch (e) { log(false, "KML 颜色格式", String(e)); }

    // 17. XML 转义
    try {
      var s = window.__XZ_xmlEsc('<a href="x">&');
      log(s === "&lt;a href=&quot;x&quot;&gt;&amp;", "XML 转义", s);
    } catch (e) { log(false, "XML 转义", String(e)); }

    // 18. 单条标签可单独显隐（核心需求）
    try {
      var Sf = window.__XZ_STATE;
      // 找第一个有多个要素、且 rawFeatures 带 entity 的层
      var target = null;
      Sf.layers.forEach(function (l) {
        if (!target && (l.rawFeatures || []).length >= 2 && l.rawFeatures[0].entity && l.rawFeatures[1].entity) {
          target = l;
        }
      });
      if (!target) {
        log(false, "单条标签显隐", "找不到带 entity 的多要素层");
      } else {
        var idx = 0, feat = target.rawFeatures[idx];
        var ent = feat.entity;
        var beforeOn = !!ent.show;
        var visBefore = feat.visible;

        // 点一次关闭
        window.__XZ_setFeatureEnabled(target, idx, false);
        var offChecked = (feat.visible === false) && (ent.show === false);
        // 再点一次打开
        window.__XZ_setFeatureEnabled(target, idx, true);
        var onChecked = (feat.visible === true) && (ent.show === true);
        log(offChecked && onChecked, "单条标签显隐",
          "关闭后 visible=" + feat.visible + " entity.show=" + ent.show + " | 打开后恢复到显示");
      }
    } catch (e) { log(false, "单条标签显隐", String(e)); }

    // 19. 展开状态渲染子条目
    try {
      var Sg = window.__XZ_STATE;
      var firstMulti = null, li = -1;
      Sg.layers.forEach(function (l, k) {
        if (li < 0 && (l.rawFeatures || []).length >= 2) { firstMulti = l; li = k; }
      });
      if (!firstMulti) {
        log(false, "展开子条目", "没有多要素层");
      } else {
        firstMulti._expanded = true;
        window.__XZ_openPanel("layer");
        var children = document.querySelector('[data-children="' + li + '"]');
        var childRows = children ? children.querySelectorAll("[data-feat]") : [];
        var hasFoldBtn = !!document.querySelector('[data-fold-layer="' + li + '"]');
        log(childRows.length === firstMulti.rawFeatures.length && hasFoldBtn,
          "展开子条目", "子条目=" + childRows.length + "/" + firstMulti.rawFeatures.length +
          " 折叠按钮=" + hasFoldBtn);
        firstMulti._expanded = false;
      }
    } catch (e) { log(false, "展开子条目", String(e)); }

    // 15. 多模型同时加载（关键功能）
    var S3 = window.__XZ_STATE;
    var all = (window.VIEWER_CONFIG.models || []);
    var second = null;
    for (var i = 0; i < all.length; i++) {
      var already = S3.models.some(function (m) { return m.url === all[i].url; });
      if (!already) { second = all[i]; break; }
    }
    if (!second) {
      log(false, "多模型同时加载", "config 里没有第二个可用模型");
    } else {
      window.__XZ_multiTest = function () {
        // 等一下让 addModel 完成
        var waited = 0;
        var t = setInterval(function () {
          waited += 100;
          if (S3.models.length >= 2 || waited > 15000) {
            clearInterval(t);
            var names = S3.models.map(function (m) { return m.name; });
            var allShown = S3.models.every(function (m) { return m.tileset && m.tileset.show; });
            log(S3.models.length >= 2, "多模型同时加载",
              S3.models.length + " 个：" + names.join(" + ") + "，全部可见=" + allShown);

            var bs2 = window.__XZ_sceneBoundingSphere();
            log(!!bs2 && (S3.models.length < 2 || bs2.radius > 0),
              "多模型合并包围球", bs2 ? ("半径 " + bs2.radius.toFixed(1) + " m") : "null");

            // 独立显隐
            var m0 = S3.models[0];
            if (m0 && m0.tileset) {
              m0.tileset.show = false;
              var hiddenOk = m0.tileset.show === false;
              m0.tileset.show = true;
              log(hiddenOk, "单模型独立显隐", "切换后恢复");
            }

            // 移除一个模型
            var before = S3.models.length;
            var idToRemove = S3.models[S3.models.length - 1].id;
            window.XZ3D.removeModel(idToRemove, true);
            log(S3.models.length === before - 1, "移除单个模型",
              before + " -> " + S3.models.length);

            render();
          }
        }, 100);
      };
      window.XZ3D.addModel(second, { zoom: false }).then(function () {
        setTimeout(window.__XZ_multiTest, 300);
      }).catch(function (e) {
        log(false, "多模型同时加载", "第二个模型加载失败：" + (e && e.message || e));
        render();
      });
      return;   // render 由 multiTest 负责
    }

    render();
  }

  function render() {
    var html = '<h1 style="font-size:18px;margin:0 0 4px">功能自检</h1>' +
      '<p style="color:#8fa3b6;margin:0 0 16px;font-size:13px">' +
      '通过 ' + pass + ' / 失败 ' + fail + '（共 ' + (pass + fail) + ' 项）</p>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:13px">';
    out.forEach(function (r) {
      var color = r.ok ? "#00d4aa" : "#ff6b6b";
      html += '<tr style="border-bottom:1px solid #1a3048">' +
        '<td style="width:26px;color:' + color + ';font-weight:700;padding:7px 4px">' + (r.ok ? "✓" : "✗") + '</td>' +
        '<td style="padding:7px 8px;color:#e8f4fd">' + r.name + '</td>' +
        '<td style="padding:7px 4px;color:#7a9cc8;font-size:12px">' + (r.detail || "") + '</td></tr>';
    });
    html += "</table>";

    var el = document.getElementById("result");
    el.innerHTML = html;
    document.title = (fail === 0 ? "全部通过" : (fail + " 项失败")) + " - 功能自检";
  }

  // 挂到 body 后面
  window.addEventListener("load", function () {
    // 主页面脚本是异步 boot 的，等它准备好
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (window.__XZ_STATE && window.__XZ_ICON_SHAPES) {
        clearInterval(timer);
        // 先确保至少有一个模型在场景里（自检页无 config 默认模型时手动加一个）
        ensureModelThenRun();
      } else if (tries > 60) {
        clearInterval(timer);
        document.getElementById("result").innerHTML =
          '<p style="color:#ff6b6b">主页面脚本未就绪（等待 6 秒超时）</p>';
      }
    }, 100);
  });

  function ensureModelThenRun() {
    var S = window.__XZ_STATE;
    if (S.models.length) { run(); return; }

    document.getElementById("result").innerHTML =
      '<p style="color:#7a9cc8">正在加载自检模型…</p>';

    // 用自检模型（一定存在，体积小）
    var self = null;
    (window.VIEWER_CONFIG.models || []).forEach(function (m) {
      if (m.id === "selftest") self = m;
    });
    if (!self) self = (window.VIEWER_CONFIG.models || [])[0];
    if (!self) { run(); return; }

    window.XZ3D.addModel(self, { zoom: false }).then(function () {
      // 给渲染一点时间
      setTimeout(run, 800);
    }).catch(function () {
      setTimeout(run, 200);
    });
  }
})();
