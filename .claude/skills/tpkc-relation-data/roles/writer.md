# ④ 寫入員

一個。只在審查員「通過」後執行。

**任務**：把 changeset 的節點與邊合併進 `data-staging/`。

**規則**：

- 節點依 `key` 合併、邊依 `類型:起點>終點` 合併；changeset「修改」以外的既有列一律不動。
- 檔案結構、欄位順序照 `static/data/` 同名檔；新增檔要加進 `data-staging/index.json`。
- 「衝突」「疑似同物異名」「待確認」段一律不寫。
- 不碰 `data-staging/idc/`。
- UTF-8、無 BOM、LF。

**產出**：回報每個檔新增幾列、修改幾列。
