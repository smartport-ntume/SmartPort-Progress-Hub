(() => {
  const runtime = window.SMARTPORT_RUNTIME_CONFIG || {};
  const token = new URLSearchParams(window.location.hash.slice(1)).get('batch')
    || new URLSearchParams(window.location.search).get('batch')
    || '';
  const $ = selector => document.querySelector(selector);
  const esc = (value = '') => String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  let client = null;
  let batch = null;
  let selectedModel = null;
  let subscription = null;

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.hidden = true; }, 5000);
  }

  function message(text, error = false) {
    const element = $('#portalMessage');
    element.hidden = !text;
    element.className = 'portal-message' + (error ? ' error' : '');
    element.textContent = text || '';
  }

  function errorText(error) {
    return error?.message || error?.error_description || String(error || '未知錯誤');
  }

  function requireConfiguration() {
    if (!window.supabase?.createClient || !/^https:\/\//.test(runtime.supabaseUrl || '')
      || String(runtime.supabaseAnonKey || '').length < 20) {
      throw new Error('週報入口尚未完成 Supabase 前端設定');
    }
    client = window.supabase.createClient(runtime.supabaseUrl, runtime.supabaseAnonKey, {
      auth: {
        storageKey: 'smartport.supabase.auth',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  }

  async function loadBatch() {
    const { data, error } = await client.rpc('get_weekly_report_batch', { p_token: token });
    if (error) throw error;
    batch = data;
    renderBatch();
    subscribe();
  }

  function dateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(+date)) return '—';
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(date);
  }

  function latestByMember() {
    const map = new Map();
    for (const submission of batch?.submissions || []) {
      if (!map.has(submission.member_id)) map.set(submission.member_id, submission);
    }
    return map;
  }

  function statusLabel(status) {
    return ({
      queued: '已上傳・等待 Agent',
      running: 'Codex 批改中',
      completed: '批改完成・等待 PM',
      failed: '批改失敗・可重新上傳',
      cancelled: '已取消'
    })[status] || '尚未繳交';
  }

  function renderSubmissions() {
    const rows = $('#submissionRows');
    const latest = latestByMember();
    const members = batch?.payload?.team_config?.members || [];
    rows.className = 'submission-rows';
    rows.innerHTML = members.map(member => {
      const submission = latest.get(member.id);
      return `<div class="submission-row"><span><b>${esc(member.name)}</b>${submission?.late ? ' · <span class="muted">逾期繳交</span>' : ''}</span><span class="status ${esc(submission?.status || '')}">${esc(statusLabel(submission?.status))}</span></div>`;
    }).join('') || '<span class="muted">本期沒有需要繳交週報的成員。</span>';
  }

  function modelFor(memberId) {
    const payload = batch?.payload || {};
    return window.SmartPortWeeklyReport.build({
      teamConfig: payload.team_config,
      workPackages: payload.work_packages,
      subtasks: payload.subtasks,
      checkpoints: payload.checkpoints,
      checkpointReferences: payload.checkpoint_references,
      memberId,
      reportDate: payload.report_date || batch.report_date
    });
  }

  function renderScope() {
    const memberId = $('#memberSelect').value;
    const panel = $('#scopePanel');
    selectedModel = null;
    $('#downloadButton').disabled = true;
    $('#reportFile').disabled = true;
    $('#submitButton').disabled = true;
    if (!memberId) {
      panel.className = 'scope-panel muted';
      panel.textContent = '請先選擇姓名。';
      return;
    }
    try {
      selectedModel = modelFor(memberId);
      const cp = selectedModel.nextCheckpoint
        ? `${selectedModel.nextCheckpoint.id}｜${selectedModel.nextCheckpoint.dateDisplay}`
        : '無後續 CP';
      panel.className = 'scope-panel';
      panel.innerHTML = `<div class="scope-summary"><b>${esc(selectedModel.member.name)}</b><span class="chip">${esc(cp)}</span><span class="chip overdue">逾期 ${selectedModel.counts.overdue}</span><span class="chip">共 ${selectedModel.counts.total} 項</span></div><div class="scope-list">${selectedModel.tasks.map(task => `<div class="scope-row"><span><b>${esc(task.id)}</b> · ${esc(task.name)}</span><span class="muted">${esc(task.categoryName)} · ${esc(task.end || task.targetCp || '—')}</span></div>`).join('') || '<div class="scope-row muted">本期沒有符合條件的未完成工作，仍可提交空白狀態週報。</div>'}</div>`;
      const canSubmit = batch.can_submit === true;
      $('#downloadButton').disabled = false;
      $('#reportFile').disabled = !canSubmit;
      $('#submitButton').disabled = !canSubmit || !$('#reportFile').files?.[0];
    } catch (error) {
      panel.className = 'scope-panel muted';
      panel.textContent = errorText(error);
    }
  }

  function renderBatch() {
    $('#loginCard').hidden = true;
    $('#batchCard').hidden = false;
    $('#weekKey').textContent = batch.week_key || 'WEEKLY REPORT';
    $('#batchTitle').textContent = '本週個人週報已建立';
    $('#batchMeta').textContent = `報告日期 ${batch.report_date}・上傳後自動批改並送交 PM`;
    const badge = $('#deadlineBadge');
    const overdue = Date.now() > +new Date(batch.due_at);
    badge.textContent = overdue && batch.can_submit
      ? `已逾期・可補交至 ${dateTime(batch.accept_until)}`
      : `截止 ${dateTime(batch.due_at)}`;
    badge.classList.toggle('late', overdue && batch.can_submit);
    badge.classList.toggle('closed', !batch.can_submit);
    const select = $('#memberSelect');
    const selected = select.value;
    const members = batch?.payload?.team_config?.members || [];
    select.innerHTML = '<option value="">請選擇成員</option>' + members.map(member =>
      `<option value="${esc(member.id)}">${esc(member.name)}</option>`
    ).join('');
    if (members.some(member => member.id === selected)) select.value = selected;
    renderScope();
    renderSubmissions();
    if (!batch.can_submit) {
      message('本週補交期限已結束；如需補交，請聯絡 PM。', true);
    } else if (overdue) {
      message(`已超過原截止時間，仍可補交至 ${dateTime(batch.accept_until)}。`);
    } else {
      message('');
    }
  }

  async function downloadReport() {
    if (!selectedModel) return;
    const button = $('#downloadButton');
    button.disabled = true;
    button.textContent = '正在產生 Word...';
    try {
      const blob = await window.SmartPortWeeklyDocx.create(selectedModel);
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = selectedModel.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      toast('週報已下載，填寫完成後回到本頁上傳');
    } catch (error) {
      toast(errorText(error));
    } finally {
      button.disabled = false;
      button.textContent = '重新下載我的 Word 週報';
    }
  }

  function validateFile(file) {
    if (!file) throw new Error('請選擇填寫完成的 Word 檔');
    const extension = (file.name.split('.').pop() || '').toLowerCase();
    if (!['doc', 'docx'].includes(extension)) throw new Error('只接受 .doc 或 .docx');
    if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('週報檔案上限為 10 MB');
  }

  async function submitReport() {
    if (!selectedModel || !batch?.can_submit) return;
    const file = $('#reportFile').files?.[0];
    try { validateFile(file); }
    catch (error) { return toast(errorText(error)); }
    const button = $('#submitButton');
    button.disabled = true;
    button.textContent = '準備上傳...';
    let grant = null;
    try {
      const prepared = await client.rpc('prepare_weekly_report_upload', {
        p_token: token,
        p_member_id: selectedModel.member.id,
        p_filename: file.name,
        p_mime_type: file.type || 'application/octet-stream',
        p_size_bytes: file.size
      });
      if (prepared.error) throw prepared.error;
      grant = prepared.data;
      button.textContent = '上傳中...';
      const upload = await client.storage.from(grant.bucket).upload(grant.storage_path, file, {
        upsert: false,
        contentType: file.type || 'application/octet-stream'
      });
      if (upload.error) throw upload.error;
      button.textContent = '建立批改工作...';
      const submitted = await client.rpc('submit_weekly_report', {
        p_token: token,
        p_upload_id: grant.upload_id
      });
      if (submitted.error) throw submitted.error;
      toast('繳交成功；系統已自動排入 Codex 批改');
      $('#reportFile').value = '';
      await loadBatch();
    } catch (error) {
      if (grant?.storage_path) {
        try { await client.storage.from(grant.bucket).remove([grant.storage_path]); }
        catch (_) {}
      }
      toast(errorText(error));
    } finally {
      button.textContent = '上傳並送出批改';
      button.disabled = !$('#reportFile').files?.[0] || !selectedModel || !batch?.can_submit;
    }
  }

  function subscribe() {
    if (!batch?.id || subscription) return;
    subscription = client.channel(`weekly-portal-${batch.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'weekly_report_submissions', filter: `batch_id=eq.${batch.id}`
      }, () => loadBatch().catch(() => {}))
      .subscribe();
  }

  async function showLogin() {
    $('#batchCard').hidden = true;
    $('#loginCard').hidden = false;
    $('#guestPassword').focus();
  }

  async function init() {
    try {
      if (token.length < 24) throw new Error('這個週報網址不完整，請回到 Discord 使用本週最新連結');
      requireConfiguration();
      const session = await client.auth.getSession();
      if (session.error) throw session.error;
      if (!session.data.session) return showLogin();
      await loadBatch();
    } catch (error) {
      const text = errorText(error);
      if (/login|required|JWT|session|permission/i.test(text)) return showLogin();
      message(text, true);
    }
  }

  $('#guestLoginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    button.textContent = '驗證中...';
    try {
      const result = await client.auth.signInWithPassword({
        email: runtime.guestEmail,
        password: $('#guestPassword').value
      });
      if (result.error) throw result.error;
      await loadBatch();
    } catch (error) {
      message('訪客密碼錯誤，或本週連結已失效。', true);
    } finally {
      button.disabled = false;
      button.textContent = '進入';
    }
  });
  $('#showPassword').addEventListener('change', event => {
    $('#guestPassword').type = event.target.checked ? 'text' : 'password';
  });
  $('#memberSelect').addEventListener('change', renderScope);
  $('#downloadButton').addEventListener('click', downloadReport);
  $('#reportFile').addEventListener('change', () => {
    try { validateFile($('#reportFile').files?.[0]); }
    catch (error) { $('#reportFile').value = ''; toast(errorText(error)); }
    $('#submitButton').disabled = !$('#reportFile').files?.[0] || !selectedModel || !batch?.can_submit;
  });
  $('#submitButton').addEventListener('click', submitReport);
  $('#refreshButton').addEventListener('click', () => loadBatch().catch(error => toast(errorText(error))));
  window.addEventListener('beforeunload', () => {
    if (subscription) client.removeChannel(subscription).catch(() => {});
  });

  init();
})();
