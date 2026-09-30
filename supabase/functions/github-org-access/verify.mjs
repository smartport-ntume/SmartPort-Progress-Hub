// Never trust browser-supplied login names or editable user_metadata.
export async function verifyMembership(user, token, fetchFn = fetch) {
  const identity = user.identities?.find(item => item.provider === 'github');
  if (!identity || !token) throw new Error('請重新按 GitHub Login，授權讀取組織成員身分。');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const request = path => fetchFn(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(10000) });
  const accountResponse = await request('/user');
  if (!accountResponse.ok) throw new Error('GitHub 授權已失效，請重新登入。');
  const account = await accountResponse.json();
  if (!identity.id || String(account.id) !== String(identity.id)) throw new Error('GitHub 身分與登入帳號不符，請登出後重新登入。');
  const response = await request('/user/memberships/orgs/smartport-ntume');
  if (response.status === 404 || response.status === 403) throw new Error('無法確認組織資格：請確認已加入 smartport-ntume，並允許此 OAuth App 存取組織。');
  if (!response.ok) throw new Error('GitHub 暫時無法驗證組織，請稍後重試。');
  const membership = await response.json();
  if (membership.state !== 'active' || membership.organization?.login?.toLowerCase() !== 'smartport-ntume') throw new Error('請先接受 smartport-ntume 的組織邀請，再重新登入。');
  // Enumerate the authenticated user's teams, including private membership.
  for (let page = 1; page <= 100; page++) {
    const teamsResponse = await request(`/user/teams?per_page=100&page=${page}`);
    if (!teamsResponse.ok) throw new Error('無法讀取 PM team，請確認 OAuth App 已獲組織授權後重新登入。');
    const teams = await teamsResponse.json();
    if (!Array.isArray(teams)) throw new Error('GitHub team 回應無效，請稍後重試。');
    if (teams.some(team => team.organization?.login?.toLowerCase() === 'smartport-ntume' && team.slug?.toLowerCase() === 'smartport-pm')) {
      return { login: account.login, role: 'PM' };
    }
    if (teams.length < 100) return { login: account.login, role: 'ENGINEER' };
  }
  throw new Error('GitHub team 清單過長，無法完成驗證。');
}
