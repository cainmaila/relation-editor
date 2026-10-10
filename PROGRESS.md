# PROGRESS

## P2 共用索引、命令與 revision（分支 cainmaila/main-3-3）

- **Goal:** 兩個視圖共用的圖核心：`GraphIndex`、typed commands／`GraphChange`、`revision`／`topologyRevision`；詳情欄改本地草稿＋儲存／取消。計畫 `.superpowers/sdd/plan/task-2-brief.md`
- **Done（agent-tested，待 parent QA）:**
  - `graph-index.ts`：`buildGraphIndex()` 一次 O(V+E) 建 `nodeById／edgeById／incoming／outgoing／incident`（只記 EdgeId）；`graph.ts` 的 `unprocessed／unreachable／findCustomers／validateEdge／checkDeleteNode` 改吃選用的預建索引（舊呼叫照舊）；`findCustomers` 多回 `customerIds`
  - `graph-change.ts`：`applyCommand()` 先驗完所有欄位才產生新狀態；IDC 唯讀、根節點、連接限制、不存在／過期（`base`）實體明確拒絕；改名／屬性只增 `revision`，增刪與方向改變才增 `topologyRevision`；回傳變更 ID 集合
  - `Editor.execute()` 是唯一寫入口；`updateNode／updateEdge` 取代 `edit／setProp`；`node()／edge()` 走索引；`unprocessed／unreachable` 只看 `topologyRevision`；新 `layoutGraph` 供 3D 版面（改名不重建，spy 驗證）
  - `DetailPanel` 本地草稿（名稱、方向、屬性、新增屬性）＋「儲存」「取消變更」，不 bind 標準圖；`ContextMenu` 方向切換走命令；`GraphView` 改吃 `layoutGraph`
  - check 0、lint 綠、unit 104、e2e 57 全過（含新增「詳情草稿」）
- **Todo:** P3 起依 `revision`／`lastChange` 接搜尋；P4 起 2D `editVisible`／`stacks` 仍隨任何 graph 變更重算
- **Notes:** 切換選取會丟棄未儲存草稿（無提示）；報告 `.superpowers/sdd/plan/task-2-report.md`

## P1 代表性 10k 資料與量測基線（分支 cainmaila/main-3-3）

- **Goal:** 建立唯一 root、domain-valid、可重現的 10k 規模資料（20k／100k 邊）與 production 量測入口，記錄現況基線（不修效能、不改門檻）。計畫 `.superpowers/sdd/plan/task-1-brief.md`
- **Done（controller 已檢視 diff，独立通過 fixture/layout 46 tests、量測入口 13 e2e；基線效能未達標）:**
  - `scaleFixture()`（`src/lib/model/scale-fixture.ts`）：seed 化；10,000 節點，hub 度 1001、ToR 環（有向 cycle）、20 個孤立節點、同名不同 id、8 系統、雙向邊、props 各自獨立；`graphStats()` 算 N／E／最大度／連通塊
  - `/measure?edges=&seed=&init=` opt-in 量測頁：僅此路由掛 `window.__measure`（卸載即刪）；預設首頁仍是 mock（e2e 驗證）
  - `GraphView` 加選用 `probe`：`graph:init`、`layout:start`、`layout:worker-done`、`layout:ready`、`camera:interactive`；worker 改用共用 `runLayout`（init 預設仍 zero）
  - `pnpm measure:universe layout|browser`：Node 版面實驗（cpuprofile＋品質指標）與 Playwright 冷啟動（真實滑鼠拖曳／滾輪、搜尋、long task、heap、GPU 字串、截圖）
  - check 0、lint 綠、unit 52、build 綠、e2e 45 全過（既有 43［主頁 42＋demo 1］＋量測 2）
- **基線（M2、headless Chromium、真 Metal GPU、zero init、5 次冷啟）:** 20k 邊可操作相機 p50 11.56s、100k 10.86s（worker 版面 ~10–10.8s）；拖曳／滾輪 frame p95 ~16.7ms；heap(GC 後) 71／85MB；DOM 44.7k 元素。SwiftShader 軟體繪製拖曳 p95 433ms（不可用，不可與 GPU 數字混用）
- **版面實驗:** d3 初始位置比 zero 少首 tick 尖峰（~630→~100ms）、移除 ~450k 離群點、分布正常；但總時仍 ~9–10s，熱點是 many-body charge（非 link）
- **Todo:** P5 修冷啟動（≤2s 門檻目前未達）；搜尋 `slice(0,8)` 不完整；大綱一次渲染全部節點
- **QA 修正:** `3418931` 增加 fixture／URL 有限整數與規模驗證、補邊嘗試上限、量測逾時與程序清理；拒絕錯誤參數，不默默改成有效資料。
- **Notes:** 量測時工作樹未提交；d3 只跑 2 次、headed 1 次；layout cpuprofile 來自 Node 而非瀏覽器 worker。報告 `.superpowers/sdd/plan/task-1-report.md`，原始產物 `.superpowers/sdd/plan/artifacts/p1`（不 commit）

