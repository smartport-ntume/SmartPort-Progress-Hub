import { discordUserId } from '../worker/src/team-config.js';

export function weeklyPortalLink(baseUrl, token, memberId = '') {
  const url = new URL(baseUrl);
  url.searchParams.delete('batch');
  url.searchParams.delete('member');
  url.hash = new URLSearchParams({ batch: token, ...(memberId ? { member: memberId } : {}) }).toString();
  return url.toString();
}

function displayName(member) {
  return String(member.name || member.id || '成員').replace(/[\r\n]/g, ' ').slice(0, 80)
    .replace(/@/g, '＠').replace(/[\\`*_~|\[\]<>]/g, '\\$&');
}

export function memberPortalEmbed(attachments, baseUrl, token) {
  return {
    title: '個人繳交入口',
    description: '點自己的連結會預選姓名；仍可在入口切換成員。',
    fields: attachments.map(file => {
      const url = weeklyPortalLink(baseUrl, token, file.memberId);
      const value = `[填寫／上傳週報](<${url}>)`;
      if (value.length > 1024) throw new Error('weekly_personal_link_too_long');
      return { name: displayName({ id: file.memberId, name: file.memberName }), value, inline: false };
    })
  };
}

export function membersNeedingReminder(members, submissions) {
  const latest = new Map();
  for (const row of submissions || []) {
    if (row.is_current === false || row.review_status === 'SUPERSEDED') continue;
    const previous = latest.get(row.member_id);
    if (!previous || Number(row.revision || 1) > Number(previous.revision || 1)
      || (Number(row.revision || 1) === Number(previous.revision || 1)
        && String(row.submitted_at || '') > String(previous.submitted_at || ''))) latest.set(row.member_id, row);
  }
  return (members || []).flatMap(member => {
    if (member.active === false || member.weekly_report_required === false || member.reminder_disabled === true) return [];
    const row = latest.get(member.id);
    if (row && ['APPROVED', 'REVIEWING', 'REVIEW_FAILED'].includes(row.review_status)) return [];
    if (row && ['queued', 'running'].includes(row.status)) return [];
    if (row?.review_status === 'CHANGES_REQUESTED') return [{ ...member, reminder_reason: '退回補件' }];
    if (row?.status === 'completed') return [];
    return [{ ...member, reminder_reason: row ? '請重新上傳' : '尚未繳交' }];
  });
}

export function reminderMessages({ members, baseUrl, token, heading, deadline }) {
  const header = `${heading}\n${deadline}\n尚有 ${members.length} 位需要繳交或補件：`;
  const messages = [];
  let lines = [], users = [];
  const flush = () => {
    if (!lines.length) return;
    messages.push({ content: [header, ...lines].join('\n'),
      allowed_mentions: { parse: [], ...(users.length ? { users: [...new Set(users)] } : {}) } });
    lines = []; users = [];
  };
  for (const member of members) {
    const id = discordUserId(member.discord_user_id);
    const url = weeklyPortalLink(baseUrl, token, member.id);
    const line = `${id ? `<@${id}> ` : ''}${displayName(member)} · ${member.reminder_reason}\n${url}`;
    if (header.length + line.length + 1 > 2000) throw new Error('weekly_personal_link_too_long');
    if ([header, ...lines, line].join('\n').length > 2000 || (id && users.length >= 100)) flush();
    lines.push(line);
    if (id) users.push(id);
  }
  flush();
  return messages;
}
