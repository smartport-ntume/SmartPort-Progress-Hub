function scalar(value) {
  if (typeof value === 'string') return value.slice(0, 2_000);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function scalarList(value) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 500).map(scalar).filter(item => item !== undefined);
}

function pick(source, scalarKeys, listKeys = []) {
  const out = {};
  for (const key of scalarKeys) {
    const value = scalar(source?.[key]);
    if (value !== undefined) out[key] = value;
  }
  for (const key of listKeys) {
    const value = scalarList(source?.[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const PROJECT_FIELDS = ['name', 'title', 'target', 'phase', 'version'];
const WP_FIELDS = [
  'id', 'name', 'owner', 'group', 'start', 'end', 'weight',
  'target_cp', 'actual_progress', 'status', 'last_update'
];
const WP_LIST_FIELDS = ['ifs', 'fsrs'];
const SUBTASK_FIELDS = [
  'id', 'parent_wp', 'name', 'owner_team', 'start', 'end', 'weight',
  'target_cp', 'actual_progress', 'status', 'last_update'
];
const SUBTASK_LIST_FIELDS = ['ifs', 'fsrs'];
const FSR_FIELDS = [
  'id', 'parent_sg', 'primary',
  'maturity', 'target_2026_12_31', 'allocation_status'
];
const FSR_LIST_FIELDS = ['support', 'linked_work_packages'];
const CHECKPOINT_FIELDS = [
  'id', 'date', 'acl', 'name', 'capability', 'fsrTarget', 'fsr_target'
];

function checkpoint(source) {
  const out = pick(source, CHECKPOINT_FIELDS);
  if (Array.isArray(source?.criteria)) {
    out.criteria = source.criteria.slice(0, 500).flatMap(item => {
      if (!Array.isArray(item) || item.length < 2) return [];
      const id = scalar(item[0]);
      const threshold = scalar(item[1]);
      return id === undefined || threshold === undefined ? [] : [[id, threshold]];
    });
  }
  return out;
}

export function sanitizeSnapshot({ project, workPackages, subtasks, fsrs, checkpoints, sourceCommit }) {
  return {
    schema_version: '1.0',
    kind: 'smartport_public_snapshot',
    generated_at: new Date().toISOString(),
    source_commit: scalar(sourceCommit) || '',
    project: pick(project || {}, PROJECT_FIELDS),
    work_packages: (workPackages || []).map(item => pick(item, WP_FIELDS, WP_LIST_FIELDS)),
    subtasks: (subtasks || []).map(item => pick(item, SUBTASK_FIELDS, SUBTASK_LIST_FIELDS)),
    functional_safety_requirements: (fsrs || []).map(item => pick(item, FSR_FIELDS, FSR_LIST_FIELDS)),
    checkpoints: (checkpoints || []).map(checkpoint)
  };
}

export async function buildSanitizedSnapshot(store) {
  await store.refreshForRead();
  const [project, workPackages, subtasks, fsrs, checkpoints, sourceCommit] = await Promise.all([
    store.readJson('project/project.json', { refresh: false }),
    store.readJson('project/work_packages.json', { refresh: false }),
    store.readJson('project/subtasks.json', { refresh: false }),
    store.readJson('safety/fsr.json', { refresh: false }),
    store.readJson('project/checkpoints.json', { refresh: false }),
    store.headSha()
  ]);
  return sanitizeSnapshot({
    project,
    workPackages: workPackages.work_packages || [],
    subtasks: subtasks.subtasks || [],
    fsrs: fsrs.functional_safety_requirements || [],
    checkpoints: checkpoints.checkpoints || [],
    sourceCommit
  });
}

export async function buildMemberSnapshot(store) {
  await store.refreshForRead();
  const [project, workPackages, subtasks, fsrs, checkpoints, sourceCommit] = await Promise.all([
    store.readJson('project/project.json', { refresh: false }),
    store.readJson('project/work_packages.json', { refresh: false }),
    store.readJson('project/subtasks.json', { refresh: false }),
    store.readJson('safety/fsr.json', { refresh: false }),
    store.readJson('project/checkpoints.json', { refresh: false }),
    store.headSha()
  ]);
  return {
    schema_version: '1.0',
    kind: 'smartport_member_snapshot',
    generated_at: new Date().toISOString(),
    source_commit: sourceCommit,
    project,
    work_packages: workPackages.work_packages || [],
    subtasks: subtasks.subtasks || [],
    functional_safety_requirements: fsrs.functional_safety_requirements || [],
    checkpoints: checkpoints.checkpoints || []
  };
}

export async function buildReferenceSnapshot(store) {
  await store.refreshForRead();
  const paths = [
    'project/reference_model.json',
    'project/item_functions.json',
    'project/technical_requirements/ctl.json',
    'project/technical_requirements/loc.json',
    'project/technical_requirements/nav_a.json',
    'project/technical_requirements/nav_b.json',
    'project/technical_requirements/per.json',
    'project/technical_requirements/per_b.json',
    'project/technical_requirements/stm_a.json',
    'project/technical_requirements/stm_b.json',
    'project/technical_requirements/interfaces.json',
    'project/technical_requirements/odd_allocation.json',
    'project/technical_requirements/traceability.json'
  ];
  const values = await Promise.all([
    ...paths.map(file => store.readJson(file, { refresh: false })),
    store.headSha()
  ]);
  const [reference, itemFunctions, ctl, loc, navA, navB, perA, perB, stmA, stmB, interfaces, odd, trace, sourceCommit] = values;
  return {
    schema_version: '1.0',
    kind: 'smartport_reference_snapshot',
    generated_at: new Date().toISOString(),
    source_commit: sourceCommit,
    reference,
    item_functions: itemFunctions,
    technical_requirements: {
      source: 'Private SmartPort Project-Control baseline',
      status: 'Preliminary / TBD as stated in source',
      groups: [
        { group: 'CTL', requirements: ctl.requirements || [] },
        { group: 'LOC', requirements: loc.requirements || [] },
        { group: 'NAV', requirements: [...(navA.requirements || []), ...(navB.requirements || [])] },
        { group: 'PER', requirements: [...(perA.requirements || []), ...(perB.requirements || [])] },
        { group: 'STM', requirements: [...(stmA.requirements || []), ...(stmB.requirements || [])] }
      ],
      interfaces: interfaces.interfaces || [],
      odd_allocation: odd.odd_allocation || [],
      fsr_traceability: trace.fsr_traceability || [],
      open_gates: trace.open_gates || []
    }
  };
}

export class SnapshotPublisher {
  constructor({ enabled, projectStore, publicStore, file }) {
    this.enabled = !!enabled;
    this.projectStore = projectStore;
    this.publicStore = publicStore;
    this.file = file || 'data/public-snapshot.json';
  }

  async publish() {
    if (!this.enabled || !this.publicStore) throw new Error('public_snapshot_not_configured');
    const snapshot = await buildSanitizedSnapshot(this.projectStore);
    const result = await this.publicStore.writeJson(this.file, snapshot, {
      message: 'Publish sanitized SmartPort project snapshot'
    });
    return {
      ok: true,
      generated_at: snapshot.generated_at,
      source_commit: snapshot.source_commit,
      public_commit: result.commitSha,
      path: result.path,
      counts: {
        work_packages: snapshot.work_packages.length,
        subtasks: snapshot.subtasks.length,
        fsr: snapshot.functional_safety_requirements.length,
        checkpoints: snapshot.checkpoints.length
      }
    };
  }

  status() {
    return {
      enabled: this.enabled,
      configured: !!this.publicStore,
      path: this.enabled ? this.file : null
    };
  }
}
