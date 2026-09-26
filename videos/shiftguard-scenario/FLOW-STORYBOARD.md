# 情境片《凌晨三點的護理長》— Google Flow 分鏡與提示詞

> 班守 ShiftGuard 第三支影片：**動畫情境片（日系動畫風）**。招商片講「為什麼」、導覽片講「怎麼用」，
> 這支補的是前兩支都沒有的東西——**讓人看見那個晚上**。
> 現有兩支片 100% 是文字動畫與 UI，畫面裡沒有任何「人的存在」，所以「痛」只被說出來、沒有被看見。
>
> 產出：10 鏡 × 8 秒原始素材（80 秒）→ 剪成 45–50 秒成片。
> 旁白與配樂沿用現有管線（曉臻 TTS ＋ warm-piano），Flow 只負責畫面與環境音。

---

## 零、動手前必須知道的五件事

**0. 全片是日系動畫風，不是實拍。**
走**劇場版動畫的寫實日常系**——手繪背景美術＋賽璐璐人物，光線是主角，
不是萌系也不是扁平插畫。風格定義、色票與反例全部在
[CHARACTER-SETUP.md](CHARACTER-SETUP.md) 第一節。
每個 prompt 的風格尾巴已經統一改成
`2D anime film still, hand-painted background, cel-shaded, theatrical slice-of-life style,`，
排除區塊也加了 `no moe or chibi styling, no oversized eyes, no pastel colors`。

改動畫風解掉三件事：AI 真人臉的恐怖谷、跨鏡一致性、
以及「假見證」的倫理疑慮（沒有人會把動畫誤認成真實護理師）。
代價是要跟招商片的幾何字卡靠色票統一——已經用同一組 ShiftGuard Indigo 處理。

**1. 全片不用 AI 對白。**
Veo 3.1 官方提示指南通篇只示範英文對白，沒有任何中文對白的支援說明；中文口型與發音
在實測中不穩。所以本分鏡**刻意設計成沒有任何角色說話**——只有環境音與音效，
旁白全部後製疊上（用現有的曉臻 TTS，跟另外兩支片同一把聲音，聽起來才是同一個品牌）。
附帶好處：不會被 Veo 自動燒進畫面的英文字幕拖累。

**2. 一鏡最多 8 秒。**
Flow 單次生成 4／6／8 秒。所有分鏡都按 8 秒設計，剪接時各鏡只取最好的 3–5 秒。

**3. 螢幕一律留白，真實畫面後製合成。**
這是本片最重要的技術決定。手機與筆電的螢幕在 prompt 裡一律指定為
「失焦的光」或「純白無介面」——因為 AI 生的 UI 是假的，會直接踩到你自己在 BRIEF
訂的硬規則「不要假見證假 logo 假數字」。留白之後，把**真正的平台畫面與 LINE 對話**
合成上去，畫面是真人實景、介面是真產品，兩邊都不作假。

**4. 倫理紅線（已寫進每個 prompt）。**
不出現病人、不出現任何病床上的人、不出現可辨識的醫院名稱或 logo、識別證留白。
成片右下角固定掛角標「情境示意．非真實人物與病房」。
Flow 產出的每支影片都內嵌 Google SynthID 浮水印，這點對評審反而是加分——
你可以誠實說「情境是 AI 重現的，產品畫面是真的」。

---

## 一、角色設定卡（逐字複製到每一個 prompt）

Veo 無法在生成後修改角色的臉與服裝，跨鏡一致性只能靠**每次都貼同一段描述**＋
Ingredients 參考圖。以下這段請一字不改地貼進每個 prompt：

```
a Taiwanese woman, 42 years old, head nurse, black shoulder-length hair tied
in a low bun, thin wire-frame glasses, navy blue scrubs under an off-white
cardigan, a plain lanyard badge with no text, no makeup, tired eyes with faint
dark circles
```

## 二、場景設定卡（同樣逐字複製）

```
a small Taiwanese hospital ward nurse station at 3 AM, pale fluorescent tube
lighting, beige laminate counter, stacked paper charts, a wall-mounted
whiteboard with a hand-drawn grid, a long dark corridor behind, no signage,
no logos, no patients
```

