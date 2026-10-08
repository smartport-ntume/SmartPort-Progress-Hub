import { extractWeeklyReport } from './report-extractor.mjs';
import { extractTaskSteps } from '../worker/src/weekly-task-reviews.js';
import { randomBytes, createHash } from 'node:crypto';
import { previousReviewHandoff, pendingReviewError } from './weekly-review-handoff.mjs';
import {
  normalizeTeamConfig,
  referencedTeamIds,
  validateTeamConfig
} from '../worker/src/team-config.js';
import {
  chunkWeeklyReportAttachments,
  createWeeklyReportAttachments,
  discordAttachmentForm
} from './weekly-report-attachments.mjs';

const DAY_MS = 86_400_000;
const RETRY_MS = 15 * 60 * 1000;
const SUBMITTED_STATUSES = new Set(['queued', 'running', 'completed']);

function localParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
  return parts;
}

function localInstant(value, timeZone) {
  const target = Date.UTC(value.year, value.month - 1, value.day, value.hour || 0, value.minute || 0, 0);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localParts(new Date(guess), timeZone);
    const actualClock = Date.UTC(
      actual.year, actual.month - 1, actual.day,
      actual.hour, actual.minute, actual.second
    );
    const correction = target - actualClock;
    guess += correction;
    if (correction === 0) break;
  }
  return new Date(guess);
}

function dateKeyFromOrdinal(ordinal) {
  return new Date(ordinal).toISOString().slice(0, 10);
}

