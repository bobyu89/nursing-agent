# LINE 機器人 Stage 1 — 預班與替班兩條迴路

> 本文件是 [BLUEPRINT.md](BLUEPRINT.md) Stage 1 的落地設計：把 LINE 機器人從「只給建議的無狀態查詢器」
> 升級為「單位內部的兩條工作迴路」。現行系統見 [ARCHITECTURE.md](ARCHITECTURE.md)，領域語義見 [CONTEXT.md](CONTEXT.md)。
>
> 範圍：**單位內部**。跨單位借調仍屬督導的調度棋盤，不在本文。

---

## 0. 已定的決定

| 決定 | 結論 | 影響 |
|---|---|---|
| 替班詢問前，護理長要不要先核准？ | **先核准再發** | bot 推翻現行「通知一律停在草稿」原則，但決定權仍在人；上線時 README 與誠實聲明同步改寫 |
| 候選人逐一問，還是同時問？ | **逐一問** | 排序的意義完整保留——「為什麼是找你不找他」在逐一詢問下有唯一答案；代價是慢，靠逾時參數調 |
| 「AI 自動聯絡」裡的 AI 做什麼？ | **只寫話，不做決定** | 候選排序仍由確定性引擎；語言模型（若接）只把 `{N-04, 8/3, N, ICU, ACLS}` 寫成一句人話。沿用「確定性歸程式、語言歸模型」 |
| 逾時多久？ | **參數，依急迫度分級** | 見 §4.4，預設值可由護理長在核准時覆寫 |
| 綁定碼誰發？ | **bot 端管理者發** | 管理者（`ADMIN_USER_ID`）在 LINE 下指令發碼，Phase 0 不動平台介面 |
| 預假上限？ | **可設定，院內常見 3–4 天** | 護理長開啟預班週期時指定，預設 4 |
| 護理長自己缺班誰核准？ | **Stage 1 允許自核並留痕** | `approved_by == original_staff_id` 即自核，留痕明標；Stage 2 升到督導 |
| 遲到的「接」算不算？ | **不算** | 逾時後才按接 → 回「已由他人接下」並留痕（§4.2） |
| 拒絕會不會扣分？ | **不會** | `standbyCount30d` 只在 FILLED 時對替補者 +1（§4.2） |

---

## 1. 現況與三個零

`src/botcore.js`（579 行）現在是**無狀態**的：訊息之間靠 `encodeParams` 把參數編進 postback 帶著走。
身分**沒有綁定**——使用者手打 `N-01`。只有 reply，push 只用在管理者安全告警。
資料是 `data.js` 的示範資料，班表在瀏覽器 localStorage。

兩條迴路都需要、而現在都是零的三樣東西：

| | 需要它做什麼 | 現況 |
|---|---|---|
| **狀態** | 記住誰預了假、哪筆替班問到第幾位、什麼時候逾時 | 零（wrangler.toml 無 KV／D1 綁定） |
| **身分** | 知道這個 LINE 帳號是 N-04，才能推播給對的人、才能驗證「你只能回答問你的那筆」 | 零 |
| **推播＋排程** | 催繳、詢問候選、逾時後問下一位——都是 bot 主動說話，不是回覆 | push 只有 adminAlert；無 cron |

**還有第四件事比三個零更大**：班表現在活在瀏覽器裡。替班「寫回班表」、預班「生成班表」都要求班表在伺服器端。
**班表落地到伺服器，是這個 Stage 真正的架構變更**，兩條迴路都掛在它上面。

---

## 2. 共同地基（Phase 0）

### 2.1 選型：Cloudflare D1 ＋ Cron Triggers

| 元件 | 選 | 不選 | 理由 |
|---|---|---|---|
| 狀態儲存 | **D1**（SQLite） | KV | 班表是人×日×班別×單位的強關聯資料，BLUEPRINT §5 已寫「主資料用 RDS 而非 NoSQL」——D1 是 Workers 原生的關聯選項 |
| 逾時與催繳 | **Cron Trigger 每分鐘掃 D1** | Durable Objects alarm | DO 是教科書解，但 Stage 1 不值得多一層抽象；每分鐘掃一張小表夠用。DO 留作升級路徑 |
| 節流 | KV（既有 in-memory 改 KV） | — | 現在的 rate limit 在 isolate 記憶體裡，重啟即失效 |

