# Svelte Flow 10k 效能實驗 — 結果（spike/svelteflow-opt）

## 量測環境與限制
- 所有瀏覽器數字：`vite build` 後 `vite preview` 的 production 版，headless Chromium（Playwright），1600×960。
- 純函式數字：Vitest（node），`stacks`／`collapse`／`layout` 等取 3 次中位數（`RUNS`）。
- 真實資料（2,066）瀏覽器量測 n=1；10k 只有一次完整載入的 CPU profile／probe，未做多次重複。

## 1. 純函式（ms，中位數）— `spike/results/bench-before.json` vs `bench-after.json`

| 函式 | real 2,066 原 | real 2,066 新 | bigMock 10k 原 | bigMock 10k 新 |
|---|---:|---:|---:|---:|
| `stacks` | 99.5 | 4.8 | 841 | 13.5 |
| `collapse`（收疊） | 2.6 | 8.1* | 9.0 | 7.3 |
| `layout`（收疊後 view） | 252.7 | 12.1 | 1,970 | 23.0 |
| `layout`（全展開） | 141.3 | 12.2 | 3,513 | 41.6 |
| `unprocessed` | 75 | 2.2 | 3.8 | 23.7** |
| `unreachable` | 46 | 2.4 | 1,116 | 5.3 |

\* 同量級雜訊（2.6 vs 8.1 單次 3 回中位數，未再細查）。
\** 新版對 bigMock 變慢：原版只走根節點可達的部分；新版先為所有邊建索引。仍遠小於 16ms 以外的預算問題，但是 tradeoff。

Equivalence: 優化前後 `stacks`、`collapse`、`layout` 座標、`unprocessed`、`unreachable`、`findCustomers`（抽樣）在 real 與 bigMock 完全相同（`graph.orig.ts` 為 HEAD 副本，已通過）。

## 2. 瀏覽器（production build，headless Chromium）

| 指標 | real 2,066 原 | real 2,066 新 | bigMock 10k 新 |
|---|---:|---:|---:|
| 首個節點進 DOM | 9,433 ms | 5,675 ms | ~181,000 ms（一個 long task） |
| 穩定（fitView 結束） | 9,438 ms | 5,688 ms | 未量 |
| DOM 節點數（收疊後） | 1,398 | 1,398 | 6,990 |
| 滾輪縮放 frame p95 | 16.7 ms | 16.8 ms | 未量 |
| 平移 frame p95 | 16.7 ms | 16.8 ms | 未量 |
| 滑過節點 frame p95 | 16.8 ms | 16.8 ms | 未量 |
| Heap idle | 165 MB | 177 MB | 未量 |

- 10k 有 6,990 個 DOM 節點，但首次渲染耗 ~181s；CPU profile（dev 版，數字已作廢，僅留意方向）顯示熱點在 Svelte runtime `is_dirty`，即響應式相依追蹤，不是 xyflow 的 DOM 操作。production 版未做 profile（時間不足）。
- 2,066 的互動在本次量測下都是 60fps 等級，DOM 不是瓶頸；瓶頸是初始化路徑。

## 3. 做了什麼（commit 內）
- `graph.ts`：`incident` 鄰接索引給 `walk`／`unprocessed`；`stacks` 鄰居集合（原本每個成員掃全部邊）；`layout` 的 `into`／`out` 改預先建的 Map（原本每次呼叫掃全部邊）；`collapse` 節點查表改 Map（原本每個堆疊 `find`）；`isCustomer` 直接比型別。
- spike 專用：`editor.svelte.ts` 的 `?big=1`（`bigMock()`）與 `?nostack=1`；`src/routes/+page.ts` 關 SSR。這些不應合併回 main。
- 沒有做：`$state.raw`、LOD、`onlyRenderVisibleElements`、GraphNode 精簡。

## 結論（verdict）
**Svelte Flow 在 10k 上「目前不可行」，但原因不在 DOM 渲染，而在 Svelte 響應式與資料計算。**
- 純演算法修正把 real 2,066 首次渲染從 9.4s 降到 5.7s，把 10k 的排版／收疊計算從約 5–6s 降到 <100ms（`layout` 等）。
- 剩下的 181s 幾乎全部在 Svelte runtime（`is_dirty`），疑似 `nodes`／`edges` 的 `$derived` 在 10k 上一次重算並通知大量相依。這是下一步要優先驗證的（`$state.raw`、把 nodes/edges 的 `$derived` 拆細、或改用 xyflow 的 `$state.raw` 注入）。
- 2,066 的互動本身已經流暢，所以目前不需要換渲染器才能滿足 real 資料。若 10k 目標不變，**需要先解掉初始化的響應式成本，再重新量**；在那之前 Svelte Flow 不算通過。

## 未量／未驗證
- 10k 的互動（滾輪、平移、滑過）未量：首次渲染都要 3 分鐘，無法在時限內做互動量測。
- 10k 的 production CPU profile 未做（只有 dev 版，已作廢）。
- 未跑 `pnpm check`、`pnpm lint`、`pnpm build` 全套（只跑了 graph.spec，20/20 通過；build 有通過）。
- `unprocessed` 在 bigMock 變慢（3.8→23.7ms）未修。
