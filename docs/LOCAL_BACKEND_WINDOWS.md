# SmartPort Local Backend — Windows Setup

> Legacy rollback only：v0.8 的預設部署已改為 [Supabase Gateway + Windows Local Agent](SUPABASE_GATEWAY_WINDOWS.md)，一般使用者不需要 Tailscale。

這份文件把 SmartPort Progress Hub 安裝在 Vincent 的 Windows 帳號下。完成後，其他人透過 Tailscale HTTPS 使用前端；資料由本機 Private Git clone 提供，只有 PM 的明確操作會使用 Vincent 在該 Windows 帳號登入的 Codex。

> 這是「本機執行 Codex CLI」，不是離線或 on-prem 模型。分析時，抽出的週報文字與必要 project context 仍會由 Codex CLI 傳送到 OpenAI 服務，並使用 Vincent 的 Codex 帳號權益。若要求資料完全不離開內網，需要改用本機模型，這不在本方案內。

## 1. 先準備工具

安裝：

- Node.js 20.12 或更新版本
- Git for Windows（建議包含 Git Credential Manager）
- Tailscale，並讓允許使用 Hub 的成員加入同一個 tailnet
- Codex CLI
- LibreOffice（只有需要解析舊 `.doc` 時才需要；`.docx` 不需要）

PowerShell 檢查：

```powershell
node --version
npm --version
git --version
tailscale version
codex --version
```

Codex CLI 可透過 npm 安裝：

```powershell
npm install -g @openai/codex
codex login
codex login status
```

`codex login` 必須在之後執行後端的**同一個 Windows 帳號**完成。只登入瀏覽器或用另一個 Windows service account 不算完成。

