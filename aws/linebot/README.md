# 班守 ShiftGuard — LINE 通報機器人部署指南

> 一句話：**通報入口放在護理人員本來就在用的 LINE，解析與決策留在平台。**
>
> ```
> 護理師 LINE 訊息 → LINE Messaging API → Webhook Lambda（本目錄，驗章）
>   → 既有 LLM Proxy（aws/lambda → Bedrock）解析
>   → 回覆：解析摘要＋缺漏追問＋平台連結（reply 免費，不吃推播額度）
> ```
>
> 機器人只做「解析與轉達」：不建立正式缺班事件、不指派、不代替主管決定——
> 與平台的治理邊界完全一致。

## 0. 前置條件

- 一個 LINE 帳號（免費）。
- AWS 帳號（Lambda 免費額度即足夠）。
- （建議）已依 [aws/README.md](../README.md) 部署 LLM Proxy——沒有它機器人也能運作，
  但只會「確認收到＋原文轉達」，不做解析（退路模式）。

## 1. 建立 LINE Messaging API Channel

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 登入。
2. 建立 **Provider**（名稱例：`ShiftGuard`）。
3. Provider 下建立 **Messaging API channel**
   （Channel name 例：`班守通報機器人`；類別隨意，Demo 用）。
   建立 channel 會同時產生一個 LINE 官方帳號（OA）。
4. 抄下兩個憑證：
   - **Basic settings 分頁 → Channel secret**
   - **Messaging API 分頁 → Channel access token**（按 Issue，長效 token）
5. 到 [LINE Official Account Manager](https://manager.line.biz/) → 該帳號 →
   設定 → 回應設定：
   - **關閉「自動回應訊息」**（否則會跟機器人搶著回）
   - **開啟「Webhook」**

## 2. 部署 Webhook Lambda

1. AWS Console → Lambda → Create function：
   - Runtime：**Node.js 20.x**、架構 arm64（便宜）或 x86 皆可
   - Timeout 調成 **15 秒**（LLM Proxy 冷啟動緩衝）
2. 把本目錄的 `index.mjs` 內容貼進程式碼編輯器（零相依，不需要 npm install），Deploy。
3. Configuration → Environment variables：

   | 變數 | 必填 | 說明 |
   |---|---|---|
   | `LINE_CHANNEL_SECRET` | ✅ | 步驟 1-4 的 Channel secret（驗章用） |
   | `LINE_CHANNEL_ACCESS_TOKEN` | ✅ | 步驟 1-4 的 access token（回覆用） |
   | `LLM_PROXY_URL` | 建議 | 既有 LLM Proxy 的 Function URL；未設定時走退路模式 |
   | `DEMO_TOKEN` | 建議 | 與 LLM Proxy 設定的通行碼相同 |
   | `PLATFORM_URL` | 選 | 回覆訊息附的平台連結，預設 GitHub Pages |

4. Configuration → Function URL → Create：Auth type 選 **NONE**。
   > 公開端點的安全性由 **LINE 簽章驗證**把關：本 Lambda 對每個請求
   > 用 channel secret 重算 HMAC-SHA256 比對 `X-Line-Signature`
   > （timingSafeEqual），非 LINE 簽發的請求一律 403。

## 3. 綁定 Webhook

1. 回 LINE Developers → 該 channel → **Messaging API 分頁**。
2. Webhook URL 填 Lambda 的 **Function URL** → 按 **Verify** → 應顯示 Success。
3. 開啟 **Use webhook**。

## 4. 測試

1. 用手機掃 Messaging API 分頁的 QR code 加機器人好友 → 應收到歡迎訊息。
2. 傳：「護理長不好意思，我明天白班發燒沒辦法上，很抱歉」
3. 預期回覆（已設 LLM_PROXY_URL）：
   - 日期（依「明天」以台灣時區換算）、班別 白班、事由 病假
   - 「訊息未載明、需主管補充」：單位、必要資格
   - 平台連結
4. 未設 LLM_PROXY_URL：回覆「已收到缺班通報（解析服務暫未啟用…）」＋原文＋平台連結。

## 5. 成本與額度

- 本機器人**只用 reply message**（使用者傳訊息才回覆）：回覆免費、
  不消耗 LINE 每月推播（push）額度，免費方案即可跑 Demo。
- Lambda ＋ Function URL 在 AWS 永久免費額度內；Bedrock 用量沿用 LLM Proxy 的成本護欄
  （低 effort、短輸出、單一模型，詳見 [aws/README.md](../README.md)）。

## 6. 資安與個資

- **驗章**：HMAC-SHA256 ＋ `timingSafeEqual`，偽造來源進不來。
- **金鑰**：全部只存在 Lambda 環境變數，程式碼與前端零憑證。
- **個資**：通報訊息會經 Bedrock 解析。Demo 守則（歡迎訊息會提醒）：
  以人員代號通報、訊息不含病人資訊。正式導入需資料處理協議、
  去識別化前處理與保存期限政策（同 docs/ARCHITECTURE.md §11.2）。

## 7. 疑難排解

| 症狀 | 原因與解法 |
|---|---|
| Webhook Verify 失敗 | Function URL 貼錯／Lambda 未部署／`LINE_CHANNEL_SECRET` 填錯（驗章 403 也算失敗）——看 CloudWatch Logs 是否出現 `signature validation failed` |
| 加好友沒有歡迎訊息 | OA Manager 的「加入好友的歡迎訊息」與 webhook 重複——關掉內建歡迎訊息，或接受兩則並存 |
| 傳訊息沒有回覆 | `LINE_CHANNEL_ACCESS_TOKEN` 失效或貼錯 → CloudWatch 看 `LINE reply failed: 401`；重新 Issue token |
| 回覆是退路模式 | `LLM_PROXY_URL`／`DEMO_TOKEN` 未設或錯誤 → CloudWatch 看 `proxy status: 403` 等 |
| 回覆很慢 | LLM Proxy 冷啟動；重試一次即暖。Demo 前先傳一則暖機 |

## 8. Demo Day 演法（30 秒）

手機掃碼 → 現場傳一則臨時請假訊息 → 機器人秒回解析摘要與追問 →
投影幕切到平台畫面 1 貼上同一則訊息接著走替補流程。台詞：

> 通報入口，放在護理師本來就在用的 LINE——零學習成本；
> 解析、合規計算、決策與留痕，全部在平台。機器人不做決定，它只讓通報不再漏接。
