<#
  deploy.ps1 — 班守 ShiftGuard 一鍵部署（Windows PowerShell 5.1+）

  部署兩顆 Lambda：
    1. shiftguard-llm-proxy  （aws/lambda   → Bedrock 解析，金鑰只在 IAM 角色）
    2. shiftguard-linebot    （aws/linebot  → LINE Webhook，驗章＋轉發解析）

  前置：aws configure 已完成（有 IAM / Lambda / Bedrock 權限的帳號）。
  冪等：重跑只更新程式碼與設定，不會重複建立資源。

  用法：
    powershell -ExecutionPolicy Bypass -File aws\deploy.ps1            # 預設 us-west-2
    powershell -ExecutionPolicy Bypass -File aws\deploy.ps1 -Region ap-northeast-1
#>
param([string]$Region = 'us-west-2')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path   # aws/ 目錄

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

Step '0. 檢查身分'
$who = aws sts get-caller-identity --output json | ConvertFrom-Json
Write-Host ("帳號 " + $who.Account + "　身分 " + $who.Arn)

# ── IAM 角色（存在即沿用）──────────────────────────────
function Ensure-Role($name, $withBedrock) {
  $arn = $null
  try { $arn = (aws iam get-role --role-name $name --query 'Role.Arn' --output text 2>$null) } catch {}
  if (-not $arn -or $arn -eq 'None') {
    $trust = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
    $trustFile = Join-Path $env:TEMP "$name-trust.json"
    Set-Content -Path $trustFile -Value $trust -Encoding Ascii
    $arn = aws iam create-role --role-name $name --assume-role-policy-document ("file://" + $trustFile) --query 'Role.Arn' --output text
    aws iam attach-role-policy --role-name $name --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole | Out-Null
    if ($withBedrock) {
      $pol = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["bedrock:InvokeModel"],"Resource":"*"}]}'
      $polFile = Join-Path $env:TEMP "$name-bedrock.json"
      Set-Content -Path $polFile -Value $pol -Encoding Ascii
      aws iam put-role-policy --role-name $name --policy-name bedrock-invoke --policy-document ("file://" + $polFile) | Out-Null
    }
    Write-Host "已建立角色 $name（等待 IAM 傳播…）"
    Start-Sleep -Seconds 12
  } else { Write-Host "沿用既有角色 $name" }
  return $arn
}

# ── 建立或更新函式 ─────────────────────────────────────
function Ensure-Function($name, $zipPath, $roleArn, $envJson) {
  $exists = $true
  try { aws lambda get-function --function-name $name --region $Region 2>$null | Out-Null } catch { $exists = $false }
  if (-not $exists) {
    $created = $false
    foreach ($try in 1..6) {   # 新角色可能尚未傳播完成，重試
      try {
        aws lambda create-function --function-name $name --runtime nodejs20.x `
          --handler index.handler --zip-file ("fileb://" + $zipPath) --role $roleArn `
          --timeout 30 --memory-size 256 --region $Region --output text --query 'FunctionArn' | Out-Null
        $created = $true; break
      } catch { Write-Host "等待角色傳播（$try/6）…"; Start-Sleep -Seconds 8 }
    }
    if (-not $created) { throw "建立 $name 失敗——請確認帳號有 lambda:CreateFunction 權限" }
    Write-Host "已建立函式 $name"
  } else {
    aws lambda update-function-code --function-name $name --zip-file ("fileb://" + $zipPath) --region $Region --output text --query 'LastUpdateStatus' | Out-Null
    aws lambda wait function-updated --function-name $name --region $Region
    Write-Host "已更新函式 $name 程式碼"
  }
  if ($envJson) {
    $envFile = Join-Path $env:TEMP "$name-env.json"
    Set-Content -Path $envFile -Value $envJson -Encoding UTF8
    aws lambda wait function-updated --function-name $name --region $Region
    aws lambda update-function-configuration --function-name $name --region $Region --environment ("file://" + $envFile) --output text --query 'LastUpdateStatus' | Out-Null
    aws lambda wait function-updated --function-name $name --region $Region
  }
}