**一份核心兩套部署的原則怎麼辦**：`botcore.js` 維持純函式，狀態透過注入的 `store` 介面存取（`store.getIdentity`、`store.createSubRequest`…）。
Cloudflare 宿主用 D1 實作；AWS 宿主若要跟上，實作同介面接 DynamoDB。**Stage 1 只做 Cloudflare 實作**，這點要誠實寫在 aws/README。

### 2.2 身分綁定

```
管理者在 LINE 輸入：發碼 N-04
      │
bot 驗管理者身分（ADMIN_USER_ID）→ 生成 6 碼一次性綁定碼，30 分鐘失效 → 只回給管理者
      │
管理者以院內既有管道（口頭／公務訊息）把碼交給 N-04
      │
N-04 在 LINE 輸入：綁定 N-04 483920
      │
bot 驗碼 → 寫入 identity(line_user_id, staff_id, unit, role) → 回「已綁定為 N-04（MED-3A）」
      │
綁定碼作廢；同一 staff_id 重綁需管理者重新發碼（換手機情境），舊 line_user_id 立即失效並留痕
```

- **發碼走 bot 不走平台**：Phase 0 因此不需改平台介面。管理者＝既有 `ADMIN_USER_ID`（可為多個，逗號分隔）。
- **D1 只存代號，永不存姓名**。LINE 的 display name 不落地。姓名只存在平台呈現層——BLUEPRINT 資料治理「代號化」原則原封搬過來。
- 角色（護理師／護理長）來自 `STAFF.role`，寫進 identity。護理長專屬動作（開啟預班、核准替班）在 worker 端查 identity 驗角色，**不信任訊息內容**。
- 既有 `ALLOWED_USERS` 名單改為「已綁定者即允許」；未綁定者只能看到綁定說明。
- 發碼與綁定各一筆留痕：誰發、給誰、何時綁、綁到哪個 line_user_id 的雜湊（不存原值）。

### 2.3 推播與額度

| 用途 | reply 還是 push |
|---|---|
| 使用者主動輸入的一切回應 | reply（不計額度） |
| 催繳未預班者、詢問替班候選、通知護理長、公告班表 | push（**計額度**） |

粗估單一單位 30 人：預班每月開啟 1 則 × 30 ＋ 催繳 2 輪 × 未回者 ≈ 50 則；替班每次通報 ≈ 3–5 則（護理長 ×2、候選 ×n、原通報人 ×1）× 月 10 次 ≈ 50 則。
**約 100 則／月／單位**。LINE 官方帳號免費方案的推播額度大約就在這個量級，第二個單位起就要看付費方案——**依 LINE 當時公告為準**，設計上每一則 push 都要有理由。

### 2.4 留痕搬到伺服器端

平台的雜湊鏈留痕（`chainValid`）搬進 D1 的 `audit` 表：append-only，每筆含前一筆雜湊。
bot 的每一個狀態轉移都是一筆留痕——這是「視同無預假」與「為什麼是找你不找他」在事後站得住的唯一依據。

---

## 3. 迴路 A：預班 → 催繳 → 生成 → 審核

### 3.1 狀態機（每單位、每月一個週期）

```
                護理長：「開啟 10 月預班，9/25 截止」
                              │
                           ┌──▼──┐
                           │OPEN │  推播全單位：「10 月預班開放，9/25 前回覆」
                           └──┬──┘
            每人 PENDING ─────┤────▶ SUBMITTED（截止前可改，最後一次為準）
                              │
        cron：截止前 3 天、前 1 天 → 只推播 PENDING 者（催繳次數＋時間留痕）
                              │
                           ┌──▼───┐
                           │CLOSED│  截止：PENDING 者標 NO_REQUEST（留痕：催 2 次無回應）
                           └──┬───┘  所有 SUBMITTED 寫入 staff.leaves（type:'預假'）
                              │
                           ┌──▼──────┐
                           │GENERATED│  engine.generateSchedule(unit, 當月日期, 需求)
                           └──┬──────┘  排不出的格子連同阻擋原因一起出來，不硬塞
                              │
                           ┌──▼────┐
                           │REVIEW │  推播護理長：「10 月草稿已生成，N 格排不出」＋ 平台畫面 8 連結
                           └──┬────┘  改班表在平台改，不在 LINE 裡改
                              │
                           ┌──▼───────┐
                           │PUBLISHED │  護理長核准 → 推播全單位「10 月班表已公告」＋ 平台連結
                           └──────────┘  草稿寫入正式班表（D1 shift 表，source:'generated'）
```

### 3.2 預班輸入

Phase 2 先用文字：`預假 10/3 10/4 10/17`，沿用 `expandDate` 解析；回覆確認清單，可再送一次覆蓋。
Phase 3 換 LIFF 日曆挑日（體驗差很多，但先把迴路跑通）。

