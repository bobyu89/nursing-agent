/**
 * admin.js — 人員與綁定（admin.html，管理者專用）
 *
 * 從 LINE「平台」回覆的「人員與綁定」連結進來（#t=本人專屬，只有 ADMIN_USER_ID 的帳號會拿到這顆按鈕）。
 * 列出每個人員代號的綁定狀態；按「產生綁定碼」＝ Worker 的 POST /api/admin/bindcode，
 * 與 LINE 裡「發碼 N-04 護理長」走同一個 issueBindCodeFlow：同一套驗證、同一筆留痕、30 分鐘失效。
 * 權限由 Worker 判斷（非管理者一律 403）；這頁只是介面。
 */
(function () {
  const $ = (s) => document.querySelector(s);
  const TIER = { staff: '護理師', head: '護理長', exec: '督導／主任' };
  const state = { staff: [], unit: 'ALL', codes: new Map(), busy: null };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function tpe(iso) {
    const d = new Date(new Date(iso).getTime() + 8 * 3600000);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
  function minsLeft(iso) { return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000)); }

  function renderFilter() {
    const units = [...new Map(state.staff.map((s) => [s.unit, s.unitName])).entries()];
    const btn = (key, label) => `<button type="button" data-u="${esc(key)}" class="${state.unit === key ? 'on' : ''}">${esc(label)}</button>`;
    $('#ad-filter').innerHTML = btn('ALL', `全部 ${state.staff.length}`) + units.map(([u, name]) => btn(u, `${name} ${state.staff.filter((s) => s.unit === u).length}`)).join('');
    document.querySelectorAll('#ad-filter button').forEach((b) => b.addEventListener('click', () => { state.unit = b.dataset.u; renderFilter(); renderList(); }));
  }

  function stateTags(s) {
    const tags = [];
    if (s.bound) {
      tags.push(`<span class="tag tag-ok">已綁定・${esc(TIER[s.bound.tier] || s.bound.tier)}</span>`);
      if (s.bound.isMe) tags.push('<span class="tag tag-brand">這是你</span>');
      tags.push(`<span class="tag tag-neutral">${esc(tpe(s.bound.bound_at))} 綁定</span>`);
    } else {
      tags.push('<span class="tag tag-warn">尚未綁定</span>');
    }
    if (s.pendingCode) tags.push(`<span class="tag tag-brand">有一組 ${esc(TIER[s.pendingCode.tier] || '')} 綁定碼未使用，${minsLeft(s.pendingCode.expires_at)} 分鐘後失效</span>`);
    return tags.join('');
  }

  function codeBox(s) {
    const c = state.codes.get(s.id);
    if (!c) return '';
    if (c.error) return `<div class="ad-msg err" style="grid-column:1/-1">${esc(c.error)}</div>`;
    return `<div class="ad-code">
      <div class="ad-sub">${esc(s.id)}・${esc(TIER[c.tier] || c.tier)}・${esc(tpe(c.expiresAt))} 前有效（30 分鐘、用過即作廢）</div>
      <div class="big">${esc(c.code)}</div>
      <div class="send">請 ${esc(s.id)} 本人在自己的 LINE 對機器人輸入：<code>${esc(c.sendText)}</code></div>
      <div class="row"><button class="btn btn-sm" type="button" data-copy="${esc(c.sendText)}">複製這句話</button><span class="ad-sub" data-copied="${esc(s.id)}"></span></div>
    </div>`;
  }

  function renderList() {
    const rows = state.staff.filter((s) => state.unit === 'ALL' || s.unit === state.unit);
    $('#ad-list').innerHTML = rows.map((s) => `
      <div class="ad-row" data-sid="${esc(s.id)}">
        <div>
          <div class="ad-id">${esc(s.id)}</div>
          <div class="ad-sub">${esc(s.unitName)}・${esc(s.role)}${s.ladder ? '・' + esc(s.ladder) : ''}</div>
          <div class="ad-state">${stateTags(s)}</div>
        </div>
        ${s.bound && s.bound.isMe ? `<div class="ad-sub" style="max-width:220px">你自己換身分不用發碼：在 LINE 輸入「我是 ${esc(s.id)} 護理長」</div>` : `<div class="ad-act">
          <select aria-label="${esc(s.id)} 的權責層">
            <option value="staff" ${s.bound && s.bound.tier === 'staff' ? 'selected' : ''}>護理師</option>
            <option value="head" ${s.bound && s.bound.tier === 'head' ? 'selected' : ''}>護理長</option>
            <option value="exec" ${s.bound && s.bound.tier === 'exec' ? 'selected' : ''}>督導／主任</option>
          </select>
          <button class="btn btn-primary" type="button" data-issue="${esc(s.id)}" ${state.busy === s.id ? 'disabled' : ''}>${state.busy === s.id ? '產生中…' : (s.bound ? '重新發碼' : '產生綁定碼')}</button>
        </div>`}
        ${codeBox(s)}
      </div>`).join('') || '<div class="ad-meta">這個單位沒有人員資料。</div>';

    document.querySelectorAll('[data-issue]').forEach((b) => b.addEventListener('click', () => {
      const sid = b.dataset.issue;
      const tier = b.closest('.ad-row').querySelector('select').value;
      issue(sid, tier);
    }));
    document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      const sid = b.closest('.ad-row').dataset.sid;
      const note = document.querySelector(`[data-copied="${sid}"]`);
      try { await navigator.clipboard.writeText(b.dataset.copy); if (note) note.textContent = '已複製'; }
      catch (e) { if (note) note.textContent = '無法自動複製，請長按上面那句話手動複製'; }
    }));
  }

  async function issue(staffId, tier) {
    if (state.busy) return;
    state.busy = staffId; renderList();
    try {
      const r = await liveFetch('/api/admin/bindcode', { method: 'POST', body: { staffId, tier } });
      state.codes.set(staffId, r);
      await load(true);
    } catch (e) {
      state.codes.set(staffId, { error: (e.body && e.body.message) || e.message || '產生失敗' });
    } finally {
      state.busy = null; renderList();
    }
  }

  async function load(quiet) {
    const r = await liveFetch('/api/admin/staff');
    state.staff = r.staff || [];
    const bound = state.staff.filter((s) => s.bound).length;
    $('#ad-title').textContent = `已綁定 ${bound}／${state.staff.length} 人`;
    $('#ad-meta').textContent = `你目前是 ${r.identity.staff_id}（${TIER[r.identity.tier] || r.identity.tier}）。資料讀自雲端（D1），${tpe(r.generatedAt)} 更新。`;
    if (!quiet) { renderFilter(); renderList(); }
  }

  async function boot() {
    const ok = await liveEstablish();
    if (!ok) {
      $('#ad-title').textContent = '需要從 LINE 的連結進來';
      $('#ad-meta').textContent = LIVE.error
        ? `登入失敗：${LIVE.error}`
        : '這頁沒有登入資訊。請用管理者的 LINE 對機器人輸入「平台」，按回覆裡的「人員與綁定」（連結只給你、10 分鐘內有效）。';
      $('#ad-list').hidden = true;
      return;
    }
    try { await load(false); }
    catch (e) {
      $('#ad-title').textContent = e.status === 403 ? '這一頁限管理者使用' : '讀不到人員資料';
      $('#ad-meta').textContent = (e.body && e.body.message) || e.message || String(e);
      $('#ad-list').hidden = true;
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