## 三、排除區塊（接在每個 prompt 最後）

```
No moe or chibi styling, no oversized eyes, no pastel colors. No on-screen text, no subtitles, no captions, no logos, no brand names,
no patients, no visible faces other than the head nurse.
```

---

## 四、前置：先做參考圖（決定成敗的一步）

跳過這步，十個鏡頭會生出十個不同的人。

**三張設定圖的完整提示詞、人物設定表與驗收清單，全部在
→ [CHARACTER-SETUP.md](CHARACTER-SETUP.md)**（用 ChatGPT 產圖，中文提示詞可直接改）

那份文件產出三張：

| 設定圖 | 內容 | 用途 |
|---|---|---|
| A | 角色三面設定（正面／四分之三／正側面全身） | 鎖定臉、髮型、眼鏡、衣著 |
| B | 表情集（平靜疲憊／揉鼻樑／猶豫／釋然） | 鎖定表演的情緒範圍 |
| C | 場景美術設定（無人的護理站） | 鎖定台灣病房的樣子 |

做完之後：

1. 下載原圖（用下載鍵，不要截圖）
2. 進 Flow → **Ingredients to Video**，三張全部上傳（上限 3 張，剛好用滿）
3. 之後每個 prompt 開頭固定加這句：
   `Using the provided reference images for the head nurse and the nurse station,`

> 設定圖階段就要把「台灣的病房」修對——動畫風特別容易滑向日本醫院。
> 這一步錯了，後面十鏡全部要重來。

---

## 五、分鏡表

| # | 秒數 | 內容 | 對應旁白 | 後製 |
|---|---|---|---|---|
| S1 | 8s | 空的護理站，凌晨三點 | 「凌晨三點，病房安靜下來。」 | — |
| S2 | 8s | 護理長獨自坐著，班表攤開 | 「護理長還沒下班。」 | — |
| S3 | 8s | 手機亮起（螢幕失焦） | 「一則訊息進來——」 | **合成真實 LINE 對話** |
| S4 | 8s | 摘眼鏡、揉鼻樑、嘆氣 | 「明天的白班，有人上不了。」 | — |
| S5 | 8s | 手指劃過紙本班表，停住 | 「誰還有空、誰已經連上五天、誰昨天才下大夜。」 | — |
| S6 | 8s | 白板上塗改過的班表 | 「這些，沒有系統幫她算。」 | — |
| S7 | 8s | 拿起話筒又放下 | 「她只能一個一個問。」 | — |
| S8 | 8s | 天亮了，她還在原位 | 「天亮了，班還是缺一個人。」 | — |
| S9 | 8s | 打開筆電（螢幕純白） | 「這一次，她不用自己算。」 | **合成真實平台畫面** |
| S10 | 8s | 靠向椅背，鬆一口氣 | 「班表照顧好，人就留得住。」 | 核心句字卡 |

S1–S8 是痛（冷色調），S9 是轉折，S10 是收（回暖）。色溫走向跟招商片的
「暗場→亮場」同一個邏輯，剪在一起不會打架。

---

## 六、十個 Prompt（可直接貼進 Flow）

每個 prompt 都已含角色卡、場景卡與排除區塊。開頭的 `Using the provided reference
images...` 若你沒用 Ingredients 就刪掉。

### S1 — 空景定場

```
Using the provided reference images for the nurse station, wide static shot of
an empty small Taiwanese hospital ward nurse station at 3 AM, pale fluorescent
tube lighting over a beige laminate counter stacked with paper charts, a wall
clock, a long dark corridor receding behind with one faintly flickering light,
no people. Ambient noise: the low hum of fluorescent tubes, a distant monitor
beeping every few seconds, the faint whir of an air conditioner. 2D anime film
still, hand-painted background, cel-shaded, theatrical slice-of-life style,
cold blue-green tones, desaturated, fine grain, still and lonely.
No moe or chibi styling, no oversized eyes, no pastel colors. No on-screen text, no subtitles, no captions, no logos, no brand names,
no patients.
```

### S2 — 她還在

