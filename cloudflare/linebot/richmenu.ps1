# richmenu.ps1 — 一鍵建立班守 LINE 圖文選單（Rich Menu）
#
# 做四件事：
#   1. 用 Windows 內建 GDI+ 畫出 2500×1686 的六格選單圖（不需安裝任何軟體）
#   2. 呼叫 LINE Rich Menu API 建立選單物件（六格動作：儀表板／換班／調度／負荷／通報範例／開啟平台）
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
  @{ title = '開啟平台';   sub = '守守帶路：完整功能與留痕'; icon = 'penguin' }
)

$margin = 40.0; $gap = 40.0
$cw = ($W - 2 * $margin - 2 * $gap) / 3   # 780
$ch = ($H - 2 * $margin - $gap) / 2       # 783

$fTitle = New-Object System.Drawing.Font('Microsoft JhengHei', 68, [System.Drawing.FontStyle]::Bold, 'Pixel')
$fSub   = New-Object System.Drawing.Font('Microsoft JhengHei', 34, [System.Drawing.FontStyle]::Regular, 'Pixel')
$bCard  = New-Object System.Drawing.SolidBrush($cCard)
$bInk   = New-Object System.Drawing.SolidBrush($cInk)
$bFaint = New-Object System.Drawing.SolidBrush($cFaint)
$bBrand = New-Object System.Drawing.SolidBrush($cBrand)
$bTint  = New-Object System.Drawing.SolidBrush($cTint)
$penLine  = New-Object System.Drawing.Pen($cLine, 4)
$penBrand = New-Object System.Drawing.Pen($cBrand, 14)
$penBrand.StartCap = 'Round'; $penBrand.EndCap = 'Round'

