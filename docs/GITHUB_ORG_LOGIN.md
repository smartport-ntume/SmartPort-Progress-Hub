# GitHub 組織成員自動開通

GitHub 登入時要求 `read:org`，Supabase Edge Function 使用使用者的 GitHub provider token 驗證 `/user` 身分與 `/user/memberships/orgs/smartport-ntume` 的 active membership。不依賴公開組織名單或可編輯的 user_metadata，也不保存或記錄 provider token。

驗證組織後，分頁讀取 `/user/teams`：smartport-ntume 組織的 `smartport-pm` team 成員自動取得 PM，其他有效組織成員取得 ENGINEER。既有 ENGINEER 重新 GitHub 登入後也能升為 PM。既有 PM / GUEST 明確授權不覆寫；active=false 不開通。Codex 開關維持原設定，不因 team 升級自動開啟。這是登入時開通與升級流程，不是組織或 team 退出同步；移除成員或取消 PM 時管理員仍須在 profiles 設 active=false 撤銷既有授權。

## 部署（不需 SQL 或更新 Windows Agent）

在專案目錄執行：

```powershell
npx supabase login
npx supabase functions deploy github-org-access --project-ref omnevhesguhofipvfccf --no-verify-jwt
```

`--no-verify-jwt` 只停用 Gateway 的舊式 JWT 驗證；函式本身每次使用 `auth.getUser(jwt)` 驗證 Supabase 使用者，未驗證身分不能取得角色。Supabase 提供函式所需的 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY，不要把 service role key 放到前端。

如果組織啟用了 OAuth App access restrictions，組織 Owner 必須允許目前 Supabase GitHub OAuth App 存取 smartport-ntume；否則連真正的成員都可能無法通過檢查。

部署後網站 Ctrl+F5，其他成員重新按 GitHub Login，接受 read:org 授權。未接受組織邀請者先接受邀請。舊 session 沒有 provider token 時重新登入即可。

驗收：使用尚未開通的組織成員登入取得 ENGINEER；外部帳號與未接受邀請者不能進入；SmartPort-PM 成員自動取得 PM（含原 ENGINEER）；原 PM 權限不變；停用帳號不能恢復。實際 OAuth 需以成員帳號驗證。
