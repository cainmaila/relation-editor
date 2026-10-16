# 關係編輯器（relation-editor）

機房／IDC 關係圖的瀏覽與局部編輯工具（SvelteKit＋Svelte 5，以 Tauri 包成 macOS 桌面 app，不部署雲端）。全圖用 3D 宇宙呈現上萬個節點，
編輯頁用 2D 卡片圖在最多 200 個節點的工作區內修改。

> **存檔**：桌面 app 第一次開啟用內建範例；按「儲存」（⌘S）選一個資料夾，編輯結果就以 CSV 寫進去（結構同 `static/data/`），
> 之後開啟會自動讀那個資料夾，「開啟…」可換資料夾。只在瀏覽器（`pnpm dev`）執行時不能存檔，重新整理就還原。
> 資料夾讀不到或內容有誤時，錯誤頁會說明原因並取消資料夾設定，重新開啟改回內建範例。
> 有未儲存的改動時，關閉視窗或開啟別的資料夾會先確認。
> 詳情欄修改是草稿：按「儲存」才寫回圖；未儲存時會顯示「尚未儲存：切換選取或離開會捨棄（不會自動保存）」，
> 切換選取就捨棄草稿，不另外跳確認框。

## 使用

- `/`：產品入口，開啟時讀 `static/data` 的 CSV（2,066 節點的 2F 全棟示意資料）。
- `/measure?nodes=10000&edges=20000&seed=1`：量測入口，產生確定性的代表性大圖（`scale-fixture.ts`），
  例如 10k／20k、10k／100k、50k／100k。只用於量測與壓力觀察，不改產品預設。
- 兩個畫面（頂列「全圖」／「編輯頁」）：
  - **全圖（3D）**：看完整標準圖。拖曳旋轉、滾輪縮放、點節點選取；⌘K 全量搜尋（結果分頁、可跨頁勾選加入編輯頁）；
    系統開關（⌥＋點只看一個系統）；「找客戶」沿完整標準圖追查，結果分頁並標示分析版本；狀態列顯示版面整理進度、
    「全景」（只移相機）與「重新整理版面」（重新跑版面）。
  - **編輯頁（2D）**：只顯示工作區成員。新增／修改／刪除節點與邊、拖曳卡片連線、右鍵選單；
    「移出工作區」只是離開工作區，不刪資料（立即生效）。刪除節點或邊是永久刪資料，沒有復原：
    詳情、右鍵、浮動工具列、⌫ 一律要再按一次「確認刪除」（取消或 Esc 什麼都不改），節點會說明連帶幾條邊
    （含工作區外看不到的）。IDC 維護的資料與根節點不能刪，直接說明原因、不出現確認。
- 工作區上限 200 個節點／1,000 條誘導邊，加入是整批原子判斷：超過就整批拒絕並說明，不會只加一部分。

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
- 選取節點只要在相機前方、遠裁切面以內且所屬系統可見，就一定有標籤（放不下時夾進畫面內）；
  在相機後方或超出遠裁切面時不畫。其他節點的標籤受 80 個上限與避碰限制，不保證每個都有。
- 選取的邊在高亮上限內一定畫。

## 資料檔（CSV）

節點與邊的 CSV：內建範例在 `static/data/`（build 時打包進 app）；使用者資料夾用同樣結構，開啟時才讀。

- `index.json`：要載入的 CSV 清單（相對 `static/data/`）。新增或刪除檔案要同步改這裡。
- `nodes/<系統>.csv`：系統為 空間、電力、空調、網路、消防、CCTV，另有 `通用.csv`（通用節點）。欄位 `類型,key,名稱,<屬性...>`；`類型` 必須屬於該系統；`key` 必填、全圖唯一（含 IDC），邊以 key 當起訖；`名稱` 選填、可重複，空白＝顯示 key；屬性空格＝沒有該屬性。屬性欄取該系統各類型的聯集，用不到的留空。
- `edges/<邊類型>.csv`：前三欄 `起點,終點,雙向`（起訖填節點 key；`雙向` 填 `是`，空白＝單向），其餘欄是屬性。
- `idc/nodes/<類型>.csv`、`idc/edges/<類型>.csv`：檔名即類型，節點檔不需 `類型` 欄（欄位 `key,名稱`）；整個資料夾載入為唯讀（由 IDC機櫃配置管理維護，之後會改由另一個系統提供）。
- 表頭固定欄不符（含舊的 `名稱` 單欄格式）會直接報錯，不相容舊格式。
- 儲存：Header「儲存」（⌘S）把整組檔案（含 `index.json`，UTF-8、無 BOM、LF）寫進資料夾；先以載入同一套規則驗證，不過就不寫並顯示原因。只寫入、覆蓋同名檔，不會刪資料夾裡其他檔案。沒有改動時不可按。
- 邊檔、idc 檔的檔名必須是 `config.ts` 已有的類型名；新增類型（或系統）要先改 `config.ts`。
- 格式：UTF-8（Excel 的 BOM 可）、逗號分隔、含逗號或換行的格子用雙引號。
- 資料有誤（未知類型、名稱重複、端點找不到）會顯示錯誤頁，訊息帶檔名與列號。

