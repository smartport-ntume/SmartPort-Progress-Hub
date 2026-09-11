import { randomBytes } from 'node:crypto';
import { weeklyPortalLink, memberPortalEmbed, membersNeedingReminder, reminderMessages } from './weekly-discord.mjs';
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

  async projectPayload(schedule) {
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

  async batchFor(schedule) {
    const existing = await this.supabase.from('weekly_report_batches')
      .select('id,token,discord_message_id,discord_message_sent_at,last_reminder_date,payload,due_at,accept_until,status')
      .eq('week_key', schedule.weekKey)
      .maybeSingle();
    if (existing.error) throw new Error('weekly_batch_lookup_failed: ' + existing.error.message);
    if (existing.data) return { row: existing.data, created: false };

    const [pm, payload] = await Promise.all([this.resolvePm(), this.projectPayload(schedule)]);
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
    }).select('id,token,discord_message_id,discord_message_sent_at,last_reminder_date,payload,due_at,accept_until,status').single();
    if (inserted.error) {
      if (inserted.error.code === '23505') return this.batchFor(schedule);
      throw new Error('weekly_batch_create_failed: ' + inserted.error.message);
    }
    return { row: inserted.data, created: true };
  }

  async sendDiscord(batch, schedule) {
    if (batch.discord_message_sent_at) return { alreadySent: true };
    const portal = weeklyPortalLink(this.options.portalUrl, batch.token);
    const members = batch.payload?.team_config?.members || [];
    const attachments = await createWeeklyReportAttachments(batch.payload);
    if (attachments.length !== members.length || !attachments.length) {
      throw new Error('weekly_discord_attachments_incomplete');
    }
    const chunks = chunkWeeklyReportAttachments(attachments);
    const messageIds = discordMessageIds(batch.discord_message_id);
    if (messageIds.length > chunks.length) throw new Error('weekly_discord_delivery_state_invalid');
    const checkpoint = nextCheckpoint(batch.payload?.checkpoints, schedule.reportDate);
    const checkpointText = checkpoint
      ? `${checkpoint.id || '下一個 CP'}｜${checkpoint.date}${checkpoint.name ? `｜${checkpoint.name}` : ''}`
      : '目前沒有後續 CP；本期只列逾期未完成項目';
    for (let index = messageIds.length; index < chunks.length; index += 1) {
      const content = index === 0 ? [
        `📣 **【SmartPort 每週週報｜${schedule.weekKey}】**`,
        `本期已建立，共 ${members.length} 位成員。請直接下載與自己姓名相同的 Word 附件，填完後由下方入口上傳。`,
        `📎 附件 ${index + 1}/${chunks.length}（本則 ${chunks[index].length} 份）`,
        `⏰ 截止：${discordDate(new Date(batch.due_at), this.options.timezone)}`,
        `🎯 ${checkpointText}`,
        `📤 上傳入口：${portal.toString()}`,
        '上傳後會由本機 Codex 自動批改並送至 PM Review Queue；正式進度仍須 PM 核准。'
      ].join('\n') : [
        `📎 **【SmartPort 每週週報附件｜${schedule.weekKey}｜${index + 1}/${chunks.length}】**`,
        `本則包含 ${chunks[index].length} 份個人 Word 週報，請下載與自己姓名相同的附件。`,
        `📤 填完後上傳：${portal.toString()}`
      ].join('\n');
      const response = await this.fetchFn(safeDiscordWebhook(this.options.discordWebhookUrl), {
        method: 'POST',
        body: discordAttachmentForm(content, chunks[index], [memberPortalEmbed(chunks[index], this.options.portalUrl, batch.token)])
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
    return { sent: true, batchId: batch.id, memberCount: members.length, messageCount: chunks.length };
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
    return this.withDeliveryLock(() => this.deliverReminder(schedule));
  }

  async deliverReminder(schedule) {
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
      || batch.last_reminder_date === todayKey || now > new Date(batch.accept_until)) {
      return { due: false };
    }

    const submissions = await this.supabase.from('weekly_report_submissions')
      .select('member_id,status,review_status,is_current,revision,submitted_at')
      .eq('batch_id', batch.id);
    if (submissions.error) {
      throw new Error('weekly_reminder_submission_lookup_failed: ' + submissions.error.message);
    }
    const missing = membersNeedingReminder(batch.payload?.team_config?.members, submissions.data);

    if (missing.length) {
      const late = now > new Date(batch.due_at);
      const messages = reminderMessages({
        members: missing, baseUrl: this.options.portalUrl, token: batch.token,
        heading: `⏰ **【SmartPort 週報${late ? '逾期' : '催繳'}｜${schedule.weekKey}】**`,
        deadline: late
          ? `補交期限：${discordDate(new Date(batch.accept_until), this.options.timezone)}`
          : `截止：${discordDate(new Date(batch.due_at), this.options.timezone)}`
      });
      for (const message of messages) {
        const response = await this.fetchFn(safeDiscordWebhook(this.options.discordWebhookUrl), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message)
        });
        if (!response.ok) throw new Error(`discord_reminder_failed:${response.status}`);
      }
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
      const { row } = await this.batchFor(schedule);
      try { return await this.sendDiscord(row, schedule); }
      catch (error) { await this.recordError(row.id, error); throw error; }
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
      if (!batch || batch.status !== 'OPEN' || +new Date(batch.accept_until) < +this.now()) {
        throw new Error('此批次已停止收件，請先展延截止時間');
      }
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

  async tick() {
    if (this.stopped) return;
    const schedule = weeklySchedule(this.now(), this.options);
    if (schedule.shouldCatchUp) {
      try {
        await this.publish(schedule);
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
