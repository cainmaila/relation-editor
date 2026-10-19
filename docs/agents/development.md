# 開發入門（給 AI agent）

使用者手冊在根目錄 `README.md`；本文件是開發細節。

## 技術與指令

SvelteKit＋Svelte 5＋TypeScript＋Tailwind v4，pnpm；以 Tauri 包成 macOS 桌面 app（不部署雲端）。測試：Vitest（unit／瀏覽器元件）＋ Playwright（e2e）。

```sh
pnpm install
pnpm dev                     # 開發（僅瀏覽器，不能存檔，重新整理就還原）
pnpm tauri dev               # 桌面 app 開發（可存檔）
pnpm tauri build             # 打包 .app／.dmg（src-tauri/target/release/bundle/，本機未簽章）
pnpm check && pnpm lint      # 型別、lint
pnpm test:unit --run         # unit＋瀏覽器元件測試（vitest）
pnpm build && pnpm preview   # production（量測一律用這個）
pnpm exec playwright test    # e2e（自動 build＋preview，port 4173）
```

## 架構分工

| 層           | 位置                                                                    | 責任                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 標準圖與命令 | `src/lib/editor.svelte.ts`、`src/lib/model/graph-change.ts`             | 唯一的資料來源；所有修改走命令、遞增 revision／topologyRevision                                                                               |
| 索引         | `src/lib/model/graph-index.ts`                                          | 鄰接、度數、系統分組；分析（未處理、無客戶路徑、找客戶）在主執行緒同步重算（P8 單一環境 Apple M2／Chrome 實測 10k／100k p95 < 200ms，非保證） |
| 全量搜尋     | `src/lib/search/`（Worker）                                             | 正規化、多字 AND、分頁；只顯示最新請求／revision 的結果                                                                                       |
| 工作區       | `src/lib/model/workspace.ts`                                            | membership、200／1,000 admission、一跳鄰居預覽                                                                                                |
| 版面         | `src/lib/universe/runtime.ts`、`layout.worker.ts`                       | 每個分頁一個 session runtime：先給種子座標、背景分段整理到預算後凍結；切頁不重啟、相機姿態保存                                                |
| 3D 繪製      | `src/lib/universe/lod.ts`、`renderer.ts`、`components/GraphView.svelte` | 全部可見節點畫 Points；依投影半徑升級細節球；細節、局部邊、高亮邊、標籤都有硬上限並誠實計數；點選靠格網＋投影＋深度（不用 raycast）           |
| 2D 編輯      | `components/Canvas.svelte`（Svelte Flow）                               | 工作區卡片圖；穩定物件身分避免整圖重建                                                                                                        |

### LOD 呈現規則（`LOD` 設定集中在 `lod.ts`）

- 縮放與 LOD 只影響「畫出多少」，不改資料、不改搜尋與追查結果。
- 細節球 ≤ 1,000、局部邊 ≤ 2,000（兩端皆細節）、高亮邊 ≤ 2,000、標籤 ≤ 80；省略數顯示在圖例。
- 選取節點只要在相機前方、遠裁切面以內且所屬系統可見，就一定有標籤（放不下時夾進畫面內）；在相機後方或超出遠裁切面時不畫。其他節點的標籤受 80 個上限與避碰限制，不保證每個都有。
- 選取的邊在高亮上限內一定畫。

## 資料載入

- 內建範例在 `static/data/`（build 時打包進 app；`/` 開啟時讀它，2,066 節點的 2F 全棟示意資料），清單是 `static/data/index.json`（相對該目錄；新增或刪除檔案要同步改）。
- `src/lib/model/load.ts`：Tauri 下優先讀使用者選過的資料夾（路徑存在 localStorage 的 `dataDir`），結構同 `static/data`；沒選過、或在瀏覽器／測試下讀內建資料。資料夾讀不到或有誤時移除該設定，錯誤頁說明後重新開啟會改回內建範例。
- `src/lib/model/save.ts`：`saveEditor` 把 `editor.exportFiles()` 整組寫入資料夾（含 `index.json`，UTF-8、無 BOM、LF）；先以載入同一套規則驗證，不過就不寫。只寫入、覆蓋同名檔，不刪其他檔。沒有改動時不可按。
- `src/lib/model/csv.ts`：CSV 解析與建圖；`csv-seed.ts`：測試與實驗用的同步資料來源（建置時把 `static/data` 讀進來，內容與正式執行期讀到的相同）。
- `src/lib/model/config.ts`：系統與類型清單。邊檔、idc 檔的檔名必須是這裡已有的類型名；新增類型（或系統）要先改它。
- 格式規則（欄位、idc 唯讀、舊格式報錯、錯誤訊息帶檔名與列號）見 `README.md` 的資料檔章節。
- 編輯頁詳情欄是草稿：按「儲存」才寫回圖；切換選取就捨棄，不另跳確認框。

