# PROGRESS

## 節點編輯器 POC（PRD v0.2）

- **Goal:** PRD §6 情境 1–18 全部通過。計畫：`~/.claude/plans/users-cain-01-fet-tpkc-tpkc-pd-docs-doc-fizzy-honey.md`
- **Done（已驗證）:**
  - model：`src/lib/model/`（config、mock、graph.ts）＋ unit test 16 項
  - UI：Svelte Flow 泳道圖、系統開關、聚焦、詳情編輯、新增節點/邊（表單＋拉線）、未處理清單、找客戶、到不了客戶標示、IDC 唯讀
  - e2e：`src/routes/page.svelte.e2e.ts` 情境 1–18 共 19 項全過
  - `pnpm check` / `lint` / `test:unit --run` / `build` 全綠
- **Todo:** 等使用者審閱，依回饋調整
- **Next:** 使用者討論
- **Notes:**
  - 情境 2「只勾空間 8 節點 7 邊」與「通用節點永遠顯示」衝突：實作為 9 節點 9 邊（含通用節點與它連到機櫃 A-01、A-02 的 2 條），待 PM 確認
  - 拉線後不直接建邊，帶入「新增邊」表單選邊類型再建立
  - 預設整張圖縮得小（8 欄很寬），需手動縮放看細節
