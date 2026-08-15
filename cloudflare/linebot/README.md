# 班守 ShiftGuard — LINE 通報機器人（Cloudflare Workers 零成本版）

> **這條路線：零元、免信用卡、不碰 AWS、不呼叫任何 LLM。**
>
> 解析器就是平台的同一份確定性關鍵詞解析器（`src/llm.js`），
> wrangler 打包時直接引入原始檔——「同一份程式碼在瀏覽器、測試頁、CI 上跑」
> 的故事，延伸到第四個環境：LINE bot。
>
> ```
> 護理師 LINE 訊息 → LINE Messaging API → Cloudflare Worker（驗章）
>   → src/llm.js 確定性解析（在 Worker 內執行，訊息不出去）
>   → 回覆：解析摘要＋缺漏追問＋平台連結（reply 免費）
> ```

## 與 aws/linebot 版的差異

| | **本版（Cloudflare）** | aws/linebot 版 |
|---|---|---|
| 解析器 | 平台同一份關鍵詞規則（確定性） | Bedrock 真實模型 |
| 理解力 | 較弱（與平台 mock 模式相同，誠實標示） | 強 |
| 費用 | **0 元**（免費額度 10 萬請求／天） | Lambda 免費＋Bedrock 每次約 NT$0.01 |
| 需要的帳號 | Cloudflare（email 免費註冊） | AWS |
| 個資 | **訊息不離開 Worker**，不經任何第三方模型 | 訊息送 Bedrock 解析 |

兩版的治理邊界相同：只做解析與轉達，不建立正式事件、不指派、不代替主管決定。

## 部署（約 10 分鐘，全程免費）

前置：本機已有 Node.js（本專案開發機已具備）。

### 1. Cloudflare 帳號與登入

- 到 https://dash.cloudflare.com/sign-up 用 email 免費註冊（不需信用卡）。
- 終端機執行（會開瀏覽器要你按一次「Allow」授權）：

```bash
cd cloudflare/linebot; npx wrangler login
```

### 2. 部署 Worker

```bash
cd cloudflare/linebot; npx wrangler deploy
```

輸出會給你正式網址：`https://shiftguard-linebot.<你的子網域>.workers.dev`
（用瀏覽器開它，看到 `shiftguard linebot: alive` 就是活的。）

### 3. 建立 LINE Messaging API channel

1. https://developers.line.biz/console/ → 建立 Provider → 建立 **Messaging API channel**。
2. 抄兩個值：**Basic settings → Channel secret**；**Messaging API → Channel access token**（按 Issue）。
3. https://manager.line.biz/ → 該帳號 → 設定 → 回應設定：**關閉「自動回應訊息」、開啟「Webhook」**。

### 4. 設定機密並綁定 Webhook

把兩個值設成 Worker 機密（指令會提示你貼值，值不會留在任何檔案或指令歷史）：

```bash
cd cloudflare/linebot; npx wrangler secret put LINE_CHANNEL_SECRET
```

```bash
cd cloudflare/linebot; npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
```

回 LINE Developers → Messaging API 分頁 → **Webhook URL** 填步驟 2 的 workers.dev 網址
→ **Verify**（應顯示 Success）→ 開啟 **Use webhook**。

### 5. 測試

用手機掃 Messaging API 分頁的 QR code 加好友（會收到歡迎訊息），傳：

> 護理長不好意思，我明天白班發燒沒辦法上，很抱歉

預期回覆（實測輸出）：

```
【班守 ShiftGuard】已收到缺班通報，解析如下：
・日期：2026-08-16（日）
・班別：白班 07:00–15:00
・事由：病假（依訊息內容「發燒」判定）

訊息未載明、需主管補充：
・這筆缺班是哪一個照護單位？
・當班需要哪些必要資格？

主管請至平台確認條件並評估替補（每一步留痕）：
https://bobyu89.github.io/nursing-agent/
```

「明天」以**台灣時區的今天**為基準換算；訊息沒寫的欄位一律轉為追問、不臆測——
與平台完全相同的行為，因為就是同一份程式碼。

## 資安與個資

- **驗章**：每個請求以 channel secret 驗 `X-Line-Signature`（HMAC-SHA256 ＋
  timingSafeEqual），非 LINE 簽發的請求一律 403。
- **機密**：只存在 Cloudflare 加密機密儲存（`wrangler secret`），不進 git、不進對話。
- **個資**：訊息只在 Worker 內以規則比對處理、即回即棄，不落地、不送任何模型端點。
  歡迎訊息仍提醒：以代號通報、勿含病人資訊。

## 疑難排解

| 症狀 | 解法 |
|---|---|
| Webhook Verify 失敗 | 多半是 `LINE_CHANNEL_SECRET` 還沒 `secret put`（驗章 403）；設定後重按 Verify |
| 傳訊息沒回覆 | `LINE_CHANNEL_ACCESS_TOKEN` 貼錯 → `npx wrangler tail` 看即時 log 找 `LINE reply failed: 401` |
| wrangler login 開不了瀏覽器 | 手動開它印出的網址完成授權 |
| 想看即時 log | `cd cloudflare/linebot; npx wrangler tail` |

## Demo Day 演法（30 秒）

手機掃碼 → 現場傳一則臨時請假訊息 → 機器人秒回解析摘要與追問 →
投影幕切到平台畫面 1 貼上同一則訊息接著走替補流程。台詞：

> 通報入口，放在護理師本來就在用的 LINE——零學習成本、零雲端費用；
> 而且 bot 用的解析器，跟你們現在螢幕上看到的是**同一份程式碼**。
