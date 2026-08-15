# 資安事件應對手冊（Incident Response Runbook）

> 這本手冊回答一個問題：**「有人亂搞的時候，我要怎麼辦？」**
> 每個情境都是同一個節奏：**偵測訊號 → 立即處置 → 復原 → 事後**。
> 防護設計的原理見 [ARCHITECTURE.md §11](ARCHITECTURE.md)；本文件只講操作。

## 0. 防線總覽（現在就在運作的）

| 入口 | 防線 | 偵測點 |
|---|---|---|
| LINE Bot（公網） | 簽章驗證（非 LINE 來源一律 403） | `[SEC] bad-signature` 日誌 |
| LINE Bot | 使用者白名單（名單外拿不到任何人事資訊） | `[SEC] blocked-user` ＋ 管理者推播告警 |
| LINE Bot | 頻率限制（每人 10 則/分，超限警告一次後靜默） | `[SEC] rate-limited` ＋ 管理者推播告警 |
| 平台（GitHub Pages） | CSP、輸出跳脫、日期嚴格驗證、端點白名單 | 瀏覽器主控台 |
| 平台 localStorage | 載回白名單驗證＋夾限，**剔除／夾限筆數寫入決策留痕** | 留痕出現「⚠ 安全警示」 |
| 決策留痕 | 雜湊鏈結（改任一筆即斷鏈） | 匯出檔 `chainValid: false` |

**監看台**（平時或懷疑有事時開著）：

```bash
cd "C:\Users\bobyu\Desktop\AI職涯營\nursing-agent\cloudflare\linebot"; npx wrangler tail --search "[SEC]"
```

## 1. 情境手冊

### S1｜陌生人在用機器人

- **偵測**：開放模式下 `[SEC] user-active ...(open-mode)` 出現陌生 userId；或有人回報「掃了 QR 就能用」。
- **立即處置**：切換白名單模式——收集自己人的 userId（請每個人傳一句話給機器人，tail 裡撈 `user-active`；或設白名單後被擋的人會收到自己的識別碼），然後：

  ```bash
  cd "C:\Users\bobyu\Desktop\AI職涯營\nursing-agent\cloudflare\linebot"; npx wrangler secret put ALLOWED_USERS
  ```

  貼上逗號分隔的 userId 清單（例：`U1234...,U5678...`）。即刻生效，名單外只會看到「請提供識別碼給管理者開通」。
- **復原**：無資料外洩疑慮（示範資料全虛構）；正式導入時視同資訊揭露事件通報。
- **事後**：Demo Day 前一天就先開白名單；QR code 不放公開簡報檔。

### S2｜訊息洪水／有人想灌爆額度

- **偵測**：`[SEC] rate-limited` 連續出現；管理者收到推播「觸發頻率限制」；Cloudflare 儀表板請求數異常。
- **立即處置**：頻率限制已自動生效（超限靜默丟棄，不回覆＝不消耗回覆資源）。若持續大量：
  1. 把攻擊者移出白名單（或封鎖該 LINE 帳號：OA 管理後台 → 聊天 → 封鎖）。
  2. 極端情況一鍵斷線：LINE Developers → Messaging API → **關閉 Use webhook**（機器人下線，平台不受影響）。
- **復原**：風頭過後重開 webhook；檢查 Cloudflare 用量（免費額度 10 萬請求/日，等閒灌不爆）。
- **事後**：正式導入把記憶體頻率限制升級為 Durable Objects／Cloudflare WAF rate rules（isolate 回收會重置計數，現況為盡力而為）。

### S3｜偽造 Webhook 請求（假冒 LINE 打端點）

- **偵測**：`[SEC] bad-signature ip=...`。
- **立即處置**：**不用做任何事**——驗章已把它擋在 403，這是防線在工作的證據，不是事件。
- **升級條件**：同一 IP 高頻出現（企圖 DoS）→ Cloudflare 儀表板 → Security → WAF → 建 IP 封鎖規則（免費方案可用）。
- **事後**：記錄 IP 與時間即可。

### S4｜金鑰洩漏（channel secret／access token／demo token）

