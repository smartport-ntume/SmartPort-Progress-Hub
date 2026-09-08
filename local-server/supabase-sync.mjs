import {
  buildMemberSnapshot,
  buildReferenceSnapshot
} from './snapshot.mjs';
import { guestTeamConfig, referencedTeamIds } from '../worker/src/team-config.js';

function assertResult(result, operation) {
  if (result?.error) throw new Error(`${operation}: ${result.error.message || result.error}`);
  return result?.data;
}

export class SupabaseSnapshotPublisher {
  constructor({ supabase, projectStore, agentId, loadProposals }) {
    this.supabase = supabase;
    this.projectStore = projectStore;
    this.agentId = agentId;
    this.loadProposals = loadProposals;
  }

  async publishProject() {
    const snapshot = await buildMemberSnapshot(this.projectStore);
    // Project planning content stays identical for Guest. The private roster and
    // person-to-task assignments are removed while category labels remain usable.
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
