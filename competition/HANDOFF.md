# 工程交接：MEmory，OPEN LAB AI Build Challenge 衝刺

撰寫時間：2026-11-27 20:20（台北時間）。截止時間：2026-11-27 23:59（台北時間；規則頁面標示此日期為暫定）。分支為私有 repo 的 `competition/openlab-2026`，repo 未公開。

以下是工程狀態標記。**主辦單位尚未確認參賽資格。** Demo 尚未錄製，也尚未提交任何東西。

## 線上候選版本

- **網址：** https://capture-pursue-overhead-longer.trycloudflare.com/studio 。主辦方審核頁在 `/organizer`，需要你電腦上 `competition-build\.env.local` 裡的 token。
- **架設方式：** 在你的 Windows 電腦上跑 Next.js 正式版伺服器（:3100，`COMPETITION_PUBLIC=1`），透過 Cloudflare quick tunnel 對外公開。
- **可用時間：** 只有在電腦開機、不休眠、有網路，而且執行 cloudflared 的 PowerShell 視窗保持開啟時才能連上。cloudflared 重新啟動後，網址會改變。
- **公開網址檢查（20:13 台北時間）：**
  - `/studio` 200，`/organizer` 200，`/` 307 轉到 `/studio`。
  - `/admin` 和 `/api/health` 回 404。
  - 沒有 token 的主辦方重設請求回 403。
  - `/api/studio/event` 顯示 AI、ComPDF 和字型都已設定。
  - 證據：`evidence/deploy/tunnel-check-2026-11-27T12-13-36Z.json`。
- **花費保護：** 每天最多 80 個任務，每位訪客每小時最多 6 個。
- **目前活動：** 內建示範活動「MEmory 現場記憶示範」（允許照片、影片和下載），因為 e2e 測試結束時會重設回示範活動。若要公開顯示由文件產生的活動，請在 `/organizer` 上傳並確認一份 PDF，它會取代示範活動，直到重設為止。

## 功能狀態

| 功能 | 標記 | 證據 |
|---|---|---|
| Track A 影片工作室：活動 → 照片/影片 → 心得 + 語氣 → Claude 真實視覺分析 → 有依據的敘事 + 分鏡 JSON → 用原始素材以 FFmpeg 算繪 → 預覽／下載／刪除 | VERIFIED（已驗證） | `evidence/trackA/`、`evidence/e2e/e2e-live-2026-11-27T11-59-23-999Z.json`、影片與縮圖總覽 |
| 範例資料模式（2 組合成素材，介面上標示為合成） | VERIFIED | `evidence/trackA/` |
| 不同輸入產生不同輸出 | VERIFIED | 3 組輸入 + 文件規則下的一次執行 |
| 無效輸入處理（同意、檔案數量、大小、偽造檔案類型、頻率／每日上限、AI 未設定） | VERIFIED | 單元測試、e2e 第 7 步 |
| 沒有把模擬結果當成 AI（範本備案標示為 `plan_source: template`；記錄 Claude message id） | VERIFIED | job.json 裡的 `ai_calls` |
| Track C：PDF → 真實 ComPDF documentParsing | VERIFIED | `evidence/compdf/`、e2e 任務 id |
| ComPDF documentExtract | BLOCKED（受阻） | 每次都回 api_code 03000，已停用（B-7） |
| AI 解讀 → 活動設定 + 權利規則，附原文引用與頁碼 | VERIFIED | `evidence/trackC/interpretation-*.json` |
| 不明或模糊的權利預設關閉；衝突與未簽署草稿會被標出 | VERIFIED | 單元測試、e2e 第 2、4、5 步 |
| 人工審核 → 匯入 → 使用者端工作室依文件規則運作 | VERIFIED | e2e 第 6、8 步、`evidence/e2e/studio-document-derived-event.png` |
| DottedSign（P2） | PARTIAL（僅唯讀連線） | `evidence/dottedsign/readonly-check-2026-11-27T12-12Z.json`；讀取任務／範本被 DottedSign 帳號安全驗證擋下；免費方案簽署任務上限為 0；沒有建立或寄出任何東西 |
| Track B Glows AI | NOT IMPLEMENTED（未實作） | 依你的決定延後（B-1） |
| 公開部署候選版本 | VERIFIED（電腦開著時） | STATUS.md、B-8 |
| 建置／lint／型別檢查／單元測試（80/80）／Playwright 比賽 e2e（3/3） | VERIFIED | STATUS.md |
| 既有 beta 測試（需要 Postgres） | PARTIAL | beta 程式碼未改動；本次未重跑 |

## 費用

- **Anthropic：** 總計約 US$1 以內，在你核准的 US$2 範圍內。這是依 token 數和執行次數估算，不是帳單，請到 Anthropic 主控台確認。
- **ComPDF：** 只用到免費試用額度。
- **Cloudflare quick tunnel 和 DottedSign：** 免費。沒有購買或升級任何付費方案。

## 你還需要做的事

1. 在評審結束前，讓電腦保持不休眠（設定 → 系統 → 電源 → 睡眠：永不），並保持 cloudflared 視窗開啟。
2. （選做）到 dottedsign.com 完成帳號安全驗證，讓讀取任務和範本可以運作。任何真的要寄出的簽署請求都需要付費方案，而且要你明確同意。
3. 比賽結束後再決定是否升級 Next.js（B-5），以及是否改用 named tunnel 或容器主機，讓網址永久有效（B-8）。`Dockerfile.competition` 和 `.env.competition.example` 已經準備好。
4. 錄製 Demo 和撰寫提交內容；這兩項不在本次衝刺範圍內。

## 機密資訊

金鑰只存在你電腦上和衝刺用容器裡的 `.env.local`，兩者都已被 gitignore。每次提交前都檢查過證據檔，確認沒有金鑰或主辦方 token。`.env.competition.example` 只列出變數名稱，沒有值。
