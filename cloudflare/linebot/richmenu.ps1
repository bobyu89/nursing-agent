# richmenu.ps1 — 一鍵建立班守 LINE 圖文選單（Rich Menu）
#
# 做四件事：
#   1. 用 Windows 內建 GDI+ 畫出 2500×1686 的「六格＋底部使用說明列」選單圖（不需安裝任何軟體）
#   2. 呼叫 LINE Rich Menu API 建立選單物件（七個動作：儀表板／換班／調度／負荷／通報範例／開啟平台／使用說明）
#   3. 上傳選單圖
#   4. 設為所有使用者的預設選單，並清掉本腳本先前建立的舊版（安全換版：先上新、再刪舊）
#
# 用法（Windows PowerShell 5.1 可直接跑）：
#   powershell -ExecutionPolicy Bypass -File richmenu.ps1
#   → 會提示貼上 Channel access token（LINE Developers → Messaging API → Channel access token）
#   或先設環境變數再跑：$env:LINE_CHANNEL_ACCESS_TOKEN = '...'
#
#   只想預覽圖片不動 LINE：powershell -ExecutionPolicy Bypass -File richmenu.ps1 -ImageOnly
#
# 設計語彙與平台儀表板一致（淺色 SaaS、靛藍 #4060EF）。
# 原理：圖文選單只是「代替使用者送出文字／開連結」——按格子＝輸入指令，
# Worker 的指令路由接手，所以本腳本可隨時重跑換版，Worker 程式完全不用動。

param(
  [string]$Token = $env:LINE_CHANNEL_ACCESS_TOKEN,
  [switch]$ImageOnly
)

$ErrorActionPreference = 'Stop'
$PLATFORM_URL = 'https://bobyu89.github.io/nursing-agent/'
$LIFF_ID = '2011209447-AlMMDUMl'   # 與 wrangler.toml 同步；留空字串則「開啟平台」退回一般網址
$MENU_NAME = 'shiftguard-menu'
$IMG_PATH = Join-Path $PSScriptRoot 'richmenu.png'

# ── 1. 畫選單圖（2500×1686，3 欄 × 2 列）────────────────────────
Add-Type -AssemblyName System.Drawing

$W = 2500; $H = 1686
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'

# 平台同款色票
$cBg     = [System.Drawing.ColorTranslator]::FromHtml('#F3F5FA')
$cCard   = [System.Drawing.ColorTranslator]::FromHtml('#FFFFFF')
$cLine   = [System.Drawing.ColorTranslator]::FromHtml('#E4E9F1')
$cInk    = [System.Drawing.ColorTranslator]::FromHtml('#16233A')
$cFaint  = [System.Drawing.ColorTranslator]::FromHtml('#5C6B85')
$cBrand  = [System.Drawing.ColorTranslator]::FromHtml('#4060EF')
$cTint   = [System.Drawing.ColorTranslator]::FromHtml('#EDF1FE')

$g.Clear($cBg)

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

# 六格內容（順序＝畫面位置：上排左中右、下排左中右）
$cells = @(
  @{ title = '戰情儀表板'; sub = '本週缺口與需要行動'; icon = 'chart' },
  @{ title = '換班預檢';   sub = '互換後 H1–H10 重算'; icon = 'swap'  },
  @{ title = '調度棋盤';   sub = '守恆律借調建議';     icon = 'board' },
  @{ title = '負荷雷達';   sub = '誰一直在扛，看得見'; icon = 'gauge' },
  @{ title = '通報缺班';   sub = '一鍵帶入請假範例';   icon = 'chat'  },
  @{ title = '開啟平台';   sub = '守守帶路・完整功能'; icon = 'mascot' }
)

$margin = 40.0; $gap = 40.0
$stripH = 150.0                                       # 底部「使用說明」細長列
$cw = ($W - 2 * $margin - 2 * $gap) / 3               # 780
$ch = ($H - 2 * $margin - 2 * $gap - $stripH) / 2     # 688（讓出說明列空間）