## P0 接回 v0.4 雙頁基線（分支 cainmaila/main-3-3）

- **Goal:** 把已提交的 v0.4 雙頁基線（`feat/v0.4-two-views` 5b59172）接進本分支，建立可重現的檢查基線；不宣稱符合新設計。計畫 `.superpowers/sdd/plan/task-0-brief.md`
- **Done（parent 已獨立 QA：check 0 錯、unit 35、e2e 42 全過；已檢視基線整合與測試遷移 diff）:**
  - merge `feat/v0.4-two-views`（fast-forward 47e087d→5b59172），`pnpm install --frozen-lockfile`（manifest 有變）
  - `playwright.config.ts` webServer 改 `pnpm build && pnpm preview`（仍跑 production build）
  - e2e 改成雙頁前置：以 `v04-two-views` 未提交 WIP 的 e2e 為底（逐項跑過才收），補 4 項前置修正（等編輯頁視野停下、取消加入時的選取、右鍵前先從大綱點選）；原全圖「A-02 命中 5 個」斷言補回
  - `GraphView.svelte` 加唯讀 e2e 掛勾 `nodeCount()`／`edgeCount()`（取自同一 WIP）
  - `.prettierignore` 排除 `.superpowers/`（git 已忽略的本機 SDD 檔讓 `pnpm lint` 失敗）
  - check 0 錯、lint 綠、unit 35、build 綠、e2e 42 項全過（連跑 2 次）
- **Todo:** P1 代表性資料與量測，後續依計畫；基線不等於新產品驗收通過
- **Notes（已知差距）:**
  - `v04-fix` 未提交 5 檔（編輯頁外節點唯讀、EdgeDialog 只列 working、GraphView 失敗處理／ready 前不飛、addNode 滿額擋下）**未帶入**，留給 P4／P5 依新設計處理
  - 原 2D 全圖測試的 ×42 疊卡、全圖淡化數、收疊卡片數 1,398 在 3D 全圖無 DOM 可驗，改在編輯頁用小集合驗同一行為
  - 情境 20（500 上限）e2e 逐一加入 500 個並驗第 501 個擋下；10k 效能、LOD、新搜尋未驗

## 上萬節點渲染實驗（spike，不合併 main）

- **Goal:** 實測 10k 節點下 Svelte Flow 優化／`force-graph`／Sigma.js，決定渲染方向；計畫 `~/.claude/plans/dom-fluttering-kazoo.md`
- **Done:** `bigMock.ts`（`bigMock()` 5 層 × 2,066 = 10,330 節點，spec 通過）
- **Todo（3 個 subagent 平行，各在 worktree）:** A `spike/svelteflow-opt`（量瓶頸＋優化）、B `spike/force-graph`、C `spike/sigma`；各回報同一組數字（載入、平移縮放 fps、點選回應、記憶體）
- **Done（三個 spike 已回報，已驗證 A、C 的 diff 與測試）:** 演算法 O(N·E)→鄰接表（`stacks` 10k 841→13.5ms、`layout` 3.5s→42ms，輸出一致）；Svelte Flow 10k 首次渲染仍 ~181s（響應式，dev profile 推測）；Sigma 渲染 <1ms/次；force-graph 整張縮小僅 8–9 fps
- **Done（已驗證）:** `$state.raw` 假設成立：同機對照，真實資料 5.56s→0.73s，10k 145s→3.6s（中位數 3.56s，3 次）；unit 28、e2e 39 全過、check 0 錯。分支 `spike/state-raw-local`（worktree `spike-state-raw`，commit b639cb6，未推送），結果 `spike/RESULTS-raw.md`
- **雲端 routine** `trig_01Uv1PtYQswZfjJpkDgpwvGt`：基準有出但「改後」量測卡住，判斷雲端除錯效率差，改本機做；該 run 無法從這邊中止，可能還會推 `spike/state-raw` 或 `claude/state-raw` 到公開 repo
- **Todo:** 量 10k 編輯操作與平移縮放 fps（subagent `aa6bdc880eccf7d31` 進行中，結果在 spike-state-raw 的 `spike/RESULTS-interact.md`）
- **Next:** 使用者決定：①把鄰接表＋`$state.raw` 帶回 main-3-2 ②是否加派 Pixi spike（使用者說先照規劃：雲端結果後再派）
- **待決:** `spike/svelteflow-opt` 已推到公開 repo（可事後刪遠端分支）；鄰接表修正是否帶回 main-3-2
- **Notes:** 懷疑 `graph.ts` `layout()` 的 `into`／`out` 每次掃全部邊（O(N·E)）才是 11 秒主因

