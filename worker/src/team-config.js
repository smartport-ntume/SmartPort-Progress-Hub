const CORE_CATEGORIES = [
  { id: 'CTL', name: '控制', color: '#5277bb' },
  { id: 'LOC/NAV', name: '定位＋導航', color: '#6c9275' },
  { id: 'PER', name: '感知', color: '#8a6bb8' },
  { id: 'STM', name: '狀態機＋任務', color: '#c37b4a' }
];

const KNOWN_CATEGORIES = {
  VERIFY: { name: '驗證', color: '#7b8794' }
};

const FALLBACK_COLORS = ['#456990', '#5b8e7d', '#7d5ba6', '#b36a5e', '#6b7280'];
const CATEGORY_ID = /^[A-Z][A-Z0-9/_-]{0,31}$/;
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const SUBTASK_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

function text(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function unique(values) {
  return [...new Set((values || []).map(value => text(value, 32)).filter(Boolean))];
}

function categoryFallback(id, index = 0) {
  const known = KNOWN_CATEGORIES[id];
  return {
    id,
    name: known?.name || id,
    color: known?.color || FALLBACK_COLORS[index % FALLBACK_COLORS.length],
    active: true,
    order: index + 1
  };
}

export function referencedTeamIds(workPackages = [], subtasks = []) {
  return unique([
    ...workPackages.map(item => item?.owner),
    ...subtasks.map(item => item?.owner_team)
  ]);
}

export function defaultTeamConfig(referencedCategoryIds = []) {
  const categories = CORE_CATEGORIES.map((item, index) => ({
    ...item,
    active: true,
    order: index + 1
  }));
  const existing = new Set(categories.map(item => item.id));
  for (const id of unique(referencedCategoryIds)) {
    if (!existing.has(id)) {
      categories.push(categoryFallback(id, categories.length));
      existing.add(id);
    }
  }
  return {
    schema_version: '1.0',
    categories,
    members: [],
    assignments: {}
  };
}

export function normalizeTeamConfig(value, { referencedCategoryIds = [] } = {}) {
  const supplied = value && typeof value === 'object' ? value : null;
  const fallback = defaultTeamConfig(referencedCategoryIds);
  const rawCategories = Array.isArray(supplied?.categories) && supplied.categories.length
    ? supplied.categories
    : fallback.categories;
  const categories = [];
  const seenCategories = new Set();

  for (const [index, raw] of rawCategories.entries()) {
    const id = text(raw?.id, 32);
    if (!id || seenCategories.has(id)) continue;
    seenCategories.add(id);
    const known = CORE_CATEGORIES.find(item => item.id === id) || KNOWN_CATEGORIES[id];
    categories.push({
      id,
      name: text(raw?.name, 80) || known?.name || id,
      color: COLOR.test(String(raw?.color || ''))
        ? String(raw.color).toLowerCase()
        : known?.color || FALLBACK_COLORS[index % FALLBACK_COLORS.length],
      active: raw?.active !== false,
      order: Number.isInteger(Number(raw?.order)) ? Number(raw.order) : index + 1
    });
  }

  for (const id of unique(referencedCategoryIds)) {
    if (!seenCategories.has(id)) {
      categories.push(categoryFallback(id, categories.length));
      seenCategories.add(id);
    }
  }
  categories.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  categories.forEach((item, index) => { item.order = index + 1; });

  const members = [];
  const seenMembers = new Set();
  for (const raw of Array.isArray(supplied?.members) ? supplied.members : []) {
    const id = text(raw?.id, 100);
    const categoryId = text(raw?.category_id, 32);
    if (!id || seenMembers.has(id) || !seenCategories.has(categoryId)) continue;
    seenMembers.add(id);
    members.push({
      id,
      name: text(raw?.name, 80),
      category_id: categoryId,
      weekly_report_required: raw?.weekly_report_required !== false,
      active: raw?.active !== false
    });
  }

  const assignments = {};
  if (supplied?.assignments && typeof supplied.assignments === 'object' && !Array.isArray(supplied.assignments)) {
    for (const [subtaskId, memberIdValue] of Object.entries(supplied.assignments)) {
      const memberId = text(memberIdValue, 100);
      if (memberId && seenMembers.has(memberId)) assignments[text(subtaskId, 200)] = memberId;
    }
  }

  return {
    schema_version: '1.0',
    categories,
    members,
    assignments,
    ...(supplied?.updated_at ? { updated_at: text(supplied.updated_at, 40) } : {}),
    ...(supplied?.updated_by ? { updated_by: text(supplied.updated_by, 100) } : {})
  };
}

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

export function validateTeamConfig(value, { workPackages = [], subtasks = [] } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('team_config_object_required');
  if (!Array.isArray(value.categories) || !value.categories.length || value.categories.length > 30) {
    invalid('team_categories_must_contain_1_to_30_items');
  }
  if (!Array.isArray(value.members) || value.members.length > 300) invalid('team_members_array_required');
  if (!value.assignments || typeof value.assignments !== 'object' || Array.isArray(value.assignments)) {
    invalid('team_assignments_object_required');
  }

  const categoryIds = new Set();
  for (const category of value.categories) {
    const id = text(category?.id, 32);
    const name = text(category?.name, 80);
    if (!CATEGORY_ID.test(id)) invalid('invalid_team_category_id');
    if (!name) invalid('team_category_name_required');
    if (categoryIds.has(id)) invalid('duplicate_team_category_id');
    if (category?.color != null && !COLOR.test(String(category.color))) invalid('invalid_team_category_color');
    categoryIds.add(id);
  }

  for (const id of referencedTeamIds(workPackages, subtasks)) {
    if (!categoryIds.has(id)) invalid(`team_category_still_in_use:${id}`);
  }

  const memberIds = new Set();
  const memberById = new Map();
  for (const member of value.members) {
    const id = text(member?.id, 100);
    const name = text(member?.name, 80);
    const categoryId = text(member?.category_id, 32);
    if (!MEMBER_ID.test(id)) invalid('invalid_team_member_id');
    if (!name) invalid('team_member_name_required');
    if (memberIds.has(id)) invalid('duplicate_team_member_id');
    if (!categoryIds.has(categoryId)) invalid(`unknown_team_member_category:${categoryId}`);
    memberIds.add(id);
    memberById.set(id, member);
  }

  const subtaskById = new Map(subtasks.map(item => [String(item?.id || ''), item]));
  const entries = Object.entries(value.assignments);
  if (entries.length > 5000) invalid('too_many_team_assignments');
  for (const [subtaskId, memberIdValue] of entries) {
    const memberId = text(memberIdValue, 100);
    if (!SUBTASK_ID.test(subtaskId)) invalid('invalid_assignment_subtask_id');
    if (!memberIds.has(memberId)) invalid(`unknown_assignment_member:${memberId}`);
    const subtask = subtaskById.get(subtaskId);
    if (!subtask) invalid(`unknown_assignment_subtask:${subtaskId}`);
    const member = memberById.get(memberId);
    if (member?.active === false) invalid(`inactive_assignment_member:${memberId}`);
    if (String(subtask.owner_team || '') !== String(member?.category_id || '')) {
      invalid(`assignment_category_mismatch:${subtaskId}`);
    }
  }

  return normalizeTeamConfig(value, {
    referencedCategoryIds: referencedTeamIds(workPackages, subtasks)
  });
}

export function guestTeamConfig(value, context = {}) {
  const normalized = normalizeTeamConfig(value, context);
  return {
    schema_version: normalized.schema_version,
    categories: normalized.categories,
    members: [],
    assignments: {}
  };
}