```
Using the provided reference images for the head nurse and the nurse station,
medium wide shot with a very slow push in. A Taiwanese woman, 42 years old,
head nurse, black shoulder-length hair tied in a low bun, thin wire-frame
glasses, navy blue scrubs under an off-white cardigan, a plain lanyard badge
with no text, tired eyes with faint dark circles, sits alone at the nurse
station under fluorescent light with a paper shift roster spread before her and
a cold cup of tea beside it. She stares down at the roster, barely moving.
Ambient noise: fluorescent hum, distant beeping. 2D anime film still, hand-painted background, cel-shaded, theatrical slice-of-life style, cold blue-green
tones, desaturated, quiet and heavy. No moe or chibi styling, no oversized eyes, no pastel colors. No on-screen text, no subtitles, no logos,
no patients.
```

### S3 — 訊息進來（螢幕留白給後製）

```
Using the provided reference images for the head nurse, extreme close-up with
very shallow depth of field. A phone lying on a beige counter beside a paper
roster lights up in the dark; the screen is completely out of focus, showing
only a soft glow with no readable content, its light spilling across the
woman's hand and the lower rim of her wire-frame glasses. Her thumb hovers
above it without tapping. SFX: a single soft notification chime, then silence.
Ambient noise: fluorescent hum. 2D anime film still, hand-painted background, cel-shaded, theatrical slice-of-life style, cold blue-green tones with a warm
screen glow, desaturated, tense stillness. No moe or chibi styling, no oversized eyes, no pastel colors. No on-screen text, no subtitles,
no user interface, no logos.
```

### S4 — 疲憊

```
Using the provided reference images for the head nurse, static close-up. The
head nurse — 42, black hair in a low bun, thin wire-frame glasses, navy scrubs
under an off-white cardigan — takes off her glasses, presses thumb and
forefinger to the bridge of her nose with her eyes closed, and exhales slowly.
Overhead fluorescent light carves hard shadows beneath her eyes. She puts the
glasses back on and looks off-frame toward the roster. Ambient noise:
fluorescent hum, a distant door closing far down the corridor. 2D anime film still, hand-painted background, cel-shaded, theatrical slice-of-life style, cold
blue-green tones, desaturated, intimate and exhausted. No dialogue, no
on-screen text, no subtitles, no logos.
```

### S5 — 在名字之間猶豫

```
Overhead close-up, slow tracking. A woman's finger moves left to right across
a printed shift roster grid lying on a beige laminate counter, pauses on one
row, lifts, and hovers without committing. The grid is dense with faint
handwriting and pencil corrections; all writing is soft, blurred and
completely unreadable. SFX: paper rustling, a fingernail tapping once on the
counter. Ambient noise: fluorescent hum. 2D anime film still, hand-painted background, cel-shaded, theatrical slice-of-life style, cold blue-green tones,
shallow depth of field, desaturated, hesitant. No moe or chibi styling, no oversized eyes, no pastel colors. No on-screen text, no subtitles,
no legible writing, no logos.
```

### S6 — 白板上的痕跡

```
Slow lateral tracking shot along a wall-mounted whiteboard covered with a
hand-drawn shift grid, crossed-out entries, smudged dry-erase marks and layers
of correction, lit only by pale corridor fluorescent light; all handwriting is
blurred and illegible. Two magnets hold a curling paper notice at the edge.
SFX: the faint squeak of a marker cap, distant footsteps in the corridor.
Ambient noise: fluorescent hum, air conditioner. 2D anime film still, hand-painted background, cel-shaded, theatrical slice-of-life style, cold blue-green
tones, desaturated, quietly chaotic. No moe or chibi styling, no oversized eyes, no pastel colors. No on-screen text, no subtitles, no
legible writing, no logos, no patients.
```

### S7 — 拿起又放下

```
Using the provided reference images for the head nurse and the nurse station,
static medium close-up with shallow depth of field. The head nurse lifts a desk
phone handset, holds it near her ear without dialing, hesitates for a long
beat, then slowly returns it to its cradle. Her other hand stays flat on the
paper roster. SFX: the soft click of a handset lifting, a long pause, then the
heavier click of it settling back. Ambient noise: fluorescent hum, distant
monitor beeping. 2D anime film still, hand-painted background, cel-shaded, theatrical slice-of-life style, cold blue-green tones, desaturated, reluctant.
No dialogue, no moe or chibi styling, no oversized eyes, no pastel colors, no on-screen text, no subtitles, no logos.
```

