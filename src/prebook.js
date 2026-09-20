/**
 * prebook.js — 預假日曆頁（prebook.html）
 *
 * 從 LINE 的預班公告／催繳／「我的預假」按進來（#t=本人專屬連結）→ 換 session → 讀本單位週期與自己的預假
 * → 點日期 → 送出。送出走 Worker 的 POST /api/prebook，Worker 把日期轉成同一句「預假 …」指令交 prebookFlow：
 * 同一套驗證（上限、月份、截止）、同一筆留痕，日曆只是輸入介面。
 */
(function () {
  const $ = (s) => document.querySelector(s);
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  const state = { cycle: null, request: null, picked: new Set(), busy: false };

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function tpe(iso) { const d = new Date(new Date(iso).getTime() + 8 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; }
  function monthDays(month) { const [y, m] = month.split('-').map(Number); const n = new Date(Date.UTC(y, m, 0)).getUTCDate(); return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`); }
  function dow(dateStr) { return new Date(dateStr + 'T00:00:00Z').getUTCDay(); }

  function msg(kind, text) {
    const el = $('#pb-msg') || (() => { const d = document.createElement('div'); d.id = 'pb-msg'; $('#pb-body').appendChild(d); return d; })();
    el.className = `pb-msg ${kind}`;
    el.textContent = text;
  }

  function render() {
    const c = state.cycle;
    const r = state.request;
    if (!c) {
      $('#pb-title').textContent = `${LIVE.identity.staff_id}｜目前沒有進行中的預班週期`;
      $('#pb-meta').textContent = '護理長開啟下個月預班後，LINE 會推播公告，屆時再從公告按進來。';
      $('#pb-body').innerHTML = '';
      return;
    }
    const monthN = Number(c.month.split('-')[1]);
    $('#pb-title').textContent = `${LIVE.identity.staff_id}｜${monthN} 月預假`;
    const stateWord = r.state === 'SUBMITTED' ? `已回覆（${r.dates.length ? r.dates.map((d) => d.slice(5).replace('-', '/')).join('、') : '無預假'}）` : r.state === 'NO_REQUEST' ? '逾期未回，視同無預假' : '尚未回覆';
    $('#pb-meta').innerHTML = `截止 ${esc(tpe(c.deadline))}・每人最多 ${c.max_days} 天・${esc(stateWord)}${c.open ? '' : '<br><b>此週期已截止，日曆唯讀。</b>'}`;

    const days = monthDays(c.month);
    const lead = dow(days[0]);
    let html = '<div class="pb-cal">' + WD.map((w) => `<div class="dow">${w}</div>`).join('');
    for (let i = 0; i < lead; i += 1) html += '<div class="pb-day off"></div>';
    for (const d of days) {
      const dn = Number(d.slice(8));
      const wk = dow(d);
      const on = state.picked.has(d);
      html += `<div class="pb-day${on ? ' on' : ''}${!c.open ? ' dis' : ''}${wk === 0 || wk === 6 ? ' wknd' : ''}" data-d="${d}" role="button" aria-pressed="${on}">${dn}<small>${WD[wk]}</small></div>`;
    }
    html += '</div>';
    const over = state.picked.size > c.max_days;
    html += `<div class="pb-count"><span>已選 <b class="${over ? 'over' : ''}" id="pb-n">${state.picked.size}</b>／${c.max_days} 天</span><span class="tag ${over ? 'tag-danger' : 'tag-neutral'}">${over ? '超過上限，送不出去' : '截止前可改，最後一次為準'}</span></div>`;
    if (c.open) {
      html += `<div class="pb-actions">
        <button class="btn" id="pb-none" type="button">不需要預假</button>
        <button class="btn btn-primary" id="pb-submit" type="button" ${over || state.busy ? 'disabled' : ''}>${state.picked.size ? `送出 ${state.picked.size} 天` : '送出（無預假）'}</button>
      </div>`;
    }
    $('#pb-body').innerHTML = html;
    if (c.open) {
      document.querySelectorAll('.pb-day[data-d]').forEach((el) => el.addEventListener('click', () => {
        const d = el.dataset.d;
        if (state.picked.has(d)) state.picked.delete(d); else state.picked.add(d);
        render();
      }));
      $('#pb-submit').addEventListener('click', () => submit([...state.picked].sort()));
      $('#pb-none').addEventListener('click', () => { state.picked.clear(); submit([]); });
    }
  }

  async function submit(dates) {
    if (state.busy) return;
    state.busy = true; render();
    msg('info', '送出中…');
    try {
      const r = await liveFetch('/api/prebook', { method: 'POST', body: { dates } });
      state.request = r.request || state.request;
      state.picked = new Set((r.request && r.request.dates) || []);
      state.busy = false; render();
      msg('ok', r.message);
    } catch (e) {
      state.busy = false; render();
      msg('err', (e.body && e.body.message) || e.message || '送出失敗');
    }
  }

  async function boot() {
    const ok = await liveEstablish();
    if (!ok) {
      $('#pb-title').textContent = '需要從 LINE 的連結進來';
      $('#pb-meta').textContent = LIVE.error
        ? `登入失敗：${LIVE.error}`
        : '這頁沒有登入資訊。請在 LINE 對機器人輸入「我的預假」或「平台」，按回覆裡的日曆按鈕開啟（連結只給你、10 分鐘內有效）。';
      return;
    }
    try {
      const r = await liveFetch('/api/prebook');
      state.cycle = r.cycle; state.request = r.request || { state: 'PENDING', dates: [] };
      state.picked = new Set(state.request.dates || []);
      render();
    } catch (e) {
      $('#pb-title').textContent = '讀不到預班資料';
      $('#pb-meta').textContent = (e.body && e.body.message) || e.message || String(e);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
