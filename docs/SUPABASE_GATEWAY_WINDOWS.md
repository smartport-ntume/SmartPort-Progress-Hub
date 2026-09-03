# Supabase Gateway + Windows Local Agent

這個部署讓所有人只開 GitHub Pages 即可使用。Supabase 負責登入、RLS 快照、持久化工作與 Realtime 通知；Windows 本機 Agent 才持有 Private Git、GitHub Issues 與 Codex 權限。

## 1. 建立 Free project

1. 在 Supabase 建立一個 **Free** project。
2. 不升級 Pro、不加入付費 add-on、不設定 custom domain。
3. 到 SQL Editor 執行 `supabase/migrations/202609030001_gateway.sql` 全文。
4. 到 Project Settings → API 保存以下兩項：
   - Project URL
   - publishable key（或 legacy anon key）
5. service-role/secret key 只保存到 Windows 的 `.env.local`，絕不可貼進前端、GitHub Issue、README 或 commit。

Migration 會建立：

| 資源 | 用途 | Browser 權限 |
|---|---|---|
| `profiles` | 明確角色與 Codex 開關 | 只能讀自己 |
| `project_snapshots` | Guest / Member 專案快照 | 依 RLS 讀取 |
| `reference_snapshots` | IF / ACL / TR 顯示資料 | 依 RLS 讀取 |
| `proposal_snapshots` | Proposal 列表快照 | Engineer / PM 讀取 |
| `gateway_jobs` | 耐久工作佇列與結果 | 只能經驗權 RPC 建立；本人或 PM 讀取 |
| `agent_state` | Agent 最近連線／工作狀態 | Engineer / PM 讀取 |
| `audit_log` | 不含週報本文的操作稽核 | PM 讀取 |
| `weekly-reports` | 10 MB 上限的 private 暫存 bucket | Vincent 上傳自己的路徑；Agent 下載／刪除 |

## 2. 設定 GitHub 登入

1. 在 GitHub 建立 OAuth App。
2. Homepage URL 設為 GitHub Pages URL：

```text
https://smartport-ntume.github.io/SmartPort-Progress-Hub/
```

3. Authorization callback URL 使用 Supabase Dashboard 的 GitHub provider 畫面顯示的 callback URL，通常是：

```text
https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback
```

4. 將 GitHub Client ID / Secret 填入 Supabase Authentication → Providers → GitHub。
5. Authentication → URL Configuration：
   - Site URL：GitHub Pages URL
   - Redirect URLs：加入同一個 GitHub Pages URL（含需要的 preview URL 時也明確加入）

任何 GitHub user 第一次登入時都只會取得 `DENIED`，不會自動看到專案。

## 3. 建立 Guest 與角色

在 Authentication → Users 建立專用 Guest user，使用一個固定 email 與強密碼，並確認 email。之後在 SQL Editor 執行：

```sql
-- Guest：以實際 email 取代範例。
update public.profiles p
set role = 'GUEST', active = true, can_trigger_codex = false
from auth.users u
where p.user_id = u.id
  and lower(u.email) = lower('smartport-guest@example.com');

-- Vincent：先用 GitHub 登入一次，再以實際 GitHub login 取代範例。
update public.profiles
set role = 'PM', active = true, can_trigger_codex = true
where lower(login) = lower('YOUR_GITHUB_LOGIN');

-- 其他 PM 不會共用 Vincent 的 Codex。
update public.profiles
set role = 'PM', active = true, can_trigger_codex = false
where lower(login) = lower('OTHER_PM_LOGIN');

-- Engineer 只能送 Manual Proposal。
update public.profiles
set role = 'ENGINEER', active = true, can_trigger_codex = false
where lower(login) = lower('ENGINEER_LOGIN');
```

可先檢查目前帳號，再精確更新：

```sql
select u.id, u.email, p.login, p.role, p.can_trigger_codex, p.active
from auth.users u
join public.profiles p on p.user_id = u.id
order by u.created_at;
```

停權時將 `active=false`；不要刪除 audit 需要引用的帳號。

## 4. 發布前端設定

編輯 `js/runtime-config.js`：

```js
window.SMARTPORT_RUNTIME_CONFIG = Object.freeze({
  backendMode: 'supabase',
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
  supabaseAnonKey: 'YOUR_PUBLISHABLE_OR_ANON_KEY',
  guestEmail: 'smartport-guest@example.com',
  reportBucket: 'weekly-reports'
});
```

Project URL、publishable/anon key 與 Guest email 都是 browser 設定，不是管理密鑰。RLS 才是資料保護邊界。`SUPABASE_SERVICE_ROLE_KEY` 絕不可放在此檔。

