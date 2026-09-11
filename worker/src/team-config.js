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
const COLOR = /^#[0-9a-fA-F]{6}$/;

export function discordUserId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  return /^[1-9][0-9]{16,19}$/.test(id) && BigInt(id) <= 18446744073709551615n ? id : '';
}

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
    category_owners: {}
  };
}

export function normalizeTeamConfig(value, {
  referencedCategoryIds = [],
  subtasks = []
} = {}) {
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
  const rawMembers = Array.isArray(supplied?.members) ? supplied.members : [];
  for (const raw of rawMembers) {
    const id = text(raw?.id, 100);
    if (!id || seenMembers.has(id)) continue;
    seenMembers.add(id);
    members.push({
      id,
      name: text(raw?.name, 80),
      ...(discordUserId(raw?.discord_user_id) ? { discord_user_id: discordUserId(raw.discord_user_id) } : {}),
      weekly_report_required: raw?.weekly_report_required !== false,
      active: raw?.active !== false
    });
  }

  const categoryOwners = {};
  if (supplied?.category_owners && typeof supplied.category_owners === 'object' && !Array.isArray(supplied.category_owners)) {
    for (const [categoryIdValue, memberIdValue] of Object.entries(supplied.category_owners)) {
      const categoryId = text(categoryIdValue, 32);
      const memberId = text(memberIdValue, 100);
      if (seenCategories.has(categoryId) && seenMembers.has(memberId)) categoryOwners[categoryId] = memberId;
    }
  }

  // Compatibility with the first preview version: infer one category owner from
  // the former member.category_id or per-Subtask assignments when possible.
  for (const raw of rawMembers) {
    const categoryId = text(raw?.category_id, 32);
    const memberId = text(raw?.id, 100);
    if (seenCategories.has(categoryId) && seenMembers.has(memberId) && !categoryOwners[categoryId]) {
      categoryOwners[categoryId] = memberId;
    }
  }
  if (supplied?.assignments && typeof supplied.assignments === 'object' && !Array.isArray(supplied.assignments)) {
    const categoryBySubtask = new Map(subtasks.map(item => [String(item?.id || ''), text(item?.owner_team, 32)]));
    for (const [subtaskId, memberIdValue] of Object.entries(supplied.assignments)) {
      const categoryId = categoryBySubtask.get(subtaskId);
      const memberId = text(memberIdValue, 100);
      if (seenCategories.has(categoryId) && seenMembers.has(memberId) && !categoryOwners[categoryId]) {
        categoryOwners[categoryId] = memberId;
      }
    }
  }

  return {
    schema_version: '1.0',
    categories,
    members,
    category_owners: categoryOwners,
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
  if (!value.category_owners || typeof value.category_owners !== 'object' || Array.isArray(value.category_owners)) {
    invalid('team_category_owners_object_required');
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
  const discordIds = new Set();
  for (const member of value.members) {
    const id = text(member?.id, 100);
    const name = text(member?.name, 80);
    if (!MEMBER_ID.test(id)) invalid('invalid_team_member_id');
    if (!name) invalid('team_member_name_required');
    if (memberIds.has(id)) invalid('duplicate_team_member_id');
    if (member.discord_user_id != null && member.discord_user_id !== '') {
      const discordId = discordUserId(member.discord_user_id);
      if (!discordId) invalid('invalid_discord_user_id');
      if (discordIds.has(discordId)) invalid('duplicate_discord_user_id');
      discordIds.add(discordId);
    }
    memberIds.add(id);
    memberById.set(id, member);
  }

  const ownerEntries = Object.entries(value.category_owners);
  if (ownerEntries.length > 30) invalid('too_many_team_category_owners');
  for (const [categoryId, memberIdValue] of ownerEntries) {
    const memberId = text(memberIdValue, 100);
    if (!categoryIds.has(categoryId)) invalid(`unknown_team_owner_category:${categoryId}`);
    if (!memberIds.has(memberId)) invalid(`unknown_team_owner_member:${memberId}`);
    if (memberById.get(memberId)?.active === false) invalid(`inactive_team_owner_member:${memberId}`);
  }

  return normalizeTeamConfig(value, {
    referencedCategoryIds: referencedTeamIds(workPackages, subtasks),
    subtasks
  });
}

export function guestTeamConfig(value, context = {}) {
  const normalized = normalizeTeamConfig(value, context);
  return {
    schema_version: normalized.schema_version,
    categories: normalized.categories,
    members: [],
    category_owners: {}
  };
}
