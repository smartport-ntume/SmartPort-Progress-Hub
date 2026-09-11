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
  let feedbackSequence = 0;

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
    const text = error?.message || error?.error_description || String(error || '未知錯誤');
    if (/weekly_report_review_in_progress/.test(text)) return 'PM 正在處理這份週報，請稍後再補交；若審核未完成，請聯絡 PM。';
    return text;
  }

  function requireConfiguration() {
    if (!window.supabase?.createClient || !/^https:\/\//.test(runtime.supabaseUrl || '')
      || String(runtime.supabaseAnonKey || '').length < 20) {
      throw new Error('週報入口尚未完成 Supabase 前端設定');
    }
    client = window.supabase.createClient(runtime.supabaseUrl, runtime.supabaseAnonKey, {
      auth: {
        storageKey: 'smartport.weekly.auth',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    });
  }

  async function ensurePortalSession() {
    const current = await client.auth.getSession();
    if (current.error) throw current.error;
    if (current.data.session) return current.data.session;
    const signedIn = await client.auth.signInAnonymously();
    if (signedIn.error) {
      if (/anonymous|disabled|not enabled/i.test(errorText(signedIn.error))) {
        throw new Error('週報免密碼登入尚未啟用，請聯絡 PM 開啟 Supabase Anonymous Sign-Ins');
      }
      throw signedIn.error;
    }
    if (!signedIn.data.session) throw new Error('無法建立週報繳交工作階段，請重新整理後再試');
    return signedIn.data.session;
  }

  async function loadBatch() {
    const { data, error } = await client.rpc('get_weekly_report_batch', { p_token: token });
    if (error) throw error;
    batch = data;
    renderBatch();
    await loadFeedback();
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

  function statusLabel(row) {
    return window.SmartPortWeeklyReview.status(row).label;
  }

  function renderSubmissions() {
    const rows = $('#submissionRows');
    const latest = latestByMember();
    const members = batch?.payload?.team_config?.members || [];
    rows.className = 'submission-rows';
    rows.innerHTML = members.map(member => {
      const submission = latest.get(member.id);
      return `<div class="submission-row"><span><b>${esc(member.name)}</b>${submission?.revision ? ` · 第 ${submission.revision} 版` : ''}${submission?.late ? ' · <span class="muted">逾期繳交</span>' : ''}</span><span class="status ${esc(submission?.status || '')}">${esc(statusLabel(submission))}</span></div>`;
    }).join('') || '<span class="muted">本期沒有需要繳交週報的成員。</span>';
  }

  async function loadFeedback() {
    const sequence = ++feedbackSequence;
    const memberId = $('#memberSelect').value;
    const panel = $('#feedbackPanel');
    panel.hidden = !memberId;
    if (!memberId) return;
    panel.textContent = '正在讀取批改與 PM 回饋…';
    try {
      const { data, error } = await client.rpc('get_weekly_report_feedback', { p_token: token, p_member_id: memberId });
      if (error) throw error;
      if (sequence !== feedbackSequence) return;
      const rows = data?.versions || [];
      if (!rows.length) { panel.innerHTML = '<h3>批改與 PM 回饋</h3><p>上傳週報後，可在這裡查看缺漏、修改建議及審核結果。</p>'; return; }
      const list = (label,items) => Array.isArray(items)&&items.length ? `<b>${label}</b><ul>${items.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>` : '';
      const content = row => {
        const review = row.review || {};
        return `<p><b>${esc(statusLabel(row))}</b> · ${esc(dateTime(row.submitted_at))}</p>
          ${row.is_current===false?'<p class="muted">這是歷史版本，請依最新一版的結果處理。</p>':''}
          ${review.overall_assessment||row.summary?`<p>${esc(review.overall_assessment||row.summary)}</p>`:''}
          ${Object.keys(review).length?`<div class="feedback-scores">${[['completeness_score','完整度'],['evidence_score','證據品質'],['schedule_alignment_score','時程一致性']].map(([key,label])=>`<span><b>${esc(review[key]??'—')}</b>${label}</span>`).join('')}</div>`:''}
          ${list('需要補充',review.missing_items)}${list('建議下一步',review.actions)}
          ${row.pm_feedback?`<div class="feedback-pm"><b>PM 回饋</b><p>${esc(row.pm_feedback)}</p></div>`:''}
          ${row.review_status==='CHANGES_REQUESTED'?'<p>請依回饋修改 Word，再使用上方入口補交新版。</p>':''}`;
      };
      panel.innerHTML = `<h3>批改與 PM 回饋 · 第 ${rows[0].revision} 版</h3>${content(rows[0])}${rows.slice(1).map(row=>`<details><summary>第 ${row.revision} 版 · ${esc(statusLabel(row))}</summary>${content(row)}</details>`).join('')}`;
    } catch (error) {
      if (sequence===feedbackSequence) panel.textContent='回饋暫時無法讀取，請重新整理或聯絡 PM。';
    }
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

  async function init() {
    try {
      if (token.length < 24) throw new Error('這個週報網址不完整，請回到 Discord 使用本週最新連結');
      requireConfiguration();
      await ensurePortalSession();
      await loadBatch();
    } catch (error) {
      $('#batchCard').hidden = true;
      message(errorText(error), true);
    }
  }

  $('#memberSelect').addEventListener('change', () => { renderScope(); loadFeedback(); });
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
