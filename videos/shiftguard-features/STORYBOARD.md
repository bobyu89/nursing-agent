---
format: 1920x1080
duration: 151s
message: "十個任務，走完一條治理鏈"
arc: 序幕 → 護理師×2 → 護理長×4 → 督導×1 → 主任×3 → 底座 → 回顧 → CTA
audience: 已被說服想了解「怎麼用」的護理長／主任；Demo Day 深講；官網第二層內容
mode: autonomous
---

設計真相源：`design.md`（ShiftGuard Indigo，沿用 promo）。任務鏡固定文法：角落任務卡
（`任務・○○`）→ 步驟卡 ①.. 跟游標亮 → 真實 UI 重建操作 → **綠色 ✓ 完成態＋收束**。
步驟卡／LINE 重建／瀏覽器外框／守守頭像規範沿用 `../shiftguard-promo` 同名元素文法。
UI 重建掛「示範資料」角標；文字一律取平台真實字樣（各格 content truth 见派工附件）。
時窗已按曉臻實速釘死（lead 0.3s）；章節卡 2.6s 無旁白。

## Frame 0 — 封面幕

- scene: 與本片 poster 同畫面起手（膠囊「功能導覽・2 分 31 秒」），停一拍元素錯峰退場，沉入暗畫布——文法同 promo 的 00-cover，字樣換本片
- duration: 3s
- poster: 0.5s
- transition_in: 影片起始
- status: outline
- voiceover: 無
- src: compositions/frames/00-cover.html
- window: 0.0–3.0
- blueprint: titlecard-reveal (Adapt — 靜帧起手＋內容清場退場)
- rules: waterfall-entry (僅退場編排 autoAlpha 錯峰)
- sfx: 無

## Frame 1 — 定位鏡

- scene: 亮場。四個角色圖示（護理師→護理長→督導→主任）沿階梯逐一亮起連成鏈；字卡「功能導覽」「十個任務，走完一條治理鏈」
- duration: 9.2s
- poster: 6.0s
- transition_in: cut
- status: outline
- voiceover: "班守，把排班從人情變成治理。接下來，我們陪你把每一件事，做完一遍。"
- src: compositions/frames/01-intro.html
- window: 3.0–12.2
- blueprint: kinetic-type-beats (Adapt — 定位句節拍＋階梯圖示組裝)
- rules: spring-pop-entrance (角色節點 stagger), waterfall-entry (字卡), svg-path-draw (鏈線)
- sfx: 無

## Frame 2 — 章節卡・護理師

- scene: 亮場章節卡：大字「第一章・護理師」＋副標「缺班，從一句話開始」＋accent 章節碼 01；一次克制入場後靜帧
- duration: 2.6s
- poster: 1.8s
- transition_in: cut
- status: outline
- voiceover: 無
- src: compositions/frames/02-ch1.html
- window: 12.2–14.8
- blueprint: titlecard-reveal (Reproduce — 章節卡)
- rules: waterfall-entry
- sfx: 無

## Frame 3 — 任務①回報一次缺班

- scene: LINE 重建（守守頭像）。①使用者打字「我明天小夜沒辦法上班」送出 → ②解析卡逐欄亮（日期／班別／單位）→ ③追問案例：快速回覆膠囊「白班／小夜／大夜」游標點「小夜」→ ✓ 完成態卡「通報成立」。步驟卡 ①②③→✓ 左欄堆疊
- duration: 11.8s
- poster: 9.0s
- transition_in: cut
- status: outline
- voiceover: "第一件事，回報缺班。打一句話，系統解析立案；沒講清楚的，按鈕補一下就好——全程不用開系統。"
- src: compositions/frames/03-t1-report.html
- window: 14.8–26.6
- blueprint: agent-progress-theater (Adapt — 對話串逐則堆疊＋膠囊點擊收於完成卡)
- rules: discrete-text-sequence (打字), spring-pop-entrance (氣泡／膠囊／完成卡), cursor-click-ripple (點膠囊)
- sfx: 15.3s typewriter tick (0.2)；19.4s message pop (0.25)；24.2s soft ui click (0.3)
- 任務卡: 任務・回報缺班

## Frame 4 — 任務②發起一次換班

