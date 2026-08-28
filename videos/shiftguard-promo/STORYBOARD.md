---
format: 1920x1080
duration: 81s
message: "班表照顧好，人就留得住"
arc: 刺（hook）→ 痛（三刀）→ 亮（亮相）→ 證（三能力）→ 信（治理）→ 收（CTA）
audience: 護理長（畫面主角）＋護理部主任（帳單層）；官網訪客靜音自動播放
mode: autonomous
---

規格真相源：`video-spec.md`（18 鏡，用戶逐句審定）。本檔 14 格＝規格 18 鏡合併連續同框後的派工單位；每格的 `spec_scenes` 指回規格鏡號，字卡／音效／畫面細節以規格為準。設計真相源：`design.md`（ShiftGuard Indigo；暗場 dark-canvas、亮場 primary）。

## Frame 1 — 冷開場：離職單的謊言

- scene: 暗場。離職單卡片浮入，「家庭因素」蓋章式砸落；被 danger 劃掉線劃掉後淡出，「真相，藏在班表裡」按詞瀑布入場，背景浮出極淡班表格線
- duration: 5.6s
- poster: 4.2s
- transition_in: cut
- status: animated
- voiceover: "離職單上，寫的是家庭因素。真相，藏在班表裡。"
- src: compositions/frames/01-cold-open.html
- window: 0.0–5.6
- spec_scenes: S01+S02
- blueprint: kinetic-type-beats (Adapt — statement beats onto payoff)
- rules: kinetic-beat-slam, css-marker-patterns (sketchout 劃掉), waterfall-entry
- sfx: 無（BGM 首和弦獨走）

## Frame 2 — 痛一：缺班靠人情

- scene: 暗場。LINE 群組氣泡重建於右側（降暗背景）——「今天小夜還缺一個人…」「拜託大家了」「已讀 17」逐則彈出；左前景字卡「缺班靠人情」slam＋marker 橫掃
- duration: 4s
- poster: 2.8s
- transition_in: cut
- status: animated
- voiceover: "缺班，靠人情調度。"
- src: compositions/frames/02-pain-line.html
- window: 5.6–9.6
- spec_scenes: S03
- blueprint: kinetic-type-beats (Adapt — 字卡 slam 為主角、聊天氣泡為降暗底景)
- rules: spring-pop-entrance (氣泡 stagger 入場；字卡以重 overshoot 的 spring-pop 落下), css-marker-patterns (marker 橫掃)
- sfx: 6.0s message pop (vol 0.25)

## Frame 3 — 痛二：換班靠猜

- scene: 暗場。gantt 重繪的一週班表逐列展開（列＝人員代號、欄＝日期、班別色塊），兩格塗改互換、接縫 danger 問號砸落；字卡「換班靠猜」
- duration: 3.8s
- poster: 2.6s
- transition_in: cut
- status: animated
- voiceover: "換班，靠感覺賭一把。"
- src: compositions/frames/03-pain-swap.html
- window: 9.6–13.4
- spec_scenes: S04
- blueprint: grid-card-assemble (Adapt — 班表列自組裝，對調為插曲)
- rules: waterfall-entry (列展開), scale-swap-transition (兩格對調), kinetic-beat-slam (字卡＋問號)
- sfx: 無

## Frame 4 — 痛三：風險沒人算

- scene: 暗場。月曆熱力圖（行＝週次、列＝週一至週日）格子逐一點亮，夜班熱區由 warn 燒向 danger 並脈動；純色階不標數字。字卡「風險沒人算」。尾端 BGM 收攏留白
- duration: 5.5s
- poster: 3.0s
- transition_in: cut
- status: animated
- voiceover: "連續上了幾天、夜班排得多密——沒有人真的算過。"
- src: compositions/frames/04-pain-heat.html
- window: 13.4–18.9
- spec_scenes: S05
- blueprint: dataviz-countup (Adapt — 數據戲劇化惡化中的問題；熱力圖為載體)
- rules: spring-pop-entrance (格 stagger), sine-wave-loop (danger 熱區灼燒脈動), kinetic-beat-slam (字卡)
- sfx: 無

## Frame 5 — 亮相：班守登場

- scene: 反白閃屏（全片唯一，0.15s 純白）暗轉亮。亮場 primary 畫布，「班守」(ink)＋「ShiftGuard」(accent) 標準字 slam 入場，副標「排班治理平台」cascade，大留白靜帧
- duration: 3.2s
- poster: 2.0s
- transition_in: 反白閃屏（white flash）
- status: animated
- voiceover: "班守 ShiftGuard。"
- src: compositions/frames/05-reveal.html
- window: 18.9–22.1
- spec_scenes: S06
- blueprint: kinetic-type-beats (Adapt — Introducing name-drop onto lockup)
- rules: spring-pop-entrance, waterfall-entry
- sfx: 無；BGM 隨閃屏揚起一階

