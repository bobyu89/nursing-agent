/**
 * fhir.js — FHIR R4 介接層（HL7 FHIR R4／台灣核心實作指引 TW Core IG）
 *
 * 台灣衛福部近年以 FHIR（TW Core IG）作為醫療資訊交換的推動標準。
 * 本檔提供內部班表資料與 FHIR 資源的「雙向、確定性」轉換：
 *
 *   匯出  fhirExportBundle(db, opts) → Bundle
 *     Organization（醫院）＋ Location（病房單位）＋ Practitioner（護理人員，
 *     含證照效期 qualification）＋ PractitionerRole（職務×單位）＋
 *     Schedule（人員×單位的班表容器）＋ Slot（每一班次一筆，status: busy）
 *
 *   匯入  fhirImportBundle(bundle, db) → { shifts, errors, counts }
 *     解析 Bundle 中的 Slot（經 Schedule → Practitioner／Location 參照鏈
 *     還原人員與單位），逐筆白名單驗證：人員∈STAFF、單位∈UNITS、
 *     日期真實存在、班別可辨識——不合法逐筆報告原因、一律不套用。
 *
 * 資源對映的誠實聲明：
 * - Practitioner／PractitionerRole／Organization／Location 宣告 TW Core profile
 *   （meta.profile），欄位取 TW Core 之必填子集。
 * - FHIR R4 沒有「排班表」專用資源；Schedule＋Slot 是 HL7 對人員值班
 *   （availability）的標準表達法，TW Core 未另訂 profile，故以 R4 基礎資源表達。
 * - 人員一律以代號（N-01）為 identifier 與 name.text，不含任何真實姓名。
 *
 * 與 engine.js 同一設計哲學：純函式、資料由參數注入、零相依、
 * 瀏覽器 <script> 與 Node（CI 測試）皆可載入。
 */

/* ── 命名系統與 profile 常數 ───────────────────────────── */

/** 本平台自訂命名系統（正式導入時改為院方向衛福部登記的 OID／URL） */
const FHIR_SYSTEM = {
  staffId: 'https://shiftguard.example.tw/fhir/NamingSystem/staff-id',
  unitId: 'https://shiftguard.example.tw/fhir/NamingSystem/unit-id',
  shiftType: 'https://shiftguard.example.tw/fhir/CodeSystem/shift-type',
  cert: 'https://shiftguard.example.tw/fhir/CodeSystem/nursing-cert',
  ladder: 'https://shiftguard.example.tw/fhir/CodeSystem/nursing-ladder',
};

/** 台灣核心實作指引 TW Core IG 的 StructureDefinition（衛福部公告） */
const TW_CORE_PROFILE = {
  Organization: 'https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Organization-twcore',
  Location: 'https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Location-twcore',
  Practitioner: 'https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/Practitioner-twcore',
  PractitionerRole: 'https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/PractitionerRole-twcore',
};

/** 台灣時區固定 +08:00（無日光節約） */
const FHIR_TZ = '+08:00';

/* ── 小工具（刻意不依賴 engine.js，本檔可獨立載入）───────── */

/** 格式正確且真實存在的日期才通過（與引擎同一道理：JS Date 會無聲進位） */
function fhirIsValidDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false;
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function fhirAddDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/** FHIR id 僅允許 [A-Za-z0-9\-\.]，其餘字元以 '.' 取代（防注入與非法 id） */
function fhirIdSafe(s) {
  return String(s).replace(/[^A-Za-z0-9\-.]/g, '.').slice(0, 64);
}

/** 班次的 FHIR 起訖時間（instant）；大夜跨日由 overnight 決定 */
function fhirShiftPeriod(dateStr, type) {
  const endDate = type.overnight ? fhirAddDays(dateStr, 1) : dateStr;
  return {
    start: `${dateStr}T${type.start}:00${FHIR_TZ}`,
    end: `${endDate}T${type.end}:00${FHIR_TZ}`,
  };
}

/* ── 匯出：內部資料 → FHIR Bundle ─────────────────────── */

/**
 * @param {object} db  { staff, shifts, units, shiftTypes, certs, ladderLevels }
 *                     （與 createEngine 的注入來源同一份資料）
 * @param {object} opts
 *   mode      'collection'（存檔交換用，預設）｜'batch'（推送 FHIR Server 用，
 *             每筆資源帶 PUT request，重送不會重複建立）
 *   hospital  { id, name } 醫院組織資訊（預設 DEMO 佔位）
 * @returns FHIR R4 Bundle（純資料物件，呼叫端自行 JSON.stringify）
 */