### 3.3 要先定的院內政策（不是引擎規則，是參數）

| 參數 | 說明 | 預設 |
|---|---|---|
| 每人每月預假上限 | 護理長開啟週期時指定；超過上限 bot 直接拒收並說明。院內常見 3–4 天 | 4 天 |
| 截止日 | 相對於當月幾號 | 前月 25 日 |
| 催繳輪數與時點 | | 截止前 3 天、前 1 天 |
| 逾期政策 | 視同無預假（已定） | — |

**誠實原則**：預假是「請求」不是「保證」。生成器在人力不足時仍可能排不開，那格會標為「阻擋：N-04 預假」交護理長決定，
不會偷偷把預假吃掉。

---

## 4. 迴路 B：通報 → 核准 → 逐一問 → 回報

### 4.1 狀態機（每筆替班請求）

```
  同仁 LINE 通報：「我 8/3 大夜不能來」（既有 askNext 追問補齊單位／資格）
                              │
                        ┌─────▼─────┐
                        │ REPORTED  │  engine.evaluateGap → 候選排序 ＋ 排除名單
                        └─────┬─────┘  推播護理長（Flex）：缺口摘要、前 5 候選、[核准][調整][駁回]
                              │
         駁回 ──▶ REJECTED     │ 核准（可刪減候選、調順序、改逾時）      ← 決定：護理長先核准
                              │
                        ┌─────▼─────┐
                        │ APPROVED  │  留痕：核准後的候選序列＝「為什麼是找你不找他」的正本
                        └─────┬─────┘
                              │
                 ┌────────────▼────────────┐
                 │  ASKING(i)              │  推播第 i 位：「8/3 大夜 ICU，需 ACLS，你合格。接嗎？」
                 │  等候 T 分鐘             │  [接][不接]
                 └──┬──────────────┬───────┘
                    │ 接            │ 不接 ／ 逾時（cron 掃到 expired_at 過期）
                    │              │
              ┌─────▼─────┐        │  i+1 < n ？──是──▶ ASKING(i+1)          ← 決定：逐一問
              │  FILLED   │        │              否
              └─────┬─────┘        │               │
                    │         ┌────▼──────┐        │
   寫回 D1 shift（原班移除＋   │ EXHAUSTED │◀───────┘  推播護理長：「5 位皆未接，請人工處理」
   替補新增＋原人 leaves）      └───────────┘         ＝決策階梯第 2–3 階（放寬試算／任務重分配）在平台做
   推播護理長、原通報人、替補者
```

### 4.2 逐一問的三條紀律

1. **同一時間只有一位候選看得到這筆請求**。第 i 位逾時或拒絕後，第 i+1 位才收到推播。
2. **遲到的「接」不算數**。候選在逾時後才按「接」→ 回「此筆已由其他同仁接下／已逾時，謝謝」，並留痕。
3. **拒絕不扣分**。`standbyCount30d` 只在 FILLED 時對替補者 +1；拒絕與逾時不影響任何評分。這是政策，寫進 CONTEXT.md。

### 4.3 護理長「調整」能做什麼

- 刪除候選（例：知道 N-07 今天家裡有事）——刪除理由留痕
- 調整順序——留痕原順序與新順序
- 改逾時 T
- **不能加入引擎排除的人**。要加，回平台用「放寬試算」看代價再決定，bot 不提供繞過硬性規則的路。

### 4.4 逾時預設（依缺班距今時間分級）

| 缺班距今 | T | 理由 |
|---|---|---|
| < 12 小時 | 15 分鐘 | 今晚就缺，等不了 |
| 12–48 小時 | 60 分鐘 | 明後天，給人查行事曆的時間 |
| > 48 小時 | 4 小時 | 不急，別半夜吵人 |

護理長核准時可覆寫。cron 每分鐘掃 `sub_ask.expired_at < now AND answer IS NULL`。

### 4.5 邊界情況

| 情況 | 處理 |
|---|---|
| 原通報人在 ASKING 中取消 | → CANCELLED；正在被問的候選收到「此筆已取消」 |
| 護理長在 ASKING 中駁回 | 同上 |
| 同一缺口重複通報 | 以 (unit, date, shift, original_staff_id) 去重，回「已有進行中的請求」 |
| 候選同時被兩筆請求問到 | 允許；接了 A 之後，B 的 evaluateGap 若重跑會因 H2 排除他——但 B 已在 ASKING 不重跑。**Stage 1 接受此縫隙**，FILLED 寫回前重驗一次硬性規則，衝突則回 EXHAUSTED 給護理長 |
| 通報事由 | 只存類別（病假／事假／公假／其他），**不存自由文字**——事由常含病情等敏感內容 |
| 原通報人是護理長本人 | Stage 1 允許自核：核准 Flex 照常推給本人，`approved_by == original_staff_id` 即為自核，留痕明標 `self_approved`。Stage 2 升到督導 |

