# 階段成果 PDF 技術文件

正式入口：[SmartPort Progress Hub](https://smartport-ntume.github.io/SmartPort-Progress-Hub/)。PDF 上傳位於既有 Discord 週報連結中的「技術文件 · PDF」，Dashboard 開啟子項目可查看文件。

## 成員操作

1. 使用仍開放的週報連結，選擇姓名。
2. 在技術文件區選擇工作細項；每項都顯示 WP 與細項的完整標題。清單依目前分工，包含已完成、未到期及不在本週週報範圍的工作。
3. 選「新增一份階段文件」，填寫標題，例如「介面定義」或「第一階段測試紀錄」，上傳不超過 **10 MB** 的 PDF。
4. 等待 Agent 歸檔，按「重新整理文件」。顯示「已歸檔」後可開啟 PDF；Dashboard 的同一細項也會出現連結。
5. 更新相同文件時，在「文件／版本」選擇既有標題，再上傳新版。不同階段可各自新增文件。歷史版本全部保留。

上傳是選填，不受週報截止日限制，也不變更正式進度、觸發 Codex 或等待 PM 審核。批次關閉後請改用最新連結。既有週報 Word 操作保持獨立。

「等待 Agent 歸檔」表示 PDF 已送達，Agent 上線後處理；「歸檔失敗」可按「重試歸檔」。檔案送達但提交時斷線，可按「完成上次上傳」，沿用原檔。若檔案本身錯誤，請另傳修正 PDF。

入口沿用共用 token：持有連結的人可切換姓名，不是 GitHub 身分驗證。僅在受控頻道提供此連結。私人 PDF 的查看另外由 GitHub repository 權限管理。

## 私人文件庫與命名

預設 repository：`smartport-ntume/SmartPort-Technical-Docs`，分支 `main`。禁止寫入公開 repository。

範例實際路徑：

```text
WP-C1_Basic Motion/C1.1_CAN Command and Feedback Interface/2026-10-06_介面定義_v01_12345678.pdf
```

- 層級為「WP ID_完整標題／細項 ID_完整標題／日期_文件標題_版本_識別碼.pdf」。日期使用台灣時間；末尾短識別碼區分同名文件。
- `/`、`\` 轉成 `and`，移除檔名不允許的符號；極長名稱截短至安全長度。畫面保留完整原標題。
- 文件關聯依穩定的 WP／細項 ID，同一文件的新版本沿用初次歸檔的資料夾名稱。後續任務改名不會搬移或破壞既有文件連結。
- Dashboard 連結固定到 Git commit，因此打開舊版不會意外變成新版。
- Supabase 保存文件標題、所屬細項、上傳者選定的姓名、版本與歸檔狀態；PDF 正本存 Git。工作佇列清理不會刪除文件版本索引。
- GitHub 成員需對文件庫有 **Read** 權限；Agent 使用本機既有憑證且需 **Contents read/write**。前端不取得 GitHub token，不向 Guest 提供私人文件清單。

## 一次性上線步驟

先停止 Windows 工作排程器中的 Agent。於 `C:\Users\Vincent Huang\SmartPort-Progress-Hub-Agent` 開啟 PowerShell：

```powershell
git pull --ff-only origin main
npm run docs:setup
```

`docs:setup` 是明確執行才會建庫的指令，使用本機 `GITHUB_AGENT_TOKEN` 或 `gh auth token`；建立 Private repo 並初始化 README，不更動已存在的文件。若 token 沒有建庫權限，Organization 管理員可手動建立同名 Private repo、勾選 Add a README，再授予 Agent 的 token 此 repo 存取權。

在 GitHub 文件庫 Settings → Collaborators and teams，給需要查看 PDF 的 Team／成員 **Read**。不要開啟公開權限。

到 [Supabase SQL Editor](https://supabase.com/dashboard/project/omnevhesguhofipvfccf/sql/new) 執行 [202610060001_technical_documents.sql](../supabase/migrations/202610060001_technical_documents.sql)。既有前置 migrations 須已完成；本 SQL 可重跑。

```powershell
npm run doctor
```

確認 `Technical document migration` 和 `Private technical document repository` 通過。再由工作排程器啟動 Agent，主站與週報頁按 `Ctrl+F5`。

預設名稱不需增加環境變數。若另用私人庫，於 `.env.local` 設定 `TECHNICAL_DOCS_REPO=owner/repository`、`TECHNICAL_DOCS_BRANCH=main`。

## 故障恢復

Agent 在歸檔前再次核對目前分工、PM 權限、PDF 檔頭與實際大小；GitHub 寫入成功並保存索引後才刪除暫存檔。中斷後重試會核對相同路徑的 Git blob SHA，相同內容直接接續索引，不覆寫不同內容。失敗文件暫存保留供重試；長期不用的失敗／逾時上傳可由管理員在 Supabase Storage 的 `technical-documents` bucket 清理，清理後需重新上傳。

本功能的 SQL、Agent 與介面測試都使用本機資料庫及模擬 GitHub／Storage，沒有上傳正式 PDF 或發送 Discord 訊息。完整實機驗證需完成上述設定並用一份可分享的測試 PDF 上傳。
