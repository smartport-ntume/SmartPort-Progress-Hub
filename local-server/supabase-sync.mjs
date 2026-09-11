import {
  buildMemberSnapshot,
  buildReferenceSnapshot
} from './snapshot.mjs';
import { discordUserId, guestTeamConfig, referencedTeamIds } from '../worker/src/team-config.js';

function assertResult(result, operation) {
  if (result?.error) throw new Error(`${operation}: ${result.error.message || result.error}`);
  return result?.data;
}

export function refreshWeeklyBatchMemberNames(payload, teamConfig) {
  const currentMembers = new Map((teamConfig?.members || []).map(member => [String(member?.id || ''), member]));
  const batchMembers = payload?.team_config?.members;
  if (!Array.isArray(batchMembers)) return null;
  let changed = false;
  const members = batchMembers.map(member => {
    const current = currentMembers.get(String(member?.id || ''));
    const name = String(current?.name || '').trim() || member.name;
    const reminderDisabled = !current || current.active === false || current.weekly_report_required === false;
    const discordId = reminderDisabled ? '' : discordUserId(current.discord_user_id);
    if (name === member.name && discordId === (member.discord_user_id || '')
      && reminderDisabled === (member.reminder_disabled === true)) return member;
    changed = true;
    const { discord_user_id: previousId, reminder_disabled: previousDisabled, ...rest } = member;
    return { ...rest, name, ...(discordId ? { discord_user_id: discordId } : {}),
      ...(reminderDisabled ? { reminder_disabled: true } : {}) };
  });
  if (!changed) return null;
  return {
    ...payload,
    team_config: { ...payload.team_config, members }
  };
}

export class SupabaseSnapshotPublisher {
  constructor({ supabase, projectStore, agentId, loadProposals, syncWeeklyMemberNames = false }) {
    this.supabase = supabase;
    this.projectStore = projectStore;
    this.agentId = agentId;
    this.loadProposals = loadProposals;
    this.syncWeeklyMemberNames = syncWeeklyMemberNames;
  }

  async publishWeeklyMemberNames(teamConfig, now = new Date()) {
    if (!this.syncWeeklyMemberNames) return { checked: 0, updated: 0 };
    const lookup = await this.supabase.from('weekly_report_batches')
      .select('id,payload')
      .eq('status', 'OPEN')
      .gte('accept_until', now.toISOString());
    const batches = assertResult(lookup, 'load_open_weekly_batches') || [];
    let updated = 0;
    for (const batch of batches) {
      const payload = refreshWeeklyBatchMemberNames(batch.payload, teamConfig);
      if (!payload) continue;
      assertResult(
        await this.supabase.from('weekly_report_batches').update({ payload }).eq('id', batch.id),
        'sync_weekly_batch_member_names'
      );
      updated += 1;
    }
    return { checked: batches.length, updated };
  }

  async publishProject() {
    const snapshot = await buildMemberSnapshot(this.projectStore);
    // Project planning content stays identical for Guest. The private roster and
    // category-owner mappings are removed while category labels remain usable.
    const guestSnapshot = {
      ...snapshot,
      team_config: guestTeamConfig(snapshot.team_config, {
        referencedCategoryIds: referencedTeamIds(snapshot.work_packages, snapshot.subtasks)
      })
    };
    const updatedAt = new Date().toISOString();
    assertResult(await this.supabase.from('project_snapshots').upsert([
      {
        audience: 'MEMBER', payload: snapshot, source_commit: snapshot.source_commit,
        updated_by_agent: this.agentId, updated_at: updatedAt
      },
      {
        audience: 'GUEST', payload: guestSnapshot, source_commit: snapshot.source_commit,
        updated_by_agent: this.agentId, updated_at: updatedAt
      }
    ], { onConflict: 'audience' }), 'publish_project_snapshots');
    await this.publishWeeklyMemberNames(snapshot.team_config);
    return {
      source_commit: snapshot.source_commit,
      generated_at: snapshot.generated_at,
      work_packages: snapshot.work_packages.length,
      subtasks: snapshot.subtasks.length
    };
  }

  async publishReference() {
    const snapshot = await buildReferenceSnapshot(this.projectStore);
    const updatedAt = new Date().toISOString();
    assertResult(await this.supabase.from('reference_snapshots').upsert([
      {
        audience: 'MEMBER', payload: snapshot, source_commit: snapshot.source_commit,
        updated_by_agent: this.agentId, updated_at: updatedAt
      },
      {
        audience: 'GUEST', payload: snapshot, source_commit: snapshot.source_commit,
        updated_by_agent: this.agentId, updated_at: updatedAt
      }
    ], { onConflict: 'audience' }), 'publish_reference_snapshots');
    return { source_commit: snapshot.source_commit, generated_at: snapshot.generated_at };
  }

  async publishProposals() {
    const payload = await this.loadProposals();
    assertResult(await this.supabase.from('proposal_snapshots').upsert({
      id: 'all',
      payload: payload || { proposals: [] },
      updated_by_agent: this.agentId,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' }), 'publish_proposal_snapshot');
    return { proposals: payload?.proposals?.length || 0 };
  }

  async publishAll() {
    const [project, reference, proposals] = await Promise.all([
      this.publishProject(),
      this.publishReference(),
      this.publishProposals()
    ]);
    return { project, reference, proposals };
  }
}
