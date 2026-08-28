---
workflow: general-video
flow: automation
storyboard: no
message: "班表照顧好，人就留得住"
destination: embed
aspect: 1920x1080
language: zh-TW
length: 75s
angle: promo
---

## Intent

班守 ShiftGuard 的招商產品片，放在 landing page（home.html）內嵌給陌生訪客看，
Demo Day 亦現場播放。雙層收訊：畫面主角是護理長（凌晨缺班、換班人情、風險自扛），
每段收尾的「所以你得到什麼」抬頭講給護理部主任（留任、法遵、數據）。語氣冷靜、
直白、帶鋒利——「離職單上寫『家庭因素』」的聲音；音樂反而溫暖（全片母錯位）。
看完唯一要記住的一句：「班表照顧好，人就留得住」；唯一動作：點「立即體驗示範平台」。

**執行真相源：`./video-spec.md`** —— 用戶已逐句審定的 9 節規格（18 鏡分鏡表、
音頻時間軸、素材清單、反例硬規則），時間釘到 0.1s，總長 75.0s。本檔為意圖摘要，
分鏡層級一律以 video-spec.md 為準。

## Assets

- ./video-spec.md — 完整規格與 18 鏡分鏡表；旁白為用戶審定逐字稿（verbatim）。
- ./design.md — ShiftGuard Indigo 主題；色票一字不差取自平台 assets/styles.css。
- ../../index.html（線上 https://bobyu89.github.io/nursing-agent/）— 活的平台，
  錄屏素材來源（換班預檢／戰情板／留任雷達／規則手冊）。

## Customizations

- 平台真實錄屏 5 段由 agent 以瀏覽器操作錄製（清單見 video-spec § 5）；
  個別段落可退化為 mock 復刻，需同步更新 § 6 素材依賴。
- LINE 對話重建（chat-thread 改 LINE 視覺，規範見 design.md § Components）。
- 旁白：本地 TTS 中文（繁中），voice 試聽後定；語速 1.05。
- BGM：暖鋼琴弦樂（免版稅，搜尋條件見 video-spec § 5）；音效僅極輕介面音。
- 反白閃屏全片 1 次（S05→S06 亮相）；無 shader、無音頻反應。
- 無聲播放友好：字卡承擔完整敘事線，不加逐句字幕。

## Notes

- 反例四條為渲染硬規則：不要罐頭勵志／簡報模板腔；不要 emoji 與卡通插畫；
  不要假見證假 logo 假數字（畫面數字皆須有平台真實出處）；不要快剪炫技節奏。
- Scene 16 的「98」以渲染前 node tests 實跑數為準。
- 待與用戶確認：LINE 重建中的機器人頭像是否使用平台新吉祥物「守守」
  （北極熊，commit 664eb6e 起為正式品牌資產）——更貼近真實 bot 外觀。
- 交付 mp4（H.264）供 landing page 內嵌；渲染畫質草稿 standard、定稿 high。
