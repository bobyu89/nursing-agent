/**
 * pixel.js — 《深夜的班表》共用像素引擎
 *
 * art canvas 160×90，每格 12px → 1920×1080。
 * 所有座標以「藝術像素」為單位，繪製時才乘 U，
 * 每個色塊都落在整數裝置像素上——邊緣是硬的，不會被抗鋸齒糊掉。
 *
 * 動作規則：位移一律是 U 的整數倍，用 steps() ease。
 * 連續補間會產生半透明邊緣，像素質感就毀了。
 */
(function () {
  "use strict";
  if (window.PX) { return; }          /* 重複載入時不重建 */

  var U = 12;

  function el(stage, x, y, w, h, color, opacity, id) {
    var d = document.createElement("div");
    d.className = "p";
    d.style.left = x * U + "px";
    d.style.top = y * U + "px";
    d.style.width = w * U + "px";
    d.style.height = h * U + "px";
    if (color) { d.style.background = color; }
    if (opacity !== undefined && opacity !== null) { d.style.opacity = String(opacity); }
    if (id) { d.id = id; }
    stage.appendChild(d);
    return d;
  }

  function layer(stage, id, opacity) {
    var g = document.createElement("div");
    g.className = "p";
    g.style.cssText = "left:0;top:0;width:1920px;height:1080px";
    if (opacity !== undefined) { g.style.opacity = String(opacity); }
    if (id) { g.id = id; }
    stage.appendChild(g);
    return g;
  }

  /* char map → 色塊。同列連續同色合併成一塊，DOM 數量少一個量級。 */
  function sprite(parent, map, pal, ox, oy, scale) {
    var s = scale || 1;
    for (var r = 0; r < map.length; r++) {
      var row = map[r], c = 0;
      while (c < row.length) {
        var ch = row.charAt(c);
        if (ch === "." || !pal[ch]) { c++; continue; }
        var run = 1;
        while (c + run < row.length && row.charAt(c + run) === ch) { run++; }
        var d = document.createElement("div");
        d.className = "p";
        d.style.left = (ox + c * s) * U + "px";
        d.style.top = (oy + r * s) * U + "px";
        d.style.width = run * s * U + "px";
        d.style.height = s * U + "px";
        d.style.background = pal[ch];
        parent.appendChild(d);
        c += run;
      }
    }
    return parent;
  }

  /* ═══ 調色盤 ═══════════════════════════════════════════ */

  var night = {
    wall: "#16223c", wallDark: "#0f1930", wallLine: "#1d2b49",
    ceil: "#0c1526", floor: "#182643", floorLit: "#1e2d4f",
    far: "#080d18", door: "#0e1830", edge: "#1b2947",
    counter: "#202e4c", counterT: "#33456d",
    metal: "#3b4a6b", tube: "#cfe0ff", lamp: "#f2c97a",
    paper: "#c9d4e6", cup: "#e2e8f2", coffee: "#4a3528", steam: "#8fa2c0",
    phoneOff: "#233450", phoneOn: "#7fd8ff",
    screen: "#1c3352", screenOn: "#4d7fb8",
    accent: "#4060ef", accentLit: "#6d86ff",
    ok: "#2fbe8b", danger: "#ff6b5e", warn: "#e0a83a",
    shadow: "#050810", deep: "#080d18"
  };

  /* 幕五：晨光。同一個空間，色溫翻過來。 */
  var morning = {
    wall: "#2f3f5c", wallDark: "#243350", wallLine: "#40527a",
    ceil: "#28374f", floor: "#3b4c6d", floorLit: "#6f83a6",
    far: "#5b6c8f", door: "#22304b", edge: "#48597f",
    counter: "#3a4a6b", counterT: "#556890",
    metal: "#59688a", sun: "#ffd9a0", sunPale: "#fff0d6",
    paper: "#eef3fb", shadow: "#1a2438", deep: "#243350"
  };

  var body = {
    S: "#f0c09a", s: "#d19a72",
    K: "#2a3348", k: "#3d4863",
    E: "#22293c", P: "#c97b6b",
    W: "#eef3fb", w: "#c3d0e4",
    A: "#4060ef",
    C: "#ffffff", c: "#dbe4f2",
    M: "#8d99b4", G: "#141d33", N: "#233450",
    B: "#6b5b45", L: "#e6ecf6",
    d: "#a8724f"
  };

  /* 手機光打在臉上時的冷色版本 */
  var bodyLit = {
    S: "#a8c4e0", s: "#7f9cbe",
    K: "#1c2436", k: "#2b3550",
    E: "#141a28", P: "#8296b4",
    W: "#c4d6ea", w: "#93a8c4",
    A: "#4060ef",
    C: "#dbe8f6", c: "#adc0d8",
    M: "#6d7a96", G: "#0d1526", N: "#7fd8ff",
    B: "#4a4436", L: "#b9cde0",
    d: "#63809f"
  };

  /* ═══ Sprites ══════════════════════════════════════════ */

  /* 正面坐姿 24×28 */
  var nurseFront = [
    "........................",
    ".......CCCCCCCCCC.......",
    "......CCCCCCCCCCCC......",
    "......cCCCCCCCCCCc......",
    ".....KKKKKKKKKKKKKK.....",
    "....KKKKKKKKKKKKKKKK....",
    "....KKKSSSSSSSSSSKKK....",
    "....KKSSSSSSSSSSSSKK....",
    "....KKSSSSSSSSSSSSKK....",
    "....KKSSEESSSSEESSKK....",
    "....KKSSEESSSSEESSKK....",
    "....KKSSSSSSSSSSSSKK....",
    "....KKSSSSPPPPSSSSKK....",
    ".....KSSSSSSSSSSSSK.....",
    "......SSSSSSSSSSSS......",
    "..........ssss..........",
    "..........SSSS..........",
    "........WWWWWWWW........",
    "......WWWWWWWWWWWW......",
    ".....WWWWWWWWWWWWWW.....",
    "....WWWWWWWAAWWWWWWW....",
    "...WWWWWWWWAAWWWWWWWW...",
    "...WWWWWWWWWWWWWWWWWW...",
    "..SSWWWWWWWWWWWWWWWWSS..",
    "..SSWWWWWWWWWWWWWWWWSS..",
    "..SSSWWWWWWWWWWWWWWSSS..",
    "...wwwwwwwwwwwwwwwwww...",
    "...wwwwwwwwwwwwwwwwww..."
  ];
  var nurseFrontBlink = nurseFront.slice();
  nurseFrontBlink[9] = "....KKSSSSSSSSSSSSKK....";

  /* 低頭看手機：頭往下一格，瀏海蓋住上半臉 */
  var nurseFrontDown = nurseFront.slice();
  nurseFrontDown[6]  = "....KKKKKKKKKKKKKKKK....";
  nurseFrontDown[7]  = "....KKKSSSSSSSSSSKKK....";
  nurseFrontDown[8]  = "....KKSSSSSSSSSSSSKK....";
  nurseFrontDown[9]  = "....KKSSSSSSSSSSSSKK....";
  nurseFrontDown[10] = "....KKSSEESSSSEESSKK....";

  /* 背影 16×20 */
  var nurseBack = [
    "................",
    ".....CCCCCC.....",
    "....CCCCCCCC....",
    "....KKKKKKKK....",
    "...KKKKKKKKKK...",
    "...KKKKKKKKKK...",
    "...KKKKKKKKKK...",
    "....KKKKKKKK....",
    ".....KKKKKK.....",
    "......WWWW......",
    "....WWWWWWWW....",
    "...WWWWWWWWWW...",
    "..WWWWWWWWWWWW..",
    "..WWWWWWWWWWWW..",
    "..WWWWWWWWWWWW..",
    "..WWWWWWWWWWWW..",
    "..wwwwwwwwwwww..",
    "..wwwwwwwwwwww..",
    "................",
    "................"
  ];

  /* 走路兩格：左右腳交替（下擺擺動）*/
  var nurseWalkA = nurseBack.slice();
  nurseWalkA[18] = "...ww......ww...";
  var nurseWalkB = nurseBack.slice();
  nurseWalkB[18] = "....ww....ww....";
  nurseWalkB[17] = "..wwwwwwwwwwww..";

  /* 手 — 拿筆（俯視特寫）20×14。
     指縫用 d 分開：不分指的話放大後只會是一坨肉色。 */
  var handPen = [
    "....................",
    ".................MM.",
    "................MM..",
    "...............MM...",
    "..........SSSSSSSS..",
    ".......SSSSSSSSSSS..",
    "....SSSSSSSSSSSSSS..",
    "..SSSSdSSSdSSSSSSS..",
    "..SSSSSSSSSSSSSSSS..",
    "...sSSSSSSSSSSSSSS..",
    "....ssSSSSSSSSSSSS..",
    ".....sssssSSSSSSSs..",
    "........ssssssssss..",
    "...................."
  ];

  /* 手 — 握手機，拇指懸空 18×16 */
  var handPhone = [
    "..................",
    "....GGGGGGGGGG....",
    "....GNNNNNNNNG....",
    "....GNNNNNNNNG....",
    "....GNNNNNNNNG....",
    "....GNNNNNNNNG....",
    "..SSGNNNNNNNNG....",
    ".SSSGNNNNNNNNGSS..",
    ".SSSGGGGGGGGGGSS..",
    ".SSSdSSSSSSSSdSS..",
    ".SSSSSSSSSSSSSSS..",
    "..SSSSSSSSSSSSSS..",
    "..ssSSSSSSSSSSs...",
    "...sssssssssss....",
    "..................",
    ".................."
  ];

  /* 兩手交接板夾 24×14 */
  var handsPass = [
    "........................",
    "......BBBBBBBBBBBB......",
    "......BLLLLLLLLLLB......",
    "......BLLLLLLLLLLB......",
    "..SSSSBLLLLLLLLLLBSSSS..",
    ".SSSSSBBBBBBBBBBBBSSSSS.",
    ".SSdSSSSS......SSSSSdSS.",
    ".SSSSSSS........SSSSSSS.",
    "..sssss..........sssss..",
    "...sss............sss...",
    "........................",
    "........................",
    "........................",
    "........................"
  ];

  /* ═══ 場景 ═════════════════════════════════════════════ */

  /* 走廊：五層景深，天花板與地板往中心收 */
  function corridor(stage, pal, opt) {
    opt = opt || {};
    el(stage, 0, 0, 160, 90, pal.wall);

    el(stage, 0, 0, 160, 8, pal.ceil);
    el(stage, 10, 8, 140, 7, pal.ceil);
    el(stage, 22, 15, 116, 7, pal.ceil);
    el(stage, 36, 22, 88, 7, pal.ceil);
    el(stage, 50, 29, 60, 6, pal.ceil);
    el(stage, 62, 35, 36, 5, pal.ceil);

    el(stage, 0, 82, 160, 8, pal.floor);
    el(stage, 10, 76, 140, 6, pal.floor);
    el(stage, 22, 70, 116, 6, pal.floor);
    el(stage, 36, 65, 88, 5, pal.floor);
    el(stage, 50, 61, 60, 4, pal.floor);
    el(stage, 62, 58, 36, 3, pal.floor);

    el(stage, 66, 70, 28, 12, pal.floorLit, 0.5);
    el(stage, 70, 61, 20, 9, pal.floorLit, 0.35);

    el(stage, 70, 40, 20, 18, pal.far);
    el(stage, 70, 40, 20, 1, pal.edge);

    el(stage, 4, 24, 16, 50, pal.door);
    el(stage, 4, 24, 16, 1, pal.edge);
    el(stage, 28, 30, 12, 40, pal.door);
    el(stage, 28, 30, 12, 1, pal.edge);
    el(stage, 140, 24, 16, 50, pal.door);
    el(stage, 140, 24, 16, 1, pal.edge);
    el(stage, 120, 30, 12, 40, pal.door);
    el(stage, 120, 30, 12, 1, pal.edge);

    if (opt.tubes !== false) {
      var pre = opt.idPrefix || "t";
      el(stage, 64, 5, 32, 2, pal.tube || pal.sunPale, 0.85, pre + "1");
      el(stage, 69, 12, 22, 2, pal.tube || pal.sunPale, 0.6, pre + "2");
      el(stage, 72, 19, 16, 1, pal.tube || pal.sunPale, 0.45, pre + "3");
      el(stage, 75, 25, 10, 1, pal.tube || pal.sunPale, 0.32, pre + "4");
      el(stage, 77, 31, 6, 1, pal.tube || pal.sunPale, 0.22, pre + "5");
    }
  }

  /* 護理站中景：牆、門、白板、櫃檯 */
  function station(stage, pal, opt) {
    opt = opt || {};
    el(stage, 0, 0, 160, 90, pal.wall);
    el(stage, 0, 0, 160, 9, pal.wallDark);
    el(stage, 0, 30, 160, 1, pal.wallLine);

    el(stage, 9, 17, 22, 47, pal.wallDark);
    el(stage, 9, 17, 22, 1, pal.wallLine);
    el(stage, 9, 17, 1, 47, pal.wallLine);
    el(stage, 30, 17, 1, 47, pal.wallLine);
    el(stage, 27, 40, 2, 3, pal.metal);

    /* 白板：有外框才讀得出是掛在牆上的物件，只有線沒有字 */
    el(stage, 118, 15, 33, 25, pal.wallDark);
    el(stage, 119, 16, 31, 23, pal.wallLine);
    el(stage, 118, 15, 33, 1, pal.metal, 0.55);
    el(stage, 118, 39, 33, 1, pal.metal, 0.55);
    el(stage, 118, 15, 1, 25, pal.metal, 0.55);
    el(stage, 150, 15, 1, 25, pal.metal, 0.55);
    el(stage, 122, 21, 18, 1, pal.edge);
    el(stage, 122, 26, 24, 1, pal.edge);
    el(stage, 122, 31, 14, 1, pal.edge);

    if (opt.tubes !== false) {
      var pre = opt.idPrefix || "fl";
      var lit = pal.tube || pal.sunPale;
      /* 燈具外殼，讓燈管看起來是嵌在天花板上而不是漂浮的 */
      el(stage, 59, 1, 42, 1, pal.wallDark || pal.wallLine);
      el(stage, 62, 3, 36, 2, lit, 1, pre + "-tube");
      /* 光錐：往下一層一層變寬變淡。矩形色塊只有做成錐形才讀得出是光。 */
      var g1 = layer(stage, pre + "-g1", 1);
      el(g1, 60, 5, 40, 1, lit, 0.11);
      el(g1, 58, 6, 44, 1, lit, 0.085);
      el(g1, 56, 7, 48, 1, lit, 0.065);
      el(g1, 54, 8, 52, 1, lit, 0.05);
      var g2 = layer(stage, pre + "-g2", 1);
      el(g2, 52, 9, 56, 1, lit, 0.04);
      el(g2, 50, 10, 60, 1, lit, 0.03);
      el(g2, 48, 11, 64, 1, lit, 0.022);
      el(g2, 46, 12, 68, 1, lit, 0.015);
    }
  }

  function counter(stage, pal) {
    el(stage, 0, 64, 160, 2, pal.counterT);
    el(stage, 0, 66, 160, 24, pal.counter);
    el(stage, 0, 72, 160, 1, pal.shadow, 0.4);
  }

  /* 檯燈 + 光暈。全片暗場鏡頭唯一的暖色。 */
  function deskLamp(stage, pal, x, idPrefix) {
    var p = idPrefix || "lamp";
    /* 底座與燈桿 */
    el(stage, x + 3, 62, 8, 2, pal.metal);
    el(stage, x + 6, 52, 2, 10, pal.metal);
    /* 燈罩：梯形，才看得出是燈不是箱子 */
    el(stage, x + 3, 47, 8, 1, pal.metal);
    el(stage, x + 2, 48, 10, 1, pal.metal);
    el(stage, x + 1, 49, 12, 1, pal.metal);
    el(stage, x, 50, 14, 1, pal.metal);
    /* 燈泡那一線 */
    el(stage, x + 1, 51, 12, 1, pal.lamp);

    /* 光錐：從燈罩往下擴散，一層一層變淡 */
    var g1 = layer(stage, p + "-g1", 1);
    el(g1, x + 1, 52, 12, 1, pal.lamp, 0.16);
    el(g1, x, 53, 14, 1, pal.lamp, 0.13);
    el(g1, x - 1, 54, 16, 1, pal.lamp, 0.11);
    el(g1, x - 2, 55, 18, 1, pal.lamp, 0.09);
    el(g1, x - 3, 56, 20, 1, pal.lamp, 0.07);
    var g2 = layer(stage, p + "-g2", 1);
    el(g2, x - 4, 57, 22, 1, pal.lamp, 0.055);
    el(g2, x - 5, 58, 24, 1, pal.lamp, 0.045);
    el(g2, x - 6, 59, 26, 1, pal.lamp, 0.035);
    el(g2, x - 7, 60, 28, 1, pal.lamp, 0.028);
    el(g2, x - 8, 61, 30, 1, pal.lamp, 0.022);
    /* 檯面上的光池 */
    el(g2, x - 9, 64, 32, 2, pal.lamp, 0.08);
  }

  /* 暗角：把注意力收到中間 */
  function vignette(stage, pal, strength) {
    var s = strength || 0.55;
    el(stage, 0, 0, 20, 90, pal.shadow, s);
    el(stage, 140, 0, 20, 90, pal.shadow, s);
    el(stage, 0, 76, 160, 14, pal.shadow, s * 0.6);
    el(stage, 0, 0, 160, 8, pal.shadow, s * 0.5);
  }

  /**
   * 光點網格 — 幕四的視覺語言。
   * 對應 rules.js：每個點是一位可調度人力，
   * 硬限制把點熄掉，軟評分讓剩下的點分出亮度。
   */
  function dotGrid(stage, opt) {
    var cols = opt.cols, rows = opt.rows;
    var x0 = opt.x0, y0 = opt.y0, gap = opt.gap || 6, size = opt.size || 2;
    var color = opt.color, pre = opt.idPrefix || "d";
    var out = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var i = r * cols + c;
        var d = el(stage, x0 + c * gap, y0 + r * gap, size, size, color,
                   opt.opacity === undefined ? 0.85 : opt.opacity,
                   pre + i);
        out.push(d);
      }
    }
    return out;
  }

  window.PX = {
    U: U,
    rect: el,
    layer: layer,
    sprite: sprite,
    pal: { night: night, morning: morning, body: body, bodyLit: bodyLit },
    spr: {
      nurseFront: nurseFront,
      nurseFrontBlink: nurseFrontBlink,
      nurseFrontDown: nurseFrontDown,
      nurseBack: nurseBack,
      nurseWalkA: nurseWalkA,
      nurseWalkB: nurseWalkB,
      handPen: handPen,
      handPhone: handPhone,
      handsPass: handsPass
    },
    scene: {
      corridor: corridor,
      station: station,
      counter: counter,
      deskLamp: deskLamp,
      vignette: vignette,
      dotGrid: dotGrid
    }
  };
})();
