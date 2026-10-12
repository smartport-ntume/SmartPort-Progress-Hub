(() => {
  const state = {
    project: { name: 'SmartPort SC' },
    workPackages: [],
    subtasks: [],
    fsrs: [],
    checkpoints: [],
    teamConfig: window.SmartPortTeam?.defaults?.() || { schema_version: '1.0', categories: [], members: [], category_owners: {} },
    connected: false,
    dirty: false
  };

  let revision = 0;
  const pendingCheckpoints = new Map();

  function replaceSnapshot(snapshot, expectedRevision = revision) {
    // A read started before a confirmed write must not replace that newer state.
    if (expectedRevision !== revision) return false;
    state.project = snapshot.project || state.project;
    state.workPackages = snapshot.work_packages || snapshot.workPackages || [];
    state.subtasks = snapshot.subtasks || [];
    state.fsrs = snapshot.functional_safety_requirements || snapshot.fsrs || [];
    state.checkpoints = (snapshot.checkpoints || []).map(cp =>
      pendingCheckpoints.has(cp.id) ? clone(pendingCheckpoints.get(cp.id).checkpoint) : cp);
    state.teamConfig = window.SmartPortTeam?.normalize
      ? window.SmartPortTeam.normalize(snapshot.team_config, state.workPackages, state.subtasks)
      : (snapshot.team_config || state.teamConfig);
    state.connected = true;
    state.dirty = false;
    revision++;
    document.dispatchEvent(new CustomEvent('smartport:snapshot-replaced'));
    return true;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  window.SmartPortStore = {
    state,
    clone,
    replaceSnapshot,
    getRevision: () => revision,
    checkpointReference: (id, fallback) => pendingCheckpoints.get(id)?.reference || fallback,
    applyCheckpoint(result) {
      const cp = result.checkpoint;
      if (!cp?.id) throw new Error('Checkpoint result is missing');
      pendingCheckpoints.set(cp.id, clone(result));
      const i = state.checkpoints.findIndex(x => x.id === cp.id);
      if (i >= 0) state.checkpoints[i] = { ...state.checkpoints[i], ...clone(cp) };
      else state.checkpoints.push(clone(cp));
      revision++;
      document.dispatchEvent(new CustomEvent('smartport:checkpoint-updated', { detail: clone(result) }));
    },
    confirmCheckpointSync(id) {
      pendingCheckpoints.delete(id);
      revision++;
    },
    markDirty() { state.dirty = true; },
    setConnected(v) { state.connected = !!v; },
    upsert(collection, item, idKey = 'id') {
      const arr = state[collection];
      const i = arr.findIndex(x => x[idKey] === item[idKey]);
      if (i >= 0) arr[i] = clone(item); else arr.push(clone(item));
      state.dirty = true;
    },
    remove(collection, id, idKey = 'id') {
      const arr = state[collection];
      const i = arr.findIndex(x => x[idKey] === id);
      if (i >= 0) arr.splice(i, 1);
      state.dirty = true;
    }
  };
})();
