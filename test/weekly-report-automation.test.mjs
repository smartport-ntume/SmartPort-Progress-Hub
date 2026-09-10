import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextReminderAt,
  WeeklyReportAutomation,
  weeklySchedule
} from '../local-server/weekly-report-automation.mjs';

const options = {
  enabled: true,
  discordWebhookUrl: 'https://discord.com/api/webhooks/1234567890/test_token',
  portalUrl: 'https://example.test/weekly-submit.html',
  timezone: 'Asia/Taipei',
  publishWeekday: 1,
  publishHour: 13,
  publishMinute: 0,
  dueDays: 7,
  dueHour: 12,
  dueMinute: 0,
  catchUpDays: 7,
  reminderEnabled: true,
  reminderHour: 13,
  reminderMinute: 0,
  agentId: 'test-agent'
};

function discordBatchPayload(memberCount = 2) {
  const members = Array.from({ length: memberCount }, (_, index) => ({
    id: `member-${index + 1}`,
    name: `成員${index + 1}`,
    active: true,
    weekly_report_required: true
  }));
  const categories = members.map((member, index) => ({
    id: `TEAM${index + 1}`,
    name: `分類${index + 1}`,
    active: true
  }));
  return {
    report_date: '2026-09-14',
    team_config: {
      members,
      categories,
      category_owners: Object.fromEntries(categories.map((category, index) => [category.id, members[index].id]))
    },
    work_packages: [],
    subtasks: [],
    checkpoints: [{ id: 'CP1', date: '2026-10-01', name: 'Basic Motion' }],
    checkpoint_references: []
  };
}

test('weekly schedule uses Asia/Taipei Monday 13:00 and survives a late agent start', () => {
  const schedule = weeklySchedule(new Date('2026-09-14T05:01:00.000Z'), options);
  assert.equal(schedule.reportDate, '2026-09-14');
  assert.equal(schedule.weekKey, '2026-W38');
  assert.equal(schedule.publishAt.toISOString(), '2026-09-14T05:00:00.000Z');
  assert.equal(schedule.dueAt.toISOString(), '2026-09-21T04:00:00.000Z');
  assert.equal(schedule.nextPublishAt.toISOString(), '2026-09-21T05:00:00.000Z');
  assert.equal(schedule.shouldCatchUp, true);
  assert.equal(
    nextReminderAt(new Date('2026-09-14T05:01:00.000Z'), options).toISOString(),
    '2026-09-15T05:00:00.000Z'
  );
});

test('weekly batch payload includes only active required members who own active categories', async () => {
  const files = {
    'project/project.json': { id: 'SMARTPORT', name: 'SmartPort' },
    'project/work_packages.json': {
      work_packages: [
        { id: 'WP-C1', name: 'Control', owner: 'CTL' },
        { id: 'WP-P1', name: 'Perception', owner: 'PER' }
      ]
    },
    'project/subtasks.json': {
      subtasks: [
        { id: 'C1.1', name: 'Control task', owner_team: 'CTL' },
        { id: 'P1.1', name: 'Perception task', owner_team: 'PER' }
      ]
    },
    'project/checkpoints.json': { checkpoints: [{ id: 'CP1', date: '2026-10-01' }] },
    'project/team_config.json': {
      schema_version: '1.0',
      categories: [
        { id: 'CTL', name: '控制', active: true, order: 1 },
        { id: 'PER', name: '感知', active: false, order: 2 }
      ],
      members: [
        { id: 'member-control', name: '控制負責人', active: true, weekly_report_required: true },
        { id: 'member-perception', name: '感知負責人', active: true, weekly_report_required: true },
        { id: 'member-observer', name: '觀察員', active: true, weekly_report_required: true }
      ],
      category_owners: { CTL: 'member-control', PER: 'member-perception' }
    },
    'project/reference_model.json': { acl_levels: [] }
  };
  const automation = new WeeklyReportAutomation({
    supabase: {},
    projectStore: { async readJson(path) { return structuredClone(files[path]); } },
    options
  });
  const payload = await automation.projectPayload({
    weekKey: '2026-W38',
    reportDate: '2026-09-14',
    dueAt: new Date('2026-09-21T04:00:00.000Z')
  });
  assert.deepEqual(payload.team_config.members.map(member => member.id), ['member-control']);
  assert.deepEqual(payload.team_config.category_owners, { CTL: 'member-control' });
  assert.equal(payload.checkpoints[0].id, 'CP1');
});