## Frame 6 — 定位：從人情變成治理

- scene: 亮場。水平光譜畫軸展開（70% 寬），左極「人情」(ink-faint)、右極「治理」(accent)；游標圓點由左滑至 85% 處，上方標籤「班守」；「治理」pulse、「人情」淡化
- duration: 4s
- poster: 3.0s
- transition_in: cut
- status: animated
- voiceover: "把排班，從人情變成治理。"
- src: compositions/frames/06-position.html
- window: 22.1–26.1
- spec_scenes: S07
- blueprint: titlecard-reveal (Adapt — 單一克制動作：光譜軸畫出＋游標滑行)
- rules: svg-path-draw (軸線畫出), nudge-curve (游標慢-快-慢滑行), spring-pop-entrance (標籤)
- sfx: 無

## Frame 7 — 能力一：LINE 一句話通報＋前三名

- scene: 亮場。LINE 對話重建（design.md 規範：米白對話區、右綠左白、無 emoji 無個資）。相位 A：使用者氣泡打字機輸入「我明天小夜沒辦法上班」送出→機器人解析卡逐欄點亮；相位 B：替補建議前 3 名卡彈入（人名＋資格徽章取平台示範資料），字卡「合格替補，前 3 名」。左上小標「能力一・快速通報」、角落「護理長的凌晨」
- duration: 10.2s
- poster: 8.0s
- transition_in: cut
- status: animated
- voiceover: "護理師在 LINE 說一句話，系統聽懂。合格的替補前三名，直接送回來——不用再一個一個打電話。"
- src: compositions/frames/07-cap1-line.html
- window: 26.1–36.3
- spec_scenes: S08+S09（內部相位軟切）
- blueprint: agent-progress-theater (Adapt — 對話串逐則堆疊至收據卡收束)
- rules: discrete-text-sequence (打字含停頓；游標閃爍同規則的 square-wave 樣式), spring-pop-entrance (氣泡／建議卡), kinetic-beat-slam (字卡)
- sfx: 26.5s typewriter tick (0.2)；32.1s message pop (0.25)

## Frame 8 — 能力二：換班預檢

- scene: 亮場。極簡瀏覽器框（無假紅綠燈）承載換班預檢畫面。相位 A：選 A、B 兩人→按預檢→danger 攔截卡彈出，畫面輕推近，字卡「換班預檢」；相位 B（軟切）：放行案例 ok 綠＋法規依據逐條亮起，字卡「擋下時，法條攤在眼前」。小標「能力二・換班簽核預檢」
- duration: 9.6s
- poster: 3.5s
- transition_in: cut
- status: animated
- voiceover: "換班先預檢。違規的，當場擋下；放行的，附上法規依據。"
- src: compositions/frames/08-cap2-swap.html
- window: 36.3–45.9
- spec_scenes: S10+S11（內部相位軟切）
- blueprint: device-surface-showcase (Adapt — 視窗英雄、畫面流轉；素材＝真實錄屏，退化 mock 復刻)
- rules: coordinate-target-zoom (攔截瞬間 punch-in), waterfall-entry (法據逐條；攔截卡與字卡以快速 fromTo scale 落下), kinetic-beat-slam (字卡)
- sfx: 38.9s soft ui click (0.3)；40.1s low soft thump (0.3)
- assets: assets/rec-swap-block.mp4, assets/rec-swap-ok.mp4 [待補充素材→退化 mock]

## Frame 9 — 能力三：主任的儀表板

- scene: 亮場。儀表板外框。相位 A：今日戰情板（KPI 卡＋缺口列表，示範資料），輕推近掃過重點卡，抬頭小字「——給護理部主任」；相位 B（軟切）：留任雷達（負荷五維名單）cascade 亮起、高負荷列 pulse，字卡「留任雷達」。小標「能力三・今日戰情板」
- duration: 9.6s
- poster: 3.5s
- transition_in: cut
- status: animated
- voiceover: "主任的儀表板：人力缺口、負荷，還有留任風險——一頁看完。"
- src: compositions/frames/09-cap3-dash.html
- window: 45.9–55.5
- spec_scenes: S12+S13（內部相位軟切）
- blueprint: device-surface-showcase (Adapt — 儀表板換頁；素材＝真實錄屏，退化 mock 復刻)
- rules: coordinate-target-zoom, waterfall-entry (雷達列), sine-wave-loop (高負荷列 pulse)
- sfx: 無
- assets: assets/rec-dashboard.mp4, assets/rec-retention.mp4 [待補充素材→退化 mock]

