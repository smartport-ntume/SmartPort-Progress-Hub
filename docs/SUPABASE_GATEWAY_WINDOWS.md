# Supabase Gateway + Windows Local Agent

這個部署讓所有人只開 GitHub Pages 即可使用。Supabase 負責登入、RLS 快照、持久化工作與 Realtime 通知；Windows 本機 Agent 才持有 Private Git、GitHub Issues 與 Codex 權限。

## 1. 建立 Free project

1. 在 Supabase 建立一個 **Free** project。
2. 不升級 Pro、不加入付費 add-on、不設定 custom domain。
3. 到 SQL Editor 依序執行以下 migration 全文：
   - `supabase/migrations/202609030001_gateway.sql`
   - `supabase/migrations/202609080001_team_config.sql`
   - `supabase/migrations/202609100001_weekly_discord_automation.sql`
   - `supabase/migrations/202609100002_passwordless_weekly_portal.sql`
   - `supabase/migrations/202609110002_weekly_review_cycle.sql`
   - `supabase/migrations/202609250001_weekly_editable_feedback.sql`
4. 到 Authentication → Providers → Anonymous Sign-Ins 開啟匿名登入。匿名 session 只可搭配當週私密 token 使用週報 RPC；既有 RLS 仍拒絕它讀取主網站資料。
5. 到 Project Settings → API 保存以下兩項：
   - Project URL
   - publishable key（或 legacy anon key）
6. service-role/secret key 只保存到 Windows 的 `.env.local`，絕不可貼進前端、GitHub Issue、README 或 commit。

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
| `weekly_report_submissions` | 提交版本、歸檔路徑、批改結果與 PM 決定 | token RPC 顯示狀態與回饋；PM 可審核 |
| `weekly_report_analysis_runs` | 不隨暫存工作清理的批改執行歷史 | Agent 寫入；PM 透過管理中心查看 |

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
- PM 修改既有成員姓名：Agent 會同步更新仍開放週報批次中的顯示姓名；當週已凍結的分類、任務與 CP 範圍不變。週報入口重新整理後即生效，重新下載的 Word 也會使用新姓名。
- Codex operator 在 Weekly Reports 選擇日期與成員：網站依成員負責分類及甘特圖產生個人 `.docx`，只列入逾期未完成，以及下一個 CP 檢核前應完成的 Subtask；首頁會預覽該 CP 的主題、日期、倒數天數、車輛能力（Capability）、Review / Check 與任務摘要。若已無後續 CP，則只列逾期項目。
- 填好的個人週報上傳並按下批改：暫存 Storage → Realtime job → Private Git archive → 刪除暫存 → Local Codex 批改與進度映射 → Proposal。Agent 會以 Private Git 的最新 `team_config.json` 與甘特圖重新計算負責分類及應填範圍，不信任 browser 傳入的名稱或 scope。
- 每週一 13:00：Agent 從 Private Git 建立不可變的當週報告批次，為每位成員產生個人 `.docx` 並直接附到指定 Discord 頻道，同時附上 token URL。成員直接下載自己的附件；填完後開啟網址即可選姓名並上傳，不需要 GitHub 帳號或 Guest 密碼。提交 RPC 會建立既有 `analyze_weekly_report` job，結果照常等待 PM Approve。
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

### 顯示「Unable to assess」或「無法讀取 weekly-report.txt」，分數卻全部為 0

這是批改輸入沒有被讀取的錯誤結果，不代表成員真的得到 0 分。新版 Agent 改成直接把週報文字、專案 context 與輸出格式傳給 Codex，並拒收缺少評分的結果；不需要放寬沙箱權限。

合併此修復後，在正在執行 Agent 的 PowerShell 按 `Ctrl+C`，再執行：

```powershell
Set-Location "C:\Users\Vincent Huang\SmartPort-Progress-Hub-Agent"
git pull --ff-only origin main
npm install
npm run check
npm test
npm run doctor
npm start
```