- **偵測**：機器人出現不是你操作的行為；或金鑰曾出現在截圖、聊天紀錄、commit。
- **立即處置**（順序重要，全程約 3 分鐘）：
  1. LINE Developers → Messaging API → Channel access token → **Reissue**（舊 token 立即失效）
  2. `npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN` 貼新值
  3. 若 secret 洩漏：Basic settings → Channel secret → 重新發行 → `npx wrangler secret put LINE_CHANNEL_SECRET`
  4. 平台 demo token（若已部署 AWS 版）：改 Lambda 環境變數 `DEMO_TOKEN`
- **復原**：傳測試訊息確認機器人正常。
- **事後**：檢查 git 歷史有無金鑰（本專案設計上金鑰不落地任何檔案；`.wrangler/` 已在 .gitignore）。

### S5｜平台資料被改（localStorage 竄改）

- **偵測**：開啟平台時，決策留痕出現
  **「⚠ 安全警示：規則載入異常（N 項超出合法範圍已夾限）」**或
  **「⚠ 安全警示：班表載入異常（N 筆不合法班次已剔除）」**。
- **立即處置**：防線已自動把不合法值夾限／剔除（法定下限不會被無聲關掉）。
  檢視規則庫與班表是否符合預期；不確定就按**「還原預設規則」＋「還原示範班表」**，一分鐘回到出廠。
- **事後**：localStorage 本來就是使用者可改的儲存——防護目標是「改了會被看見、不會生效出危險值」，此目標已達成。正式導入時資料在後端，此面消失。

### S6｜決策留痕斷鏈（有人改留痕）

- **偵測**：匯出 JSON 的 `chainValid: false`。
- **立即處置**：把匯出檔完整保存（斷鏈位置本身就是證據——斷點之後的紀錄都不可信）。
- **事後**：demo 版留痕在記憶體、重整即重置，斷鏈只可能發生在「匯出前被 console 竄改」的示範情境——這正是拿來演示防竄改的腳本。正式導入：後端 append-only ＋ SHA-256 ＋ 定期錨定（ARCHITECTURE §11.2）。

### S7｜帳號層被搞（GitHub／Cloudflare／LINE 帳號）

- **偵測**：GitHub 出現非本人 commit／force push；Cloudflare 出現陌生部署（`npx wrangler deployments list`）；LINE OA 設定被改。
- **立即處置**：改密碼＋開兩步驟驗證（三個平台都開）；Cloudflare 撤銷可疑 API token；GitHub 檢查 repo 的 Deploy keys 與 Actions secrets。
- **復原**：`git log` 比對最後已知良好 commit；必要時 `git revert`（不用 force push 覆蓋歷史，保留證據）。
- **事後**：兩步驟驗證是這一整類事件的疫苗，現在就開。

## 2. 監看指令速查

| 要看什麼 | 指令 |
|---|---|
| 即時安全事件 | `npx wrangler tail --search "[SEC]"`（在 cloudflare/linebot 下執行） |
| 全部即時日誌 | `npx wrangler tail` |
| 部署歷史（有沒有陌生部署） | `npx wrangler deployments list` |
| 機器人活著嗎 | 瀏覽器開 workers.dev 網址，見 `alive` |
| 平台被改過嗎 | 開平台 → 公平性與留痕頁 → 找「⚠ 安全警示」 |
| 留痕完整性 | 留痕頁「匯出 JSON」→ 看 `chainValid` |

## 3. 設定安全告警（建議 Demo 前完成）

1. 管理者用自己的 LINE 傳任意訊息給機器人 → tail 撈出自己的 userId（`user-active U...`）
2. ```bash
   cd "C:\Users\bobyu\Desktop\AI職涯營\nursing-agent\cloudflare\linebot"; npx wrangler secret put ADMIN_USER_ID
   ```
   貼上該 userId。之後「名單外嘗試使用」「頻率限制觸發」都會推播到管理者的 LINE
   （告警每人只發一次、用量極低，不吃免費推播額度的顯著份額）。

## 4. 與正式導入的關係

本手冊涵蓋 demo 架構（靜態前端＋Cloudflare Worker）真實存在的攻擊面。
正式導入後新增的面（後端 API、資料庫、院內整合、個資）之防護與應對，
依 [ARCHITECTURE.md §11.2](ARCHITECTURE.md) 的五項必要補強建置，
屆時本手冊應擴充為院內資安政策的一部分（含通報時限與法遵義務）。
