# 教訓與來源怪癖

一條一行：`日期｜現象｜怎麼處理`。

- 2026-10-16｜`buildGraph` 不檢查邊的連接限制（只驗格式、key、端點）｜用 `scripts/validate-data.test.ts`，它另外跑 `validateEdge`
- 2026-10-16｜邊 id 是 `類型:起點>終點`，key 含 `>` 可能撞 id｜key 避免用 `>`（PROGRESS.md 已記此待辦）
- 2026-10-19｜使用者說「新增」的東西常已存在｜對應員一律先 grep 現有 key（含去掉類型前綴比對）再判斷新增
- 2026-10-19｜現有樓層 PDU 字尾＝排（2F-A 供 A 排兩路），不是路別｜來源講「A 路／B 路」時別直接對到 PDU 字尾，先問
- 2026-10-19｜抽取員用 Explore 型不能寫檔｜已改 roles/extractor.md 用 general-purpose
