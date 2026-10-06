// Explicit one-time setup command. Never runs on Agent startup or upload.
import { loadConfig } from '../local-server/config.mjs';
import { runCommand } from '../local-server/command.mjs';
import { TechnicalDocumentArchive } from '../local-server/technical-documents.mjs';

const config = loadConfig();
const token = config.github.agentToken || (await runCommand('gh', ['auth', 'token'], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 })).stdout.trim();
if (!token) throw new Error('請先執行 gh auth login，或設定 GITHUB_AGENT_TOKEN。');
const archive = new TechnicalDocumentArchive({ ...config.technicalDocs, token, fetchImpl: fetch });
const [owner, name] = config.technicalDocs.repository.split('/');
let repo = await archive.github('');
if (!repo) {
  const response = await fetch(`https://api.github.com/orgs/${owner}/repos`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ name, private: true, auto_init: true, description: 'SmartPort 階段成果 PDF 技術文件', has_issues: false, has_wiki: false })
  });
  if (!response.ok) throw new Error(`建立文件庫失敗（HTTP ${response.status}）。請由 Organization 管理員建立 ${config.technicalDocs.repository}，選 Private 並勾選 Add a README。`);
  repo = await response.json();
}
await archive.checkRepository();
let branch = await archive.github(`/git/ref/heads/${encodeURIComponent(config.technicalDocs.branch)}`);
if (!branch) {
  const base = await archive.github(`/git/ref/heads/${encodeURIComponent(repo.default_branch || 'main')}`);
  if (!base?.object?.sha) throw new Error('文件庫尚未初始化。請先在 GitHub 建立 README，再執行一次。');
  branch = await archive.github('/git/refs', { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + config.technicalDocs.branch, sha: base.object.sha }) });
  if (!branch) throw new Error('無法建立文件庫分支。');
}
process.stdout.write(`私人文件庫已就緒：https://github.com/${config.technicalDocs.repository}\n請在 Repository Settings → Collaborators and teams 給需要查看文件的成員或 Team「Read」權限。\n接著執行技術文件 SQL、npm run doctor，並重啟 Agent。\n`);
