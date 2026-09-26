// Shared by the browser, Agent and Word generator so legacy feedback lands in the same place.
((root) => {
  const general = () => ({ type: 'GENERAL', id: '' });
  const key = item => `${item.type}:${item.id}`;
  const fold = text => String(text || '').normalize('NFKC').toUpperCase();
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function records(context = {}) {
    return [
      ...(context.work_packages || context.workPackages || []).map(wp => ({ type: 'WP', id: wp.id, name: wp.name || wp.id, owner: wp.owner })),
      ...(context.subtasks || []).map(task => ({ type: 'SUBTASK', id: task.id, name: task.name || task.id, owner: task.owner_team, parentWp: task.parent_wp }))
    ].filter(item => typeof item.id === 'string' && item.id);
  }

  function targets(context = {}, memberId) {
    const all = records(context);
    const owners = (context.team_config || context.teamConfig)?.category_owners;
    if (!owners || !memberId) return all;
    const tasks = all.filter(item => item.type === 'SUBTASK' && owners[item.owner] === memberId);
    const parents = new Set(tasks.map(item => item.parentWp));
    return all.filter(item => item.type === 'WP' ? owners[item.owner] === memberId || parents.has(item.id) : tasks.includes(item));
  }

  function assign(items = [], context = {}, memberId) {
    const all = records(context), allowed = targets(context, memberId);
    const allowedKeys = new Set(allowed.map(key));
    const patterns = all.map(item => ({ item, pattern: new RegExp(`(^|[^A-Z0-9_.-])${escape(fold(item.id))}(?![A-Z0-9_-]|\\.[A-Z0-9])`) }));
    const matches = text => patterns.filter(({ pattern }) => pattern.test(fold(text))).map(({ item }) => item);
    const groups = new Map();

    function combine(found) {
      const own = found.filter(item => allowedKeys.has(key(item)));
      if (!own.length) return [general()];
      const parents = new Map();
      for (const item of own) {
        const parent = item.type === 'WP' ? item.id : item.parentWp;
        const group = parents.get(parent || key(item)) || [];
        group.push(item); parents.set(parent || key(item), group);
      }
      return [...parents.entries()].flatMap(([parent, group]) => {
        const wp = allowed.find(item => item.type === 'WP' && item.id === parent);
        return wp && (group.length > 1 || group[0].type === 'WP') ? [wp] : group;
      });
    }

    function headings(text) {
      const header = text.match(/^\s*(?:[-*•]\s*|\d+[.)、]\s*)?([^:：\n]{1,120})[:：]/)?.[1]
        || text.match(/^\s*[\[【（(]([^\]】）)]+)[\]】）)]/)?.[1];
      return header ? matches(header) : [];
    }

    function statements(value) {
      const chunks = [];
      for (const line of String(value || '').split(/\r?\n/).map(text => text.trim()).filter(Boolean)) {
        if (!chunks.length || headings(line).length) chunks.push(line);
        else chunks[chunks.length - 1] += '\n' + line;
      }
      return chunks;
    }

    function route(text, source) {
      // A leading task heading wins over references to dependencies later in the sentence.
      const headed = headings(text);
      if (headed.length) return combine(headed);
      if (source.target_type !== 'GENERAL' && source.target_id) {
        const explicit = { type: source.target_type, id: source.target_id };
        const known = all.find(item => key(item) === key(explicit));
        // Keep explicitly assigned historical work even if it has since been archived.
        return !known || allowedKeys.has(key(known)) ? [known || explicit] : [general()];
      }
      const mentioned = matches(text);
      if (mentioned.length) return combine(mentioned);
      const named = allowed.filter(item => String(item.name).length >= 4 && fold(text).includes(fold(item.name)));
      return named.length === 1 ? named : [general()];
    }

    for (const source of Array.isArray(items) ? items : []) {
      for (const field of ['missing_items', 'actions']) {
        for (const text of (Array.isArray(source?.[field]) ? source[field] : []).flatMap(statements)) {
          for (const target of route(text, source)) {
            const id = key(target);
            if (!groups.has(id)) groups.set(id, { target_type: target.type, target_id: target.id, missing_items: [], actions: [] });
            const lines = groups.get(id)[field];
            if (!lines.includes(text)) lines.push(text);
          }
        }
      }
    }
    // Stay within the existing per-card storage limits when several sources merge.
    return [...groups.values()].flatMap(item => {
      const count = Math.max(Math.ceil(item.missing_items.length / 50), Math.ceil(item.actions.length / 50));
      return Array.from({ length: count }, (_, index) => ({ ...item,
        missing_items: item.missing_items.slice(index * 50, (index + 1) * 50),
        actions: item.actions.slice(index * 50, (index + 1) * 50)
      }));
    });
  }

  root.SmartPortWeeklyFeedback = { assign, targets };
})(typeof window === 'object' ? window : globalThis);