## 5. 準備 Windows 本機

以平常執行 Agent 的同一個 Windows user 開 PowerShell：

```powershell
git clone --branch feature/local-ai-weekly https://github.com/smartport-ntume/SmartPort-Progress-Hub.git
Set-Location SmartPort-Progress-Hub
npm install
Copy-Item .env.example .env.local

gh auth login
gh auth setup-git
codex login
```

需求：

- Node.js 22 或更新版本。
- Git 與 GitHub CLI。
- Codex CLI，且 `codex login status` 成功。
- `.docx` 可直接解析；要支援舊 `.doc`，另安裝 LibreOffice 並確認 `soffice` 在 PATH。

將 `.env.local` 至少填好：

```dotenv
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_LOCAL_ONLY_SERVICE_ROLE_OR_SECRET_KEY
SUPABASE_AGENT_ID=vincent-windows-agent
PROJECT_REPO_PATH=.runtime/SmartPort-Project-Control
```

若 `gh auth token` 可成功，`GITHUB_AGENT_TOKEN` 留白即可。GitHub credential 只用於 Private repo Issues API；Contents 寫入會走本機 managed clone，commit/push 則使用本機 Git credential。

## 6. 驗證與啟動

```powershell
npm run check
npm test
npm run doctor
npm start
```

成功時會顯示：

```text
SmartPort Supabase Agent connected
Mode: Realtime events + reconnect catch-up; no interval polling
```

本機不需要開 port、設定 DNS、Tailscale 或 router port forwarding。Agent 只建立 outbound HTTPS / WebSocket 連線。

### 開機後自動啟動（建議）

在 Windows Task Scheduler 建立工作：

- Trigger：`At startup` 或 Vincent 登入時。
- Program：`powershell.exe`
- Arguments：`-NoProfile -ExecutionPolicy Bypass -File "C:\PATH\SmartPort-Progress-Hub\scripts\start-agent.ps1"`
- 勾選失敗後重新啟動，並限制同一時間只執行一個 instance。
- Run as user 必須是已完成 `gh auth login` 與 `codex login` 的同一個 Windows user。

## 7. 日常行為

- 開啟網頁、切頁、讀 Dashboard：只讀 Supabase snapshot，不觸發本機 Agent 或 Codex。
- Engineer 送 Manual Proposal：建立一個 job；Agent 建 GitHub Issue，再更新 Proposal snapshot。
- PM 編輯／核准：建立一個 job；Agent pull、檢查 clean worktree、commit、push，再更新 snapshot。
- Vincent 上傳週報並按下分析：暫存 Storage → Realtime job → Private Git archive → 刪除暫存 → Local Codex → Proposal。
- Agent 離線：job 保持 `queued`。重新上線訂閱成功時補查一次，不使用 interval polling。

## 8. 免費與資料量護欄

- 保持 project 在 Free plan，不升級也不建立付費 add-on。
- 週報 bucket 與 browser/Agent 都設 10 MB 單檔限制。
- 週報一旦成功寫入 Private Git，立即從 Storage 刪除。
- Snapshot 上限 5 MB；job payload/result 上限 4 MB；每位 user 最多 20 個 queued/running jobs。
- completed/failed/cancelled jobs 保留 30 天，audit metadata 保留 90 天；Agent 啟動與每次操作完成後清理。
- 不使用 Edge Functions，因此沒有把 GitHub/Codex secrets 部署到 Supabase。
- 只要維持 Free plan，額度不足時應停用／限制對應服務，而不是由本程式自動升級。仍應在 Supabase Dashboard 的 Usage 頁定期確認用量。

## 9. 故障處理

### Job 一直 queued

在 Windows 執行：

```powershell
npm run doctor
npm start
```

確認 `agent_state` 最近狀態及 `.env.local` 的 URL/key。

### Job 顯示 failed

先看 UI error 與 `audit_log`，再檢查 managed clone：

```powershell
git -C .runtime/SmartPort-Project-Control status
git -C .runtime/SmartPort-Project-Control log -5 --oneline
```

若錯誤表示 Agent 上次在完成回報前中止，先核對 Git/Issue 是否已寫入，再決定是否重送，避免重複 Proposal。

### Guest 密碼要更換

在 Supabase Authentication → Users 對專用 Guest user 變更密碼。前端刻意不持有 Auth 管理權限。

### Supabase Free project 被暫停

到 Supabase Dashboard 恢復 project，再重新啟動 Agent。Private Git 仍是正式資料來源，因此恢復後可重新發布 snapshot。