### S8 — 天亮

```
Using the provided reference images for the head nurse and the nurse station,
wide static shot with an almost imperceptible slow push in. The same head nurse
still seated at the nurse station, now lit by pale grey dawn light from a
window at the end of the corridor mixing with the overhead fluorescents; the
roster still open before her, the tea untouched. She rubs her eyes and
straightens her cardigan. Ambient noise: early morning ward sounds, a cart
wheeling past far away, faint birdsong outside. 2D anime film still, hand-painted background, cel-shaded, theatrical slice-of-life style, cool grey-blue dawn
tones, desaturated, weary. No moe or chibi styling, no oversized eyes, no pastel colors. No on-screen text, no subtitles, no logos,
no patients.
```

### S9 — 轉折（螢幕純白，後製貼真實平台）

```
Using the provided reference images for the head nurse and the nurse station,
over-the-shoulder medium shot, static, shallow depth of field. The head nurse
opens a laptop at the nurse station; the screen is a clean flat blank white
rectangle with no interface, no icons and no text, its even light falling on
her face and glasses. Her hands rest on the keyboard, still. Ambient noise:
fluorescent hum, the soft click of a laptop hinge. 2D anime film still, hand-painted background, cel-shaded, theatrical slice-of-life style, cold blue-green
tones warming very slightly, desaturated, the feeling of a held breath.
No moe or chibi styling, no oversized eyes, no pastel colors. No on-screen text, no subtitles, no user interface, no icons, no logos.
```

### S10 — 收：鬆一口氣

```
Using the provided reference images for the head nurse and the nurse station,
medium shot with a slow push in. The head nurse leans back into her chair,
shoulders dropping as she lets out a long breath; a small, tired smile forms as
she turns toward the window where dawn light is rising. The corridor behind her
falls into soft warm focus. Ambient noise: quiet morning ward sounds, a distant
muffled conversation. 2D anime film still, hand-painted background, cel-shaded, theatrical slice-of-life style, tones warming from grey to soft gold, gentle
contrast, desaturated but hopeful, calm resolution. No dialogue, no on-screen
text, no subtitles, no logos, no patients.
```

---

## 七、旁白稿（後製配音，曉臻 zh-TW-HsiaoChenNeural）

沿用另外兩支片的同一把聲音。每句對應的鏡次見分鏡表。

```
凌晨三點，病房安靜下來。護理長還沒下班。
一則訊息進來——明天的白班，有人上不了。
誰還有空、誰已經連上五天、誰昨天才下大夜。
這些，沒有系統幫她算。她只能一個一個問。
天亮了，班還是缺一個人。
這一次，她不用自己算。
班表照顧好，人就留得住。
```

最後一句是招商片的核心句，三支片就靠這句串成同一個世界。

---

## 八、操作順序

1. Gemini 2.5 Flash Image 生 3 張參考圖 → 上傳 Flow 的 Ingredients
2. S1 先生，確認光線與色調你能接受，再往下做（第一鏡定調，不要一次全生）
3. 每鏡生 3–4 個 take，挑一個；重生時 prompt 一個字都別改，只按重新生成
4. 十鏡到齊後匯出，進剪輯：各鏡取 3–5 秒 → 疊旁白 → 疊 warm-piano → 合成 S3／S9 的真實畫面 → 掛角標
5. 成片 45–50 秒，可獨立當情境片，也可以剪進招商片開頭取代現在的純文字痛點段

## 九、已知風險

- **一致性仍會漂**：即使有 Ingredients，臉還是可能鏡與鏡之間微變。對策是把她的臉
  在剪接時盡量用中景與背影、特寫留給手與物件（S3、S5、S6、S7 本來就是這樣設計的）。
- **中文環境細節不準**：Veo 對台灣醫院的樣子沒有概念，可能生出偏西式的病房。
  參考圖階段就要把這個修對，不要留到生影片才發現。
- **Flow 需要 Google AI Pro／Ultra 訂閱**，生成按 credits 計。十鏡各 4 個 take
  是 40 次生成，先確認你的額度夠再開始。
