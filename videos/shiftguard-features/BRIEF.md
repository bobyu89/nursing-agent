---
workflow: general-video
flow: automation
storyboard: no
message: "十個任務，走完一條治理鏈"
destination: embed
aspect: 1920x1080
language: zh-TW
length: ~3min
angle: walkthrough
voice: zh-TW-HsiaoChenNeural
---

## Intent

班守 ShiftGuard 第二支影片：**功能導覽片（任務式）**。與招商片分工——招商片賣
「為什麼」，本片帶「怎麼用」：十個任務按角色階梯（護理師→護理長→督導→主任）
從頭做到尾，每個任務有步驟卡逐步亮起、游標實際操作、綠色 ✓ 完成態收束。
觀眾看完等於自己操作過一遍。分鏡 v2 已由用戶逐鏡審定（對話中），任務清單：
①回報缺班 ②發起換班 ③生成週班表 ④補缺口（含留痕）⑤簽核換班單 ⑥看戰情板
⑦跨單位借人 ⑧盤留任 ⑨護病比重算 ⑩政策沙盤；另有治理底座巡禮、十任務回顧牆、CTA。

## Assets

- ../shiftguard-promo/design.md → ./design.md — ShiftGuard Indigo 主題原樣沿用。
- ../shiftguard-promo/compositions/frames/（參考）— LINE 重建規範、步驟卡樣式、
  瀏覽器／儀表板外框、守守頭像 SVG、封面幕文法，全部沿用同一視覺系統。
- ../../src/（內容真相源）— data.js／rules.js／botcore.js／app.js 的真實文案與資料。

## Customizations

- 旁白：edge-tts 曉臻（zh-TW-HsiaoChenNeural）自然語速；先配音量實速再釘時窗。
- BGM：warm-piano 同曲床（audition 曲源沿用）＋carve＋宏觀車道；教學片基準音量再低一階。
- 步驟卡＝敘事主裝置：每任務 ①..→✓，完成態綠色＋收束句。
- 章節卡 ×4（角色）＋封面幕（poster 無縫）。無 shader；反白閃屏 0 次（教學片不需要）。

## Notes

- 反例四條沿用（不假造、不 emoji、不漸層、不炫技快剪）；畫面數字皆取平台示範資料，
  UI 重建掛「示範資料」角標。
- 招商片講過的信任論證不重演，僅收尾一句 callback。
- 預估 3:00–3:20（曉臻實速為準）。