function Draw-Penguin([float]$cx, [float]$cy, [float]$s) {
  # 班守 IP「守守」（輪班企鵝）：與 assets/logo.svg 同一份幾何，SVG 貝茲手工轉 GDI+
  # (cx,cy)＝企鵝視覺中心（單位座標 32,34 的落點）；s＝縮放（1 單位 → s px）
  # 唯一的 Q（二次貝茲）已轉三次：C1=P0+2/3(Q-P0)、C2=P2+2/3(Q-P2)
  $ox = $cx - 32 * $s; $oy = $cy - 34 * $s
  $bWing   = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#3350DD'))
  $bBelly  = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#FFF6EA'))
  $bAmber  = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#F2A93B'))
  $bCheek  = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#EE94A5'))
  $bShadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(28, 22, 35, 58))

  # 地面陰影與腳先畫，身體壓在上面（腳掌自然只露出前緣）
  $g.FillEllipse($bShadow, ($ox + 18 * $s),   ($oy + 57 * $s),   (28 * $s),  (4.8 * $s))
  $g.FillEllipse($bAmber,  ($ox + 21.5 * $s), ($oy + 55.7 * $s), (8 * $s),   (4.6 * $s))
  $g.FillEllipse($bAmber,  ($ox + 34.5 * $s), ($oy + 55.7 * $s), (8 * $s),   (4.6 * $s))

  # 身體（蛋形，垂直漸層 #5B78F5 → #4060EF）
  $body = New-Object System.Drawing.Drawing2D.GraphicsPath
  $body.AddBezier(($ox+32*$s),($oy+7.5*$s),  ($ox+44.5*$s),($oy+7.5*$s),  ($ox+50.5*$s),($oy+18.5*$s), ($ox+50.5*$s),($oy+33.5*$s))
  $body.AddBezier(($ox+50.5*$s),($oy+33.5*$s),($ox+50.5*$s),($oy+48.5*$s),($ox+43.5*$s),($oy+57.5*$s), ($ox+32*$s),($oy+57.5*$s))
  $body.AddBezier(($ox+32*$s),($oy+57.5*$s), ($ox+20.5*$s),($oy+57.5*$s), ($ox+13.5*$s),($oy+48.5*$s), ($ox+13.5*$s),($oy+33.5*$s))
  $body.AddBezier(($ox+13.5*$s),($oy+33.5*$s),($ox+13.5*$s),($oy+18.5*$s),($ox+19.5*$s),($oy+7.5*$s),  ($ox+32*$s),($oy+7.5*$s))
  $body.CloseFigure()
  $bodyRect = New-Object System.Drawing.RectangleF(($ox + 13.5 * $s), ($oy + 7.5 * $s), (37 * $s), (50 * $s))
  $bBody = New-Object System.Drawing.Drawing2D.LinearGradientBrush($bodyRect,
    [System.Drawing.ColorTranslator]::FromHtml('#5B78F5'),
    [System.Drawing.ColorTranslator]::FromHtml('#4060EF'),
    [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
  $g.FillPath($bBody, $body)

  # 左右翅膀
  $wl = New-Object System.Drawing.Drawing2D.GraphicsPath
  $wl.AddBezier(($ox+16.6*$s),($oy+29.5*$s), ($ox+13.2*$s),($oy+34.5*$s), ($ox+13.2*$s),($oy+45.5*$s), ($ox+17.2*$s),($oy+50.5*$s))
  $wl.AddBezier(($ox+17.2*$s),($oy+50.5*$s), ($ox+19.6*$s),($oy+46.5*$s), ($ox+20.1*$s),($oy+37.5*$s), ($ox+19.1*$s),($oy+30.5*$s))
  $wl.CloseFigure()
  $g.FillPath($bWing, $wl)
  $wr = New-Object System.Drawing.Drawing2D.GraphicsPath
  $wr.AddBezier(($ox+47.4*$s),($oy+29.5*$s), ($ox+50.8*$s),($oy+34.5*$s), ($ox+50.8*$s),($oy+45.5*$s), ($ox+46.8*$s),($oy+50.5*$s))
  $wr.AddBezier(($ox+46.8*$s),($oy+50.5*$s), ($ox+44.4*$s),($oy+46.5*$s), ($ox+43.9*$s),($oy+37.5*$s), ($ox+44.9*$s),($oy+30.5*$s))
  $wr.CloseFigure()
  $g.FillPath($bWing, $wr)

  # 白肚（盾形，呼應「守」）
  $belly = New-Object System.Drawing.Drawing2D.GraphicsPath
  $belly.AddBezier(($ox+32*$s),($oy+29.5*$s), ($ox+40*$s),($oy+29.5*$s),  ($ox+44*$s),($oy+33.5*$s),   ($ox+44*$s),($oy+39.5*$s))
  $belly.AddBezier(($ox+44*$s),($oy+39.5*$s), ($ox+44*$s),($oy+47.5*$s),  ($ox+39.5*$s),($oy+54*$s),   ($ox+32*$s),($oy+55.2*$s))
  $belly.AddBezier(($ox+32*$s),($oy+55.2*$s), ($ox+24.5*$s),($oy+54*$s),  ($ox+20*$s),($oy+47.5*$s),   ($ox+20*$s),($oy+39.5*$s))
  $belly.AddBezier(($ox+20*$s),($oy+39.5*$s), ($ox+20*$s),($oy+33.5*$s),  ($ox+24*$s),($oy+29.5*$s),   ($ox+32*$s),($oy+29.5*$s))
  $belly.CloseFigure()
  $g.FillPath($bBelly, $belly)

  # 眼睛、高光、腮紅
  $g.FillEllipse($bInk,   ($ox + 23 * $s),   ($oy + 20.5 * $s), (6 * $s),   (6 * $s))
  $g.FillEllipse($bInk,   ($ox + 35 * $s),   ($oy + 20.5 * $s), (6 * $s),   (6 * $s))
  $g.FillEllipse([System.Drawing.Brushes]::White, ($ox + 26 * $s), ($oy + 21.5 * $s), (2 * $s), (2 * $s))
  $g.FillEllipse([System.Drawing.Brushes]::White, ($ox + 38 * $s), ($oy + 21.5 * $s), (2 * $s), (2 * $s))
  $g.FillEllipse($bCheek, ($ox + 18.5 * $s), ($oy + 26.1 * $s), (4.2 * $s), (2.6 * $s))
  $g.FillEllipse($bCheek, ($ox + 41.3 * $s), ($oy + 26.1 * $s), (4.2 * $s), (2.6 * $s))

  # 嘴（琥珀菱形，下緣圓弧）
  $beak = New-Object System.Drawing.Drawing2D.GraphicsPath
  $beak.AddLine(($ox+32*$s),($oy+26.6*$s), ($ox+35.2*$s),($oy+29*$s))
  $beak.AddBezier(($ox+35.2*$s),($oy+29*$s), ($ox+33.07*$s),($oy+31.13*$s), ($ox+30.93*$s),($oy+31.13*$s), ($ox+28.8*$s),($oy+29*$s))
  $beak.CloseFigure()
  $g.FillPath($bAmber, $beak)

  $bWing.Dispose(); $bBelly.Dispose(); $bAmber.Dispose(); $bCheek.Dispose(); $bShadow.Dispose(); $bBody.Dispose()
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
    'penguin' { # 班守 IP「守守」本尊坐鎮「開啟平台」格
      Draw-Penguin $cx $cy 3.4
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

  # 下方：標題與副標
  $g.DrawString($cells[$i].title, $fTitle, $bInk,   ($x + 48), ($y + $ch - 250))
  $g.DrawString($cells[$i].sub,   $fSub,   $bFaint, ($x + 56), ($y + $ch - 120))
}

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
    @{ bounds = @{ x = 0;    y = 0;   width = 833; height = 843 }; action = @{ type = 'message'; text = '儀表板' } },
    @{ bounds = @{ x = 833;  y = 0;   width = 833; height = 843 }; action = @{ type = 'message'; text = '換班' } },
    @{ bounds = @{ x = 1666; y = 0;   width = 834; height = 843 }; action = @{ type = 'message'; text = '調度' } },
    @{ bounds = @{ x = 0;    y = 843; width = 833; height = 843 }; action = @{ type = 'message'; text = '負荷' } },
    @{ bounds = @{ x = 833;  y = 843; width = 833; height = 843 }; action = @{ type = 'message'; text = $sample } },
    @{ bounds = @{ x = 1666; y = 843; width = 834; height = 843 }; action = @{ type = 'uri'; uri = $(
      # 設了 LIFF 就走 liff.line.me（LINE 內全高視窗，與 bot 按鈕一致）；否則退回一般網址
      if ($LIFF_ID) { "https://liff.line.me/$LIFF_ID" } else { $PLATFORM_URL }) } }
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
