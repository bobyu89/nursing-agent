# richmenu.ps1 — 一鍵建立班守 LINE 圖文選單（Rich Menu）——四份依權責層
#
# Stage 1（docs/LINEBOT-STAGE1.md §2.4、§2.5）：選單不再是一份給全體，而是
#   unbound  未綁定（設為全體預設）：如何綁定＋三個「綁定後可用」的預告格
#   staff    護理師：通報缺班／換班預檢／我的邀請／我是誰／選單／開啟平台
#   head     護理長：儀表板／待核准／通報缺班／換班簽核／我的邀請／開啟平台
#   exec     督導／主任：儀表板／調度棋盤／負荷雷達／待核准／換班／開啟平台
# 格子＝§2.5 權限矩陣該層打勾的指令；按格子＝送出指令文字，Worker 的指令路由接手。
# Worker 在「綁定成功」那一刻依 tier 把對應選單掛給本人（wrangler.toml [vars] RICHMENU_*）。
#
# 做四件事（每份選單各一次）：
#   1. 用 Windows 內建 GDI+ 畫出 2500×1686 的「六格＋底部細長列」選單圖（不需安裝任何軟體）
#   2. 呼叫 LINE Rich Menu API 建立選單物件（座標與圖對齊）
#   3. 上傳選單圖
#   4. unbound 設為全體預設；清掉本腳本先前建立的同名舊版（安全換版：先上新、再刪舊）
# 最後印出四個 richMenuId 與可直接貼進 wrangler.toml 的 [vars] 片段。
#
# 用法（Windows PowerShell 5.1 可直接跑）：
#   powershell -ExecutionPolicy Bypass -File richmenu.ps1
#   → 會提示貼上 Channel access token（LINE Developers → Messaging API → Channel access token）
#   或先設環境變數再跑：$env:LINE_CHANNEL_ACCESS_TOKEN = '...'
#   只想預覽圖片不動 LINE：powershell -ExecutionPolicy Bypass -File richmenu.ps1 -ImageOnly
#   （會產生 richmenu-unbound.png／-staff.png／-head.png／-exec.png）
#
# 設計語彙與平台儀表板一致（淺色 SaaS、靛藍 #4060EF）。

param(
  [string]$Token = $env:LINE_CHANNEL_ACCESS_TOKEN,
  [switch]$ImageOnly
)

$ErrorActionPreference = 'Stop'
$PLATFORM_URL = 'https://bobyu89.github.io/nursing-agent/'
$LIFF_ID = '2011209447-AlMMDUMl'   # 與 wrangler.toml 同步；留空字串則「開啟平台」退回一般網址
$MENU_NAME = 'shiftguard-menu'
$OPEN_URI = $(if ($LIFF_ID) { "https://liff.line.me/$LIFF_ID" } else { $PLATFORM_URL })

Add-Type -AssemblyName System.Drawing
$W = 2500; $H = 1686

# 平台同款色票
$cBg     = [System.Drawing.ColorTranslator]::FromHtml('#F3F5FA')
$cCard   = [System.Drawing.ColorTranslator]::FromHtml('#FFFFFF')
$cLine   = [System.Drawing.ColorTranslator]::FromHtml('#E4E9F1')
$cInk    = [System.Drawing.ColorTranslator]::FromHtml('#16233A')
$cFaint  = [System.Drawing.ColorTranslator]::FromHtml('#5C6B85')
$cBrand  = [System.Drawing.ColorTranslator]::FromHtml('#4060EF')
$cTint   = [System.Drawing.ColorTranslator]::FromHtml('#EDF1FE')

$margin = 40.0; $gap = 40.0
$stripH = 150.0                                       # 底部細長列
$cw = ($W - 2 * $margin - 2 * $gap) / 3               # 780
$ch = ($H - 2 * $margin - 2 * $gap - $stripH) / 2     # 688

