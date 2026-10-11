# PROGRESS

## 試用回饋 10-11（PRD v0.5，分支 cainmaila/main-3-3）

- **Goal:** 處理試用回饋；計畫 `~/.claude/plans/lod-lod-ticklish-duckling.md`
- **Done（已驗證：check／lint 綠、unit 350、e2e 94 全過、build 過；Chrome 實操編輯頁）:**
  - 類型「列」→「排」；供電終點不限（PDU→ToR 可建）
  - 編輯頁：`pin()` 加了節點又讓既有卡片換欄就整張重排 → 上游在左（只加邊不重排）
  - 流向：編輯頁選取節點的相連邊流動虛線（反向邊倒播）；全圖高亮邊加 GPU 流動光點（每邊 3 顆，最多 6,000；reduced-motion 停住）
  - 邊類型標籤（只標亮起的邊）；新增邊選單編輯頁節點優先（搜尋 `first`）；「工作區」→「編輯頁」；找客戶亮起節點不受標籤最小尺寸限制；xyflow Controls 中文；對話框 `max-h-[86vh]` 可捲
- **Notes:** 邊標籤全部常駐時平移 p95 33.4ms（超預算 33.3），改只標亮起的邊後 16.8；推定虛線（5 4）流動每 0.5 秒跳 1px 未處理；reduced-motion 未目視驗證；500 節點壓力未重跑

## 3D 宇宙：全圖連線常駐＋視覺質感（分支 cainmaila/main-3-3）

- **Goal:** 連線不走 LOD（遠景就看得到關係網）、文字維持 LOD；視覺達 awwwards 等級。計畫 `~/.claude/plans/lod-lod-ticklish-duckling.md`
- **Done（已驗證：check／lint 綠、unit 348、e2e 94 全過、build 過）:**
  - `renderer.ts`：全圖連線層 `baseLines`（端點系統色漸層、疊加混色、邊越多越淡，只在可見子圖改變時重配）；聚焦時整層退到 0.04
  - 遠景點改柔光核心＋光暈（疊加混色）；detail 球改不打光；星塵背景；標籤細框
  - `GraphView.svelte`：UnrealBloom＋OutputPass；背景 `#05070f` 改走 `scene.background`（透過 composer 時 clear color 會被二次編碼成灰）；軟體 GL（SwiftShader，headless 測試）略過 bloom，否則 GraphView 元件測試慢 3 倍逾時
  - 實機 M2：10k 節點／100k 邊，拖曳／滾輪／拉近 p95 17.7ms
  - 根節點 TPKC 大樓：layout 固定在原點（`layout-sim.ts` fx/fy/fz）、核心 3 倍、淺靛 `#c7d2fe`、雙環呼吸光環（畫面最小 32px）、名稱「ROOT」常駐不走 LOD；聚焦時光環 0.25、名稱 .35
  - 冷色系：電力紫 `#c084fc`、消防青綠 `#2dd4bf`、CCTV 洋紅 `#e879f9`；邊 供電紫、監測青綠；「示意」徽章改 slate。紅／橘／黃只留給告警語意（未處理、無客戶路徑、刪除、錯誤）
- **Todo:** 使用者看過視覺後再調
- **Notes:** 未做：idle 自轉、高亮邊流動光點、fog（自轉會讓 e2e／量測相機不穩定）；背景有極淡的 bloom 色階帶

## P8 端到端與效能驗收、文件收斂（分支 cainmaila/main-3-3）

- **Goal:** 在真 GPU 上實跑正式效能矩陣、補殘留情境 e2e、README 收斂；計畫 `.superpowers/sdd/plan/task-8-brief.md`，報告 `task-8-report.md`，產物 `artifacts/p8`
- **Status:** fix round 2 完成（agent-tested），**待 parent QA**（P0–P7 已交付、已自本檔移除）
- **Done:**
  - `scripts/measure-p8.ts`：formal／workspace／stability／stress／selftest，頁內事件→畫出延遲、真滑鼠點選、PASS／FAIL 判定
  - 正式 10k／20k、10k／100k 各 5 冷樣本全數 PASS（含 25／25 真點選）；50k／100k 壓力可操作
  - 穩定性改版（`ea9217d`）：預設 200 輪、`--name-input fill|assign`、`--snapshots on|off`；量測本身有上限（`createMarkLog` 關 history 只留冷 marker＋計數）；
    判定只比同相位（`stabilityTrend`），document 外節點成長以 heap snapshot 歸因。200 輪 20k（`artifacts/p8/qa5`）：
    fill → heap PASS（late 0.036 MB/窗）、DOM ATTRIBUTED（+1/輪＝Chrome 原生 undo 堆疊，上限 1000）；assign 控制組 → 全 PASS
  - fix2：workspace 量測改在可讀縮放（真滾輪、容器內 hit-test，判定檢查 zoom 0.75–1.5／卡寬／字級，zoom 0.1 一律 FAIL）；
    舊 fix1 數字只在 zoom 0.1 成立。可讀縮放下 hover／選取逐條改 1,000 條邊樣式造成 GPU 重 raster（~350ms），
    改為邊容器整層暗化＋亮起副本（`FocusEdge.svelte`）後 3 樣本：平移／拉線 p95 16.8、提交 27.8、選單 55.9 全 PASS（`artifacts/p8/fix2`）
  - fix2：節點／邊刪除在詳情、右鍵、工具列、⌫ 一律確認（`requestDelete`／`confirmDelete`，圖換版即作廢）
- **Todo:** parent QA 與人工操作確認（全圖／工作集辨識、找到省略關係、移出≠刪除、可讀縮放下的亮起外觀）
- **Notes:** 500 節點壓力產物仍是 fix2 之前的；3D 正式矩陣未重跑（路徑未改）；
  PR #6 審查後：heap 判定未做 `--snapshots off` 對照（snapshot 在第 100 輪可能擾動 late 第一窗）；heap 門檻 0.05 MB/窗為刻意解析度下限，未調

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