## mock 改 2F 全棟機櫃（PRD v0.3）

- **Goal:** 取代 A 排 4 台的 mock，改成 2F 16 排 327 台、共 2,066 節點（PRD §5）；計畫 `~/.claude/plans/users-cain-01-fet-tpkc-tpkc-fe-situatio-curious-nygaard.md`
- **Done（已驗證：unit 26 項、e2e 39 項、check／lint／build 全綠；e2e 全跑一次有 1 項在平行負載下失敗，單跑與重跑 4 次都過）:**
  - `mock.ts`：`ROWS` 表產生排、機櫃、PDU A／B、ToR、樓層 PDU、匯聚 Switch；`idcRows()` 給 `graphMock`（ToR→主機）與 `idcMock` 共用，A-01～A-04 維持原內容
  - 拿掉區域層：排掛 2F，Core 包含、空調箱冷卻改連 2F，通用節點改名「2F A 排監視與偵測範圍」
  - 測試：unit／e2e 數字照 PRD v0.3；e2e 因 2,066 張卡縮到最小也塞不進畫面，`pick` 改從大綱點選（置中），`playwright.config.ts` 拉長逾時並平行跑
  - 實測：載入到 1,398 張卡約 0.8 秒；關收疊展開到 2,066 張約 11 秒（慢）；只看空間 0.4 秒
- **Todo:** 回報 PD（見 Notes）；決定是否改 `stacks()`；效能若要處理，先看關收疊的 11 秒
- **Notes:**
  - **收疊與 PRD 不符：** `stacks()` 只看上游。機櫃上游＝排＋自己的 PDU A／B，ToR 上游＝機櫃＋AGG，彼此都不同，所以機櫃、ToR 一台都不收；實際只收 18 疊（16 排的機櫃 PDU、列 ×16、樓層 PDU ×16）。PRD §4／情境 1 寫「每排機櫃、ToR 各收成卡片」做不到。可選：改成只比「同系統的上游」（機櫃按排收、ToR 按排收）。預設卡片數 1,398
  - PRD §7 還留著「匯聚 1 台、ToR 4 台」（10-08），已被 v0.3 取代
  - 「區域」節點類型仍在 `config.ts`，新增節點選單還能選
  - 情境 12 操作 3 改驗 CAM-03（Core Switch-2 現在有 16 條下行邊，刪一條不會變未處理）

## 手測 6 項修正（分支 fix/manual-test-6）

- **Goal:** 修使用者手測 6 項；計畫 `~/.claude/plans/pasted-content-id-cc19-1-parallel-liskov.md`
- **Done（已驗證，e2e 38 項、unit 24 項、check／lint／build 全綠）:**
  - #1 `select()` 清 `hoverEdge`（詳情欄邊列卸載收不到 mouseleave）
  - #2 選取不再改排版：拿掉「選取中不收疊」、`reveal()` 不自動展開，收起的成員改亮疊卡；編輯圖時既有節點沿用位置（`graph.ts` `pin`），系統／收疊／展開變動或空白右鍵「重新排版」（`editor.relayout`）才整張重排
  - #3 `ViewSync` 一律走 `fitView`（排隊只留最後一次），系統 effect 有選取時不整圖入鏡
  - #4 大綱文字＋問題篩選無結果時說明並給「清除○○篩選」鈕
  - #5 承載邊預設 `hidden`，選取／滑過端點或在找客戶路徑上才畫；圖例補說明
  - #6 確認狀態改下拉（`config.ts` `CONFIRM_STATES`），新邊預設「推定」
  - Code review 10 項全修：編輯後新進疊卡的節點留在外面（`editor.loose`，重新排版清掉）；過期 expanded 清除不觸發重排；反向邊改依排版層級判斷；ViewSync 系統 effect 排在視野請求前、拿掉選取守門；確認狀態不合法時提示；大綱只有問題篩選造成空結果才怪它；「重新排版」順便入鏡、新圖示
  - e2e 39 項、unit 26 項全過
  - UI 用詞「到不了客戶」改「無客戶路徑」（PRD 定義名稱未改，需與 PM 對齊）
  - 手測回饋 2 項：主機↔機框包含／承載在 `Canvas.svelte` 合併成一條雙向線（資料不動、只限主機）；「無客戶路徑」集中到 `config.ts` `UNREACHABLE_LABEL`。e2e 39 項、unit 26 項、check／lint 全過
- **Todo:** 使用者手測（照 測試案例.md 47 項跑一遍）；合併 PR #5 後刪除本任務
- **Notes:** 建邊後節點留在原欄，可能有往左擺的卡片，要「重新排版」才整齊；在詳情欄直接改邊類型（bind）不經 `#keepOut`，可能讓卡片收進疊卡

## 節點編輯器 POC（PRD v0.2）