# 字級以手機實際顯示為準：2500px 寬的圖縮到聊天室約 370px 寬，縮比 ~6.8 倍——
# 標題 96px ≈ 螢幕 14px、副標 46px ≈ 螢幕 7px，再小就看不清了
$fTitle = New-Object System.Drawing.Font('Microsoft JhengHei', 96, [System.Drawing.FontStyle]::Bold, 'Pixel')
$fSub   = New-Object System.Drawing.Font('Microsoft JhengHei', 46, [System.Drawing.FontStyle]::Regular, 'Pixel')
$fStrip = New-Object System.Drawing.Font('Microsoft JhengHei', 50, [System.Drawing.FontStyle]::Bold, 'Pixel')
$fQ     = New-Object System.Drawing.Font('Microsoft JhengHei', 44, [System.Drawing.FontStyle]::Bold, 'Pixel')
$bCard  = New-Object System.Drawing.SolidBrush($cCard)
$bInk   = New-Object System.Drawing.SolidBrush($cInk)
$bFaint = New-Object System.Drawing.SolidBrush($cFaint)
$bBrand = New-Object System.Drawing.SolidBrush($cBrand)
$bTint  = New-Object System.Drawing.SolidBrush($cTint)
$bWhite = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$bBrandTxt = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#3350DD'))
$penLine  = New-Object System.Drawing.Pen($cLine, 4)
$penTint  = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#C9D6F6'), 3)
$penBrand = New-Object System.Drawing.Pen($cBrand, 14)
$penBrand.StartCap = 'Round'; $penBrand.EndCap = 'Round'

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Draw-Mascot([float]$cx, [float]$cy, [float]$s) {
  # 班守 IP「守守」（北極熊）：與 assets/logo.svg 同一份幾何，SVG 手工轉 GDI+
  # (cx,cy)＝視覺中心（單位座標 32,34 的落點）；s＝縮放（1 單位 → s px）
  $ox = $cx - 32 * $s; $oy = $cy - 34 * $s
  $bInner = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#D9D4C8'))
  $bMuzzle = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#E6E1D4'))
  $furRect = New-Object System.Drawing.RectangleF(($ox + 5 * $s), ($oy + 5 * $s), (54 * $s), (57 * $s))
  $bFur = New-Object System.Drawing.Drawing2D.LinearGradientBrush($furRect,
    [System.Drawing.ColorTranslator]::FromHtml('#FFFDF6'),
    [System.Drawing.ColorTranslator]::FromHtml('#F3ECDB'),
    [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)

  # 耳朵（先畫，頭蓋上）＋內耳
  $g.FillEllipse($bFur, ($ox + 5.3 * $s),  ($oy + 5.8 * $s), (18.4 * $s), (18.4 * $s))
  $g.FillEllipse($bFur, ($ox + 40.3 * $s), ($oy + 5.8 * $s), (18.4 * $s), (18.4 * $s))
  $g.FillEllipse($bInner, ($ox + 10.7 * $s), ($oy + 11.2 * $s), (9.6 * $s), (9.6 * $s))
  $g.FillEllipse($bInner, ($ox + 43.7 * $s), ($oy + 11.2 * $s), (9.6 * $s), (9.6 * $s))

  # 頭（四段貝茲的大圓臉）
  $head = New-Object System.Drawing.Drawing2D.GraphicsPath
  $head.AddBezier(($ox+32*$s),($oy+9*$s),   ($ox+48.5*$s),($oy+9*$s),   ($ox+58*$s),($oy+22*$s),   ($ox+58*$s),($oy+38*$s))
  $head.AddBezier(($ox+58*$s),($oy+38*$s),  ($ox+58*$s),($oy+53*$s),    ($ox+47*$s),($oy+61.5*$s), ($ox+32*$s),($oy+61.5*$s))
  $head.AddBezier(($ox+32*$s),($oy+61.5*$s),($ox+17*$s),($oy+61.5*$s),  ($ox+6*$s),($oy+53*$s),    ($ox+6*$s),($oy+38*$s))
  $head.AddBezier(($ox+6*$s),($oy+38*$s),   ($ox+6*$s),($oy+22*$s),     ($ox+15.5*$s),($oy+9*$s),  ($ox+32*$s),($oy+9*$s))
  $head.CloseFigure()
  $g.FillPath($bFur, $head)

  # 口鼻部、眼睛、鼻子、微笑
  $g.FillEllipse($bMuzzle, ($ox + 20.5 * $s), ($oy + 36 * $s), (23 * $s), (18 * $s))
  $g.FillEllipse($bInk, ($ox + 19.6 * $s), ($oy + 30.6 * $s), (5.8 * $s), (5.8 * $s))
  $g.FillEllipse($bInk, ($ox + 38.6 * $s), ($oy + 30.6 * $s), (5.8 * $s), (5.8 * $s))
  $g.FillEllipse([System.Drawing.Brushes]::White, ($ox + 22.5 * $s), ($oy + 31.5 * $s), (2 * $s), (2 * $s))
  $g.FillEllipse([System.Drawing.Brushes]::White, ($ox + 41.5 * $s), ($oy + 31.5 * $s), (2 * $s), (2 * $s))
  $nose = New-RoundedPath ($ox + 27.4 * $s) ($oy + 39.2 * $s) (9.2 * $s) (5.6 * $s) (2.8 * $s)
  $g.FillPath($bInk, $nose)
  $penSmile = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#16233A'), (1.8 * $s))
  $penSmile.StartCap = 'Round'; $penSmile.EndCap = 'Round'
  $g.DrawBezier($penSmile, ($ox+28.5*$s),($oy+49.5*$s), ($ox+30.83*$s),($oy+51.5*$s), ($ox+33.17*$s),($oy+51.5*$s), ($ox+35.5*$s),($oy+49.5*$s))

  $bInner.Dispose(); $bMuzzle.Dispose(); $bFur.Dispose(); $penSmile.Dispose()
}

function Draw-Icon([string]$kind, [float]$cx, [float]$cy) {
  # 以 (cx,cy) 為中心、約 150px 見方的簡單幾何圖示（GDI+ 不畫 emoji，畫線條最乾淨）
  switch ($kind) {
    'chart' {   # 三根長條
      $g.FillRectangle($bBrand, $cx - 66, $cy + 8,  34, 58)
      $g.FillRectangle($bBrand, $cx - 17, $cy - 40, 34, 106)
      $g.FillRectangle($bBrand, $cx + 32, $cy - 12, 34, 78)
    }
    'swap' {    # 上下兩支對向箭頭
      $g.DrawLine($penBrand, $cx - 60, $cy - 26, $cx + 52, $cy - 26)
      $g.DrawLine($penBrand, $cx + 52, $cy - 26, $cx + 24, $cy - 54)
      $g.DrawLine($penBrand, $cx + 60, $cy + 26, $cx - 52, $cy + 26)
      $g.DrawLine($penBrand, $cx - 52, $cy + 26, $cx - 24, $cy + 54)
    }
    'board' {   # 棋盤四格，右下一格實心
      $g.DrawRectangle($penBrand, $cx - 58, $cy - 58, 52, 52)
      $g.DrawRectangle($penBrand, $cx + 6,  $cy - 58, 52, 52)
      $g.DrawRectangle($penBrand, $cx - 58, $cy + 6,  52, 52)
      $g.FillRectangle($bBrand,   $cx + 6,  $cy + 6,  56, 56)
    }
    'gauge' {   # 儀表半圓＋指針
      $g.DrawArc($penBrand, $cx - 62, $cy - 40, 124, 124, 180, 180)
      $g.DrawLine($penBrand, $cx, $cy + 22, $cx + 38, $cy - 26)
      $g.FillEllipse($bBrand, $cx - 12, $cy + 10, 24, 24)
    }
    'chat' {    # 對話泡泡
      $p = New-RoundedPath ($cx - 64) ($cy - 52) 128 88 20
      $g.DrawPath($penBrand, $p)
      $tail = New-Object System.Drawing.PointF[] 3
      $tail[0] = New-Object System.Drawing.PointF(($cx - 22), ($cy + 34))
      $tail[1] = New-Object System.Drawing.PointF(($cx + 12), ($cy + 34))
      $tail[2] = New-Object System.Drawing.PointF(($cx - 26), ($cy + 62))
      $g.FillPolygon($bBrand, $tail)
    }
    'globe' {   # 地球：圓＋經緯線
      $g.DrawEllipse($penBrand, $cx - 58, $cy - 58, 116, 116)
      $g.DrawEllipse($penBrand, $cx - 26, $cy - 58, 52, 116)
      $g.DrawLine($penBrand, $cx - 58, $cy, $cx + 58, $cy)
    }
    'bell' {    # 鈴鐺：我的邀請
      $p = New-Object System.Drawing.Drawing2D.GraphicsPath
      $p.AddArc($cx - 48, $cy - 52, 96, 96, 180, 180)
      $p.AddLine($cx + 48, $cy - 4, $cx + 60, $cy + 34)
      $p.AddLine($cx + 60, $cy + 34, $cx - 60, $cy + 34)
      $p.AddLine($cx - 60, $cy + 34, $cx - 48, $cy - 4)
      $p.CloseFigure()
      $g.DrawPath($penBrand, $p)
      $g.FillEllipse($bBrand, $cx - 16, $cy + 40, 32, 24)
    }
    'check' {   # 勾：待核准
      $g.DrawEllipse($penBrand, $cx - 58, $cy - 58, 116, 116)
      $g.DrawLine($penBrand, $cx - 30, $cy + 2, $cx - 8, $cy + 26)
      $g.DrawLine($penBrand, $cx - 8, $cy + 26, $cx + 34, $cy - 24)
    }
    'id' {      # 名牌：我是誰
      $p = New-RoundedPath ($cx - 64) ($cy - 44) 128 88 14
      $g.DrawPath($penBrand, $p)
      $g.FillEllipse($bBrand, $cx - 46, $cy - 22, 30, 30)
      $g.DrawLine($penBrand, $cx + 2, $cy - 12, $cx + 44, $cy - 12)
      $g.DrawLine($penBrand, $cx + 2, $cy + 14, $cx + 44, $cy + 14)
    }
    'key' {     # 鑰匙：如何綁定
      $g.DrawEllipse($penBrand, $cx - 60, $cy - 30, 60, 60)
      $g.DrawLine($penBrand, $cx, $cy, $cx + 62, $cy)
      $g.DrawLine($penBrand, $cx + 40, $cy, $cx + 40, $cy + 24)
      $g.DrawLine($penBrand, $cx + 58, $cy, $cx + 58, $cy + 18)
    }
    'mascot' { # 班守 IP「守守」（北極熊）本尊坐鎮「開啟平台」格
      Draw-Mascot $cx $cy 3.4
    }
  }
}

# ── 四份選單的內容（§2.4）：格子順序＝上排左中右、下排左中右；action 即按下去送出的文字 ──
$T = { param($t) @{ type = 'message'; text = $t } }
$OPEN = @{ title = '開啟平台'; sub = '守守帶路・完整功能'; icon = 'mascot'; action = @{ type = 'uri'; uri = $OPEN_URI } }

$MENUS = @(
  @{ key = 'unbound'; chatBar = '先綁定'; default = $true
     strip = '尚未綁定 —— 向管理者索取六位數綁定碼，輸入「綁定 你的代號 碼」'; stripAction = (& $T '綁定說明')
     cells = @(
       @{ title = '如何綁定';   sub = '30 秒完成，之後全開'; icon = 'key';   action = (& $T '綁定說明') },
       @{ title = '使用說明';   sub = '指令怎麼打，一頁看完'; icon = 'chat';  action = (& $T '使用說明') },
       $OPEN,
       @{ title = '通報缺班';   sub = '綁定後可用';           icon = 'chat';  action = (& $T '綁定說明') },
       @{ title = '換班預檢';   sub = '綁定後可用';           icon = 'swap';  action = (& $T '綁定說明') },
       @{ title = '我的邀請';   sub = '綁定後可用';           icon = 'bell';  action = (& $T '綁定說明') }
     ) },
  @{ key = 'staff'; chatBar = '功能選單'; default = $false
     strip = '使用說明　—　第一次用？點這裡看指令怎麼打'; stripAction = (& $T '使用說明')
     cells = @(
       @{ title = '通報缺班';   sub = '一句話，其餘按鈕問你'; icon = 'chat';  action = (& $T '通報缺班') },
       @{ title = '換班預檢';   sub = '互換後 H1–H10 重算';   icon = 'swap';  action = (& $T '換班') },
       @{ title = '我的邀請';   sub = '等你回覆的替班詢問';   icon = 'bell';  action = (& $T '我的邀請') },
       @{ title = '我的預假';   sub = '下個月想休的日期';     icon = 'id';    action = (& $T '我的預假') },
       @{ title = '功能選單';   sub = '全部指令的快速按鈕';   icon = 'gauge'; action = (& $T '選單') },
       $OPEN
     ) },
  @{ key = 'head'; chatBar = '護理長'; default = $false
     strip = '使用說明　—　指令怎麼打、核准後會發生什麼'; stripAction = (& $T '使用說明')
     cells = @(
       @{ title = '戰情儀表板'; sub = '本週缺口與需要行動';   icon = 'chart'; action = (& $T '儀表板') },
       @{ title = '待核准';     sub = '替班請求，核准才開口'; icon = 'check'; action = (& $T '待核准') },
       @{ title = '通報缺班';   sub = '自己的缺班也走迴路';   icon = 'chat';  action = (& $T '通報缺班') },
       @{ title = '換班簽核';   sub = '互換後 H1–H10 重算';   icon = 'swap';  action = (& $T '換班') },
       @{ title = '預班';       sub = '開啟、進度、催繳、公告'; icon = 'bell';  action = (& $T '預班狀態') },
       $OPEN
     ) },
  @{ key = 'exec'; chatBar = '督導'; default = $false
     strip = '使用說明　—　指令怎麼打、各視角能看什麼'; stripAction = (& $T '使用說明')
     cells = @(
       @{ title = '戰情儀表板'; sub = '本週缺口與需要行動';   icon = 'chart'; action = (& $T '儀表板') },
       @{ title = '調度棋盤';   sub = '守恆律借調建議';       icon = 'board'; action = (& $T '調度') },
       @{ title = '負荷雷達';   sub = '誰一直在扛，看得見';   icon = 'gauge'; action = (& $T '負荷') },
       @{ title = '待核准';     sub = '全院替班請求（檢視）'; icon = 'check'; action = (& $T '待核准') },
       @{ title = '換班預檢';   sub = '互換後 H1–H10 重算';   icon = 'swap';  action = (& $T '換班') },
       $OPEN
     ) }
)

# ── 畫一份選單圖 ─────────────────────────────────────────────────
function Draw-MenuImage($menu, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $script:g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear($cBg)

  for ($i = 0; $i -lt 6; $i++) {
    $c = $menu.cells[$i]
    $col = $i % 3; $row = [math]::Floor($i / 3)
    $x = $margin + $col * ($cw + $gap)
    $y = $margin + $row * ($ch + $gap)
    $path2 = New-RoundedPath $x $y $cw $ch 36
    $g.FillPath($bCard, $path2)
    $g.DrawPath($penLine, $path2)
    $badge = New-RoundedPath ($x + 56) ($y + 56) 210 210 42
    $g.FillPath($bTint, $badge)
    Draw-Icon $c.icon ($x + 56 + 105) ($y + 56 + 105)
    $g.DrawString($c.title, $fTitle, $bInk,   ($x + 44), ($y + $ch - 320))
    $g.DrawString($c.sub,   $fSub,   $bFaint, ($x + 52), ($y + $ch - 140))
  }

  # 底部細長列：整條可點
  $stripY = $margin + 2 * ($ch + $gap)          # 1496
  $strip = New-RoundedPath $margin $stripY ($W - 2 * $margin) $stripH 36
  $g.FillPath($bTint, $strip)
  $g.DrawPath($penTint, $strip)
  $sz = $g.MeasureString($menu.strip, $fStrip)
  $badgeR = 45.0
  $totalW = $badgeR * 2 + 28 + $sz.Width
  $startX = [math]::Max(60.0, ($W - $totalW) / 2)
  $badgeY = $stripY + ($stripH - $badgeR * 2) / 2
  $g.FillEllipse($bBrand, $startX, $badgeY, ($badgeR * 2), ($badgeR * 2))
  $sfC = New-Object System.Drawing.StringFormat
  $sfC.Alignment = 'Center'; $sfC.LineAlignment = 'Center'
  $qRect = New-Object System.Drawing.RectangleF($startX, $badgeY, ($badgeR * 2), ($badgeR * 2))
  $g.DrawString($(if ($menu.key -eq 'unbound') { '!' } else { '?' }), $fQ, $bWhite, $qRect, $sfC)
  $g.DrawString($menu.strip, $fStrip, $bBrandTxt, ($startX + $badgeR * 2 + 28), ($stripY + ($stripH - $sz.Height) / 2))

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

# ── 1. 畫四張圖＋寫出選單定義 JSON ──────────────────────────────
# richmenu-defs.json 與四張 png 一起 commit 到 repo，GitHub Pages 會把它們公開；
# Worker 的管理者指令「建立選單」就從那裡抓定義與圖、用它自己手上的 channel token 建選單，
# 本機不需要任何 token。座標與下方 §3 相同（六格＋底部細長列）。
$defs = @()
foreach ($m in $MENUS) {
  $m.img = Join-Path $PSScriptRoot "richmenu-$($m.key).png"
  Draw-MenuImage $m $m.img
  $size = [math]::Round((Get-Item $m.img).Length / 1KB)
  Write-Host "✓ 選單圖已產生：$($m.img)（${size} KB）"
  $areas = @()
  for ($i = 0; $i -lt 6; $i++) {
    $col = $i % 3; $row = [math]::Floor($i / 3)
    $areas += @{ bounds = @{ x = [int](833 * $col); y = [int](748 * $row); width = $(if ($col -eq 2) { 834 } else { 833 }); height = $(if ($row -eq 0) { 748 } else { 728 }) }
                 action = $m.cells[$i].action }
  }
  $areas += @{ bounds = @{ x = 0; y = 1476; width = 2500; height = 210 }; action = $m.stripAction }
  $defs += [ordered]@{ key = $m.key; default = [bool]$m.default; chatBarText = $m.chatBar; image = "richmenu-$($m.key).png"
                       size = @{ width = $W; height = $H }; areas = $areas }
}
$defsPath = Join-Path $PSScriptRoot 'richmenu-defs.json'
[IO.File]::WriteAllText($defsPath, (ConvertTo-Json -InputObject $defs -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "✓ 選單定義已寫出：$defsPath"
if ($ImageOnly) { Write-Host '（-ImageOnly：不呼叫 LINE API。commit png＋json 後，在 LINE 對機器人輸入「建立選單」即可）'; exit 0 }

# ── 2. 取得 token ────────────────────────────────────────────────
Write-Host ''
Write-Host '→ 圖已畫好，但選單還沒建立：接下來需要 Channel access token 呼叫 LINE API。'
if (-not $Token) {
  # 非互動環境（stdin 被重導、由其他程式呼叫）會在 Read-Host 無聲卡死——直接說清楚並中止
  if ([Console]::IsInputRedirected) {
    throw '沒有 token 且目前不是互動式視窗，無法提示輸入。請在 PowerShell 視窗裡執行本腳本並貼上 token，或先設定 $env:LINE_CHANNEL_ACCESS_TOKEN 再執行。'
  }
  $sec = Read-Host '貼上 LINE Channel access token（LINE Developers → Messaging API）' -AsSecureString
  $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
if (-not $Token) { throw '沒有 token，中止。' }
$headers = @{ Authorization = "Bearer $Token" }

$old = (Invoke-RestMethod -Uri 'https://api.line.me/v2/bot/richmenu/list' -Headers $headers).richmenus |
  Where-Object { $_.name -like "$MENU_NAME*" }

# ── 3. 逐份建立 → 上傳圖 → （unbound）設為預設 ──────────────────
$ids = @{}
foreach ($m in $MENUS) {
  $areas = @()
  for ($i = 0; $i -lt 6; $i++) {
    $col = $i % 3; $row = [math]::Floor($i / 3)
    # 上下兩排六格（各分到相鄰間隙的一半），最底 1476–1686 整條是細長列
    $areas += @{ bounds = @{ x = [int](833 * $col); y = [int](748 * $row); width = $(if ($col -eq 2) { 834 } else { 833 }); height = $(if ($row -eq 0) { 748 } else { 728 }) }
                 action = $m.cells[$i].action }
  }
  $areas += @{ bounds = @{ x = 0; y = 1476; width = 2500; height = 210 }; action = $m.stripAction }
  $menuObj = @{
    size = @{ width = 2500; height = 1686 }
    selected = $true
    name = "$MENU_NAME-$($m.key)-$(Get-Date -Format yyyyMMdd-HHmm)"
    chatBarText = $m.chatBar
    areas = $areas
  }
  $body = [System.Text.Encoding]::UTF8.GetBytes(($menuObj | ConvertTo-Json -Depth 8))   # PS5.1：中文一定要自己轉 UTF-8
  $created = Invoke-RestMethod -Uri 'https://api.line.me/v2/bot/richmenu' -Method Post -Headers $headers `
    -ContentType 'application/json; charset=utf-8' -Body $body
  $id = $created.richMenuId
  Invoke-RestMethod -Uri "https://api-data.line.me/v2/bot/richmenu/$id/content" -Method Post `
    -Headers $headers -ContentType 'image/png' -InFile $m.img | Out-Null
  if ($m.default) {
    Invoke-RestMethod -Uri "https://api.line.me/v2/bot/user/all/richmenu/$id" -Method Post -Headers $headers | Out-Null
  }
  $ids[$m.key] = $id
  Write-Host "✓ [$($m.key)] 已建立並上傳圖：$id$(if ($m.default) { '（已設為全體預設）' })"
}

# ── 4. 刪舊版 ────────────────────────────────────────────────────
foreach ($o in $old) {
  Invoke-RestMethod -Uri "https://api.line.me/v2/bot/richmenu/$($o.richMenuId)" -Method Delete -Headers $headers | Out-Null
  Write-Host "✓ 已清除舊版選單：$($o.name)"
}

Write-Host ''
Write-Host '完成！把下面三行貼進 cloudflare/linebot/wrangler.toml 的 [vars]，然後重新部署（deploy.ps1）：'
Write-Host ''
Write-Host "RICHMENU_STAFF = `"$($ids['staff'])`""
Write-Host "RICHMENU_HEAD  = `"$($ids['head'])`""
Write-Host "RICHMENU_EXEC  = `"$($ids['exec'])`""
Write-Host ''
Write-Host '未綁定者會看到 unbound（全體預設）；綁定成功那一刻 Worker 依權責層把對應選單掛給本人。'
Write-Host '已綁定的既有使用者：重新綁定一次（發碼→綁定）即可掛上，或用 LINE API 手動連結。'