# 字級以手機實際顯示為準：2500px 寬的圖縮到聊天室約 370px 寬，縮比 ~6.8 倍——
# 標題 96px ≈ 螢幕 14px、副標 46px ≈ 螢幕 7px，再小就看不清了
$fTitle = New-Object System.Drawing.Font('Microsoft JhengHei', 96, [System.Drawing.FontStyle]::Bold, 'Pixel')
$fSub   = New-Object System.Drawing.Font('Microsoft JhengHei', 46, [System.Drawing.FontStyle]::Regular, 'Pixel')
$bCard  = New-Object System.Drawing.SolidBrush($cCard)
$bInk   = New-Object System.Drawing.SolidBrush($cInk)
$bFaint = New-Object System.Drawing.SolidBrush($cFaint)
$bBrand = New-Object System.Drawing.SolidBrush($cBrand)
$bTint  = New-Object System.Drawing.SolidBrush($cTint)
$penLine  = New-Object System.Drawing.Pen($cLine, 4)
$penBrand = New-Object System.Drawing.Pen($cBrand, 14)
$penBrand.StartCap = 'Round'; $penBrand.EndCap = 'Round'

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
    'mascot' { # 班守 IP「守守」（北極熊）本尊坐鎮「開啟平台」格
      Draw-Mascot $cx $cy 3.4
    }
  }
}

for ($i = 0; $i -lt 6; $i++) {
  $col = $i % 3; $row = [math]::Floor($i / 3)
  $x = $margin + $col * ($cw + $gap)
  $y = $margin + $row * ($ch + $gap)

  $path = New-RoundedPath $x $y $cw $ch 36
  $g.FillPath($bCard, $path)
  $g.DrawPath($penLine, $path)

  # 左上：靛藍淡底圖示章
  $badge = New-RoundedPath ($x + 56) ($y + 56) 210 210 42
  $g.FillPath($bTint, $badge)
  Draw-Icon $cells[$i].icon ($x + 56 + 105) ($y + 56 + 105)

  # 下方：標題與副標（字級放大後同步下修起點，維持底部留白）
  $g.DrawString($cells[$i].title, $fTitle, $bInk,   ($x + 44), ($y + $ch - 320))
  $g.DrawString($cells[$i].sub,   $fSub,   $bFaint, ($x + 52), ($y + $ch - 140))
}

# ── 底部「使用說明」細長列：整條可點，送出「使用說明」指令 ─────────
$stripY = $margin + 2 * ($ch + $gap)          # 1496
$strip = New-RoundedPath $margin $stripY ($W - 2 * $margin) $stripH 36
$g.FillPath($bTint, $strip)
$penTint = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#C9D6F6'), 3)
$g.DrawPath($penTint, $strip)

$fStrip = New-Object System.Drawing.Font('Microsoft JhengHei', 50, [System.Drawing.FontStyle]::Bold, 'Pixel')
$stripText = '使用說明　—　第一次用？點這裡看指令怎麼打'
$sz = $g.MeasureString($stripText, $fStrip)
$badgeR = 45.0
$totalW = $badgeR * 2 + 28 + $sz.Width
$startX = ($W - $totalW) / 2
$badgeY = $stripY + ($stripH - $badgeR * 2) / 2
$g.FillEllipse($bBrand, $startX, $badgeY, ($badgeR * 2), ($badgeR * 2))
$fQ = New-Object System.Drawing.Font('Microsoft JhengHei', 44, [System.Drawing.FontStyle]::Bold, 'Pixel')
$sfC = New-Object System.Drawing.StringFormat
$sfC.Alignment = 'Center'; $sfC.LineAlignment = 'Center'
$qRect = New-Object System.Drawing.RectangleF($startX, $badgeY, ($badgeR * 2), ($badgeR * 2))
$g.DrawString('?', $fQ, (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)), $qRect, $sfC)
$bBrandTxt = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#3350DD'))
$g.DrawString($stripText, $fStrip, $bBrandTxt, ($startX + $badgeR * 2 + 28), ($stripY + ($stripH - $sz.Height) / 2))