參考：[Codex CLI](https://learn.chatgpt.com/docs/codex/cli)、[Codex authentication](https://learn.chatgpt.com/docs/auth)。

## 2. Clone Hub 與 Private Project-Control

```powershell
git clone --branch feature/local-ai-weekly https://github.com/smartport-ntume/SmartPort-Progress-Hub.git
Set-Location SmartPort-Progress-Hub
npm install

New-Item -ItemType Directory -Force .runtime | Out-Null
git clone --branch main https://github.com/smartport-ntume/SmartPort-Project-Control.git .runtime/SmartPort-Project-Control
```

第二個 `git clone` 會透過 Git Credential Manager 要求 GitHub 登入。請確認該帳號對 Private Project-Control 有 read / push 權限；後端需要 pull、commit 與 push。GitHub 的瀏覽器 OAuth 登入與 Git CLI credential 是兩套不同用途的授權，兩者都要完成。

這裡使用的就是一般 `git clone`，不是 snapshot。`.runtime/SmartPort-Project-Control` 是後端專用的 managed clone，請不要用編輯器在裡面做手動修改；dirty worktree 會讓後端停止寫入，避免蓋掉未提交內容。

參考：[GitHub credentials in Git](https://docs.github.com/en/get-started/git-basics/caching-your-github-credentials-in-git)。

## 3. 建立 Tailscale HTTPS 位址

保持 Node 只 listen 在 localhost，讓 Tailscale Serve 反向代理 8787：

```powershell
tailscale serve --bg 8787
tailscale serve status
```

記下輸出的 HTTPS URL，例如：

```text
https://vincent-pc.example-tailnet.ts.net
```

請使用 **Tailscale Serve**，不要使用會公開到 Internet 的 Funnel。Serve 的 access control 仍受 tailnet policy 控制，而 `--bg` 設定可在 Tailscale / 電腦重啟後恢復。

參考：[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)、[`tailscale serve` CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)。

## 4. 建立 GitHub OAuth App

在 GitHub 的 **Settings → Developer settings → OAuth Apps → New OAuth App** 建立一個專用 App：

| 欄位 | 值 |
|---|---|
| Application name | `SmartPort Local Hub` |
| Homepage URL | `https://smartport-ntume.github.io/SmartPort-Progress-Hub/` |
| Authorization callback URL | `https://vincent-pc.example-tailnet.ts.net/auth/callback` |

Callback URL 必須換成第 3 步的真實 Tailscale hostname，且要精確包含 `/auth/callback`。不需要 wildcard。建立 Client Secret 後，把 Client ID 與 Secret 留給下一步；Secret 不可放進前端或 commit。

參考：[Creating a GitHub OAuth app](https://docs.github.com/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)、[OAuth callback URLs](https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#redirect-urls)。

## 5. 設定 `.env.local`

```powershell
Copy-Item .env.example .env.local
notepad .env.local
```

至少修改：

```dotenv
PUBLIC_BASE_URL=https://vincent-pc.example-tailnet.ts.net
ALLOWED_ORIGINS=https://smartport-ntume.github.io,https://vincent-pc.example-tailnet.ts.net,http://127.0.0.1:8787,http://localhost:8787

GITHUB_CLIENT_ID=<OAuth App Client ID>
GITHUB_CLIENT_SECRET=<OAuth App Client Secret>
SESSION_SECRET=<至少 32 字元的隨機值>

PROJECT_REPO_PATH=.runtime/SmartPort-Project-Control
LOCAL_CODEX_ENABLED=true
LOCAL_CODEX_REQUIRE_PM=true
PUBLIC_SNAPSHOT_ENABLED=false
```

可用 PowerShell 產生 `SESSION_SECRET`：

```powershell
$secretBytes = New-Object byte[] 48
$secretRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$secretRng.GetBytes($secretBytes)
[Convert]::ToBase64String($secretBytes)
$secretRng.Dispose()
```

把輸出的單行字串貼到 `SESSION_SECRET=` 後面。`.env.local` 已被 Git ignore。

## 6. 檢查並啟動

```powershell
npm run doctor
npm run check
npm test
npm start
```

`doctor` 應該顯示 Configuration、Git、Project clone、Codex CLI、Codex login、Codex automation flags、Tailscale 與 Tailscale Serve 都是 `[OK]`。

另一個 PowerShell 視窗可做 smoke test：

```powershell
Invoke-RestMethod https://vincent-pc.example-tailnet.ts.net/api/health | ConvertTo-Json -Depth 8
```

應看到：

- `mode: "local"`
- `local.repository.ready: true`
- `local.repository.clean: true`
- `local.codex.available: true`
- `local.codex.authenticated: true`
- `local.codex.compatible: true`

## 7. 讓其他人開啟

### 建議：直接開 Tailscale URL

```text
https://vincent-pc.example-tailnet.ts.net
```

這會由本機後端同時提供前端與 API，沒有跨網域設定問題。使用者必須先連上 Tailscale，且 tailnet policy 必須允許他連到這台電腦。

### 沿用 GitHub Pages

第一次提供帶 `apiBase` 的網址：

```text
https://smartport-ntume.github.io/SmartPort-Progress-Hub/?apiBase=https://vincent-pc.example-tailnet.ts.net
```

成功載入後，該瀏覽器會把 API Base 儲存在 localStorage；之後可以用原本的 GitHub Pages URL。使用者仍需連上 Tailscale。

## 8. 實際的 Codex 觸發邊界

Local Codex 不會在這些動作執行：

- 開啟前端
- Dashboard / Gantt / Requirement 查詢
- Guest 或 GitHub 登入
- reload / health check
- Engineer 送 Manual Proposal

只有符合以下全部條件才會建立 Codex job：

1. 使用者通過 GitHub Organization 驗證。
2. 使用者具 PM / Maintain / Write 權限（預設）。
3. 使用者選擇 `.doc` / `.docx`、填日期與 owner team。
4. 使用者按下「上傳並排入本機 Codex」。

後端會先把原始 Word 檔 commit / push 到 Private Project-Control，接著把工作放進單工 queue。Codex 使用：

- `codex exec --ephemeral`
- `--sandbox read-only`
- `--ignore-user-config` 與 `--ignore-rules`
- JSON Schema structured output
- 隔離的 temporary workspace
- 去除 token / secret / password / API key 的 process environment

提示中的「不要使用網路」限制的是 Codex agent 的工具行為；Codex CLI 本身仍需連網呼叫模型服務。

同一份 report path 不會重複排程；active jobs 預設最多 5 個。Codex 只產生 proposal，不能直接修改 Git repo 或 baseline。

## 9. Windows 登入時自動啟動（選用）

Tailscale Serve 已使用 `--bg` 保存設定，但 Node 後端仍要啟動。若用 Windows Task Scheduler：

1. Trigger 選 **At log on**。
2. 使用 Vincent 登入 Codex 的同一個 Windows user。
3. Action program 設 `powershell.exe`。
4. Arguments 設：

   ```text
   -NoProfile -ExecutionPolicy Bypass -Command "Set-Location 'C:\path\to\SmartPort-Progress-Hub'; npm start"
   ```

5. 不要改成 `SYSTEM`；SYSTEM 看不到 Vincent 的 Codex login cache 與 Git Credential Manager credential。

正式啟用 Task Scheduler 前，先手動連續跑過一次 `npm run doctor` 與 `npm start`。

## 10. Public snapshot（預設不要開）

只有確定結構欄位可以公開時才啟用：

```powershell
git clone --branch main https://github.com/smartport-ntume/SmartPort-Progress-Hub.git .runtime/SmartPort-Progress-Hub-public
```

```dotenv
PUBLIC_SNAPSHOT_ENABLED=true
PUBLIC_REPO_PATH=.runtime/SmartPort-Progress-Hub-public
```

手動發布：

```powershell
npm run snapshot
```

Snapshot 使用固定 allowlist，不包含 description、blocker、evidence、週報內容、密碼或 access policy。但因目的 repo 是 public，第一次啟用前仍應由 PM review 產出的 `data/public-snapshot.json`。

發布並 review 後，以下網址可在本機後端離線時提供有限唯讀畫面：

```text
https://smartport-ntume.github.io/SmartPort-Progress-Hub/?publicSnapshot=1
```

前端不會自動 fallback 到公開資料；必須明確加上 `publicSnapshot=1`，且畫面會標示 `Public Snapshot · Read Only`。

## Troubleshooting

| 現象 | 檢查 |
|---|---|
| `managed_repository_not_cloned` | 重新執行第 2 步的 Private repo clone |
| `managed_repository_dirty` | 不要直接改 managed clone；先人工確認、commit 或移走變更 |
| Git pull / push 要求登入 | 用同一 Windows user 完成 Git Credential Manager 或 SSH 認證 |
| `Codex login` 非 authenticated | 在同一 Windows user 執行 `codex login`；不要用 SYSTEM 啟動 |
| `Codex automation flags` 缺少 | 更新 Codex CLI：`npm install -g @openai/codex@latest` |
| OAuth callback mismatch | GitHub OAuth App callback 與 `PUBLIC_BASE_URL + /auth/callback` 必須完全一致 |
| 瀏覽器 CORS error | 把實際 frontend origin 加入 `ALLOWED_ORIGINS`，再重啟後端 |
| `.doc` 解析失敗 | 安裝 LibreOffice，或先轉成 `.docx` |
| Tailscale URL 無法開啟 | 檢查 `tailscale status`、`tailscale serve status` 與 tailnet ACL |