function dateOrdinal(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error('invalid_weekly_local_date');
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function addLocalDays(value, days) {
  return dateKeyFromOrdinal(dateOrdinal(value) + Number(days) * DAY_MS);
}

function dateKeyParts(value) {
  const date = new Date(dateOrdinal(value));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function isoWeekKey(value) {
  const date = new Date(dateOrdinal(value));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / DAY_MS) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function publicationToken(value) {
  const stable = item => Array.isArray(item) ? item.map(stable) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function manualWeeklySchedule(input, now, timeZone = 'Asia/Taipei') {
  const reportDate = String(input.report_date || '');
  const ordinal = dateOrdinal(reportDate);
  if (dateKeyFromOrdinal(ordinal) !== reportDate || new Date(ordinal).getUTCDay() !== 1) {
    throw new Error('請選擇有效的週次（週一為起始日）。');
  }
  const today = dateOrdinal(localDateKey(now, timeZone));
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY_MS;
  if (ordinal < monday) throw new Error('新發布請選本週或未來週次；既有週次請使用更新回饋並補發。');
  const dueAt = new Date(input.due_at);
  if (!Number.isFinite(+dueAt) || dueAt <= now || dueAt <= instantForDate(reportDate, 0, 0, timeZone)) {
    throw new Error('截止時間必須晚於現在與該週起始日。');
  }
  return { reportDate, weekKey: isoWeekKey(reportDate), dueAt };
}

function instantForDate(value, hour, minute, timeZone) {
  return localInstant({ ...dateKeyParts(value), hour, minute }, timeZone);
}

function localDateKey(value, timeZone) {
  const parts = localParts(new Date(value), timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function nextReminderAt(nowValue, options) {
  const now = new Date(nowValue);
  if (Number.isNaN(+now)) throw new Error('invalid_weekly_reminder_now');
  const todayKey = localDateKey(now, options.timezone);
  let candidate = instantForDate(
    todayKey, options.reminderHour, options.reminderMinute, options.timezone
  );
  if (candidate <= now) {
    candidate = instantForDate(
      addLocalDays(todayKey, 1), options.reminderHour, options.reminderMinute, options.timezone
    );
  }
  return candidate;
}

export function weeklySchedule(nowValue, options) {
  const now = new Date(nowValue);
  if (Number.isNaN(+now)) throw new Error('invalid_weekly_schedule_now');
  const today = localParts(now, options.timezone);
  const todayKey = localDateKey(now, options.timezone);
  const todayWeekday = new Date(dateOrdinal(todayKey)).getUTCDay();
  const daysSincePublishDay = (todayWeekday - options.publishWeekday + 7) % 7;
  let occurrenceDate = addLocalDays(todayKey, -daysSincePublishDay);
  let occurrenceAt = instantForDate(
    occurrenceDate, options.publishHour, options.publishMinute, options.timezone
  );
  let nextPublishAt;
  if (occurrenceAt > now) {
    nextPublishAt = occurrenceAt;
    occurrenceDate = addLocalDays(occurrenceDate, -7);
    occurrenceAt = instantForDate(
      occurrenceDate, options.publishHour, options.publishMinute, options.timezone
    );
  } else {
    const nextDate = addLocalDays(occurrenceDate, 7);
    nextPublishAt = instantForDate(
      nextDate, options.publishHour, options.publishMinute, options.timezone
    );
  }
  const dueDate = addLocalDays(occurrenceDate, options.dueDays);
  const dueAt = instantForDate(dueDate, options.dueHour, options.dueMinute, options.timezone);
  return {
    reportDate: occurrenceDate,
    weekKey: isoWeekKey(occurrenceDate),
    publishAt: occurrenceAt,
    dueAt,
    nextPublishAt,
    shouldCatchUp: now >= occurrenceAt
      && now - occurrenceAt <= options.catchUpDays * DAY_MS
  };
}

function reportArrays(files) {
  return {
    project: files.project || {},
    workPackages: files.workPackages?.work_packages || [],
    subtasks: files.subtasks?.subtasks || [],
    checkpoints: files.checkpoints?.checkpoints || [],
    checkpointReferences: files.reference?.acl_levels || []
  };
}

async function optionalJson(store, file) {
  try { return await store.readJson(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function safeDiscordWebhook(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:'
    || !['discord.com', 'discordapp.com'].includes(url.hostname)
    || !/^\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+\/?$/.test(url.pathname)) {
    throw new Error('invalid_discord_webhook_url');
  }
  url.searchParams.set('wait', 'true');
  return url;
}

function discordDate(value, timeZone) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(value);
}

function nextCheckpoint(checkpoints, reportDate) {
  return (checkpoints || [])
    .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(String(item?.date || '')) && item.date > reportDate)
    .sort((left, right) => left.date.localeCompare(right.date))[0] || null;
}

function discordMessageIds(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map(item => String(item || '').slice(0, 100)).filter(Boolean).slice(0, 100);
    }
  } catch (_) {}
  return [text.slice(0, 100)];
}

export class WeeklyReportAutomation {
  constructor({ supabase, projectStore, options, fetchFn = fetch, logger = console, now = () => new Date() }) {
    this.supabase = supabase;
    this.projectStore = projectStore;
    this.options = options;
    this.fetchFn = fetchFn;
    this.logger = logger;
    this.now = now;
    this.timer = null;
    this.stopped = true;
    this.deliveryChain = Promise.resolve();
  }

  async resolvePm() {
    let query = this.supabase.from('profiles')
      .select('user_id,login,display_name')
      .eq('role', 'PM')
      .eq('active', true)
      .eq('can_trigger_codex', true)
      .order('created_at', { ascending: true })
      .limit(1);
    if (this.options.pmLogin) query = query.eq('login', this.options.pmLogin);
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error('weekly_pm_lookup_failed: ' + error.message);
    if (!data) throw new Error(this.options.pmLogin
      ? `weekly_pm_not_authorized:${this.options.pmLogin}`
      : 'weekly_pm_with_codex_permission_not_found');
    return data;
  }

  async projectPayload(schedule, previousReview = null) {
    const [project, workPackages, subtasks, checkpoints, teamConfigValue, reference] = await Promise.all([
      this.projectStore.readJson('project/project.json'),
      this.projectStore.readJson('project/work_packages.json'),
      this.projectStore.readJson('project/subtasks.json'),
      this.projectStore.readJson('project/checkpoints.json'),
      optionalJson(this.projectStore, 'project/team_config.json'),
      optionalJson(this.projectStore, 'project/reference_model.json')
    ]);
    const arrays = reportArrays({ project, workPackages, subtasks, checkpoints, reference });
    const normalizedTeamConfig = normalizeTeamConfig(teamConfigValue, {
      referencedCategoryIds: referencedTeamIds(arrays.workPackages, arrays.subtasks),
      subtasks: arrays.subtasks
    });
    const teamConfig = validateTeamConfig(normalizedTeamConfig, {
      workPackages: arrays.workPackages,
      subtasks: arrays.subtasks
    });
    const activeCategoryIds = new Set((teamConfig.categories || [])
      .filter(category => category.active !== false)
      .map(category => category.id));
    const eligibleMemberIds = new Set(Object.entries(teamConfig.category_owners || {})
      .filter(([categoryId]) => activeCategoryIds.has(categoryId))
      .map(([, memberId]) => memberId));
    const eligibleMembers = (teamConfig.members || []).filter(member =>
      member.active !== false
      && member.weekly_report_required !== false
      && eligibleMemberIds.has(member.id)
    );
    if (!eligibleMembers.length) throw new Error('weekly_automation_has_no_eligible_members');
    const eligibleSet = new Set(eligibleMembers.map(member => member.id));
    const payload = {
      schema_version: '1.0',
      week_key: schedule.weekKey,
      report_date: schedule.reportDate,
      due_at: schedule.dueAt.toISOString(),
      previous_review: previousReview,
      project: arrays.project,
      work_packages: arrays.workPackages,
      subtasks: arrays.subtasks,
      checkpoints: arrays.checkpoints,
      checkpoint_references: arrays.checkpointReferences,
      team_config: {
        ...teamConfig,
        members: eligibleMembers,
        category_owners: Object.fromEntries(Object.entries(teamConfig.category_owners || {})
          .filter(([categoryId, memberId]) => activeCategoryIds.has(categoryId) && eligibleSet.has(memberId)))
      }
    };
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > 4 * 1024 * 1024) throw new Error('weekly_batch_payload_too_large');
    return payload;
  }

  async reviewGate(schedule, { readOnly = false } = {}) {
    const previous = await this.supabase.from('weekly_report_batches')
      .select('id,week_key,report_date,payload,last_error')
      .lt('report_date', schedule.reportDate).order('report_date', { ascending: false }).limit(1).maybeSingle();
    if (previous.error) throw new Error('weekly_previous_batch_lookup_failed: ' + previous.error.message);
    if (!previous.data) return previousReviewHandoff(null);
    const submissions = await this.supabase.from('weekly_report_submissions')
      .select('id,member_id,revision,is_current,status,review_status,pm_feedback,pm_task_feedback,analysis_result,reviewed_at,report_path')
      .eq('batch_id', previous.data.id);
    if (submissions.error) throw new Error('weekly_previous_review_lookup_failed: ' + submissions.error.message);
    // Older analyses did not retain step plans. Read each current archived Word
    // once per version; never alter the submitted file or a PM review decision.
    this.stepCache ||= new Map();
    for (const row of submissions.data || []) {
      if (row.is_current === false || row.review_status === 'SUPERSEDED' || row.analysis_result?.analysis?.task_steps != null
        || !row.report_path?.startsWith('weekly_reports/') || !this.projectStore.readBuffer) continue;
      const cacheKey = `${row.id}:${row.revision}:${row.report_path}`;
      let steps = this.stepCache.get(cacheKey);
      if (!steps) {
        const buffer = await this.projectStore.readBuffer(row.report_path);
        if (buffer.length > 10 * 1024 * 1024) throw new Error('weekly_report_file_too_large');
        const extracted = await extractWeeklyReport({ filename: row.report_path, buffer, libreOfficeBin: this.options.libreOfficeBin });
        steps = extractTaskSteps(extracted.text, previous.data.payload);
        if (this.stepCache.size >= 200) this.stepCache.clear();
        this.stepCache.set(cacheKey, steps);
      }
      row.analysis_result = { ...row.analysis_result, analysis: { ...row.analysis_result?.analysis, task_steps: steps } };
    }
    const gate = previousReviewHandoff(previous.data, submissions.data || []);
    if (!readOnly && gate.ready && String(previous.data.last_error || '').startsWith('下一期週報等待 ')) {
      const cleared = await this.supabase.from('weekly_report_batches').update({ last_error: null })
        .eq('id', previous.data.id).eq('last_error', previous.data.last_error);
      if (cleared.error) throw new Error('weekly_previous_review_state_failed: ' + cleared.error.message);
    }
    return gate;
  }

  async batchFor(schedule, previousReview = null, preparedPayload = null) {
    const existing = await this.supabase.from('weekly_report_batches')
      .select('id,week_key,report_date,token,discord_message_id,discord_message_sent_at,last_reminder_date,payload,due_at,accept_until,status')
      .eq('week_key', schedule.weekKey)
      .maybeSingle();
    if (existing.error) throw new Error('weekly_batch_lookup_failed: ' + existing.error.message);
    if (existing.data) return { row: existing.data, created: false };

    const [pm, payload] = await Promise.all([this.resolvePm(), preparedPayload || this.projectPayload(schedule, previousReview)]);
    const token = randomBytes(24).toString('base64url');
    const inserted = await this.supabase.from('weekly_report_batches').insert({
      week_key: schedule.weekKey,
      report_date: schedule.reportDate,
      due_at: schedule.dueAt.toISOString(),
      accept_until: new Date(+schedule.dueAt + 7 * DAY_MS).toISOString(),
      token,
      payload,
      pm_user_id: pm.user_id,
      created_by_agent: this.options.agentId || ''
    }).select('id,week_key,report_date,token,discord_message_id,discord_message_sent_at,last_reminder_date,payload,due_at,accept_until,status').single();
    if (inserted.error) {
      if (inserted.error.code === '23505') return this.batchFor(schedule, previousReview, preparedPayload);
      throw new Error('weekly_batch_create_failed: ' + inserted.error.message);
    }
    return { row: inserted.data, created: true };
  }

  async sendDiscord(batch, schedule, { frozen = false } = {}) {
    if (batch.discord_message_sent_at) return { alreadySent: true };
    if (frozen && batch.payload?.publication?.mode !== 'manual') throw new Error('manual_publication_confirmation_missing');
    if (frozen && batch.status !== 'OPEN') throw new Error('weekly_batch_closed');
    const gate = frozen ? { ready: true, review: batch.payload.previous_review } : await this.reviewGate(schedule);
    if (!gate.ready) throw pendingReviewError(gate);
    const messageIds = discordMessageIds(batch.discord_message_id);
    if (!frozen && !messageIds.length) {
      // Refresh only before the first attachment is delivered. Retries keep one consistent snapshot.
      const payload = await this.projectPayload({ ...schedule, dueAt: new Date(batch.due_at) }, gate.review);
      const saved = await this.supabase.from('weekly_report_batches').update({ payload }).eq('id', batch.id);
      if (saved.error) throw new Error('weekly_handoff_save_failed: ' + saved.error.message);
      batch.payload = payload;
    } else if (!frozen && JSON.stringify(batch.payload?.previous_review ?? null) !== JSON.stringify(gate.review)) {
      throw new Error('上一期審核結果已變更，請確認後使用「更新回饋並補發」重新發送整批週報。');
    }
    const portal = new URL(this.options.portalUrl);
    portal.hash = new URLSearchParams({ batch: batch.token }).toString();
    const members = batch.payload?.team_config?.members || [];
    const attachments = await createWeeklyReportAttachments(batch.payload);
    if (attachments.length !== members.length || !attachments.length) {
      throw new Error('weekly_discord_attachments_incomplete');
    }
    const chunks = chunkWeeklyReportAttachments(attachments);
    if (messageIds.length > chunks.length) throw new Error('weekly_discord_delivery_state_invalid');
    const confirmed = frozen ? gate : await this.reviewGate(schedule);
    if (!confirmed.ready) throw pendingReviewError(confirmed);
    if (JSON.stringify(confirmed.review) !== JSON.stringify(gate.review)) throw new Error('上期 PM 回饋剛更新，稍後重新產生附件。');
    const checkpoint = nextCheckpoint(batch.payload?.checkpoints, schedule.reportDate);
    const checkpointText = checkpoint
      ? `${checkpoint.id || '下一個 CP'}｜${checkpoint.date}${checkpoint.name ? `｜${checkpoint.name}` : ''}`
      : '目前沒有後續 CP；本期只列逾期未完成項目';
    for (let index = messageIds.length; index < chunks.length; index += 1) {
      const content = index === 0 ? [
        `📣 **【SmartPort 每週週報｜${schedule.weekKey}${batch.payload?.publication?.revision > 1 ? `｜更新版 v${batch.payload.publication.revision}` : ''}】**`,
        `本期已建立，共 ${members.length} 位成員。請直接下載與自己姓名相同的 Word 附件，填完後由下方入口上傳。`,
        `📎 附件 ${index + 1}/${chunks.length}（本則 ${chunks[index].length} 份）`,
        `⏰ 截止：${discordDate(new Date(batch.due_at), this.options.timezone)}`,
        `🎯 ${checkpointText}`,
        ...(gate.review ? [frozen
          ? `📝 已帶入 ${gate.review.week_key} 已完成審閱的個人 PM 回饋；上期未繳或待審者也有本期附件，狀態標示於 Word。`
          : `📝 已帶入 ${gate.review.week_key} 的個人 PM 回饋，請在 Word 的「上期 PM 回饋與本週回覆」逐項回應。`] : []),
        `📤 上傳入口：${portal.toString()}`,
        '上傳後會由本機 Codex 自動批改並送至 PM Review Queue；正式進度仍須 PM 核准。'
      ].join('\n') : [
        `📎 **【SmartPort 每週週報附件｜${schedule.weekKey}${batch.payload?.publication?.revision > 1 ? `｜更新版 v${batch.payload.publication.revision}` : ''}｜${index + 1}/${chunks.length}】**`,
        `本則包含 ${chunks[index].length} 份個人 Word 週報，請下載與自己姓名相同的附件。`,
        `📤 填完後上傳：${portal.toString()}`
      ].join('\n');
      const response = await this.fetchFn(safeDiscordWebhook(this.options.discordWebhookUrl), {
        method: 'POST',
        body: discordAttachmentForm(content, chunks[index])
      });
      if (!response.ok) throw new Error(`discord_webhook_failed:${response.status}`);
      const sent = await response.json().catch(() => ({}));
      const messageId = String(sent?.id || '').slice(0, 100);
      if (!messageId) throw new Error('discord_webhook_missing_message_id');
      messageIds.push(messageId);
      const progress = await this.supabase.from('weekly_report_batches').update({
        discord_message_id: JSON.stringify(messageIds),
        last_error: null
      }).eq('id', batch.id);
      if (progress.error) throw new Error('weekly_batch_discord_state_failed: ' + progress.error.message);
    }
    const updated = await this.supabase.from('weekly_report_batches').update({
      discord_message_sent_at: this.now().toISOString(),
      discord_message_id: JSON.stringify(messageIds),
      last_error: null
    }).eq('id', batch.id);
    if (updated.error) throw new Error('weekly_batch_discord_state_failed: ' + updated.error.message);
    this.logger.info(`[weekly] published ${schedule.weekKey} to Discord (${members.length} files in ${chunks.length} message(s))`);
    return { sent: true, batchId: batch.id, memberCount: members.length, messageCount: chunks.length,
      revision: batch.payload?.publication?.revision || 1 };
  }

  async publicationPlan(input, { allowSent = false } = {}) {
    if (!this.options.discordWebhookUrl || !this.options.portalUrl) throw new Error('請先設定 Discord Webhook 與週報繳交入口。');
    safeDiscordWebhook(this.options.discordWebhookUrl);
    const updating = !!input.batch_id;
    let schedule = updating ? null : manualWeeklySchedule(input, this.now(), this.options.timezone);
    const lookup = this.supabase.from('weekly_report_batches').select('*');
    const loaded = await (updating ? lookup.eq('id', input.batch_id) : lookup.eq('week_key', schedule.weekKey)).maybeSingle();
    if (loaded.error) throw new Error('weekly_publication_lookup_failed: ' + loaded.error.message);
    const batch = loaded.data;
    if (updating && !batch) throw new Error('weekly_batch_not_found');
    if (batch && batch.status !== 'OPEN') throw new Error('此週次已關閉，無法發布。');
    if (!updating && batch?.discord_message_sent_at) {
      if (allowSent) return { alreadySent: true, batch };
      throw new Error('此週已發布，請選下一週，或使用「更新回饋並補發」。');
    }
    if (batch) schedule = { reportDate: batch.report_date, weekKey: batch.week_key, dueAt: new Date(batch.due_at) };
    const resume = !!batch && !batch.discord_message_sent_at
      && (batch.payload?.publication?.mode === 'manual' || discordMessageIds(batch.discord_message_id).length > 0);
    const gate = resume ? { review: batch.payload.previous_review } : await this.reviewGate(schedule, { readOnly: true });
    // A feedback update keeps the existing members, task scope, baseline and portal.
    // A new publication uses the current official project data for all eligible members.
    const payload = batch && (updating || resume) ? structuredClone(batch.payload) : await this.projectPayload(schedule, gate.review);
    if (!resume) payload.previous_review = gate.review;
    const recipients = payload.team_config.members;
    const previous = payload.previous_review;
    const members = recipients.map(member => {
      const review = previous?.members?.find(row => row.member_id === member.id);
      const state = review && ['APPROVED','CHANGES_REQUESTED'].includes(review.review_status) ? 'REVIEWED'
        : review?.review_status === 'MISSING' ? 'MISSING' : review ? 'PENDING' : 'NOT_REQUIRED';
      return { member_id: member.id, member_name: member.name || member.id, state,
        label: ({ REVIEWED: '已完成 PM 審閱', MISSING: '上期未繳交', PENDING: '上期 PM 回饋待補', NOT_REQUIRED: previous ? '上期無需繳交' : '首次週報' })[state] };
    });
    const revision = resume ? batch.payload?.publication?.revision || 1
      : batch?.discord_message_sent_at ? (batch.payload?.publication?.revision || 1) + 1 : 1;
    const token = publicationToken({ payload, report_date: schedule.reportDate, due_at: schedule.dueAt.toISOString(),
      batch_id: batch?.id || null, revision, mode: updating ? 'update' : 'publish', resume });
    return { batch, payload, schedule, preview: { preview_token: token, week_key: schedule.weekKey,
      report_date: schedule.reportDate, due_at: schedule.dueAt.toISOString(), batch_id: batch?.id || null,
      previous_week: previous?.week_key || null, revision, resume, updating, members,
      counts: Object.fromEntries(['REVIEWED','MISSING','PENDING','NOT_REQUIRED'].map(state => [state, members.filter(m => m.state === state).length])) } };
  }

  async previewPublication(input) {
    return (await this.publicationPlan(input)).preview;
  }

  async publishManually(input, job) {
    return this.withDeliveryLock(async () => {
      let batch;
      try {
        // An interrupted, confirmed job may resume after its week or deadline has passed.
        // Resolve the job's saved edition before validating a new publication request.
        const replay = await this.supabase.from('weekly_report_batches').select('*')
          .eq('delivery_job_id', job.id).maybeSingle();
        if (replay.error) throw new Error('weekly_publication_lookup_failed: ' + replay.error.message);
        if (replay.data?.payload?.publication?.mode === 'manual'
          && replay.data.payload.publication.job_id === job.id) {
          batch = replay.data;
          return await this.sendDiscord(batch, { reportDate: batch.report_date, weekKey: batch.week_key }, { frozen: true });
        }
        const plan = await this.publicationPlan(input, { allowSent: true });
        batch = plan.batch;
        if (plan.alreadySent) return { alreadySent: true, batchId: batch.id };
        if (input.preview_token !== plan.preview.preview_token) throw new Error('發布資料已變更，請重新預覽名單與回饋狀態後再發布。');
        if (!batch) {
          const created = await this.batchFor(plan.schedule, plan.payload.previous_review, plan.payload);
          if (!created.created) throw new Error('此週次剛被建立，請重新預覽後再發布。');
          batch = created.row;
        }
        const payload = { ...plan.payload, publication: {
          mode: 'manual', revision: plan.preview.revision, job_id: job.id, confirmed_by: job.actor_login,
          confirmed_at: this.now().toISOString(), preview_token: input.preview_token
        } };
        const patch = { payload, delivery_job_id: job.id, last_error: null };
        if (!plan.preview.resume) Object.assign(patch, { discord_message_id: '', discord_message_sent_at: null });
        const saved = await this.supabase.from('weekly_report_batches').update(patch).eq('id', batch.id);
        if (saved.error) throw new Error('weekly_publication_save_failed: ' + saved.error.message);
        Object.assign(batch, patch);
        return await this.sendDiscord(batch, plan.schedule, { frozen: true });
      } catch (error) { await this.recordError(batch?.id, error); throw error; }
    });
  }

  async recordError(batchId, error) {
    if (!batchId) return;
    try {
      const updated = await this.supabase.from('weekly_report_batches').update({
        last_error: String(error?.message || error).slice(0, 2000)
      }).eq('id', batchId);
      if (updated.error) this.logger.error('[weekly] failed to record scheduler error:', updated.error.message);
    } catch (_) {}
  }

  async sendReminder(schedule) {
    if (!this.options.reminderEnabled) return { enabled: false };
    const now = this.now();
    const todayKey = localDateKey(now, this.options.timezone);
    const reminderAt = instantForDate(
      todayKey, this.options.reminderHour, this.options.reminderMinute, this.options.timezone
    );
    if (todayKey <= schedule.reportDate || now < reminderAt) return { due: false };

    const lookup = await this.supabase.from('weekly_report_batches')
      .select('id,token,discord_message_id,discord_message_sent_at,last_reminder_date,payload,due_at,accept_until,status')
      .eq('week_key', schedule.weekKey)
      .maybeSingle();
    if (lookup.error) throw new Error('weekly_reminder_batch_lookup_failed: ' + lookup.error.message);
    const batch = lookup.data;
    if (!batch || !batch.discord_message_sent_at || batch.status !== 'OPEN'
      || batch.last_reminder_date === todayKey) {
      return { due: false };
    }

    const submissions = await this.supabase.from('weekly_report_submissions')
      .select('member_id,status')
      .eq('batch_id', batch.id);
    if (submissions.error) {
      throw new Error('weekly_reminder_submission_lookup_failed: ' + submissions.error.message);
    }
    const submitted = new Set((submissions.data || [])
      .filter(item => SUBMITTED_STATUSES.has(item.status))
      .map(item => item.member_id));
    const missing = (batch.payload?.team_config?.members || [])
      .filter(member => !submitted.has(member.id));

    if (missing.length) {
      const portal = new URL(this.options.portalUrl);
      portal.hash = new URLSearchParams({ batch: batch.token }).toString();
      const names = [];
      let length = 0;
      for (const member of missing) {
        const name = String(member.name || member.id || '').trim();
        if (!name || length + name.length > 900) break;
        names.push(name);
        length += name.length + 1;
      }
      const omitted = missing.length - names.length;
      const late = now > new Date(batch.due_at);
      const content = [
        `⏰ **【SmartPort 週報${late ? '逾期' : '催繳'}｜${schedule.weekKey}】**`,
        `尚有 ${missing.length} 位未完成繳交：${names.join('、')}${omitted ? `，另 ${omitted} 位` : ''}`,
        late
          ? '仍可直接補交，系統將註記逾期。'
          : `截止：${discordDate(new Date(batch.due_at), this.options.timezone)}`,
        `👉 ${portal.toString()}`
      ].join('\n');
      const response = await this.fetchFn(safeDiscordWebhook(this.options.discordWebhookUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
      });
      if (!response.ok) throw new Error(`discord_reminder_failed:${response.status}`);
    }

    const updated = await this.supabase.from('weekly_report_batches').update({
      last_reminder_date: todayKey,
      last_error: null
    }).eq('id', batch.id);
    if (updated.error) throw new Error('weekly_reminder_state_failed: ' + updated.error.message);
    this.logger.info(`[weekly] reminder ${schedule.weekKey}: ${missing.length} member(s) missing`);
    return { sent: missing.length > 0, missing: missing.length };
  }

  async publish(schedule) {
    return this.withDeliveryLock(async () => {
      let row;
      try {
        const delivered = await this.supabase.from('weekly_report_batches').select('*')
          .eq('week_key', schedule.weekKey).maybeSingle();
        if (delivered.error) throw new Error('weekly_batch_lookup_failed: ' + delivered.error.message);
        if (delivered.data?.discord_message_sent_at) return { alreadySent: true };
        if (delivered.data?.payload?.publication?.mode === 'manual') {
          row = delivered.data;
          return await this.sendDiscord(row, { reportDate: row.report_date, weekKey: row.week_key }, { frozen: true });
        }
        const gate = await this.reviewGate(schedule);
        if (!gate.ready) throw pendingReviewError(gate);
        ({ row } = await this.batchFor(schedule, gate.review));
        return await this.sendDiscord(row, schedule);
      } catch (error) {
        if (error.code === 'weekly_previous_review_pending') {
          await this.recordError(error.gate.batchId, error);
          return { deferred: true, blockingWeek: error.gate.weekKey, blocked: error.gate.blocked };
        }
        await this.recordError(row?.id, error); throw error;
      }
    });
  }

  withDeliveryLock(operation) {
    const next = this.deliveryChain.then(operation);
    this.deliveryChain = next.catch(() => {});
    return next;
  }

  async resendBatch(batchId, jobId) {
    if (!this.options.enabled) throw new Error('請先啟用每週 Discord 發送設定');
    return this.withDeliveryLock(async () => {
      const loaded = await this.supabase.from('weekly_report_batches').select('*').eq('id', batchId).maybeSingle();
      if (loaded.error) throw new Error('weekly_resend_lookup_failed: ' + loaded.error.message);
      const batch = loaded.data;
      if (!batch || batch.status !== 'OPEN') {
        throw new Error('此批次已關閉');
      }
      const gate = await this.reviewGate({ reportDate: batch.report_date });
      if (!gate.ready) throw pendingReviewError(gate);
      if (batch.delivery_job_id !== jobId) {
        const reset = { delivery_job_id: jobId, discord_message_id: '', discord_message_sent_at: null, last_error: null };
        const updated = await this.supabase.from('weekly_report_batches').update(reset).eq('id', batch.id);
        if (updated.error) throw new Error('weekly_resend_state_failed: ' + updated.error.message);
        Object.assign(batch, reset);
      }
      try { return await this.sendDiscord(batch, { weekKey: batch.week_key, reportDate: batch.report_date }); }
      catch (error) { await this.recordError(batch.id, error); throw error; }
    });
  }

  arm(when) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(250, Math.min(+when - +this.now(), 2_147_000_000));
    this.timer = setTimeout(() => this.tick().catch(error => {
      this.logger.error('[weekly] scheduler error:', error?.message || String(error));
    }), delay);
  }

  wakeAfterReview() {
    if (this.options.enabled && !this.stopped) this.arm(this.now());
  }

  async tick() {
    if (this.stopped) return;
    const schedule = weeklySchedule(this.now(), this.options);
    if (schedule.shouldCatchUp) {
      try {
        const result = await this.publish(schedule);
        if (result.deferred) {
          this.logger.info(`[weekly] ${schedule.weekKey} waits for PM review of ${result.blockingWeek}`);
          this.arm(new Date(+this.now() + RETRY_MS));
          return;
        }
      } catch (error) {
        this.logger.error(`[weekly] ${schedule.weekKey} publish failed:`, error?.message || String(error));
        this.arm(new Date(+this.now() + RETRY_MS));
        return;
      }
    }
    if (this.options.reminderEnabled) {
      try {
        await this.sendReminder(schedule);
      } catch (error) {
        this.logger.error(`[weekly] ${schedule.weekKey} reminder failed:`, error?.message || String(error));
        this.arm(new Date(+this.now() + RETRY_MS));
        return;
      }
    }
    const nextEventAt = this.options.reminderEnabled
      ? new Date(Math.min(+schedule.nextPublishAt, +nextReminderAt(this.now(), this.options)))
      : schedule.nextPublishAt;
    this.arm(nextEventAt);
  }

  async start() {
    if (!this.options.enabled) return { enabled: false };
    this.stopped = false;
    await this.tick();
    return { enabled: true };
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