$g.Dispose()
$bmp.Save($IMG_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$size = [math]::Round((Get-Item $IMG_PATH).Length / 1KB)
Write-Host "✓ 選單圖已產生：$IMG_PATH（${size} KB，2500×1686）"

if ($ImageOnly) { Write-Host '（-ImageOnly：不呼叫 LINE API，先開圖檔確認樣式）'; exit 0 }

# ── 2. 取得 token ────────────────────────────────────────────────
if (-not $Token) {
  $sec = Read-Host '貼上 LINE Channel access token（LINE Developers → Messaging API）' -AsSecureString
  $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
if (-not $Token) { throw '沒有 token，中止。' }
$headers = @{ Authorization = "Bearer $Token" }

# ── 3. 建立 Rich Menu 物件（六格動作，座標與圖對齊）──────────────
$sample = '護理長不好意思，我明天白班發燒沒辦法上，很抱歉'
$menu = @{
  size = @{ width = 2500; height = 1686 }
  selected = $true
  name = "$MENU_NAME-$(Get-Date -Format yyyyMMdd-HHmm)"
  chatBarText = '功能選單'
  areas = @(
    # 上下兩排六格（各分到相鄰間隙的一半），最底 1476–1686 整條是「使用說明」列
    @{ bounds = @{ x = 0;    y = 0;    width = 833; height = 748 }; action = @{ type = 'message'; text = '儀表板' } },
    @{ bounds = @{ x = 833;  y = 0;    width = 833; height = 748 }; action = @{ type = 'message'; text = '換班' } },
    @{ bounds = @{ x = 1666; y = 0;    width = 834; height = 748 }; action = @{ type = 'message'; text = '調度' } },
    @{ bounds = @{ x = 0;    y = 748;  width = 833; height = 728 }; action = @{ type = 'message'; text = '負荷' } },
    @{ bounds = @{ x = 833;  y = 748;  width = 833; height = 728 }; action = @{ type = 'message'; text = $sample } },
    @{ bounds = @{ x = 1666; y = 748;  width = 834; height = 728 }; action = @{ type = 'uri'; uri = $(
      # 設了 LIFF 就走 liff.line.me（LINE 內全高視窗，與 bot 按鈕一致）；否則退回一般網址
      if ($LIFF_ID) { "https://liff.line.me/$LIFF_ID" } else { $PLATFORM_URL }) } },
    @{ bounds = @{ x = 0;    y = 1476; width = 2500; height = 210 }; action = @{ type = 'message'; text = '使用說明' } }
  )
}
$json = $menu | ConvertTo-Json -Depth 8
$body = [System.Text.Encoding]::UTF8.GetBytes($json)   # PS5.1：中文一定要自己轉 UTF-8

$old = (Invoke-RestMethod -Uri 'https://api.line.me/v2/bot/richmenu/list' -Headers $headers).richmenus |
  Where-Object { $_.name -like "$MENU_NAME*" }

$created = Invoke-RestMethod -Uri 'https://api.line.me/v2/bot/richmenu' -Method Post -Headers $headers `
  -ContentType 'application/json; charset=utf-8' -Body $body
$id = $created.richMenuId
Write-Host "✓ Rich Menu 已建立：$id"

# ── 4. 上傳圖片 → 設為預設 → 刪舊版 ─────────────────────────────
Invoke-RestMethod -Uri "https://api-data.line.me/v2/bot/richmenu/$id/content" -Method Post `
  -Headers $headers -ContentType 'image/png' -InFile $IMG_PATH | Out-Null
Write-Host '✓ 選單圖已上傳'

Invoke-RestMethod -Uri "https://api.line.me/v2/bot/user/all/richmenu/$id" -Method Post -Headers $headers | Out-Null
Write-Host '✓ 已設為所有使用者的預設選單'

foreach ($m in $old) {
  Invoke-RestMethod -Uri "https://api.line.me/v2/bot/richmenu/$($m.richMenuId)" -Method Delete -Headers $headers | Out-Null
  Write-Host "✓ 已清除舊版選單：$($m.name)"
}

Write-Host ''
Write-Host '完成！打開與機器人的聊天室（已開啟的畫面請關掉重進），下方就會出現六格選單。'