- scene: 平台換班畫面（護理師視角）。①點選日期與對象（甲乙兩側各點一格）→ ②按「送出申請」→ ✓ 完成態：狀態章「待簽核」亮起。步驟卡 ①②→✓
- duration: 6s
- poster: 4.5s
- transition_in: cut
- status: outline
- voiceover: "想換班，選好對象送出，狀態隨時看得到。"
- src: compositions/frames/04-t2-swapreq.html
- window: 26.6–32.6
- blueprint: cursor-ui-demo (Adapt — 兩點選＋一送出的最小工作流)
- rules: cursor-click-ripple, spring-pop-entrance (狀態章)
- sfx: 31.2s soft ui click (0.3)
- 任務卡: 任務・發起換班

## Frame 5 — 章節卡・護理長

- scene: 章節卡「第二章・護理長」＋副標「每天的中樞」＋章節碼 02
- duration: 2.6s
- poster: 1.8s
- transition_in: cut
- status: outline
- voiceover: 無
- src: compositions/frames/05-ch2.html
- window: 32.6–35.2
- blueprint: titlecard-reveal (Reproduce)
- rules: waterfall-entry
- sfx: 無

## Frame 6 — 任務③生成一週班表

- scene: 週班表工作區。①空白週格 → ②游標按「生成下一週班表」→ 班格逐格瀑布填入 → ③把關摘要卡浮出「H1–H10 全數通過」→ ✓ 完成態「本週班表完成・0 違規」。步驟卡 ①②③→✓
- duration: 10s
- poster: 7.0s
- transition_in: cut
- status: outline
- voiceover: "排一週的班，一個按鍵。十條硬規則邊排邊把關——違法的組合，它根本排不出來。"
- src: compositions/frames/06-t3-generate.html
- window: 35.2–45.2
- blueprint: grid-card-assemble (Adapt — 班格自組裝即生成的視覺本體)
- rules: waterfall-entry (逐格填入), cursor-click-ripple (按鍵), spring-pop-entrance (摘要卡)
- sfx: 36.4s soft ui click (0.3)
- 任務卡: 任務・生成週班表

## Frame 7 — 任務④補一個缺口

- scene: 快速通報面板。①點日期、點班別指定缺口 → ②前三名建議卡亮出（N-02/N-03/N-01＋排序依據，同 promo 資料）→ ③游標點第一名 → ④「正式確認」→ ✓ 完成態「已指派・決策已留痕」＋留痕紀錄一行入帳特寫。步驟卡 ①②③④→✓
- duration: 13s
- poster: 10.0s
- transition_in: cut
- status: outline
- voiceover: "補缺口四步：指定缺口、看建議、選人、確認。為什麼是這個人——依據寫在臉上；確認之後，決策自動留痕。"
- src: compositions/frames/07-t4-fillgap.html
- window: 45.2–58.2
- blueprint: cursor-ui-demo (Adapt — 四步工作流落在確認鍵)
- rules: cursor-click-ripple, waterfall-entry (建議卡三列), spring-pop-entrance (完成卡)
- sfx: 46.2s soft ui click (0.3)；56.4s low soft thump (0.3，確認落定)
- 任務卡: 任務・補一個缺口

## Frame 8 — 任務⑤簽核一張換班單

- scene: 簽核佇列（護理長視角）。①佇列列表：任務②那張單掛「待簽核」章 → ②「帶入預檢」自動跑：紅例擋（H10＋法條）綠例放（附依據）並列快帶 → ③游標按「核准」→ ✓ 完成態「已核准・班表已同步」。步驟卡 ①②③→✓
- duration: 10.8s
- poster: 8.0s
- transition_in: cut
- status: outline
- voiceover: "換班單進佇列，預檢先跑一輪：該擋的擋、能放的放，每一筆都附法條。你只要按下核准。"
- src: compositions/frames/08-t5-approve.html
- window: 58.2–69.0
- blueprint: device-surface-showcase (Adapt — 佇列→預檢→核准畫面流轉)
- rules: coordinate-target-zoom (預檢卡 punch), waterfall-entry (依據逐條), cursor-click-ripple (核准)
- sfx: 67.0s soft ui click (0.3)
- 任務卡: 任務・簽核換班單

