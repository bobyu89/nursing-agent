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
>   → 缺漏條件用「快速回覆按鈕」逐步點選（班別 → 單位 → 必要資格）
>   → 條件齊全 → src/engine.js 同一份 evaluateGap 引擎排序
>     （規則 H1–H9，含勞基法四週彈性工時 H7–H9，週期錨點與平台一致）
>   → 回覆：替補建議前三名（分數＋依據＋風險標記）＋排除摘要＋平台連結
> ```
>
> 互動全程**無狀態**：已選條件夾帶在按鈕的 postback data 裡，
> 不需要任何資料庫。機器人提供「建議」，不做指派決定——
> 正式確認與決策留痕在平台。
>
> **指令**：輸入「選單」→ 功能快速按鈕（儀表板／通報範例／開啟平台／功能介紹）；
> 輸入「儀表板」（或 戰情／狀態／缺口）→ 回覆 Flex 戰情卡：
> 缺口方程式、殘餘缺口、帶班平衡、單點依賴、證照效期、結構性訊號
> ＋前三項需要行動，附「開啟完整儀表板」按鈕——與平台管理總覽
> 同一份引擎即時計算。

## 與 aws/linebot 版的差異

| | **本版（Cloudflare）** | aws/linebot 版 |
|---|---|---|
| 解析器 | 平台同一份關鍵詞規則（確定性） | Bedrock 真實模型 |
| 理解力 | 較弱（與平台 mock 模式相同，誠實標示） | 強 |
| 費用 | **0 元**（免費額度 10 萬請求／天） | Lambda 免費＋Bedrock 每次約 NT$0.01 |
| 需要的帳號 | Cloudflare（email 免費註冊） | AWS |
| 個資 | **訊息不離開 Worker**，不經任何第三方模型 | 訊息送 Bedrock 解析 |

兩版共用同一份互動核心（`src/botcore.js`）與規則引擎（H1–H9），差別只在解析器；
治理邊界相同：提供建議與草稿、不建立正式事件、不指派、不代替主管決定。

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

### 4½. 底部固定按鈕（圖文選單 Rich Menu，5 分鐘手動設定）

讓聊天室下方常駐一排可點的大按鈕（像一般官方帳號）。在
[manager.line.biz](https://manager.line.biz/) → 該帳號 → 左側 **聊天室相關 → 圖文選單** → **建立**：

1. **顯示設定**：標題 `班守選單`；使用期間選長期；「選單列顯示文字」填 `功能選單`；
   **預設顯示：開啟**。
2. **內容設定**：版型選 **3 格**；點 **建立圖片** 用內建工具做圖——
   每格填上底色與文字即可：`📊 戰情儀表板`／`📝 通報缺班`／`🌐 開啟平台`。
3. **動作**（關鍵）：
   - A 格：類型 **文字** → 內容 `儀表板`
   - B 格：類型 **文字** → 內容 `護理長不好意思，我明天白班發燒沒辦法上，很抱歉`
   - C 格：類型 **連結** → `https://bobyu89.github.io/nursing-agent/`
4. 儲存。聊天室下方立即出現固定按鈕。

原理：圖文選單只是「代替使用者送出文字／開連結」的介面層——按下 A 格等於輸入
「儀表板」，由 Worker 的指令路由接手，**不需要改任何程式**。沒空做圖的話，
輸入「選單」也能隨時叫出同功能的快速按鈕（本 Worker 內建）。

## 5. 測試

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

### 濫用防護（偵測 → 應對 → 告警）

| 機制 | 設定 | 行為 |
|---|---|---|
| 使用者白名單 | `npx wrangler secret put ALLOWED_USERS`（逗號分隔 userId） | 名單外只收到「請提供識別碼給管理者開通」，拿不到任何功能與人事資訊；未設定＝開放模式（每個新使用者記入 `[SEC]` 日誌） |
| 頻率限制 | 內建（10 則/分/人） | 超限警告一次、之後靜默丟棄；Workers isolate 回收會重置計數（盡力而為，正式導入改 Durable Objects／WAF） |
| 管理者告警 | `npx wrangler secret put ADMIN_USER_ID` | 名單外嘗試、頻率超限 → 推播通知管理者（同一使用者只告警一次） |
| 監看台 | `npx wrangler tail --search "[SEC]"` | 即時看 blocked-user／rate-limited／bad-signature／user-active |

事件應對流程（含金鑰輪換、一鍵斷線、封鎖名單）見 [docs/SECURITY.md](../../docs/SECURITY.md)。

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
