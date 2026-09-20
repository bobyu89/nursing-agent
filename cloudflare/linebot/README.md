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
>     （規則 H1–H10，含四週彈性工時 H7–H9 與母性保護 H10，週期錨點與平台一致）
>   → 回覆：替補建議前三名（分數＋依據＋風險標記）＋排除摘要＋平台連結
> ```
>
> 互動全程**無狀態**：已選條件夾帶在按鈕的 postback data 裡，
> 不需要任何資料庫。機器人提供「建議」，不做指派決定——
> 正式確認與決策留痕在平台。
>
> **指令**：輸入「選單」→ 功能快速按鈕（儀表板／換班預檢／調度棋盤／負荷雷達／通報範例／開啟平台／使用說明）；
> 「**使用說明**」（或 說明／教學）→ 完整教學一頁看完，附「照著打」的快速按鈕；
> 「換班 N-01 8/3 N-02 8/5」→ 互換後兩人各自重跑 H1–H10 的預檢；
> 「調度 8/9 大夜」→ 全院棋盤與守恆律借調建議；「負荷」→ 高負荷名單；
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

兩版共用同一份互動核心（`src/botcore.js`）與規則引擎（H1–H10），差別只在解析器；
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
powershell -ExecutionPolicy Bypass -File cloudflare/linebot/deploy.ps1
```

（`deploy.ps1` 會先把檔案複製到 %TEMP% 的純 ASCII 路徑再跑 `wrangler deploy`——
wrangler 的 esbuild 在含中文的路徑會直接失敗，見疑難排解。直接
`cd cloudflare/linebot; npx wrangler deploy` 只在純英文路徑下可用。）

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

### 4½. 底部固定按鈕（圖文選單 Rich Menu，四份依權責層，一鍵腳本）

聊天室下方常駐六格大按鈕＋一條細長列。Stage 1 起選單**依權責層分四份**（設計 §2.4）：

| 版本 | 六格 | 誰看到 |
|---|---|---|
| unbound | 如何綁定／使用說明／開啟平台／通報缺班・換班預檢・我的邀請（標「綁定後可用」） | 全體預設，未綁定者 |
| staff | 通報缺班／換班預檢／我的邀請／我的預假／功能選單／開啟平台 | 綁定為護理師者 |
| head | 戰情儀表板／待核准／通報缺班／換班簽核／預班／開啟平台 | 綁定為護理長者 |
| exec | 戰情儀表板／調度棋盤／負荷雷達／待核准／換班預檢／開啟平台 | 綁定為督導／主任者 |

格子＝§2.5 權限矩陣該層打勾的指令（`tests/linebot-stage1.test.js` 會對矩陣逐格檢查）；Worker 在**綁定成功那一刻**依 tier 把對應選單掛給本人（換手機時舊帳號解除、退回預設）。

**建立方式（本機零 token）**：四張圖與定義檔已在 repo（`richmenu-*.png`、`richmenu-defs.json`），GitHub Pages 公開。
管理者（`ADMIN_USER_ID`）在 LINE 對機器人輸入 **`建立選單`**，機器人立刻回「已開始」，接著每分鐘的 cron 一步一步做
（一個 webhook 請求裡做完四份會撞免費方案的單次預算，實測第二份就被砍）：unbound → staff → head → exec（各：建立 → 上傳圖 →
unbound 設全體預設 → id 寫進 D1 `setting` 表）→ **已綁定者依權責層整批重掛** → 清掉自家舊版（安全換版）→ **推播一段報告給管理者**，約 6 分鐘。
不需要貼 token、不需要改 `wrangler.toml`、不需要重新部署；之後每次綁定成功都會讀 D1 的 id 掛上。
失敗會推播原因並停止，修好後再輸入一次即從頭重來（半成品在最後一步一併清掉）。

改文案或格子：改 `richmenu.ps1` 頂端的 `$MENUS` 表 → `powershell -ExecutionPolicy Bypass -File richmenu.ps1 -ImageOnly`
（用 Windows 內建 GDI+ 重畫四張 2500×1686 的圖並重寫 `richmenu-defs.json`；「開啟平台」格由班守 IP「守守」坐鎮，
動作依腳本頂端 `$LIFF_ID` 走 `liff.line.me` 全高視窗）→ commit、等 Pages 發布 → 再輸入一次 `建立選單` 即換版。
腳本不帶 `-ImageOnly` 的舊路徑（本機貼 token 直接呼叫 LINE API）仍保留，給沒有 Worker 的部署用。

原理：圖文選單只是「代替使用者送出文字／開連結」的介面層——按格子等於輸入指令文字，
由 Worker 的指令路由接手。不想用腳本的話，manager.line.biz → 圖文選單也能手動建立
（動作類型選「文字」，內容分別填 `儀表板`／`換班`／`調度`／`負荷`）；
輸入「選單」也能隨時叫出同功能的快速按鈕（本 Worker 內建）。

### 4¾. LIFF：在 LINE 內全螢幕開平台（選配，3 分鐘）

讓「開啟平台／完整儀表板」按鈕不再跳外部瀏覽器，而是在 LINE 裡以全高視窗開出平台頁：

