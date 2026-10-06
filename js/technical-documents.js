(() => {
  const esc = (v = '') => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const label = { queued: '等待 Agent 歸檔', running: '歸檔中', archived: '已歸檔', failed: '歸檔失敗' };
  const date = value => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'medium' }).format(new Date(value));
  function url(value) {
    try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password ? u.href : ''; }
    catch (_) { return ''; }
  }
  function errorText(error) {
    const s = error?.message || String(error);
    if (/PGRST|does not exist|schema cache/.test(s)) return '文件上傳尚未啟用，請聯絡 PM 完成資料庫更新。';
    if (/not_assigned|inactive|revision_target/.test(s)) return '分工已變更，請重新整理並選擇目前負責的細項。';
    if (/closed_or_invalid|invalid_document_link/.test(s)) return '此連結已關閉，請使用最新週報連結。';
    if (/expired_or_invalid|not_uploaded/.test(s)) return '上傳已逾時或檔案未送達，請重新選擇 PDF 上傳。';
    if (/too_many_pending/.test(s)) return '待處理文件較多，請等 Agent 完成後再上傳。';
    return s;
  }
  function groups(rows) {
    const map = new Map();
    for (const row of rows) { if (!map.has(row.document_id)) map.set(row.document_id, []); map.get(row.document_id).push(row); }
    return [...map.values()].map(versions => versions.sort((a, b) => b.revision - a.revision));
  }
  function version(row, retry) {
    const link = row.status === 'archived' ? url(row.html_url) : '';
    return `<div class="td-version"><span>v${String(row.revision).padStart(2, '0')} · ${esc(date(row.created_at))} · ${esc(row.member_name)}</span>
      <span>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">開啟 PDF ↗</a>` : esc(label[row.status] || row.status)}</span>
      ${row.status === 'failed' ? `<p class="td-error">${esc(row.error || '請重試歸檔。')}</p>${retry ? `<button class="button small" type="button" data-retry-document="${esc(row.id)}">重試歸檔</button>` : ''}` : ''}</div>`;
  }
  function list(rows, retry = false) {
    return groups(rows).map(versions => {
      const latest = versions[0];
      return `<article class="td-document"><b>${esc(latest.title)}</b><div class="muted">${esc(latest.subtask_id)} · ${(latest.size_bytes / 1024 / 1024).toFixed(2)} MB</div>
        ${version(latest, retry)}${versions.length > 1 ? `<details><summary>歷史版本（${versions.length - 1}）</summary>${versions.slice(1).map(v => version(v, retry)).join('')}</details>` : ''}</article>`;
    }).join('') || '<p class="muted">尚無技術文件。完成階段成果後可自行上傳。</p>';
  }
  async function drawer(root, api, subtaskId) {
    if (!root) return;
    root.innerHTML = '<h3>技術文件</h3><p class="muted">正在讀取…</p>';
    try {
      const rows = await api.listTechnicalDocuments(subtaskId);
      if (!root.isConnected) return;
      root.innerHTML = `<h3>技術文件</h3><p class="muted">私人文件庫，開啟 PDF 需有 GitHub 讀取權限。</p>${list(rows)}`;
    } catch (error) { if (root.isConnected) root.innerHTML = `<h3>技術文件</h3><p>${esc(errorText(error))}</p>`; }
  }
  function portal({ client, token, root, toast }) {
    let member = '', data = { tasks: [], versions: [] }, sequence = 0, busy = false, ready = false;
    const $ = selector => root.querySelector(selector);
    root.innerHTML = `<div class="section-head"><div><h3>技術文件 · PDF</h3><p>完成一個階段就可以上傳，選填、不受週報截止日限制。上傳後可在 Dashboard 的對應細項查看。</p></div><button type="button" class="button small" data-refresh-docs>重新整理文件</button></div>
      <p data-doc-message role="status">請先選擇姓名。</p>
      <fieldset class="td-form" disabled>
        <label for="technicalTask">工作細項</label><select id="technicalTask"><option value="">請選擇細項</option></select>
        <label for="technicalVersion">文件／版本</label><select id="technicalVersion"><option value="">新增一份階段文件</option></select>
        <label for="technicalTitle">文件標題／階段</label><input id="technicalTitle" maxlength="100" placeholder="例如：CAN 介面定義、第一階段測試紀錄">
        <label for="technicalFile">PDF（上限 10 MB）</label><input id="technicalFile" type="file" accept=".pdf,application/pdf">
        <div class="td-actions"><button class="button primary" type="button" data-upload-document>上傳 PDF</button><button class="button" type="button" data-resume-document hidden>完成上次上傳</button></div>
      </fieldset><div data-doc-list></div>`;
    const rpc = async (name, args) => { const r = await client.rpc(name, args); if (r.error) throw r.error; return r.data; };
    const key = () => 'smartport.pending-pdf:' + member;
    const pending = () => { try { return localStorage.getItem(key()); } catch (_) { return null; } };
    const remember = id => { try { id ? localStorage.setItem(key(), id) : localStorage.removeItem(key()); } catch (_) {} };
    const message = text => { $('[data-doc-message]').textContent = text; };
    function controls() {
      $('fieldset').disabled = busy || !ready || !data.tasks.length;
      $('[data-refresh-docs]').disabled = busy;
      $('[data-resume-document]').hidden = !pending();
      $('#technicalTitle').disabled = !!$('#technicalVersion').value;
      root.querySelectorAll('[data-retry-document]').forEach(b => { b.disabled = busy; });
    }
    function choices() {
      const select = $('#technicalVersion'), selected = select.value;
      const rows = data.versions.filter(v => v.subtask_id === $('#technicalTask').value);
      select.innerHTML = '<option value="">新增一份階段文件</option>' + groups(rows).map(g => `<option value="${esc(g[0].document_id)}">更新：${esc(g[0].title)}（目前 v${g[0].revision}）</option>`).join('');
      if ([...select.options].some(o => o.value === selected)) select.value = selected;
      if (select.value) $('#technicalTitle').value = rows.find(r => r.document_id === select.value)?.title || '';
      controls();
    }
    async function load(memberId = member) {
      if (busy) return;
      const current = ++sequence;
      if (member !== memberId) {
        member = memberId; data = { tasks: [], versions: [] };
        $('#technicalTask').innerHTML = '<option value="">請選擇細項</option>';
        $('#technicalVersion').value = ''; $('#technicalTitle').value = ''; $('#technicalFile').value = '';
        $('[data-doc-list]').innerHTML = '';
      }
      ready = false; controls();
      if (!member) { message('請先選擇姓名。'); return; }
      message('正在讀取分工與文件…');
      try {
        const response = await rpc('get_technical_document_portal', { p_token: token, p_member_id: member });
        if (current !== sequence) return;
        data = response; ready = true;
        const selected = $('#technicalTask').value;
        $('#technicalTask').innerHTML = '<option value="">請選擇細項</option>' + data.tasks.map(t => `<option value="${esc(t.id)}">${esc(t.wp_id)} · ${esc(t.wp_name)} ／ ${esc(t.id)} · ${esc(t.name)}</option>`).join('');
        if (data.tasks.some(t => t.id === selected)) $('#technicalTask').value = selected;
        choices(); $('[data-doc-list]').innerHTML = list(data.versions, true);
        message(data.tasks.length ? '文件會存入私人 GitHub 文件庫；歸檔完成後即可開啟。這項操作不會變更進度百分比。' : '目前沒有分配給你的工作細項，請聯絡 PM。');
      } catch (error) { if (current === sequence) message(errorText(error)); }
      if (current === sequence) controls();
    }
    async function action(fn) {
      if (busy) return;
      busy = true; ++sequence; controls();
      const memberSelect = document.querySelector('#memberSelect');
      if (memberSelect) memberSelect.disabled = true;
      try { await fn(); }
      catch (error) { message(errorText(error)); toast(errorText(error)); }
      finally { busy = false; if (memberSelect) memberSelect.disabled = false; controls(); }
    }
    async function submit(id) {
      await rpc('submit_technical_document', { p_token: token, p_upload_id: id });
      if (pending() === id) remember(null);
      message('PDF 已送出，等待 Agent 歸檔；稍後按「重新整理文件」查看。');
      toast('文件已排入歸檔，不需等候本週週報審核');
    }
    $('[data-upload-document]').onclick = async () => {
      await action(async () => {
        const file = $('#technicalFile').files?.[0], task = $('#technicalTask').value, title = $('#technicalTitle').value.trim();
        if (!task || !title) throw new Error('請選擇工作細項並填寫文件標題。');
        if (!file || !/\.pdf$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024) throw new Error('請選擇 10 MB 以下的 PDF。');
        if (pending()) throw new Error('請先按「完成上次上傳」，確認上一份文件的結果。');
        message('正在上傳 PDF…');
        const grant = await rpc('prepare_technical_document_upload', { p_token: token, p_member_id: member, p_subtask_id: task,
          p_document_id: $('#technicalVersion').value || null, p_title: title, p_filename: file.name, p_size_bytes: file.size });
        const upload = await client.storage.from(grant.bucket).upload(grant.storage_path, file, { upsert: false, contentType: 'application/pdf' });
        if (upload.error) throw upload.error;
        remember(grant.upload_id);
        await submit(grant.upload_id); $('#technicalFile').value = '';
      });
      // Only refresh after success; leave actionable upload errors visible.
      if (!$('#technicalFile').files?.length && !pending()) await load();
    };
    $('[data-resume-document]').onclick = async () => {
      await action(async () => { try { await submit(pending()); }
        catch (error) { if (/expired_or_invalid|not_uploaded/.test(error.message)) remember(null); throw error; } });
      if (!pending()) await load();
    };
    $('[data-refresh-docs]').onclick = () => load();
    $('#technicalTask').onchange = () => { $('#technicalVersion').value = ''; $('#technicalTitle').value = ''; choices(); };
    $('#technicalVersion').onchange = () => { $('#technicalTitle').value = data.versions.find(v => v.document_id === $('#technicalVersion').value)?.title || ''; controls(); };
    root.addEventListener('click', async event => {
      const button = event.target.closest('[data-retry-document]');
      if (button) { await action(() => submit(button.dataset.retryDocument)); await load(); }
    });
    return { load };
  }
  window.SmartPortDocuments = { portal, drawer, list };
})();