# ── Function URL（存在即沿用）──────────────────────────
function Ensure-Url($name, $cors) {
  $url = $null
  try { $url = (aws lambda get-function-url-config --function-name $name --region $Region --query 'FunctionUrl' --output text 2>$null) } catch {}
  if (-not $url -or $url -eq 'None') {
    if ($cors) {
      $url = aws lambda create-function-url-config --function-name $name --auth-type NONE --region $Region `
        --cors '{"AllowOrigins":["*"],"AllowMethods":["POST"],"AllowHeaders":["content-type","x-demo-token"]}' `
        --query 'FunctionUrl' --output text
    } else {
      $url = aws lambda create-function-url-config --function-name $name --auth-type NONE --region $Region --query 'FunctionUrl' --output text
    }
    try {
      aws lambda add-permission --function-name $name --region $Region --statement-id public-url `
        --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE | Out-Null
    } catch {}
  }
  return $url.Trim()
}

# ══ 1. LLM Proxy ══════════════════════════════════════
Step '1. 打包 LLM Proxy（npm install 相依套件）'
Push-Location (Join-Path $root 'lambda')
npm install --omit=dev --no-audit --no-fund | Out-Null
$proxyZip = Join-Path $env:TEMP 'shiftguard-llm-proxy.zip'
if (Test-Path $proxyZip) { Remove-Item $proxyZip -Force }
Compress-Archive -Path index.mjs, package.json, node_modules -DestinationPath $proxyZip
Pop-Location
Write-Host ("打包完成：" + [math]::Round((Get-Item $proxyZip).Length / 1MB, 1) + " MB")

Step '2. 部署 shiftguard-llm-proxy'
$proxyRole = Ensure-Role 'shiftguard-llm-proxy-role' $true

# DEMO_TOKEN：沿用既有設定，否則產生新亂數
$demoToken = $null
try {
  $envNow = aws lambda get-function-configuration --function-name shiftguard-llm-proxy --region $Region --query 'Environment.Variables.DEMO_TOKEN' --output text 2>$null
  if ($envNow -and $envNow -ne 'None') { $demoToken = $envNow }
} catch {}
if (-not $demoToken) {
  $demoToken = -join ((48..57) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  Write-Host '已產生新的 DEMO_TOKEN'
}
$proxyEnv = '{"Variables":{"DEMO_TOKEN":"' + $demoToken + '","BEDROCK_REGION":"' + $Region + '"}}'
Ensure-Function 'shiftguard-llm-proxy' $proxyZip $proxyRole $proxyEnv
$proxyUrl = Ensure-Url 'shiftguard-llm-proxy' $true

# ══ 2. LINE Bot ═══════════════════════════════════════
Step '3. 打包並部署 shiftguard-linebot'
$botZip = Join-Path $env:TEMP 'shiftguard-linebot.zip'
if (Test-Path $botZip) { Remove-Item $botZip -Force }
Compress-Archive -Path (Join-Path $root 'linebot\index.mjs'), (Join-Path $root 'linebot\package.json') -DestinationPath $botZip
$botRole = Ensure-Role 'shiftguard-linebot-role' $false

# LINE 憑證：沿用既有設定（尚未設定時留空，稍後由使用者以指令補上）
$secretNow = ''; $tokenNow = ''
try {
  $cfg = aws lambda get-function-configuration --function-name shiftguard-linebot --region $Region --output json 2>$null | ConvertFrom-Json
  if ($cfg.Environment.Variables.LINE_CHANNEL_SECRET) { $secretNow = $cfg.Environment.Variables.LINE_CHANNEL_SECRET }
  if ($cfg.Environment.Variables.LINE_CHANNEL_ACCESS_TOKEN) { $tokenNow = $cfg.Environment.Variables.LINE_CHANNEL_ACCESS_TOKEN }
} catch {}
$botEnv = '{"Variables":{"LINE_CHANNEL_SECRET":"' + $secretNow + '","LINE_CHANNEL_ACCESS_TOKEN":"' + $tokenNow + '",' +
  '"LLM_PROXY_URL":"' + $proxyUrl + '","DEMO_TOKEN":"' + $demoToken + '",' +
  '"PLATFORM_URL":"https://bobyu89.github.io/nursing-agent/"}}'
Ensure-Function 'shiftguard-linebot' $botZip $botRole $botEnv
$botUrl = Ensure-Url 'shiftguard-linebot' $false

# ══ 3. 驗證與輸出 ═════════════════════════════════════
Step '4. 冒煙測試 LLM Proxy'
try {
  $resp = Invoke-RestMethod -Method Post -Uri $proxyUrl -TimeoutSec 30 `
    -Headers @{ 'x-demo-token' = $demoToken } -ContentType 'application/json; charset=utf-8' `
    -Body ([System.Text.Encoding]::UTF8.GetBytes('{"task":"parse_gap","payload":{"rawText":"我明天白班沒辦法上","refDate":"2026-08-15"}}'))
  Write-Host ("解析測試 OK：date=" + $resp.extracted.date.value + "　shift=" + $resp.extracted.shift.value) -ForegroundColor Green
} catch {
  Write-Host ("冒煙測試失敗：" + $_.Exception.Message) -ForegroundColor Yellow
  Write-Host '若為 AccessDenied：到 Bedrock 主控台 → Model access → 啟用 Anthropic Claude 模型後重跑本腳本。'
}

Step '完成——接下來的三步（唯一需要人工的部分）'
Write-Host ''
Write-Host ('LLM Proxy URL : ' + $proxyUrl)
Write-Host ('LINE Bot URL  : ' + $botUrl)
Write-Host ('DEMO_TOKEN    : ' + $demoToken)
Write-Host ''
Write-Host '① LINE Developers（developers.line.biz/console）建 Messaging API channel，'
Write-Host '   抄 Channel secret 與 Channel access token（Issue 長效）。'
Write-Host '② 執行（把兩個值換成你抄的）：'
Write-Host ('   aws lambda update-function-configuration --function-name shiftguard-linebot --region ' + $Region) -ForegroundColor Yellow
Write-Host ('     --environment "Variables={LINE_CHANNEL_SECRET=你的secret,LINE_CHANNEL_ACCESS_TOKEN=你的token,LLM_PROXY_URL=' + $proxyUrl + ',DEMO_TOKEN=' + $demoToken + ',PLATFORM_URL=https://bobyu89.github.io/nursing-agent/}"') -ForegroundColor Yellow
Write-Host ('③ 回 LINE console 把 Webhook URL 填 ' + $botUrl + ' → Verify → 開啟 Use webhook。')
Write-Host ''
Write-Host ('前端接真模型：https://bobyu89.github.io/nursing-agent/?llm=' + $proxyUrl + '&llmtoken=' + $demoToken)