## 開發

```sh
pnpm install
pnpm dev                     # 開發（瀏覽器，不能存檔）
pnpm tauri dev               # 桌面 app 開發（可存檔）
pnpm tauri build             # 打包 .app／.dmg（src-tauri/target/release/bundle/，本機未簽章）
pnpm check && pnpm lint      # 型別、lint
pnpm test:unit --run         # unit＋瀏覽器元件測試（vitest）
pnpm build && pnpm preview   # production（量測一律用這個）
pnpm exec playwright test    # e2e（自動 build＋preview，port 4173）
```

## 量測（可重現）

先 `pnpm build && pnpm preview --port 4173`，再用真 GPU 的 Chrome 串行執行（同時不要跑其他瀏覽器測試）：

```sh
pnpm measure:universe formal    --edges 20000,100000 --samples 5 --channel chrome   # 正式矩陣（10k 節點）
pnpm measure:universe workspace --edges 100000 --samples 3 --channel chrome         # 編輯頁 200／1,000（＋500 壓力觀察）
pnpm measure:universe stability --edges 20000 --cycles 20 --channel chrome          # 20 輪洩漏／Worker／listener
pnpm measure:universe stress    --channel chrome                                    # 50k、原生 DPR、小視窗、SwiftShader 對照
pnpm measure:universe selftest  --channel chrome                                    # harness 逾時與清理自測
pnpm measure:universe analysis  --edges 20000,100000                                # Node 端分析耗時（參考，不是瀏覽器驗收）
```

所有延遲都在頁內量（真實輸入事件的 `event.timeStamp` → 狀態成立後畫出的下一幀），不是測試驅動端的牆鐘。
結果寫入 `--out`（預設 `.superpowers/sdd/plan/artifacts/…`）：raw JSON、截圖、trace，以及 PASS／FAIL 判定。

門檻：冷啟動到可操作＋全量搜尋可用 ≤ 2s；旋轉／滾輪幀間隔 p95 ≤ 33.3ms；搜尋 p95 ≤ 150ms；
選取 p95 ≤ 100ms；回 3D ≤ 500ms 且不重啟 Worker；分析 ≤ 500ms；編輯頁 200／1,000 平移／拉線 p95 ≤ 33.3ms、
提交 p95 ≤ 150ms。

## 已知限制與支援範圍

- 支援：桌面版 Chromium（Chrome）＋硬體 GPU。SwiftShader（軟體繪製）可用但達不到效能門檻。
- 2D 編輯頁 200 節點／1,000 條邊，在可讀縮放（0.87：卡片約 139px、名稱約 10px，不是全部塞進畫面的 0.1）下，
  P8 量測環境（Apple M2、Chrome、Metal）3 個樣本：平移與拉線幀間隔 p95 16.8ms、提交到畫面 p95 27.8ms、
  放開到建立邊選單 p95 55.9ms；每個樣本第一次拉線有一幀 50ms。其他機器未量測。
- 編輯頁 500 節點只作壓力觀察（平移、提交明顯變慢），產品上限維持 200／1,000。
- 50k 節點／100k 邊可操作（冷啟動 < 1s），但不是正式支援規模。
- 3D 程式庫入口載入失敗時顯示錯誤與「重試」（換 URL 真的重新下載，並驗證拿到的是預期模組）。
  失敗的若是入口依賴的共用 chunk（例如 three），瀏覽器會在這個分頁記住失敗，頁面內無法恢復：
  改顯示「需要重新整理頁面」且不給重試、不自動重整（重新整理會遺失本分頁的所有編輯，包括已按儲存的）。Safari 類錯誤訊息不含 URL 時只能照原方式重試。
- 沒有存檔、匯入、多人協作。
