# `$state.raw` 實驗結果（spike/state-raw，基於 spike/svelteflow-opt）

假設：`editor.svelte.ts` 的 `graph = $state<Graph>(...)`（深層 proxy）改成 `$state.raw` 可讓首次渲染快一個數量級。只改這個（無 onlyRenderVisibleElements／LOD／其他優化）。

## 量測

production build（`pnpm build` + `vite preview --port 4173`），headless Chromium 1194，視窗 1600×960，`spike/raw-bench.mjs`：
從 `page.goto`（waitUntil: commit）到第一個 `.svelte-flow__node` 出現的 wall-clock，300 s 逾時。每組 3 次。

| 資料集              |               前（中位數） |  後（中位數） | runs（前 → 後）                                  | 節點數（DOM） |
| ------------------- | -------------------------: | ------------: | ------------------------------------------------ | ------------: |
| `/`（2,066）        |                  12,074 ms |      2,948 ms | 14,515 / 12,041 / 12,074 → 2,788 / 2,948 / 3,161 |         1,398 |
| `/?big=1`（10,330） | **timeout（>300 s，3/3）** | **22,197 ms** | timeout×3 → 23,380 / 22,197 / 21,522             |         6,990 |

原始資料：`spike/results/raw-before.json`、`raw-after.json`。
**判定：假設成立**（10k 從 >300 s 降到 ~22 s，未達「<60 s 以外」的失敗門檻；2,066 也從 12 s 降到 3 s）。10k 前面的數字只能說 ">300 s"，因為我設的逾時是 300 s，沒有量到真正的值（先前紀錄是 ~181 s，本機比較慢）。

## 改了哪些 in-place 變更（`$state.raw` 下 in-place 不會通知，全部改成換新物件）

`src/lib/editor.svelte.ts`

- `addNode`：`graph.nodes.push(...)` → `this.graph = { ...graph, nodes: [...nodes, new] }`
- `addEdge`：`graph.edges.push(...)` → `this.graph = { ...graph, edges: [...edges, new] }`
- `deleteNode`：兩次 `graph.edges = …; graph.nodes = …` → 一次 `this.graph = { nodes, edges }`
- `deleteEdge`：`graph.edges = …` → `this.graph = { ...graph, edges }`
- 新增 `setProp(kind, id, key, value)`、`patch(kind, id, fields)` 兩個方法，用來取代元件裡直接改物件。

元件（原本靠深層 proxy 的 in-place 寫入）

- `DetailPanel.svelte`：節點名稱 `bind:value={node.name}` → `value` + `oninput` → `editor.patch`
- `DetailPanel.svelte`：邊方向 `edge.bidirectional = …` → `editor.patch`
- `DetailPanel.svelte`：屬性編輯 `bind:value={props[k]}`（select／input）與 `addProp` 的 `props[k] = v` → `editor.setProp`
- `ContextMenu.svelte`：`e.bidirectional = !e.bidirectional` → `editor.patch`

注意：第一輪我只 grep `graph.` 開頭的寫入，漏掉經由 `editor.node()/edge()` 取得的物件上的寫入；是 e2e 情境 11（改邊方向）失敗才發現，之後補上。沒有保證沒有其他遺漏（見未驗證）。

## 測試／檢查

- `pnpm check`：0 errors / 0 warnings。
- `pnpm test:unit --run`：6 files / 28 tests 通過（需把環境缺的 chromium headless shell 以 symlink 指向已安裝的 1194 版，只在容器內，未進 repo）。
- `pnpm exec playwright test`（完整 e2e，38 個）：第一次 37 通過、1 失敗（情境 11，上述漏掉的 `bidirectional` 寫入）；修正後跑 `-g 編輯`（含情境 11、共 25 個）全過。**修正後沒有重跑完整 38 個**（單次整套約 8.5 分鐘），其餘 13 個的結果是修正前那次的通過。
- `pnpm lint`：失敗，但全是既有問題（spike/ 檔案的 prettier 格式、`src/lib/model/graph.ts:9` 的 no-unused-expressions），與本次改動無關；本次改動的檔案 prettier／eslint 無新增錯誤。

## 未驗證

- 前／後效能量測是在補上 `patch`／`setProp` 之前的 build 上做的；這些只在編輯時執行，不在載入路徑，預期不影響數字，但沒有重量。
- 10k 前的真實時間（只知道 >300 s）。
- 10k 的互動（縮放、平移、滑過、編輯）、記憶體、穩定時間（fitView 結束）都沒量；「首個節點出現」不等於畫面可用。
- 10k 的編輯操作在 `$state.raw` 下每次都複製整個陣列（O(n)）與重算 `$derived`，未量成本。
- 有沒有其他 in-place 寫入沒找到：靠 grep 與 e2e 覆蓋，非型別強制（可考慮把 `Graph` 型別改 `readonly` 讓編譯器抓）。
- 沒有做 CPU profile 說明剩下 22 s 花在哪（假設成立，未走失敗分支）。
- 只在 headless Chromium／這台容器量；`?big=1` 與 `?nostack=1` 仍是 spike 專用，不應合併回 main。