確認各命令成功才繼續下一個。這次僅新增供 DOM 互動測試使用的開發套件，沒有新增 SQL。接著在網站按 `Ctrl+F5`，到 **Workflow → Weekly Reports** 選擇有問題的成員，按 **重新批改原始週報**，逐份重跑即可。原始 Word 已歸檔，無需請成員重交；新回饋會使用繁體中文。開啟明細後，舊的輸入讀取失敗結果會顯示「批改未完成」，不再顯示假 0 分或允許核准。

`Not assessed` 或 `Unable to assess ... without file access` 也屬於這類錯誤，即使檔名只出現在「需要補充」也能辨識。批改一份週報時可立即切換其他成員，繼續排入重批，不必等待前一份結束。若顯示 **解除失敗審核**，先按該按鈕解除尚未寫入進度的失敗審核，再重新批改。

「進度更新 0 項」會區分批改未完成與已完成但沒有可採用提案：前者要先重批；後者請查看缺漏及批改注意事項，必要時退回補件。按 **核准週報（不更新進度）** 只結案週報，不會修改甘特圖進度。

若批改有具體成果，卻只因目前百分比未知或驗收待補而列為 0 項，更新並重啟 Agent 後，按 **重新批改原始週報**。新版允許勾選「工作紀錄更新（百分比不變）」，保留目前百分比與既有證據；自報任務完成度則會另列待 PM 確認的值與缺少的驗證。真正沒有本週成果的空白範本仍可沒有提案。

### 下一週週報等待 PM 審閱，並帶入回饋

沿用上述更新步驟，不需要新增 SQL 或環境變數。每週一 13:00 到時，Agent 先檢查上一批每位應繳成員的最新版本：PM 已核准或已附意見退回才算已審閱。缺繳、批改中、失敗、待審和補交後尚未重審都會阻擋下一批。

在管理中心逐份填寫 **PM 回饋（將帶入下期週報）** 並完成審核。全數審閱後，Agent 會重新檢查排程；若發送時間已到就接續產生新附件，否則等原訂時間。等待期間每 15 分鐘重試，重啟也會恢復檢查。下一份 Word 會有 **上期 PM 回饋與本週回覆**，只帶入該成員的意見，供逐項回覆處理結果。未審完跨週時不會預建多份舊週報。

自動發送與手動 **補發 Discord** 均遵守審閱條件；已發到 Discord 的舊附件不會自動改寫。首批沒有前期資料時不需等待。測試使用模擬 Discord，正式流程須在更新 Windows Agent 後驗證。

### 星期一沒有收到 Discord 週報附件或上傳連結

在 Windows 執行：

```powershell
npm run doctor
npm start
```

確認 doctor 顯示 `Weekly automation migration` 正常，且啟動畫面顯示 `Weekly Discord automation: enabled`。每則最多五份 `.docx`，因此成員較多時會看到多則連續附件訊息。本週批次會記錄已送出的訊息；重啟後只從未完成的下一批續送。Webhook 回傳錯誤時 Agent 會每 15 分鐘重試。

### 週報入口能開啟但不能上傳

確認週報相關 migration 均已執行、Authentication → Providers 的 Anonymous Sign-Ins 已開啟、使用的是 Discord 當週最新網址，且檔案為 `.doc` / `.docx` 且不超過 10 MB。截止後可直接補交，系統會標記逾期；不需 PM 展延。若仍被擋住，確認已執行 `202609250001_weekly_editable_feedback.sql`，它同時更新入口 RPC 與 Storage RLS。

### Job 顯示 failed

先看 UI error 與 `audit_log`，再檢查 managed clone：

```powershell
git -C .runtime/SmartPort-Project-Control status
git -C .runtime/SmartPort-Project-Control log -5 --oneline
```

若錯誤表示 Agent 上次在完成回報前中止，先核對 Git/Issue 是否已寫入，再決定是否重送，避免重複 Proposal。

### Guest 密碼要更換

在 Supabase Authentication → Users 對專用 Guest user 變更密碼。這只影響主網站的唯讀 Guest 登入；週報專用網址不再要求這組密碼。前端刻意不持有 Auth 管理權限。

### Supabase Free project 被暫停

到 Supabase Dashboard 恢復 project，再重新啟動 Agent。Private Git 仍是正式資料來源，因此恢復後可重新發布 snapshot。
