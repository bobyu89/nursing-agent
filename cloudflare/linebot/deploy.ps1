# deploy.ps1 — 班守 LINE bot Worker 一鍵部署（繞開中文路徑地雷）
#
# 為什麼需要這支：wrangler 的 esbuild 打包步驟在含 CJK 字元的路徑
# （本專案位於「AI職涯營」資料夾）會直接以 exit 9／127 失敗，連錯誤訊息都不給；
# `wrangler whoami` 等純 API 指令不受影響，所以很難察覺。
# 解法：把 worker 需要的檔案複製到 %TEMP% 的純 ASCII 暫存路徑再部署。
#
# 用法（第一次需先 npx wrangler login）：
#   powershell -ExecutionPolicy Bypass -File deploy.ps1
#
# 機密（LINE_CHANNEL_SECRET／ACCESS_TOKEN）綁在 Cloudflare 上的 Worker 服務本體，
# 不隨部署路徑改變——換路徑重佈不會弄丟。

$ErrorActionPreference = 'Stop'
$stage = Join-Path $env:TEMP 'shiftguard-deploy'
$root  = Resolve-Path (Join-Path $PSScriptRoot '..\..')

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force (Join-Path $stage 'cloudflare\linebot') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $stage 'src') | Out-Null

Copy-Item (Join-Path $root 'src\*.js') (Join-Path $stage 'src')
Copy-Item (Join-Path $PSScriptRoot 'worker.mjs')    (Join-Path $stage 'cloudflare\linebot')
Copy-Item (Join-Path $PSScriptRoot 'store-d1.mjs')  (Join-Path $stage 'cloudflare\linebot')   # Stage 1：D1 store
Copy-Item (Join-Path $PSScriptRoot 'schema.sql')    (Join-Path $stage 'cloudflare\linebot')   # Stage 1：schema（供 -Schema 用）
Copy-Item (Join-Path $PSScriptRoot 'wrangler.toml') (Join-Path $stage 'cloudflare\linebot')

Set-Location (Join-Path $stage 'cloudflare\linebot')
Write-Host "→ 從 ASCII 暫存路徑部署：$stage"

# Stage 1：帶 -Schema 參數時先套 schema（IF NOT EXISTS，重跑安全），再部署
#   powershell -ExecutionPolicy Bypass -File deploy.ps1 -Schema
if ($args -contains '-Schema') {
  Write-Host "→ 套用 D1 schema（shiftguard）"
  npx wrangler d1 execute shiftguard --remote --file=schema.sql
}
npx wrangler deploy