1. [LINE Developers](https://developers.line.biz/console/) → 同一個 Provider → **Create channel → LINE Login**
   （名稱隨意，如「班守平台」；這是 LIFF 的掛載點，與 Messaging API channel 並存）。
2. 進該 channel → **LIFF** 分頁 → **Add**：Endpoint URL 填
   `https://bobyu89.github.io/nursing-agent/index.html`、Size 選 **Full** → 儲存，複製 **LIFF ID**
   （長得像 `1234567890-Abcdefgh`；LIFF ID 會出現在網址中，不是機密）。
3. 把 ID 貼進 `wrangler.toml` 的 `LIFF_ID = "..."` → `npx wrangler deploy`。

誠實取捨：平台頁基於嚴格 CSP 不載入 LIFF SDK，故僅作全螢幕展示；
指令回覆中的深鏈（#swap 等）維持一般網址——經 LIFF 轉址會遺失錨點。

### 4⅞. Stage 1 地基：D1 狀態儲存（選配，5 分鐘）

沒做這步，bot 就是 Stage 0 的無狀態示範模式——一切照舊、零成本。
做了這步，身分改以綁定為準、人員與班表改讀雲端快照，後續替班／預班迴路才有地方站。設計見 [docs/LINEBOT-STAGE1.md](../../docs/LINEBOT-STAGE1.md)。

```powershell
cd cloudflare/linebot
npx wrangler d1 create shiftguard          # 記下輸出的 database_id
```

把 `wrangler.toml` 裡 `[[d1_databases]]` 那三行取消註解、貼上 `database_id`，然後：

```powershell
powershell -ExecutionPolicy Bypass -File deploy.ps1 -Schema     # 套 schema 並部署
node ..\..\tools\snapshot-to-sql.cjs --out snapshot.sql          # 從 data.js 產生人員／班表快照
npx wrangler d1 execute shiftguard --remote --file=snapshot.sql  # 上傳快照（全量覆蓋）
npx wrangler secret put ADMIN_USER_ID                            # 管理者 LINE userId（逗號可多人）
```

啟用後的行為：

| 誰 | 能做什麼 |
|---|---|
| 管理者（`ADMIN_USER_ID`） | `發碼 N-04`（護理師）／`發碼 N-04 護理長`／`發碼 N-04 督導` → 六位數一次性綁定碼（30 分鐘失效），**發碼時即授權權責層**，走院內管道交給本人 |
| 未綁定的任何人 | 只看得到綁定說明；輸入 `綁定 N-04 483920` 完成綁定，權責層隨碼進 identity |
| 已綁定者 | 依權責層開放指令（設計 §2.5 矩陣）：護理師＝通報／換班；護理長＋儀表板；督導＋負荷／調度。權限不足時誠實回覆屬哪一層。人員與班表來自 D1 快照 |

既有的庫補欄位（新建的庫跑 schema.sql 即含），依序：`npx wrangler d1 execute shiftguard --remote --file=migrations/0001-tier.sql`、`…/0002-sub-candidates.sql`、`…/0003-prebook-draft.sql`

每一次發碼、綁定、拒絕都是 `audit` 表裡的一筆雜湊鏈留痕；`line_user_id` 只在 `identity` 表存原值（推播要用），留痕一律雜湊。
cron 每分鐘：清過期綁定碼、替班詢問逾時換下一位、預班催繳（截止前 3 天／1 天，只推未回覆者）、到期截止並生成草稿。

預班迴路（Phase 2）的指令：護理長 `開啟預班 10月`（可加 `截止 9/25`、`上限 3`）、`預班狀態`、`催繳`、`關閉預班`（提前截止並生成）；同仁 `預假 10/3 10/4`、`預假 無`、`我的預假`。
草稿推給護理長附「核准並公告／暫緩」鍵，核准才寫入 `shift`（source generated）。
生成需求（每班人數）護理長可改：`需求` 看目前值、`設定需求 D2 E1 N1` 改（留痕；另加院內政策 ACLS）。

**平台登入與 API（Phase 3）**：已綁定者輸入 `平台` → 回兩個本人專屬的簽章連結（開啟平台／預假日曆，10 分鐘內有效）。
Worker 提供 `GET /api/session?t=`（換 12 小時 session）、`GET /api/snapshot`（D1 的人員／班表，範圍依權責層）、
`GET|POST /api/prebook`（日曆頁；POST 的日期轉成同一句「預假 …」走同一套驗證與留痕）。CORS 只放行 `PLATFORM_URL` 來源與本機開發。
平台端的網址在 `src/config.js`（`PLATFORM_API`）——Worker 網址不同時改那一行。

> 正式導入時 `snapshot.sql` 的來源改為平台匯出的 JSON（`--json export.json`），匯出端請剔除任何可識別個人之欄位——D1 只存代號。

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
| `wrangler deploy` 印完版本橫幅就以 exit 9／127 結束、無錯誤訊息 | esbuild 打包在**含中文的路徑**（如「AI職涯營」）會直接失敗；`whoami`／`secret` 等純 API 指令正常所以難察覺。用 `deploy.ps1`（自動複製到 %TEMP% 純 ASCII 路徑再部署），機密綁在雲端 Worker 本體、不會因換路徑遺失 |
| 想看即時 log | `cd cloudflare/linebot; npx wrangler tail` |

## Demo Day 演法（30 秒）

手機掃碼 → 現場傳一則臨時請假訊息 → 機器人秒回解析摘要與追問 →
投影幕切到平台畫面 1 貼上同一則訊息接著走替補流程。台詞：

> 通報入口，放在護理師本來就在用的 LINE——零學習成本、零雲端費用；
> 而且 bot 用的解析器，跟你們現在螢幕上看到的是**同一份程式碼**。
