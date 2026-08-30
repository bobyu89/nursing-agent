---
name: ShiftGuard Indigo
colors:
  primary: "#f3f5fa"
  on-primary: "#16233a"
  accent: "#4060ef"
  accent-deep: "#3350dd"
  accent-tint: "#edf1fe"
  ink: "#16233a"
  ink-soft: "#47566f"
  ink-faint: "#5c6b85"
  line: "#e4e9f1"
  line-soft: "#eef2f7"
  surface: "#f8fafc"
  dark-canvas: "#101b30"
  on-dark: "#f3f5fa"
  on-dark-faint: "#9aa8c2"
  ok: "#117a58"
  ok-tint: "#e6f6ef"
  warn: "#93600a"
  danger: "#c92c21"
  danger-tint: "#fdecea"
typography:
  headline:
    fontFamily: Noto Sans TC
    fontSize: 4.5rem
    fontWeight: 800
    letterSpacing: 0.01em
  subhead:
    fontFamily: Noto Sans TC
    fontSize: 1.5rem
    fontWeight: 700
  body:
    fontFamily: Noto Sans TC
    fontSize: 1.125rem
    fontWeight: 400
    lineHeight: 1.7
  stat:
    fontFamily: Noto Sans TC
    fontSize: 7rem
    fontWeight: 800
  label:
    fontFamily: Noto Sans TC
    fontSize: 0.875rem
    fontWeight: 500
    letterSpacing: 0.08em
rounded:
  sm: 6px
  md: 12px
  lg: 18px
spacing:
  sm: 8px
  md: 16px
  lg: 32px
  xl: 64px
motion:
  energy: medium
  easing:
    entry: "power3.out"
    exit: "power2.in"
    ambient: "sine.inOut"
  duration:
    entrance: 0.6
    hold: 2.2
    transition: 0.4
  atmosphere:
    - hairline-rules
  transition: hard-cut
---

## Overview

班守 ShiftGuard 的產品影片主題，色票一字不差取自平台正式設計代幣
（repo `assets/styles.css` 的 `:root`）。目標：影片、landing page、平台、
LINE 選單四個面孔是同一張臉。

全片兩幕式：

- **暗場**（開場 0–17.4s 與其後的問題段）：`dark-canvas` 深墨藍打底、
  `on-dark` 文字、`danger` 只出現在「被劃掉／出事」的元素上。冷、沉、刺。
- **亮場**（亮相之後）：`primary` 淺灰藍畫布、白卡片、hairline 細線、
  靛藍強調——與平台介面同一套光線。乾淨、俐落、可信。

暗轉亮只發生一次，由全片唯一的反白閃屏承擔（亮相瞬間）。

## Colors

- `accent` #4060ef 是品牌靛藍：標準字、關鍵字 marker、CTA 按鈕。不得替換。
- `danger` #c92c21 只給「攔截／違規／被劃掉」；`ok` #117a58 只給「放行／通過」。
  語義色不做裝飾用。
- 暗場文字用 `on-dark`／`on-dark-faint` 兩階；亮場文字用 `ink`／`ink-soft`／
  `ink-faint` 三階。所有文字對比須達 WCAG AA。
- 禁止漸層背景。底色永遠是平色＋hairline。

## Typography

- 全片單一字族 Noto Sans TC（.woff2 內嵌），繁體中文。
- 中文不用斜體——強調一律靠字重（700→800）、`accent` 色、或 marker 橫掃。
- 大字卡每屏 ≤ 12 字；hero 標題 ≤ 8 字，超過拆兩行。
- 數字（98、前 3 名）用 `stat` 檔，等寬數字對齊。

## Elevation

- 卡片：白底（亮場）／深一階（暗場）＋ 1px `line` 邊框＋極淺投影。
- 不用毛玻璃、不用發光暈影。層次靠邊線與底色深淺，與平台一致。

## Components

- **LINE 對話重建**：依 LINE 視覺習慣——對話區米白底、使用者訊息右側
  綠底白字、機器人訊息左側白底墨字、快速回覆為圓角膠囊鈕。重建時
  去掉狀態列與個資，訊息內容不含 emoji。
- **瀏覽器／儀表板外框**：承載平台真實錄屏，外框極簡（圓角 md、
  hairline 邊、頂部窄工具列），不畫假 macOS 紅綠燈。
- 圖標僅用平台既有的線性 SVG 語彙（1.5–2px 描邊），不用 3D 圖標。

## Do's and Don'ts

- ✓ 真實錄屏當主角；✓ 大字卡是每段的結論；✓ 留白多、元素少。
- ✗ 罐頭勵志／簡報模板腔（禁止星球、火箭、握手 stock 圖）。
- ✗ emoji 與卡通醫護插畫。
- ✗ 假見證、假客戶 logo、假 ROI 數字——畫面上每個數字都要有平台真實出處。
- ✗「醫療藍漸層＋3D 圖標」的同業套路。