function fhirExportBundle(db, opts = {}) {
  const mode = opts.mode === 'batch' ? 'batch' : 'collection';
  const hospital = opts.hospital || { id: 'org-shiftguard-demo', name: '示範醫院（班守 ShiftGuard DEMO）' };
  const resources = [];

  // Organization（醫院）
  resources.push({
    resourceType: 'Organization',
    id: fhirIdSafe(hospital.id),
    meta: { profile: [TW_CORE_PROFILE.Organization] },
    active: true,
    name: hospital.name,
  });

  // Location（病房單位）
  Object.entries(db.units).forEach(([code, name]) => {
    resources.push({
      resourceType: 'Location',
      id: fhirIdSafe(`loc-${code}`),
      meta: { profile: [TW_CORE_PROFILE.Location] },
      status: 'active',
      identifier: [{ system: FHIR_SYSTEM.unitId, value: code }],
      name,
      mode: 'instance',
      managingOrganization: { reference: `Organization/${fhirIdSafe(hospital.id)}` },
    });
  });

  // Practitioner（護理人員；代號化，證照與進階以 qualification 表達）
  db.staff.forEach((s) => {
    const qualification = Object.entries(s.certs || {}).map(([code, expiry]) => ({
      code: {
        coding: [{ system: FHIR_SYSTEM.cert, code, display: (db.certs || {})[code] || code }],
        text: (db.certs || {})[code] || code,
      },
      period: { end: expiry },
    }));
    if (s.ladder) {
      const lv = (db.ladderLevels || {})[s.ladder];
      qualification.push({
        code: {
          coding: [{ system: FHIR_SYSTEM.ladder, code: s.ladder, display: lv ? lv.name : s.ladder }],
          text: lv ? lv.name : s.ladder,
        },
      });
    }
    resources.push({
      resourceType: 'Practitioner',
      id: fhirIdSafe(`pra-${s.id}`),
      meta: { profile: [TW_CORE_PROFILE.Practitioner] },
      active: true,
      identifier: [{ system: FHIR_SYSTEM.staffId, value: s.id }],
      name: [{ text: `${s.id}（代號）` }],
      qualification,
    });
  });

  // PractitionerRole（職務 × 所屬單位）
  db.staff.forEach((s) => {
    resources.push({
      resourceType: 'PractitionerRole',
      id: fhirIdSafe(`rol-${s.id}`),
      meta: { profile: [TW_CORE_PROFILE.PractitionerRole] },
      active: true,
      practitioner: { reference: `Practitioner/${fhirIdSafe(`pra-${s.id}`)}`, display: s.id },
      organization: { reference: `Organization/${fhirIdSafe(hospital.id)}` },
      code: [{ text: s.role }],
      location: [{ reference: `Location/${fhirIdSafe(`loc-${s.unit}`)}`, display: (db.units || {})[s.unit] || s.unit }],
    });
  });

  // Schedule（人員 × 單位；actor 同時掛 Practitioner 與 Location，
  // 跨單位支援班次自然歸入不同 Schedule）＋ Slot（每一班次一筆）
  const schedules = {};   // key: staffId|unit → schedule 資源（planningHorizon 累積）
  const slotIds = new Set();
  const slots = [];

  db.shifts.forEach((sh) => {
    const type = db.shiftTypes[sh.shift];
    if (!type) return;   // 不明班別不匯出（匯出端的白名單）
    const key = `${sh.staffId}|${sh.unit}`;
    if (!schedules[key]) {
      schedules[key] = {
        resourceType: 'Schedule',
        id: fhirIdSafe(`sch-${sh.staffId}-${sh.unit}`),
        active: true,
        actor: [
          { reference: `Practitioner/${fhirIdSafe(`pra-${sh.staffId}`)}`, display: sh.staffId },
          { reference: `Location/${fhirIdSafe(`loc-${sh.unit}`)}`, display: (db.units || {})[sh.unit] || sh.unit },
        ],
        planningHorizon: { start: sh.date, end: sh.date },
      };
    }
    const h = schedules[key].planningHorizon;
    if (sh.date < h.start) h.start = sh.date;
    if (sh.date > h.end) h.end = sh.date;

    let slotId = fhirIdSafe(`slot-${sh.staffId}-${sh.date.replace(/-/g, '')}-${sh.shift}`);
    let dup = 2;
    while (slotIds.has(slotId)) slotId = fhirIdSafe(`slot-${sh.staffId}-${sh.date.replace(/-/g, '')}-${sh.shift}-${dup++}`);
    slotIds.add(slotId);

    const period = fhirShiftPeriod(sh.date, type);
    slots.push({
      resourceType: 'Slot',
      id: slotId,
      schedule: { reference: `Schedule/${schedules[key].id}` },
      serviceType: [{ coding: [{ system: FHIR_SYSTEM.shiftType, code: sh.shift, display: type.name }] }],
      status: 'busy',
      start: period.start,
      end: period.end,
      ...(sh.isReplacement ? { comment: '替補班次（主管確認後寫回）' } : {}),
    });
  });

  Object.values(schedules).forEach((sch) => resources.push(sch));
  slots.forEach((sl) => resources.push(sl));

  const entry = resources.map((r) => ({
    fullUrl: `https://shiftguard.example.tw/fhir/${r.resourceType}/${r.id}`,
    resource: r,
    ...(mode === 'batch' ? { request: { method: 'PUT', url: `${r.resourceType}/${r.id}` } } : {}),
  }));

  return {
    resourceType: 'Bundle',
    id: fhirIdSafe(`shiftguard-roster-${mode}`),
    type: mode,
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    entry,
  };
}

