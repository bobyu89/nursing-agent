# 接上真實模型：AWS Lambda + Amazon Bedrock 部署指南

> 目標：讓平台右上角的「api 模式」真正接上 Claude（Amazon Bedrock），
> 現場演示「真模型解析 → 斷網自動退回 mock」。
> 對應架構：前端 → Lambda Function URL（LLM Proxy）→ Amazon Bedrock。
> 金鑰永不落地前端——Bedrock 權限來自 Lambda 的 IAM Role。

## 架構與費用概觀

```
瀏覽器（GitHub Pages / 本機）
   │  POST { task, payload }        ←─ 前端 15 秒逾時，任何失敗自動退回 mock
   ▼
Lambda Function URL（CORS 限定來源；可選 x-demo-token 通行碼）
   ▼
aws/lambda/index.mjs（本目錄）
   │  結構化輸出（json_schema）＋ 低 effort（現場演示求快）
   ▼
Amazon Bedrock（anthropic.claude-sonnet-5）
```

費用量級：每次解析約 1–2K tokens。以 Sonnet 5 計價，整場 Demo 跑幾十次
呼叫的費用大約是幾美分等級。仍建議做好第 6 節的成本護欄。

---

## 1. 前置條件

1. AWS 帳號（實戰營提供的額度即可）。
2. **開通 Bedrock 模型存取權**：AWS Console → Amazon Bedrock →
   左側「Model access」→ 勾選 Anthropic Claude 模型 → 送出（通常數分鐘內生效）。
   記下開通的**區域**（建議 us-west-2 / 奧勒岡）。
3. 本機有 Node.js（打包依賴用）。

## 2. 打包 Lambda 程式

```bash
cd aws/lambda
npm install
```

打包成 zip（Windows PowerShell）：

```bash
Compress-Archive -Path aws/lambda/* -DestinationPath function.zip -Force
```

（macOS/Linux：`cd aws/lambda && zip -r ../function.zip .`）

## 3. 建立 Lambda 函式

AWS Console → Lambda → Create function：

| 設定 | 值 |
|---|---|
| Function name | `shiftguard-llm-proxy` |
| Runtime | Node.js 22.x |
| Architecture | arm64（便宜一點）或 x86_64 |

建立後：

1. **Code** → Upload from → .zip file → 上傳 `function.zip`。
2. **Configuration → General configuration**：Timeout 改為 **30 秒**、Memory 256 MB。
3. **Configuration → Environment variables**（皆可選）：
   | 變數 | 說明 |
   |---|---|
   | `MODEL_ID` | 預設 `anthropic.claude-sonnet-5`；想省成本可改 `anthropic.claude-haiku-4-5` |
   | `BEDROCK_REGION` | 模型開通區域與 Lambda 部署區域不同時才需要（例 `us-west-2`） |
   | `DEMO_TOKEN` | 設定後請求必須帶通行碼（見第 5 節），建議設一個隨機字串 |

## 4. IAM 權限與 Function URL

**IAM（讓 Lambda 能呼叫 Bedrock）**：

Configuration → Permissions → 點 Role name 進入 IAM →
Add permissions → Attach policies → 勾選 **`AmazonBedrockFullAccess`** → Add。

> Demo 用寬鬆授權求快；正式導入應縮限為僅 `bedrock:InvokeModel`
> 並限定特定模型資源（見 docs/ARCHITECTURE.md 第 11 節）。

**Function URL（讓前端打得到）**：

Configuration → Function URL → Create function URL：

| 設定 | 值 |
|---|---|
| Auth type | `NONE`（demo 用；正式導入改 API Gateway + Cognito） |
| **CORS** | 勾選 Configure CORS |
| Allow origins | `https://bobyu89.github.io` 與 `http://localhost:8777` |
| Allow methods | `POST` |
| Allow headers | `content-type, x-demo-token` |
| Max age | `3600` |

建立後得到形如 `https://xxxxx.lambda-url.us-west-2.on.aws/` 的網址——這就是前端的 endpoint。

## 5. 接上前端

前端已內建 URL 參數切換（只接受 `*.on.aws` 網域與本機，防止惡意連結
把通報訊息導去第三方端點）。開啟：

```
https://bobyu89.github.io/nursing-agent/?llm=<你的 Function URL>
```

有設 `DEMO_TOKEN` 時：

```
https://bobyu89.github.io/nursing-agent/?llm=<Function URL>&llmtoken=<通行碼>
```

右上角徽章會顯示「LLM 模式：即時推論」。任何一次呼叫失敗（斷網、額度、
權限）都會**自動退回 mock 並在畫面標示**，演示不中斷——這正是可以講給
評審聽的設計：demo 保險不是備案，是架構的一部分。

先用 curl 驗證（PowerShell 用 `curl.exe`）：

```bash
curl -X POST "<你的 Function URL>" -H "Content-Type: application/json" -H "x-demo-token: <通行碼>" -d "{\"task\":\"parse_gap\",\"payload\":{\"rawText\":\"護理長，我明天的白班沒辦法上了，發燒到38.5\",\"refDate\":\"2026-08-08\"}}"
```

預期回傳 `{"extracted":{...},"missing":[...]}`，date 應為 `2026-08-09`。

## 6. 成本與安全護欄（上場前務必做）

1. **Reserved concurrency 設為 2**（Configuration → Concurrency）：
   就算被掃到狂打，同時最多 2 個執行——這是最有效的一道成本上限。
2. **設 `DEMO_TOKEN`**：Function URL 是公開網址，通行碼能擋掉路過掃描。
   注意它會出現在前端網址中，屬於「防路人不防駭客」的等級——所以還要有第 1、3 道。
3. **Billing Alarm**：CloudWatch → Billing → 設 5 美元警報。
4. **Demo 結束後刪除 Function URL**（或整個函式）。程式碼在 repo 裡，隨時可重建。

## 7. 疑難排解

| 症狀 | 原因與解法 |
|---|---|
| 前端一直是 mock，徽章顯示「api 失敗，已自動退回」 | 開瀏覽器 DevTools → Network 看該請求：CORS 錯誤→檢查第 4 節的 Allow origins 是否完全一致（含 https、無斜線結尾）；403→token 不符；502/500→看下一列 |
| curl 回 500 | CloudWatch Logs 看錯誤：`AccessDeniedException`→IAM 沒掛好或模型未開通；`model not found`→`MODEL_ID` 或 `BEDROCK_REGION` 不對 |
| 回應很慢（>10 秒）導致前端逾時退回 mock | 確認 Lambda Timeout ≥30 秒；`MODEL_ID` 換 `anthropic.claude-haiku-4-5` 更快 |
| 解析結果欄位怪異 | 前端 `sanitizeParsed` 會把不合法值降級為追問（畫面不會壞）；要調整解析行為，改 `index.mjs` 的 parse_gap system prompt |

## 8. 正式導入的差距（簡報可講）

本部署是 demo 級：Function URL + 通行碼。正式導入依 docs/ARCHITECTURE.md：
API Gateway（限流、WAF）+ Cognito（認證）+ IAM 最小權限 + 通報訊息
去識別化前處理與資料處理協議（訊息含病情描述，屬個資）。
