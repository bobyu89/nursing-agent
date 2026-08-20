/**
 * fhir.test.js — FHIR 介接層的邊界條件測試
 *
 * 釘住的是「資料交換事故等級」的行為：
 * 匯出結構與 TW Core profile 宣告、大夜跨日的起訖時間、
 * 匯出→匯入 roundtrip 一筆不差、匯入白名單逐筆拒絕不合法資料。
 */

function fhirTestDb() {
  return { staff: STAFF, shifts: SHIFTS, units: UNITS, shiftTypes: SHIFT_TYPES, certs: CERTS, ladderLevels: LADDER_LEVELS };
}

test('FHIR 匯出：Bundle 六種資源數量正確、Slot 全為 busy、宣告 TW Core profile', () => {
  const db = fhirTestDb();
  const bundle = fhirExportBundle(db);
  assertEqual(bundle.resourceType, 'Bundle');
  assertEqual(bundle.type, 'collection');
  const stats = fhirBundleStats(bundle);
  assertEqual(stats.Organization, 1, '一個醫院組織');
  assertEqual(stats.Location, Object.keys(UNITS).length, '每單位一個 Location');
  assertEqual(stats.Practitioner, STAFF.length, '每人一個 Practitioner');
  assertEqual(stats.PractitionerRole, STAFF.length, '每人一個 PractitionerRole');
  assertEqual(stats.Slot, SHIFTS.length, '每班次一個 Slot');
  assert(stats.Schedule >= 1, '至少一個 Schedule');

  const slots = bundle.entry.filter((e) => e.resource.resourceType === 'Slot');
  assert(slots.every((e) => e.resource.status === 'busy'), 'Slot 狀態應為 busy');
  assert(slots.every((e) => e.resource.schedule && e.resource.schedule.reference.startsWith('Schedule/')),
    '每個 Slot 都要掛在 Schedule 之下');

  const pract = bundle.entry.find((e) => e.resource.resourceType === 'Practitioner').resource;
  assertEqual(pract.meta.profile, [TW_CORE_PROFILE.Practitioner], 'Practitioner 應宣告 TW Core profile');
  assert(pract.name[0].text.indexOf('（代號）') > 0, '人員只出代號，不含姓名');
});

test('FHIR 匯出：大夜跨日 end 在翌日早上；證照效期寫入 qualification.period', () => {
  const db = fhirTestDb();
  db.shifts = [{ staffId: 'N-07', date: '2026-08-08', shift: 'N', unit: 'MED-3A' }];
  const bundle = fhirExportBundle(db);
  const slot = bundle.entry.find((e) => e.resource.resourceType === 'Slot').resource;
  assertEqual(slot.start, '2026-08-08T23:00:00+08:00');
  assertEqual(slot.end, '2026-08-09T07:00:00+08:00', '大夜 23:00–07:00 的 end 必須是翌日（+08:00 時區）');
  assertEqual(slot.serviceType[0].coding[0].code, 'N', '班別代碼進 serviceType');

  const p = bundle.entry.find((e) => e.resource.id === 'pra-N-07').resource;
  const acls = p.qualification.find((q) => q.code.coding[0].code === 'ACLS');
  assertEqual(acls.period.end, '2027-04-30', 'N-07 的 ACLS 效期應寫入 qualification.period.end');
  const ladder = p.qualification.find((q) => q.code.coding[0].code === 'N2');
  assert(ladder, 'N1–N4 進階層級也應寫入 qualification');
});

test('FHIR roundtrip：匯出再匯入，全部班次一筆不差、零錯誤', () => {
  const db = fhirTestDb();
  const bundle = JSON.parse(JSON.stringify(fhirExportBundle(db)));   // 模擬經檔案／網路傳輸
  const r = fhirImportBundle(bundle, db);
  assertEqual(r.errors, [], 'roundtrip 不得有任何驗證錯誤');
  assertEqual(r.counts.imported, SHIFTS.length, '筆數一致');
  const key = (s) => `${s.staffId}|${s.date}|${s.shift}|${s.unit}`;
  assertEqual(r.shifts.map(key).sort(), SHIFTS.map(key).sort(), '人員×日期×班別×單位完全一致');
});

