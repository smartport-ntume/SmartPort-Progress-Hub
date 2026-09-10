# Supabase Gateway + Windows Local Agent

這個部署讓所有人只開 GitHub Pages 即可使用。Supabase 負責登入、RLS 快照、持久化工作與 Realtime 通知；Windows 本機 Agent 才持有 Private Git、GitHub Issues 與 Codex 權限。

## 1. 建立 Free project

1. 在 Supabase 建立一個 **Free** project。
2. 不升級 Pro、不加入付費 add-on、不設定 custom domain。
3. 到 SQL Editor 依序執行以下 migration 全文：
   - `supabase/migrations/202609030001_gateway.sql`
   - `supabase/migrations/202609080001_team_config.sql`
   - `supabase/migrations/202609100001_weekly_discord_automation.sql`
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
| `weekly-reports` | 10 MB 上限的 private 暫存 bucket | PM 上傳自己的路徑，或 portal 依一次性 grant 上傳；Agent 下載／刪除 |
| `weekly_report_batches` | 每週凍結的報告範圍、期限與私密入口 | 只能透過有 token 的 RPC 讀取 |
| `weekly_report_upload_grants` | 15 分鐘、一次性的 Storage 上傳授權 | 不能直接讀取 |
| `weekly_report_submissions` | 成員繳交與 Codex job 狀態 | token RPC 顯示當週狀態；PM 可稽核 |

`project_snapshots` 的 GUEST 與 MEMBER 列會發布相同的甘特圖、需求與 Checkpoint 內容，讓 Guest 在唯讀頁面看到完整的專案快照；但 GUEST 快照會移除成員姓名與分類負責人對應，只保留分類名稱與顏色。這不會提高 Guest 權限：RLS 仍只允許讀取指定 audience，前端仍隱藏 reports、review、settings，且 Guest 不能建立或修改工作。

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

-- Codex operator：先用 GitHub 登入一次，再以實際 GitHub login 取代範例。
update public.profiles
set role = 'PM', active = true, can_trigger_codex = true
where lower(login) = lower('YOUR_GITHUB_LOGIN');

-- 其他 PM 不會自動共用 operator 的 Codex 權限。
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
git clone --branch main https://github.com/smartport-ntume/SmartPort-Progress-Hub.git SmartPort-Progress-Hub-Agent
Set-Location SmartPort-Progress-Hub-Agent
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

若要啟用每週一 13:00 自動發布，先在 Discord 的目標頻道建立 webhook，將複製到的 URL **只**放進同一份 `.env.local`：

```dotenv
WEEKLY_AUTOMATION_ENABLED=true
WEEKLY_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN
WEEKLY_PORTAL_URL=https://smartport-ntume.github.io/SmartPort-Progress-Hub/weekly-submit.html
WEEKLY_REPORT_TIMEZONE=Asia/Taipei
WEEKLY_REPORT_PUBLISH_WEEKDAY=1
WEEKLY_REPORT_PUBLISH_HOUR=13
WEEKLY_REPORT_PUBLISH_MINUTE=0
WEEKLY_REPORT_DUE_DAYS=7
WEEKLY_REPORT_DUE_HOUR=12
WEEKLY_REPORT_DUE_MINUTE=0
WEEKLY_REPORT_PM_LOGIN=YOUR_AUTHORIZED_PM_LOGIN
```

`WEEKLY_REPORT_PUBLISH_WEEKDAY=1` 代表星期一。`WEEKLY_REPORT_PM_LOGIN` 必須對應 `profiles` 中 `role='PM'`、`active=true` 且 `can_trigger_codex=true` 的 login。若只有一位符合者可留白，但明確填寫較不容易選錯。

要借鏡集中催繳流程，可再開啟每日提醒；它只列姓名，不會 ping 成員：

```dotenv
WEEKLY_REMINDER_ENABLED=true
WEEKLY_REMINDER_HOUR=13
WEEKLY_REMINDER_MINUTE=0
```