## Frame 10 — 信任一：AI 的權限邊界

- scene: 亮場。左右對照鏡面開場：左欄「AI」(ink-faint 弱化)——聽懂人話／不碰數字；右欄「規則引擎」(accent)——算工時／守法規；中央 hairline 分工線。旁白讀到關鍵句時 marker 橫掃右欄。BGM 已壓最低，旁白獨走（安靜即設計）
- duration: 6.4s
- poster: 4.0s
- transition_in: cut
- status: animated
- voiceover: "最關鍵的一件事：AI，沒有計算工時的權限。"
- src: compositions/frames/10-trust-versus.html
- window: 55.5–61.9
- spec_scenes: S14
- blueprint: comparison-split (Reproduce — 鏡面對開雙欄＋徽章 punctuate)
- rules: split-tilt-cards, css-marker-patterns (marker)
- sfx: 無

## Frame 11 — 信任二：勞基法內建

- scene: 亮場。瀏覽器框內規則手冊 H1–H10 逐條勻速捲動（法源字樣照平台實際文案），「母性保護」經過時輕 pulse 不停留；字卡「勞基法規則內建」
- duration: 5.2s
- poster: 2.6s
- transition_in: cut
- status: animated
- voiceover: "數字歸規則引擎，勞基法十條硬規則內建，"
- src: compositions/frames/11-trust-rules.html
- window: 61.9–67.1
- spec_scenes: S15
- blueprint: transcript-scroll-artifact-reveal (Adapt — 縱向捲讀即證據，無 pivot)
- rules: viewport-change (捲動), sine-wave-loop (pulse), kinetic-beat-slam (字卡)
- sfx: 無
- assets: assets/rec-rules.mp4 [待補充素材→退化 mock（src/rules.js 真實條文復刻）]

## Frame 12 — 信任三：98 項測試

- scene: 亮場。大數字「98」(stat 檔、accent) 居中偏左 counts up 從 0 滾到 98、落定 pulse；副標「每一條規則，都有測試把關」兩行 cascade；左下來源小字「repo 內 tests/ 全數通過」
- duration: 3.4s
- poster: 2.4s
- transition_in: cut
- status: animated
- voiceover: "98 項自動測試把關。"
- src: compositions/frames/12-trust-98.html
- window: 67.1–70.5
- spec_scenes: S16
- blueprint: dataviz-countup (Reproduce — count-up 數字英雄)
- rules: counting-dynamic-scale, waterfall-entry
- sfx: 68.9s low soft thump (0.3)

## Frame 13 — 核心句

- scene: 亮場大留白。兩行 hero 置中——「班表照顧好，」／「人就留得住」按詞 cascade，「留得住」accent＋marker 橫掃；其餘元素全退場，長靜帧消化。BGM 自此回暖放出
- duration: 5s
- poster: 3.5s
- transition_in: cut
- status: animated
- voiceover: "班表照顧好，人就留得住。"
- src: compositions/frames/13-core-line.html
- window: 70.5–75.5
- spec_scenes: S17
- blueprint: titlecard-reveal (Adapt — 呼吸鏡：一次克制入場＋靜帧)
- rules: waterfall-entry, css-marker-patterns (marker)
- sfx: 無；BGM 回暖

## Frame 14 — CTA：現在就能試

- scene: 亮場。極簡瀏覽器框居中，URL 列「bobyu89.github.io/nursing-agent」可讀；視窗內標準字＋accent 實心按鈕「立即體驗示範平台」——CTA 動作壓在前 3 秒（框浮入、按鈕 slam＋pulse 一次），其後靜帧停留，末尾 dissolve 收黑（全片唯一 exit）。BGM 76.5–80.9 fade-out
- duration: 5.4s
- poster: 3.0s
- transition_in: crossfade
- status: animated
- voiceover: "班守 ShiftGuard，現在就能試。"
- src: compositions/frames/14-cta.html
- window: 75.5–80.9
- spec_scenes: S18
- blueprint: titlecard-reveal (Adapt — CTA end-card，收於停留)
- rules: spring-pop-entrance, press-release-spring (按鈕 pulse), ambient-glow-bloom (按鈕後極淡光暈)
- sfx: 無