## Frame 9 — 任務⑥開早會前看一眼戰情

- scene: 今日戰情板。①開板 → ②三格掃過：今日缺口／三班補足率／高負荷提醒（同 promo 資料）→ ✓ 完成態「今日狀況・心裡有數」。步驟卡 ①②→✓
- duration: 6s
- poster: 4.0s
- transition_in: cut
- status: outline
- voiceover: "早會之前三十秒，今天的仗怎麼打，一頁看完。"
- src: compositions/frames/09-t6-today.html
- window: 69.0–75.0
- blueprint: device-surface-showcase (Adapt — KPI 掃視)
- rules: coordinate-target-zoom (輕推掃), waterfall-entry
- sfx: 無
- 任務卡: 任務・看今日戰情

## Frame 10 — 章節卡・督導

- scene: 章節卡「第三章・督導」＋副標「跨單位的棋盤」＋章節碼 03
- duration: 2.6s
- poster: 1.8s
- transition_in: cut
- status: outline
- voiceover: 無
- src: compositions/frames/10-ch3.html
- window: 75.0–77.6
- blueprint: titlecard-reveal (Reproduce)
- rules: waterfall-entry
- sfx: 無

## Frame 11 — 任務⑦跨單位借一個人

- scene: 調度棋盤。①紅黃綠棋盤一眼掃（單位×班別格）→ ②游標點紅格缺口（ICU・小夜）→ ③候選名單彈出：資格徽章（ACLS／VENT）＋借出單位餘裕同屏 → ④選定 S-03 → ✓ 完成態「守恆檢查通過・借人不加班」。步驟卡 ①②③④→✓
- duration: 14.6s
- poster: 11.0s
- transition_in: cut
- status: outline
- voiceover: "跨單位調度像下棋：點缺口、看候選——資格合不合、借出的單位撐不撐得住，兩個條件同屏攤開。橫向借調，不動任何人的工時。"
- src: compositions/frames/11-t7-dispatch.html
- window: 77.6–92.2
- blueprint: cursor-ui-demo (Adapt — 棋盤點擊→候選→選定)
- rules: cursor-click-ripple, spring-pop-entrance (候選卡), waterfall-entry (餘裕列)
- sfx: 79.8s soft ui click (0.3)；90.4s low soft thump (0.3，選定)
- 任務卡: 任務・跨單位借人

## Frame 12 — 章節卡・主任

- scene: 章節卡「第四章・護理部主任」＋副標「看得見的治理」＋章節碼 04
- duration: 2.6s
- poster: 1.8s
- transition_in: cut
- status: outline
- voiceover: 無
- src: compositions/frames/12-ch4.html
- window: 92.2–94.8
- blueprint: titlecard-reveal (Reproduce)
- rules: waterfall-entry
- sfx: 無

## Frame 13 — 任務⑧盤一次留任風險

- scene: 留任雷達。①開雷達（五維欄：工時／夜班／連續／假日／代班）→ ②游標按負荷排序、列重排 → ③點開最高一位、五維明細卡展開 → ✓ 完成態「高負荷名單在手」。步驟卡 ①②③→✓
- duration: 10.4s
- poster: 8.0s
- transition_in: cut
- status: outline
- voiceover: "盤留任，三步：打開雷達、排序、點開明細。誰快撐不住，遞辭呈之前先看見。"
- src: compositions/frames/13-t8-retention.html
- window: 94.8–105.2
- blueprint: cursor-ui-demo (Adapt — 排序＋展開明細)
- rules: cursor-click-ripple, anchored-layout-expand (明細卡展開), waterfall-entry
- sfx: 96.0s soft ui click (0.3)
- 任務卡: 任務・盤留任風險

## Frame 14 — 任務⑨用法定護病比重算需求