---

## 5. 資料模型（D1）

```sql
identity        (line_user_id PK, staff_id UNIQUE, unit, role, bound_at)
bind_code       (code PK, staff_id, issued_by, expires_at, used_at)

shift           (staff_id, date, shift, unit, source, written_at, PK(staff_id, date, shift))
                -- source: 'imported' | 'generated' | 'substitution' | 'manual'
leave           (staff_id, from_date, to_date, type, source, created_at)
                -- type: '預假' | '病假' | '事假' | ... ；預班 CLOSED 時寫入

prebook_cycle   (id PK, unit, month, deadline, state, opened_by, opened_at, closed_at)
prebook_request (cycle_id, staff_id, dates_json, state, submitted_at,
                 reminded_count, last_reminded_at, PK(cycle_id, staff_id))

sub_request     (id PK, unit, date, shift, required_certs_json, original_staff_id,
                 reason_type, reporter_staff_id, state, timeout_min,
                 created_at, approved_at, approved_by, filled_by, closed_at)
sub_ask         (request_id, seq, staff_id, asked_at, expired_at, answered_at, answer,
                 PK(request_id, seq))
                -- answer: 'accept' | 'decline' | NULL(逾時)

audit           (id PK, ts, actor_staff_id, action, payload_json, prev_hash, hash)
```

`STAFF` 的靜態欄位（資格、職級、意願）Stage 1 仍由平台 Excel 匯入後上傳到 D1（`staff` 表，同 `data.js` 形狀）；
Stage 2 再接人事系統。

---

## 6. 分階段

| Phase | 內容 | 可交付的東西 | 粗估 |
|---|---|---|---|
| **0 地基** | D1 schema、`store` 介面、綁定流程、push 工具、cron 骨架、audit 鏈、平台「上傳班表快照到 D1」 | 「綁定」指令可用；儀表板改讀 D1 | 1–2 週 |
| **1 替班迴路** | §4 全部：通報→核准 Flex→逐一問→逾時→寫回→回報 | **當天就能實測**的完整迴路；landing page「我們開始在那通電話」成真 | 2–3 週 |
| **2 預班迴路** | §3 全部：開啟→文字預假→催繳→截止→生成→審核→公告 | 月度預班；要跑過一個月才驗得完 | 2 週 |
| **3 收斂** | LIFF 日曆、平台改讀 D1 即時班表（取代 localStorage）、aws 宿主的 store 實作或明寫不支援、README／誠實聲明改寫 | 平台與 bot 同一份班表 | 1–2 週 |

**為什麼替班（B）先於預班（A）**：B 是差異化功能、當天可測、且 A 的「催繳—等回覆」是 B 的「詢問—等回覆」的簡化版——
做完 B，A 的機制大半已在。A 的戰略價值（讓全單位有理由綁進來）留到 Phase 2 收割。

估時以一人業餘投入計，**不含**院內導入、資安審查、正式帳號申請——那些不是工程時間。

---

## 7. 不做的事（Stage 1 邊界）

- 跨單位借調（督導的調度棋盤，Stage 2）
- 在 LINE 裡改班表格子（改班表回平台）
- 自由文字事由
- 語言模型進入「找誰」的迴路
- 繞過硬性規則的任何路徑
- AWS 宿主的狀態實作（介面留著，實作明寫「未提供」）

---

## 8. 上線前必改的既有文案

Phase 1 上線那一刻，這些地方從「不自動通知」變成「經護理長核准後自動詢問」：

- `README.md` 範圍聲明「不自動通知員工」
- `home.html` `#honest` 誠實聲明「通知一律停在草稿」
- `home.html` FAQ「AI 會不會算錯工時」——補一句「也不會決定找誰；找誰是引擎排、護理長核」
- `docs/CONTEXT.md` 新增：拒絕不扣分、遲到的接不算數、逾時分級

---

## 9. 開放問題

已全數收斂進 §0。新問題出現時加在這裡，定案後移回 §0。

---

*本文件為設計層。實作以此為準，實作與文件不一致時先改文件再改程式，並補測試。*