不需要建立第二個 Windows 排程。每週發布與選用的每日提醒都由原本常駐的 Agent 以單次 timer 排程；Agent 會直接產生每位成員的個人 `.docx` 並附在 Discord，最多每則五份，人數較多時自動分批。Agent 從睡眠或關機恢復後，會在本週內補發尚未完成的附件批次。

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
Weekly Discord automation: enabled
```

本機不需要開 port、設定 DNS、Tailscale 或 router port forwarding。Agent 只建立 outbound HTTPS / WebSocket 連線。

### 開機後自動啟動（建議）

在 Windows Task Scheduler 建立工作：

- Trigger：`At startup` 或 Agent operator 登入時。
- Program：`powershell.exe`
- Arguments：`-NoProfile -ExecutionPolicy Bypass -File "C:\PATH\SmartPort-Progress-Hub\scripts\start-agent.ps1"`
- 勾選失敗後重新啟動，並限制同一時間只執行一個 instance。
- Run as user 必須是已完成 `gh auth login` 與 `codex login` 的同一個 Windows user。

## 7. 日常行為

- 開啟網頁、切頁、讀 Dashboard：只讀 Supabase snapshot，不觸發本機 Agent 或 Codex。
- Engineer 送 Manual Proposal：建立一個 job；Agent 建 GitHub Issue，再更新 Proposal snapshot。
- PM 編輯／核准：建立一個 job；Agent pull、檢查 clean worktree、commit、push，再更新 snapshot。
- PM 儲存成員與分工：建立 `write_team_config` job；Agent 驗證分類負責人後寫入 `project/team_config.json`。WP / Subtask 依分類自動繼承負責人，再更新 Guest / Member snapshot。
- Codex operator 在 Weekly Reports 選擇日期與成員：網站依成員負責分類及甘特圖產生個人 `.docx`，只列入逾期未完成，以及下一個 CP 檢核前應完成的 Subtask；首頁會預覽該 CP 的主題、日期、倒數天數、車輛能力（Capability）、Review / Check 與任務摘要。若已無後續 CP，則只列逾期項目。
- 填好的個人週報上傳並按下批改：暫存 Storage → Realtime job → Private Git archive → 刪除暫存 → Local Codex 批改與進度映射 → Proposal。Agent 會以 Private Git 的最新 `team_config.json` 與甘特圖重新計算負責分類及應填範圍，不信任 browser 傳入的名稱或 scope。
- 每週一 13:00：Agent 從 Private Git 建立不可變的當週報告批次，為每位成員產生個人 `.docx` 並直接附到指定 Discord 頻道，同時附上 token URL。成員直接下載自己的附件；填完後用 Guest 密碼進入網址、選姓名並上傳。提交 RPC 會建立既有 `analyze_weekly_report` job，結果照常等待 PM Approve。
- Agent 離線：job 保持 `queued`。重新上線訂閱成功時補查一次，不使用 interval polling。

## 8. 免費與資料量護欄

- 保持 project 在 Free plan，不升級也不建立付費 add-on。
- 週報 bucket 與 browser/Agent 都設 10 MB 單檔限制。
- 每次 portal 上傳先取得 15 分鐘一次性授權；每人每週最多補交五次，網址在補交期限後失效。
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

### 星期一沒有收到 Discord 週報附件或上傳連結

在 Windows 執行：

```powershell
npm run doctor
npm start
```

確認 doctor 顯示 `Weekly automation migration` 正常，且啟動畫面顯示 `Weekly Discord automation: enabled`。每則最多五份 `.docx`，因此成員較多時會看到多則連續附件訊息。本週批次會記錄已送出的訊息；重啟後只從未完成的下一批續送。Webhook 回傳錯誤時 Agent 會每 15 分鐘重試。

### 週報入口能開啟但不能上傳

確認第三份 migration 已執行、使用的是 Discord 當週最新網址、檔案為 `.doc` / `.docx` 且不超過 10 MB。原截止後仍可在七天補交期內上傳；再超過則需等 PM 處理。

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