test('FHIR 匯入白名單：不明人員／單位／無效日期／無法辨識班別逐筆拒絕，合法筆不受牽連', () => {
  const db = fhirTestDb();
  const praOk = { resourceType: 'Practitioner', id: 'pra-N-02', identifier: [{ system: FHIR_SYSTEM.staffId, value: 'N-02' }] };
  const praGhost = { resourceType: 'Practitioner', id: 'pra-GHOST', identifier: [{ system: FHIR_SYSTEM.staffId, value: 'GHOST' }] };
  const locOk = { resourceType: 'Location', id: 'loc-MED-3A', identifier: [{ system: FHIR_SYSTEM.unitId, value: 'MED-3A' }] };
  const locHack = { resourceType: 'Location', id: 'loc-HACK', identifier: [{ system: FHIR_SYSTEM.unitId, value: 'HACK' }] };
  const sch = (id, pRef, lRef) => ({ resourceType: 'Schedule', id, actor: [{ reference: pRef }, { reference: lRef }] });
  const slot = (id, schedId, start) => ({
    resourceType: 'Slot', id, schedule: { reference: `Schedule/${schedId}` }, status: 'busy',
    start, end: start,
  });
  const bundle = {
    resourceType: 'Bundle', type: 'collection',
    entry: [
      praOk, praGhost, locOk, locHack,
      sch('sch-ok', 'Practitioner/pra-N-02', 'Location/loc-MED-3A'),
      sch('sch-ghost', 'Practitioner/pra-GHOST', 'Location/loc-MED-3A'),
      sch('sch-hack', 'Practitioner/pra-N-02', 'Location/loc-HACK'),
      slot('s1', 'sch-ok', '2026-08-10T07:00:00+08:00'),      // 合法：白班
      slot('s2', 'sch-ghost', '2026-08-10T07:00:00+08:00'),   // 人員不在主檔
      slot('s3', 'sch-hack', '2026-08-10T07:00:00+08:00'),    // 單位不在白名單
      slot('s4', 'sch-ok', '2026-02-31T07:00:00+08:00'),      // 不存在的日期
      slot('s5', 'sch-ok', '2026-08-10T03:33:00+08:00'),      // 起始時刻不符任何班別
    ].map((resource) => ({ resource })),
  };
  const r = fhirImportBundle(bundle, db);
  assertEqual(r.counts.imported, 1, '只有 s1 應通過');
  assertEqual(r.counts.rejected, 4, '四筆不合法應全數拒絕');
  assertEqual(r.shifts, [{ staffId: 'N-02', date: '2026-08-10', shift: 'D', unit: 'MED-3A' }]);
  assertEqual(r.errors.length, 4, '每筆拒絕都要有原因');
});

test('FHIR batch 模式帶 PUT request（重送不重複）；serviceType 缺失時以起始時刻辨識班別', () => {
  const db = fhirTestDb();
  const batch = fhirExportBundle(db, { mode: 'batch' });
  assertEqual(batch.type, 'batch');
  assert(batch.entry.every((e) => e.request && e.request.method === 'PUT'
    && e.request.url === `${e.resource.resourceType}/${e.resource.id}`),
    'batch 模式每筆資源都要帶 PUT request（idempotent upsert）');

  const noType = JSON.parse(JSON.stringify(fhirExportBundle(db)));
  noType.entry.forEach((e) => { if (e.resource.resourceType === 'Slot') delete e.resource.serviceType; });
  const r = fhirImportBundle(noType, db);
  assertEqual(r.counts.imported, SHIFTS.length, '沒有 serviceType 時，起始時刻退路應辨識出全部班別');
  assertEqual(r.errors, []);
});