/** 匯出統計（畫面顯示用）：各資源類型的筆數 */
function fhirBundleStats(bundle) {
  const byType = {};
  (bundle.entry || []).forEach((e) => {
    const t = e.resource && e.resource.resourceType;
    if (t) byType[t] = (byType[t] || 0) + 1;
  });
  return byType;
}

/* ── 匯入：FHIR Bundle → 內部班次 ─────────────────────── */

/**
 * 由 Bundle 還原班次。只信任參照鏈與白名單，不信任任何自由文字：
 *   Slot.schedule → Schedule.actor → Practitioner.identifier（staff-id 系統）
 *                                  → Location.identifier（unit-id 系統）
 * 班別辨識順序：serviceType 的 shift-type coding（首選）→ 起訖時間比對（退路）。
 *
 * @returns {{ shifts: Array<{staffId,date,shift,unit}>, errors: string[],
 *             counts: { slots, imported, rejected } }}
 */
function fhirImportBundle(bundle, db) {
  const errors = [];
  if (!bundle || bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) {
    return { shifts: [], errors: ['不是有效的 FHIR Bundle（缺 resourceType: "Bundle" 或 entry 陣列）'], counts: { slots: 0, imported: 0, rejected: 0 } };
  }

  const byType = {};
  bundle.entry.forEach((e) => {
    const r = e && e.resource;
    if (r && r.resourceType) (byType[r.resourceType] = byType[r.resourceType] || []).push(r);
  });

  // Practitioner／Location 參照 → 內部代號（identifier 優先，id 前綴為退路）
  const practToStaff = {};
  (byType.Practitioner || []).forEach((p) => {
    const ident = (p.identifier || []).find((i) => i.system === FHIR_SYSTEM.staffId);
    const staffId = ident ? ident.value : (String(p.id || '').startsWith('pra-') ? String(p.id).slice(4) : null);
    if (staffId) practToStaff[`Practitioner/${p.id}`] = staffId;
  });
  const locToUnit = {};
  (byType.Location || []).forEach((l) => {
    const ident = (l.identifier || []).find((i) => i.system === FHIR_SYSTEM.unitId);
    const unit = ident ? ident.value : (String(l.id || '').startsWith('loc-') ? String(l.id).slice(4) : null);
    if (unit) locToUnit[`Location/${l.id}`] = unit;
  });

  // Schedule → { staffId, unit }
  const schedInfo = {};
  (byType.Schedule || []).forEach((sch) => {
    let staffId = null;
    let unit = null;
    (sch.actor || []).forEach((a) => {
      const ref = a && a.reference;
      if (!ref) return;
      if (practToStaff[ref]) staffId = practToStaff[ref];
      if (locToUnit[ref]) unit = locToUnit[ref];
    });
    schedInfo[`Schedule/${sch.id}`] = { staffId, unit };
  });

  const slots = byType.Slot || [];
  const seen = new Set();
  const shifts = [];

  slots.forEach((slot, i) => {
    const label = `Slot ${i + 1}（id: ${slot.id || '無'}）`;
    const info = slot.schedule && schedInfo[slot.schedule.reference];
    if (!info) { errors.push(`${label}：schedule 參照無法解析（${slot.schedule ? slot.schedule.reference : '缺 schedule'}）`); return; }
    const { staffId, unit } = info;
    if (!staffId || !db.staff.some((s) => s.id === staffId)) { errors.push(`${label}：人員代號「${staffId || '?'}」不在人員主檔`); return; }
    if (!unit || !db.units[unit]) { errors.push(`${label}：單位代碼「${unit || '?'}」不在單位白名單`); return; }

    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(slot.start || ''));
    if (!m || !fhirIsValidDate(m[1])) { errors.push(`${label}：start「${slot.start || ''}」不是有效的日期時間`); return; }
    const [, date, startTime] = m;

    // 班別辨識：serviceType coding 優先，起始時刻比對為退路
    let shift = null;
    (slot.serviceType || []).forEach((st) => (st.coding || []).forEach((c) => {
      if (c.system === FHIR_SYSTEM.shiftType && db.shiftTypes[c.code]) shift = c.code;
    }));
    if (!shift) {
      const hit = Object.values(db.shiftTypes).find((t) => t.start === startTime);
      if (hit) shift = hit.code;
    }
    if (!shift) { errors.push(`${label}：無法辨識班別（serviceType 無已知代碼，起始時刻 ${startTime} 亦不符任何班別）`); return; }

    const key = `${staffId}|${date}|${shift}`;
    if (seen.has(key)) { errors.push(`${label}：與另一筆 Slot 重複（${staffId} ${date} ${shift}），略過`); return; }
    seen.add(key);
    shifts.push({ staffId, date, shift, unit });
  });

  return {
    shifts, errors,
    counts: { slots: slots.length, imported: shifts.length, rejected: slots.length - shifts.length },
  };
}

/* 讓測試（tests.html／Node CI）與瀏覽器共用同一份程式碼 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FHIR_SYSTEM, TW_CORE_PROFILE,
    fhirExportBundle, fhirImportBundle, fhirBundleStats,
    fhirShiftPeriod, fhirIdSafe, fhirIsValidDate,
  };
}
