import { createHash } from 'node:crypto';

export const PDF_LIMIT = 10 * 1024 * 1024;
const sha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const result = (response, operation) => {
  if (response.error) throw new Error(`${operation}: ${response.error.message}`);
  return response.data;
};

export function documentSegment(value) {
  let name = String(value || '').normalize('NFC').replace(/[\/\\]+/g, ' and ')
    .replace(/[<>:"|?*\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  // Bound UTF-8 component lengths for Git/Windows while retaining readable titles.
  while (Buffer.byteLength(name) > 160) name = [...name].slice(0, -1).join('');
  name = name.trim().replace(/[. ]+$/g, '');
  if (!name || /^\.+$/.test(name)) name = 'Document';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}

export function documentPath(v) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(v.created_at));
  // A short stable document ID prevents identically titled stages colliding.
  return `${documentSegment(v.wp_id + '_' + v.wp_name)}/${documentSegment(v.subtask_id + '_' + v.subtask_name)}/${day}_${documentSegment(v.title)}_v${String(v.revision).padStart(2, '0')}_${v.document_id.slice(0, 8)}.pdf`;
}

export class TechnicalDocumentArchive {
  constructor({ supabase, getProject, fetchImpl, token, repository = 'smartport-ntume/SmartPort-Technical-Docs', branch = 'main' }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[A-Za-z0-9_.-]+$/.test(branch)) throw new Error('invalid_technical_document_repository');
    Object.assign(this, { supabase, getProject, fetchImpl, token, repository, branch });
  }

  async github(suffix, options = {}) {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repository}${suffix}`, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${this.token}`,
        Accept: suffix.startsWith('/contents/') && !options.method ? 'application/vnd.github.object+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }
    });
    if (response.status === 404) return null;
    if (!response.ok) throw Object.assign(new Error(`GitHub 文件歸檔失敗（HTTP ${response.status}），請確認 Agent 的文件庫寫入權限。`), { status: response.status });
    return response.json();
  }

  async checkRepository() {
    const repo = await this.github('');
    if (!repo) throw new Error(`請先建立私人文件庫 ${this.repository}，並授予 Agent Contents 讀寫權限。`);
    if (repo.private !== true || repo.full_name?.toLowerCase() !== this.repository.toLowerCase()) throw new Error('技術文件只允許存入指定的私人文件庫。');
    if (repo.permissions?.push === false || repo.archived) throw new Error('Agent 沒有技術文件庫的寫入權限。');
    return repo;
  }

  async existing(path, expectedSha) {
    const ref = await this.github(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
    if (!ref?.object?.sha) throw new Error('技術文件庫尚未初始化，請先在 main 分支建立 README。');
    const file = await this.github(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref.object.sha}`);
    if (!file) return null;
    if (file.type !== 'file' || file.sha !== expectedSha) throw new Error('文件路徑已有不同內容，已停止以保留原檔。');
    return ref.object.sha;
  }

  async archive(job) {
    const v = result(await this.supabase.from('technical_document_versions').select('*')
      .eq('id', job.payload?.version_id).eq('job_id', job.id).maybeSingle(), 'load_document');
    if (!v) throw new Error('invalid_technical_document_job');
    const pm = result(await this.supabase.from('profiles').select('role,active').eq('user_id', job.actor_id).maybeSingle(), 'document_actor');
    if (pm?.role !== 'PM' || !pm.active) throw new Error('document_pm_no_longer_authorized');
    if (v.status === 'archived') return { document_id: v.document_id, html_url: v.html_url };
    const project = await this.getProject();
    const task = project.subtasks?.find(t => t.id === v.subtask_id && !t.archived);
    const config = project.team_config;
    if (!task || !config?.members?.some(m => m.id === v.member_id && m.active !== false)
      || !config.categories?.some(c => c.id === task.owner_team && c.active !== false)
      || config.category_owners?.[task.owner_team] !== v.member_id || task.parent_wp !== v.wp_id) throw new Error('工作分工已變更，請聯絡 PM 確認文件所屬細項。');
    await this.checkRepository();
    const file = result(await this.supabase.storage.from('technical-documents').download(v.storage_path), 'download_pdf');
    if (!file?.size || file.size !== v.size_bytes || file.size > PDF_LIMIT) throw new Error('PDF 大小不符或超過 10 MB，請重新上傳。');
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length !== v.size_bytes || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('檔案不是有效的 PDF，請重新匯出後上傳。');
    const path = documentPath(v), blobSha = sha(bytes);
    let commit = await this.existing(path, blobSha);
    if (!commit) {
      try {
        const saved = await this.github(`/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
          method: 'PUT', body: JSON.stringify({ message: `Archive ${v.subtask_id}: ${v.title} v${v.revision} (${v.id})`,
            content: bytes.toString('base64'), branch: this.branch })
        });
        if (saved?.content?.sha !== blobSha || !saved?.commit?.sha) throw new Error('無法確認 GitHub 文件歸檔結果，請重試。');
        commit = saved.commit.sha;
      } catch (error) {
        // A lost response may follow a successful commit. Retry never overwrites.
        if (![409, 422].includes(error.status)) throw error;
        commit = await this.existing(path, blobSha);
        if (!commit) throw error;
      }
    }
    const htmlUrl = `https://github.com/${this.repository}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const saved = result(await this.supabase.from('technical_document_versions').update({ status: 'archived', error: null,
      repository: this.repository, repository_path: path, commit_sha: commit, blob_sha: blobSha, html_url: htmlUrl,
      archived_at: new Date().toISOString() }).eq('id', v.id).eq('job_id', job.id).select('id').maybeSingle(), 'record_archive');
    if (!saved) throw new Error('文件索引已變更，請重新整理後重試。');
    // Never remove a staged PDF until BOTH the Git commit and durable index exist.
    const removed = await this.supabase.storage.from('technical-documents').remove([v.storage_path]).catch(() => ({ error: true }));
    return { document_id: v.document_id, html_url: htmlUrl, ...(removed.error ? { warning: 'temporary_pdf_cleanup_pending' } : {}) };
  }
}
