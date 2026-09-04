# NTU／實驗室公開本機後端 — Windows 部署

## 0. 先向網管確認

部署前取得以下資訊；缺少任何一項都先不要開 Port：

| 項目 | 範例 |
|---|---|
| 後端電腦固定內網 IP | `192.168.10.20` |
| 實驗室 Public IPv4 | `140.x.x.x` |
| 對外 TCP | `80`、`443` |
| DNS hostname | `progresshub.example.ntu.edu.tw` |
| Router/NAT 管理者 | 實驗室網管 |

如果電腦本身直接取得 Public IP，通常不需要 NAT Port Forwarding，但仍要由網管確認校級防火牆與 Windows Firewall 規則。

## 1. 正式架構

```text
Internet
  → DNS / Public IP
  → Router: TCP 80,443 → Windows 固定內網 IP
  → Caddy: HTTPS / security headers
  → http://127.0.0.1:8787
  → SmartPort Node backend
  → Local Git / Local job history / Local Codex
```

不要轉發或開放 `8787`、Git、SMB、RDP、資料庫 port。Node 的 `HOST` 必須維持 `127.0.0.1`。

## 2. 安裝工具

- Node.js 22+
- Git for Windows
- GitHub CLI
- Codex CLI
- Caddy 官方 Windows binary
- LibreOffice（只有解析舊 `.doc` 才需要）

一般 PowerShell：

```powershell
node --version
git --version
gh --version
codex --version
caddy version
```

Git 與 Codex 必須使用日後執行 Node 後端的同一個 Windows 帳號登入：

```powershell
gh auth login
gh auth setup-git
codex login
codex login status
```

## 3. Clone 程式與資料

```powershell
git clone --branch feature/ntu-local-backend https://github.com/smartport-ntume/SmartPort-Progress-Hub.git
Set-Location SmartPort-Progress-Hub
npm install

New-Item -ItemType Directory -Force .runtime | Out-Null
git clone --branch main https://github.com/smartport-ntume/SmartPort-Project-Control.git .runtime/SmartPort-Project-Control
```

`.runtime/SmartPort-Project-Control` 是後端專用 managed clone，不要用編輯器直接修改。正式寫入由後端 commit/push，dirty worktree 會讓後端停止。

目前不需要 PostgreSQL：

| 資料 | 本機位置 | 遠端用途 |
|---|---|---|
| Project / WP / FSR / CP / access policy | `.runtime/SmartPort-Project-Control` | Private Git 備援與版本歷史 |
| Codex job history | `.runtime/jobs/history.json` | 不同步 |
| 暫時 Codex workspace | `.runtime/codex` | 執行後刪除，除非明確保留 |
| Weekly report | 先進本機後端，再 commit 到 Private Git | 稽核與留存 |

## 4. 建立 GitHub OAuth App

建立新的 GitHub OAuth App：

| 欄位 | 值 |
|---|---|
| Application name | `SmartPort NTU Local Hub` |
| Homepage URL | `https://YOUR-DOMAIN/` |
| Authorization callback URL | `https://YOUR-DOMAIN/auth/callback` |

Client Secret 只能放在 `.env.local`，不可放入前端、GitHub commit 或聊天截圖。

## 5. 設定 Node 後端

```powershell
Copy-Item .env.example .env.local
notepad .env.local
```

將所有 `progresshub.example.ntu.edu.tw` 換成真實 hostname，並填入：

```dotenv
GITHUB_CLIENT_ID=<OAuth Client ID>
GITHUB_CLIENT_SECRET=<OAuth Client Secret>
SESSION_SECRET=<至少 32 字元的隨機值>
LOCAL_CODEX_ALLOWED_LOGINS=<只有你的 GitHub login>
```

產生 `SESSION_SECRET`：

```powershell
$secretBytes = New-Object byte[] 48
$secretRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$secretRng.GetBytes($secretBytes)
[Convert]::ToBase64String($secretBytes)
$secretRng.Dispose()
```

不要把 `<...>` 或 `YOUR_GITHUB_LOGIN` 範例文字留在設定中。

## 6. 設定 Caddy

