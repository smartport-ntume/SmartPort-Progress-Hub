(() => {
  const state = {
    project: { name: 'SmartPort SC' },
    workPackages: [],
    subtasks: [],
    fsrs: [],
    checkpoints: [],
    connected: false,
    dirty: false
  };

  function replaceSnapshot(snapshot) {
    state.project = snapshot.project || state.project;
    state.workPackages = snapshot.work_packages || snapshot.workPackages || [];
    state.subtasks = snapshot.subtasks || [];
    state.fsrs = snapshot.functional_safety_requirements || snapshot.fsrs || [];
    state.checkpoints = snapshot.checkpoints || [];
    state.connected = true;
    state.dirty = false;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  window.SmartPortStore = {
    state,
    clone,
    replaceSnapshot,
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
