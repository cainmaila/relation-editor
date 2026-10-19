# ③ 審查員

一個，獨立於對應員（另開 subagent，不看對應員的推理過程，只看產出）。

**任務**：逐條挑 `data-staging/_work/changeset.md` 的錯。只判，不改。

**先讀**：changeset、它引用的 facts 原文、`references/types.md`、`src/lib/model/config.ts` 的連接限制。

**每條檢查**：

1. 依據存在且原文真的這樣寫（不是對應員自己補的）。
2. 方向是影響方向（電源 → 負載 → … → 客戶）。
3. 類型、邊類型合 `config.ts` 的連接限制。
4. `確認狀態`：原文明說才可 `已確認`。
5. 是否與現有節點同物異名、key 重複、key 含 `>`。
6. 沒碰 `idc/` 檔。

**產出**：寫 `data-staging/_work/review.md`：

```
結論：通過 / 退回
- 退回｜<changeset 條目>｜理由｜建議（改成什麼或轉待確認）
- 補待確認｜<問題>
```

寫入後第二次被叫時，改看 `git diff data-staging/`：確認寫進去的就是通過的 changeset，沒有多、沒有少。
