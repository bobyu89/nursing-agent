# 班守 ShiftGuard — LINE 通報機器人部署指南（AWS＋Bedrock 真模型版）

> 💡 **想要零成本、不碰 AWS？** 用 [cloudflare/linebot](../../cloudflare/linebot/README.md)：
> Cloudflare Workers 免費方案＋平台同一份確定性解析器，免信用卡、10 分鐘部署。
> 本版（Bedrock 真模型解析）留作理解力升級選項，兩版可隨時切換（換 Webhook URL 即可）。

> 一句話：**通報入口放在護理人員本來就在用的 LINE，正式決策與留痕留在平台。**
>
> ```
> 護理師 LINE 訊息 → LINE Messaging API → Webhook Lambda（本目錄，驗章）
>   → 解析：既有 LLM Proxy（aws/lambda → Bedrock）優先；未設定或失敗時
>     退回平台同一份確定性解析（src/llm.js），服務不中斷
>   → 缺漏條件用「快速回覆按鈕」逐步點選（班別 → 單位 → 必要資格）
>   → 條件齊全 → src/engine.js 同一份 evaluateGap 引擎
>     （規則 H1–H10，含四週彈性工時 H7–H9 與母性保護 H10）
>   → 回覆：替補建議前三名（分數＋依據＋風險標記）＋詢問草稿＋排除摘要
>     ＋平台連結；輸入「儀表板」回 Flex 戰情卡（reply 免費，不吃推播額度）
> ```
>
> 互動流程與 Cloudflare 版共用同一份 `src/botcore.js`；模型輸出一律經
> `sanitizeParsed` 白名單消毒才進引擎。機器人提供「建議」，不做指派決定——
> 正式確認與決策留痕在平台，與平台的治理邊界完全一致。

## 0. 前置條件

- 一個 LINE 帳號（免費）。
- AWS 帳號（Lambda 免費額度即足夠）。
- （建議）已依 [aws/README.md](../README.md) 部署 LLM Proxy——沒有它機器人也能運作，
  解析自動退回平台同一份確定性關鍵詞規則（理解力較弱，功能不減）。

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

最省事的方式是一鍵腳本（會自動把平台引擎一起打包）：

```bash
powershell -ExecutionPolicy Bypass -File aws/deploy.ps1
```

手動部署時注意：本函式**內嵌平台引擎**，zip 必須含下列結構
（`src/package.json` 內容為 `{"type":"commonjs"}`，缺了它 Node 會把
引擎檔誤判為 ESM）：

```
index.mjs
package.json
src/data.js src/rules.js src/engine.js src/llm.js src/botcore.js
src/package.json
```

1. AWS Console → Lambda → Create function：
   - Runtime：**Node.js 20.x**、架構 arm64（便宜）或 x86 皆可
   - Timeout 調成 **15 秒**（LLM Proxy 冷啟動緩衝）
2. 上傳依上述結構打包的 zip（零外部相依，不需要 npm install），Deploy。
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
3. 預期回覆：解析摘要（日期依「明天」以台灣時區換算、班別 白班、事由 病假）
   ＋「這筆缺班在哪一個照護單位？」快速回覆按鈕 → 點選單位、必要資格
   → 替補建議前三名（分數＋依據）＋詢問草稿按鈕。
4. 輸入「儀表板」→ Flex 戰情卡；「換班 N-01 8/3 N-02 8/5」→ 換班預檢；「調度」→ 守恆律棋盤；「負荷」→ 留任雷達；「選單」→ 功能快速按鈕。
5. 未設 LLM_PROXY_URL：流程完全相同，解析改用本機確定性規則（理解力較弱）。

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
| 解析理解力變弱（複雜句抓不到日期） | `LLM_PROXY_URL`／`DEMO_TOKEN` 未設或錯誤，已退回本機規則 → CloudWatch 看 `proxy status: 403` 等 |
| 部署後傳訊息完全沒反應且 log 有 import 錯誤 | zip 缺 `src/` 引擎檔或缺 `src/package.json`（`{"type":"commonjs"}`）→ 改用 `aws/deploy.ps1` 打包 |
| 回覆很慢 | LLM Proxy 冷啟動；重試一次即暖。Demo 前先傳一則暖機 |

## 8. Demo Day 演法（30 秒）

手機掃碼 → 現場傳一則臨時請假訊息 → 機器人秒回解析摘要與追問 →
投影幕切到平台畫面 1 貼上同一則訊息接著走替補流程。台詞：

> 通報入口，放在護理師本來就在用的 LINE——零學習成本；
> 解析、合規計算、決策與留痕，全部在平台。機器人不做決定，它只讓通報不再漏接。