- scene: 護病比畫面（表頭：單位／占床（可改）／適用比率／各班需求）。①游標改占床數字 → ②需求公式 ⌈占床÷三班護病比⌉ 帶出、各班底線數字滾動更新 → ③按「套用至全平台」→ ✓ 完成態「人力底線已更新（可還原）」。步驟卡 ①②③→✓
- duration: 12s
- poster: 9.0s
- transition_in: cut
- status: outline
- voiceover: "三班護病比入法後，需求是一條算式。輸入占床，各班底線直接算給你——套用之後，隨時可以還原。"
- src: compositions/frames/14-t9-ratio.html
- window: 105.2–117.2
- blueprint: panel-edit-live-sync (Adapt — 改占床、需求即時同步)
- rules: control-target-sync (占床↔需求連動), counting-dynamic-scale (需求數字), cursor-click-ripple (套用)
- sfx: 115.4s soft ui click (0.3)
- 任務卡: 任務・護病比重算

## Frame 15 — 任務⑩試一次政策改動

- scene: 政策沙盤。①調整工時參數（滑桿或欄位）→ ②按「試算」平行沙盤跑（不動正本的提示語）→ ③新增警示 diff 逐條列出（紅字）→ ✓ 完成態「影響已量化・有數字再決策」。步驟卡 ①②③→✓
- duration: 11s
- poster: 8.5s
- transition_in: cut
- status: outline
- voiceover: "政策要改，先在沙盤試。會多出哪些警示，先看到再決定——沒有影響，也是一個誠實的答案。"
- src: compositions/frames/15-t10-sandbox.html
- window: 117.2–128.2
- blueprint: panel-edit-live-sync (Adapt — 參數↔試算結果)
- rules: control-target-sync, waterfall-entry (diff 逐條), cursor-click-ripple
- sfx: 119.0s soft ui click (0.3)
- 任務卡: 任務・政策沙盤

## Frame 16 — 治理底座巡禮

- scene: 非任務鏡。治理儀表板指標一覽輕掃 → 軟切規則手冊 H1–H10 勻速捲讀（每條附法源，同 promo F11 文法）；字卡「同一塊治理底座」
- duration: 7.8s
- poster: 5.5s
- transition_in: cut
- status: outline
- voiceover: "這一切踩在同一塊底座上：十條規則攤在手冊裡，每一條都有法源。"
- src: compositions/frames/16-foundation.html
- window: 128.2–136.0
- blueprint: transcript-scroll-artifact-reveal (Adapt — 捲讀即證據)
- rules: viewport-change (捲動), waterfall-entry
- sfx: 無

## Frame 17 — 十任務回顧牆

- scene: 十張任務卡（各帶綠 ✓ 與任務名）瀑布自組裝成 5×2 牆——「你剛剛完成的」；字卡「十個任務・一天的治理」
- duration: 7s
- poster: 5.0s
- transition_in: cut
- status: outline
- voiceover: "十個任務，就是護理部的一天。"
- src: compositions/frames/17-recap.html
- window: 136.0–143.0
- blueprint: grid-card-assemble (Reproduce — 卡片牆 cascade)
- rules: spring-pop-entrance (卡 stagger), waterfall-entry (字卡)
- sfx: 無
- 十卡文案: 回報缺班／發起換班／生成週班表／補一個缺口／簽核換班單／看今日戰情／跨單位借人／盤留任風險／護病比重算／政策沙盤

## Frame 18 — 治理一句

- scene: 大留白字卡：「數字歸規則引擎，AI 只聽懂人話」（招商片信任段 callback，一句不重講）；「規則引擎」accent
- duration: 3s
- poster: 2.2s
- transition_in: cut
- status: outline
- voiceover: 無
- src: compositions/frames/18-oneliner.html
- window: 143.0–146.0
- blueprint: kinetic-type-beats (Adapt — 單句節拍卡)
- rules: waterfall-entry, css-marker-patterns (marker)
- sfx: 無

## Frame 19 — CTA

- scene: 瀏覽器框＋URL＋「立即體驗示範平台」按鈕（同 promo F14 文法）；CTA 動作前 2 秒完成，停留後 dissolve 收黑（全片唯一 exit）
- duration: 5s
- poster: 2.8s
- transition_in: crossfade
- status: outline
- voiceover: "換你動手了。"
- src: compositions/frames/19-cta.html
- window: 146.0–151.0
- blueprint: titlecard-reveal (Adapt — CTA end-card)
- rules: spring-pop-entrance, press-release-spring (按鈕 pulse), ambient-glow-bloom (極淡)
- sfx: 無