```powershell
Copy-Item .env.caddy.example .env.caddy
notepad .env.caddy
```

內容只需要：

```dotenv
SMARTPORT_DOMAIN=YOUR-DOMAIN
```

先驗證：

```powershell
caddy validate --config deploy/Caddyfile --envfile .env.caddy
```

Caddy 會自動取得並更新公開 HTTPS 憑證；條件是 DNS 已指向 Public IP，且 Internet 能連到 TCP 80/443。

## 7. Router 與 Windows Firewall

Router/NAT 建立兩條規則：

| Public port | Protocol | Internal target |
|---|---|---|
| 80 | TCP | `<後端固定內網 IP>:80` |
| 443 | TCP | `<後端固定內網 IP>:443` |

系統管理員 PowerShell 只允許 Caddy 使用的 port：

```powershell
New-NetFirewallRule -DisplayName "SmartPort HTTP for HTTPS redirect" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow
New-NetFirewallRule -DisplayName "SmartPort HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
```

不要建立 8787 inbound rule。

## 8. 本機驗證與第一次啟動

```powershell
npm run check
npm test
npm run doctor
npm start
```

另一個系統管理員 PowerShell：

```powershell
caddy run --config deploy/Caddyfile --envfile .env.caddy
```

看到 Node 顯示 `SmartPort Local Backend listening on http://127.0.0.1:8787` 後，從手機行動網路測試真實網址，再執行：

```powershell
npm run probe
```

`probe` 會驗證 HTTPS、local mode、health 資訊隱藏、安全標頭，以及 `.env.local` 無法公開讀取。

## 9. 建立 Guest 密碼與帳號角色

1. 先使用白名單中的 GitHub PM 帳號登入。
2. 到 Settings 設定至少 12 字元 Guest password。
3. Guest 用共用密碼進入完整唯讀畫面。
4. GitHub Organization 成員依 Private repo permission 判定：可 push 為 PM，僅 read 為 Engineer。

更新 Guest password 會同步更新 Private Git 的 salted hash，舊 Guest session 立即失效。

## 10. 開機自動啟動

Node 必須由已完成 Git/Codex login 的 Windows user 執行，可使用 Task Scheduler：

- Trigger：`At log on`
- Program：`powershell.exe`
- Arguments：

```text
-NoProfile -ExecutionPolicy Bypass -Command "Set-Location 'C:\path\to\SmartPort-Progress-Hub'; npm start"
```

不要用 `SYSTEM` 執行 Node，否則讀不到該使用者的 Git Credential Manager 與 Codex login。

Caddy 建議依官方 Windows service 說明以 `sc.exe` 或 WinSW 安裝；service 的 `binPath` 必須包含完整的 `--config` 與 `--envfile` 路徑。先完成手動運行與外網測試，再設定自動啟動。

## 11. 安全邊界

- 公開 request 只能進入既定 HTTP routes，不能提交 shell command。
- Codex 使用隔離 temporary workspace、read-only sandbox 與 structured output。
- 只有 `LOCAL_CODEX_ALLOWED_LOGINS` 白名單中的 PM 能啟動 Codex。
- Guest login 每個來源 IP 每 10 分鐘最多嘗試 10 次。
- Public health 只回傳 ready/not-ready，不公開 commit、branch、Codex version 或 queue 細節。
- `.env.local`、`.git`、source、test、runtime files 不在 static allowlist 中。
- Dropbox 若使用，只備份匯出檔；不要即時同步正在工作的 `.git` 目錄。

## 12. 上線前檢查表

- [ ] 網管書面同意對外提供 80/443
- [ ] DNS 指向正確 Public IP
- [ ] Router 只轉發 80/443
- [ ] Windows 沒有開放 8787/RDP/SMB/DB
- [ ] GitHub OAuth callback 完全相符
- [ ] `SESSION_SECRET` 與 Client Secret 未進 Git
- [ ] Codex login 白名單只有 Vincent
- [ ] `npm run doctor` 全部通過
- [ ] `npm run probe` 全部通過
- [ ] 使用手機行動網路測試 Guest、Engineer、PM
- [ ] Windows Update、Caddy、Node 與 npm dependencies 有固定維護窗口