## Tauri

- `src-tauri/`：Rust 端；`lib.rs` 註冊 dialog、fs、persisted-scope、log plugin。
- `src-tauri/capabilities/default.json`：只開 `fs:allow-read-text-file`、`fs:allow-write-text-file`、`fs:allow-mkdir`、`dialog:default`、`core:window:allow-destroy`。fs 範圍不預先宣告，只限使用者用對話框選過的資料夾，由 persisted-scope plugin 跨啟動記住。
- CSP 在 `src-tauri/tauri.conf.json`（`app.security.csp`；`devCsp` 為 null）。
- 關窗攔截：`src/lib/components/App.svelte` 用 `onCloseRequested`，有未儲存改動時先確認，確認後 `destroy` 視窗。
- 打包前端來源是 `../build`，dev 用 `http://localhost:5173`。

## 量測

`/measure?nodes=10000&edges=20000&seed=1`：量測入口，產生確定性的代表性大圖（`scale-fixture.ts`），例如 10k／20k、10k／100k、50k／100k。只用於量測與壓力觀察，不改產品預設。

以下數字與門檻都是在 Chrome 量的；app 實際使用的 WebView（WKWebView）沒有量過。

先 `pnpm build && pnpm preview --port 4173`，再用真 GPU 的 Chrome 串行執行（同時不要跑其他瀏覽器測試）：

```sh
pnpm measure:universe formal    --edges 20000,100000 --samples 5 --channel chrome   # 正式矩陣（10k 節點）
pnpm measure:universe workspace --edges 100000 --samples 3 --channel chrome         # 編輯頁 200／1,000（＋500 壓力觀察）
pnpm measure:universe stability --edges 20000 --cycles 20 --channel chrome          # 20 輪洩漏／Worker／listener
pnpm measure:universe stress    --channel chrome                                    # 50k、原生 DPR、小視窗、SwiftShader 對照
pnpm measure:universe selftest  --channel chrome                                    # harness 逾時與清理自測
pnpm measure:universe analysis  --edges 20000,100000                                # Node 端分析耗時（參考，不是瀏覽器驗收）
```

所有延遲都在頁內量（真實輸入事件的 `event.timeStamp` → 狀態成立後畫出的下一幀），不是測試驅動端的牆鐘。結果寫入 `--out`（預設 `.superpowers/sdd/plan/artifacts/…`）：raw JSON、截圖、trace，以及 PASS／FAIL 判定。

門檻：冷啟動到可操作＋全量搜尋可用 ≤ 2s；旋轉／滾輪幀間隔 p95 ≤ 33.3ms；搜尋 p95 ≤ 150ms；選取 p95 ≤ 100ms；回 3D ≤ 500ms 且不重啟 Worker；分析 ≤ 500ms；編輯頁 200／1,000 平移／拉線 p95 ≤ 33.3ms、提交 p95 ≤ 150ms。

實測：2D 編輯頁 200 節點／1,000 條邊，在可讀縮放（0.87：卡片約 139px、名稱約 10px，不是全部塞進畫面的 0.1）下，P8 量測環境（Apple M2、Chrome、Metal）3 個樣本：平移與拉線幀間隔 p95 16.8ms、提交到畫面 p95 27.8ms、放開到建立邊選單 p95 55.9ms；每個樣本第一次拉線有一幀 50ms。其他機器未量測。

## 技術性已知限制

- 效能門檻以硬體 GPU 為前提。SwiftShader（軟體繪製）可用但達不到門檻。
- 編輯頁 500 節點只作壓力觀察（平移、提交明顯變慢），產品上限維持 200／1,000。
- 50k 節點／100k 邊可操作（冷啟動 < 1s），但不是正式支援規模。
- 3D 程式庫入口載入失敗時顯示錯誤與「重試」（換 URL 真的重新下載，並驗證拿到的是預期模組）。失敗的若是入口依賴的共用 chunk（例如 three），瀏覽器會在這個分頁記住失敗，頁面內無法恢復：改顯示「需要重新整理頁面」且不給重試、不自動重整（重新整理會遺失還沒存進資料夾的編輯；瀏覽器模式下是全部編輯）。Safari 類錯誤訊息不含 URL 時只能照原方式重試。
