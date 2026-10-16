# 教訓與來源怪癖

一條一行：`日期｜現象｜怎麼處理`。

- 2026-10-16｜`buildGraph` 不檢查邊的連接限制（只驗格式、key、端點）｜用 `scripts/validate-data.test.ts`，它另外跑 `validateEdge`
- 2026-10-16｜邊 id 是 `類型:起點>終點`，key 含 `>` 可能撞 id｜key 避免用 `>`（PROGRESS.md 已記此待辦）
