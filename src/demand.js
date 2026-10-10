/**
 * demand.js — 照護需求換算（從「要多少格」改成「這段時間需要哪些能力、幾個人」）
 *
 * 唯一的介面：careDemand(profile, { dates, bookings, forecast }) → slots
 *   profile   compileProfile 編譯後的單位設定檔
 *   dates     要換算的日期（YYYY-MM-DD）
 *   bookings  透析預約人數 { [date]: { [sessionId]: { [areaId]: 人數 } } }
 *   forecast  急診預測 { [date]: { [shiftId]: { [postId]: 每小時就診人次 } } }
 *             預測從哪個模型來不是本模組的事——任何預測器只要給這個形狀即可
 *
 * 每一格（slot）回答三件事，並標明數字的來源：
 *   headcount { min, source, basis }  至少幾人
 *   allMust   每一位都須具備的能力
 *   atLeast   至少幾位須具備的能力
 * source：known（依已確認的預約換算）／baseline（設定檔保底）／
 *         forecast（依預測換算）／assumed（缺資料時的保守假設）。
 * 下游據此區分「確定缺人」與「預測可能缺人」，不把預測當成已知未來。
 */

function careDemand(profile, { dates = [], bookings = {}, forecast = {} } = {}) {
  if (!profile || !profile.fingerprint) throw new Error('careDemand 需要 compileProfile 編譯後的設定檔');
  const slots = profile.kind === 'hemodialysis' ? dialysisSlots(profile, dates, bookings)
    : emergencySlots(profile, dates, forecast);
  return slots.map((s) => ({ ...s, unit: profile.unit, profile: profile.fingerprint }));
}

/* 血液透析室：每場次每區域一格；人數 = 病人數 ÷ 每人病人數（無條件進位） */
function dialysisSlots(profile, dates, bookings) {
  const { patientsPerNurse: ppn, sessions, areas } = profile.demand;
  const out = [];
  dates.forEach((date) => {
    const wd = weekdayOfDate(date);
    sessions.filter((s) => s.weekdays.includes(wd)).forEach((session) => {
      const { start, end } = timeRange(date, session.start, session.end);
      areas.forEach((area) => {
        const booked = ((bookings[date] || {})[session.id] || {})[area.id];
        const known = typeof booked === 'number';
        const patients = known ? booked : area.stations;
        if (patients <= 0) return;   // 本場次此區無病人，不需人力
        const min = Math.ceil(patients / ppn);
        out.push({
          id: `${date}|${session.id}|${area.id}`,
          date, start, end,
          label: `${session.label}・${area.label}`,
          headcount: {
            min,
            source: known ? 'known' : 'assumed',
            basis: known
              ? `預約 ${patients} 人 ÷ 每人 ${ppn} 床 = ${min} 人`
              : `未提供預約數，以床數上限 ${patients} 床估算：÷ ${ppn} = ${min} 人`,
          },
          allMust: area.allMust.slice(),
          atLeast: area.atLeast.map((n) => ({ ...n })),
        });
      });
    });
  });
  return out;
}

/* 急診：每班別每崗位一格；人數 = max(保底, 預測就診量 ÷ 每人可照護量) */
function emergencySlots(profile, dates, forecast) {
  const { shifts, posts } = profile.demand;
  const out = [];
  dates.forEach((date) => {
    shifts.forEach((shift) => {
      const { start, end } = timeRange(date, shift.start, shift.end);
      posts.forEach((post) => {
        const visits = ((forecast[date] || {})[shift.id] || {})[post.id];
        let headcount = { min: post.min, source: 'baseline', basis: `設定檔保底 ${post.min} 人` };
        if (post.visitsPerNurse && typeof visits === 'number') {
          const need = Math.ceil(visits / post.visitsPerNurse);
          if (need > post.min) {
            headcount = {
              min: need,
              source: 'forecast',
              basis: `預測每小時 ${visits} 人次 ÷ 每人 ${post.visitsPerNurse} 人次 = ${need} 人（保底 ${post.min}）`,
            };
          }
        }
        out.push({
          id: `${date}|${shift.id}|${post.id}`,
          date, start, end,
          label: `${shift.label}・${post.label}`,
          headcount,
          allMust: post.allMust.slice(),
          atLeast: post.atLeast.map((n) => ({ ...n })),
        });
      });
    });
  });
  return out;
}

/* 跨午夜的時段（如 20:00–08:00）結束於隔日 */
function timeRange(date, hhmmStart, hhmmEnd) {
  const endDate = hhmmEnd <= hhmmStart ? nextDate(date) : date;
  return { start: `${date}T${hhmmStart}`, end: `${endDate}T${hhmmEnd}` };
}

function weekdayOfDate(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function nextDate(date) {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { careDemand };
}