- **Goal:** PRD §6 情境 1–18 全部通過。計畫：`~/.claude/plans/users-cain-01-fet-tpkc-tpkc-pd-docs-doc-fizzy-honey.md`
- **Done（已驗證）:**
  - model：`src/lib/model/`（config、mock、graph.ts）＋ unit test 16 項
  - UI：Svelte Flow 泳道圖、系統開關、聚焦、詳情編輯、新增節點/邊（表單＋拉線）、未處理清單、找客戶、到不了客戶標示、IDC 唯讀
  - e2e：`src/routes/page.svelte.e2e.ts` 情境 1–18 共 19 項全過
  - 通用節點不受連接限制（PRD 10-08 改版 §3、情境 10 操作 3）：`graph.ts` `matches`；unit＋e2e 已補
  - `pnpm check` / `lint` / `test:unit --run` / `build` 全綠
  - UI/UX 翻新（深色編輯器版面）：頂列系統膠囊（⌥＋點只看一個）、⌘K 搜尋、新增節點／邊改對話框（不合法邊類型事先停用並寫原因）、左右欄可收合可調寬（⌘B／⌘I／⌘. 專注）、檢查欄（未處理＋到不了客戶）、檢視器空狀態＋快捷鍵、刪節點確認、找客戶橫幅＋路徑動畫
  - 泳道改單欄（整張圖縮放後讀得到字）
  - UX 第二輪（滑鼠優先）：圖標化頂列／檢視器／檢查欄（`Icon.svelte`）；右鍵選單 `ContextMenu.svelte`（節點、邊、泳道、空白；子選單 hover 展開、停用原因、刪節點二次確認）；整張卡片拖曳即連線（目標綠／紅框，放開跳邊類型選單；拖到空白可新增節點並連線）；hover 節點浮動工具列＋鄰居淡亮；邊 hover 顯示類型
  - 排版改由左往右分層（上游在左、客戶在最右欄、同層平行節點同一欄）；拿掉泳道，系統改用顏色＋卡片圖示區分（使用者 10-08 同意，3D 不做）
  - 左欄改「大綱」（UX 研究員建議＋使用者同意 10-08）：`OutlinePanel.svelte` 篩選框、⚠／⛓ 問題篩選鈕、依系統分組節點清單（點＝定位、滑過＝畫布亮、👁 開關系統、⌥ 只看）；圖例移到畫布左下 `?` 卡（`Legend.svelte`，? 鍵）；左欄收合時有問題亮點；ChecksPanel 刪除
  - 反向邊（承載）改由左畫到右、箭頭在起點，走卡片下緣 back 把手不和包含重疊；大綱篩選時畫布淡化未命中節點（`editor.matched`，左欄收合時不淡化）
  - 同類兄弟節點收疊（`graph.ts` `stacks`／`collapse`）：同類型＋上游完全相同（略過承載）≥3 個收成一張「類型 ×N」疊卡，預設收起；點卡或合併邊展開、大綱／搜尋定位成員自動展開、右鍵成員「收疊同類」、頂列開關。mock 只有機櫃 PDU ×8 符合（機櫃、ToR 上游各不同）
  - code review 10 項全修（PR #1–#3）：疊卡邊界、雙擊疊卡、大綱自動展開分組、過期 expanded 清除、stacks 線性化、圖例卡限寬
  - e2e 33 項、unit 23 項全過
- **Todo:**
  - 大綱是平清單，未依包含關係縮排
  - 邊 hover 顯示「推定」
  - 瀏覽器手測：通用節點任意連線；圖例卡限寬（PR #3）後在小視窗是否仍與 Controls／MiniMap 重疊（只依 CSS 推算，未目視）
  - `expanded` 過期 key 清除（PR #2）沒有專屬測試
- **Next:** 使用者討論
- **Notes:**
  - 已偏離 PRD §4「每個系統一欄」（PRD 寫試行）：情境 1 改驗系統開關＋卡片系統圖示、情境 2 改驗由左往右、情境 8 改驗卡片為 CCTV；需與 PM 對齊
  - 情境 2「只勾空間 8 節點 7 邊」與「通用節點永遠顯示」衝突：實作為 9 節點 9 邊（含通用節點與它連到機櫃 A-01、A-02 的 2 條），待 PM 確認
  - 拖曳放開後不直接建邊，跳就地選單選邊類型；鍵盤 E 仍走對話框
  - e2e beforeEach 先關掉收疊，PRD 情境照 44 節點驗；收疊另有專屬測試
  - e2e 狀態改以節點卡上的圖示（role=img「未處理」「到不了客戶」）判斷
  - e2e 改了操作步驟、沒改斷言：新增改走對話框；情境 10 改驗「事先停用＋原因」；情境 12 刪節點多一步確認、機櫃 A-01 改驗停用＋原因
