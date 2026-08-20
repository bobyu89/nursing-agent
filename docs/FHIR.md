# FHIR 介接規格（HL7 FHIR R4／TW Core IG）

台灣衛福部以 HL7 FHIR 及**台灣核心實作指引（TW Core IG）**作為醫療資訊交換的推動標準
（電子病歷交換單張已逐步改以 FHIR 表達）。班守把班表資料對映為 FHIR 資源，
讓排班／替班結果能與院內系統、國家標準介接。

實作：`src/fhir.js`（純函式、零依賴，瀏覽器與 Node 共用）；
操作介面：平台「治理 → 9 FHIR 介接」；測試：`tests/fhir.test.js`。

## 資源對映

| 內部資料 | FHIR 資源 | Profile | 關鍵欄位 |
|---|---|---|---|
| 醫院 | `Organization` | TW Core | `name`、`active` |
| 單位（`UNITS`） | `Location` | TW Core | `identifier`（unit-id）、`name`、`managingOrganization` |
| 人員主檔（`STAFF`，代號） | `Practitioner` | TW Core | `identifier`（staff-id）、`name.text`（僅代號）、`qualification`（證照＋`period.end` 效期；N1–N4／AHN 進階） |
| 職務 × 所屬單位 | `PractitionerRole` | TW Core | `practitioner`、`organization`、`code`（職務）、`location` |
| 人員 × 單位的班表 | `Schedule` | R4 基礎 | `actor`（Practitioner ＋ Location）、`planningHorizon` |
| 班次（`SHIFTS`） | `Slot` | R4 基礎 | `schedule`、`serviceType`（D／E／N 自訂 CodeSystem）、`start`／`end`、`status: busy`、替補班次註記於 `comment` |

設計要點：

- **Schedule 以（人員 × 單位）為單位**：actor 同時掛 Practitioner 與 Location，
  跨單位支援的班次自然歸入不同 Schedule，匯入端由參照鏈還原單位，不靠自由文字。
- **大夜跨日**：`N` 班 23:00–07:00 的 Slot `end` 落在翌日早上（`+08:00` 時區，台灣無日光節約）。
- **代號化**：`Practitioner.name` 只有代號（如 `N-01（代號）`），Bundle 不含姓名與任何病患資料。

## 誠實聲明（標準對齊的邊界）

- FHIR R4 **沒有「排班表」專用資源**；`Schedule`＋`Slot` 是 HL7 對人員值班時段
  （availability）的標準表達法。TW Core IG 未對這兩個資源另訂 profile，
  故以 R4 基礎資源表達；`Practitioner`／`PractitionerRole`／`Organization`／`Location`
  則於 `meta.profile` 宣告 TW Core profile 並取必填子集。
- 命名系統（`https://shiftguard.example.tw/fhir/...`）為示範 URL；
  正式導入時應改為院方登記之 OID／URL，並將人員 identifier 對接院內人事系統。

## 匯出

`fhirExportBundle(db, opts)` → FHIR R4 `Bundle`

- `opts.mode: 'collection'`（預設）——存檔／傳遞用。
- `opts.mode: 'batch'`——推送 FHIR Server 用：每筆資源帶
  `request: { method: 'PUT', url: '{type}/{id}' }`，**重送不會重複建立**（idempotent upsert）。
- 推送方式：`POST {FHIR base URL}`、`Content-Type: application/fhir+json`。
  DEMO 不附驗證資訊；正式導入應以 **SMART on FHIR（OAuth 2.0）** 授權並經院方資安審查。

## 匯入（白名單驗證）

`fhirImportBundle(bundle, db)` → `{ shifts, errors, counts }`

驗證鏈（只信參照與白名單，不信任何自由文字）：

```
Slot.schedule → Schedule.actor → Practitioner.identifier（staff-id 系統）
                               → Location.identifier（unit-id 系統）
```

逐筆檢查：人員 ∈ 人員主檔、單位 ∈ 單位白名單、日期真實存在
（`2026-02-31` 這種格式對但不存在的日期一律拒絕）、班別可辨識
（`serviceType` 的 shift-type coding 優先；缺失時以起始時刻比對班別定義為退路）、
同一（人員×日期×班別）去重。**不合法逐筆報告原因、一律不套用**；
套用時僅取代匯入內容涵蓋的（人員×日期），其餘班次不動，且寫入決策留痕。

## 與規則引擎的關係

FHIR 層只做**格式轉換**，不做合規判斷；匯入套用後，缺口總覽、主動預警
（含勞基法四週彈性工時 H7–H9）會立即以同一份規則引擎重算——
外部系統排出的班表若違法，會在預警上直接現形。