test('weekly publisher attaches each personalized DOCX and records delivery', async () => {
  const updates = [];
  const requests = [];
  const automation = new WeeklyReportAutomation({
    supabase: {
      from(table) {
        assert.equal(table, 'weekly_report_batches');
        return {
          update(values) {
            return {
              async eq(column, value) {
                updates.push({ values, column, value });
                return { error: null };
              }
            };
          }
        };
      }
    },
    projectStore: {},
    options,
    now: () => new Date('2026-09-14T05:00:02.000Z'),
    fetchFn: async (url, init) => {
      requests.push({ url: String(url), init });
      return { ok: true, async json() { return { id: 'discord-message-1' }; } };
    },
    logger: { info() {}, error() {} }
  });
  const schedule = weeklySchedule(new Date('2026-09-14T05:00:02.000Z'), options);
  const batch = {
    id: 'batch-1',
    token: 'abcdefghijklmnopqrstuvwxyz123456',
    discord_message_id: '',
    discord_message_sent_at: null,
    due_at: schedule.dueAt.toISOString(),
    payload: discordBatchPayload()
  };
  const result = await automation.sendDiscord(batch, schedule);
  assert.deepEqual(result, { sent: true, batchId: 'batch-1', memberCount: 2, messageCount: 1 });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /discord\.com\/api\/webhooks\/1234567890\/test_token\?wait=true$/);
  assert.equal(requests[0].init.headers, undefined);
  assert.ok(requests[0].init.body instanceof FormData);
  const body = JSON.parse(requests[0].init.body.get('payload_json'));
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.match(body.content, /直接下載.*Word 附件/);
  assert.match(body.content, /weekly-submit\.html#batch=abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(body.content, /CP1/);
  assert.equal(body.attachments.length, 2);
  const firstFile = requests[0].init.body.get('files[0]');
  assert.match(firstFile.name, /成員1\.docx$/);
  assert.equal(firstFile.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(Buffer.from(await firstFile.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  assert.equal(updates[0].values.discord_message_id, '["discord-message-1"]');
  assert.equal(updates.at(-1).values.discord_message_sent_at, '2026-09-14T05:00:02.000Z');

  await automation.sendDiscord({ ...batch, discord_message_sent_at: '2026-09-14T05:00:02Z' }, schedule);
  assert.equal(requests.length, 1);
});

test('weekly publisher splits attachments and resumes after a delivered chunk', async () => {
  const updates = [];
  const requests = [];
  const automation = new WeeklyReportAutomation({
    supabase: {
      from(table) {
        assert.equal(table, 'weekly_report_batches');
        return {
          update(values) {
            return {
              async eq(column, value) {
                updates.push({ values, column, value });
                return { error: null };
              }
            };
          }
        };
      }
    },
    projectStore: {},
    options,
    now: () => new Date('2026-09-14T05:00:02.000Z'),
    fetchFn: async (_url, init) => {
      requests.push(init);
      return { ok: true, async json() { return { id: 'discord-message-2' }; } };
    },
    logger: { info() {}, error() {} }
  });
  const schedule = weeklySchedule(new Date('2026-09-14T05:00:02.000Z'), options);
  const result = await automation.sendDiscord({
    id: 'batch-1',
    token: 'abcdefghijklmnopqrstuvwxyz123456',
    discord_message_id: '["discord-message-1"]',
    discord_message_sent_at: null,
    due_at: schedule.dueAt.toISOString(),
    payload: discordBatchPayload(6)
  }, schedule);
  assert.deepEqual(result, { sent: true, batchId: 'batch-1', memberCount: 6, messageCount: 2 });
  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].body.get('payload_json'));
  assert.match(body.content, /2\/2/);
  assert.equal(body.attachments.length, 1);
  assert.match(requests[0].body.get('files[0]').name, /成員6\.docx$/);
  assert.equal(updates[0].values.discord_message_id, '["discord-message-1","discord-message-2"]');
  assert.equal(updates.at(-1).values.discord_message_sent_at, '2026-09-14T05:00:02.000Z');
});

test('optional reminder lists only members without a usable submission', async () => {
  const updates = [];
  const requests = [];
  const batch = {
    id: 'batch-1',
    token: 'abcdefghijklmnopqrstuvwxyz123456',
    discord_message_sent_at: '2026-09-14T05:00:02Z',
    last_reminder_date: null,
    status: 'OPEN',
    due_at: '2026-09-21T04:00:00.000Z',
    accept_until: '2026-09-28T04:00:00.000Z',
    payload: {
      team_config: {
        members: [
          { id: 'm1', name: '已繳成員' },
          { id: 'm2', name: '未繳成員' },
          { id: 'm3', name: '批改失敗成員' }
        ]
      }
    }
  };
  const supabase = {
    from(table) {
      if (table === 'weekly_report_batches') {
        return {
          select() {
            return { eq() { return { async maybeSingle() { return { data: batch, error: null }; } }; } };
          },
          update(values) {
            return {
              async eq(column, value) {
                updates.push({ values, column, value });
                return { error: null };
              }
            };
          }
        };
      }
      assert.equal(table, 'weekly_report_submissions');
      return {
        select() {
          return {
            async eq() {
              return {
                data: [
                  { member_id: 'm1', status: 'completed' },
                  { member_id: 'm3', status: 'failed' }
                ],
                error: null
              };
            }
          };
        }
      };
    }
  };
  const now = new Date('2026-09-15T05:01:00.000Z');
  const automation = new WeeklyReportAutomation({
    supabase,
    projectStore: {},
    options,
    now: () => now,
    fetchFn: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return { ok: true };
    },
    logger: { info() {}, error() {} }
  });
  const result = await automation.sendReminder(weeklySchedule(now, options));
  assert.deepEqual(result, { sent: true, missing: 2 });
  assert.equal(requests.length, 1);
  assert.match(requests[0].content, /未繳成員/);
  assert.match(requests[0].content, /批改失敗成員/);
  assert.doesNotMatch(requests[0].content, /已繳成員/);
  assert.deepEqual(requests[0].allowed_mentions, { parse: [] });
  assert.equal(updates[0].values.last_reminder_date, '2026-09-15');
});
