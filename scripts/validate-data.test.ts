// 驗證一個資料目錄：DATA_DIR=data-staging pnpm vitest run scripts/validate-data.test.ts
// 沒設 DATA_DIR 就略過，不影響一般 unit 測試。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/lib/model/csv';
import { buildGraphIndex } from '../src/lib/model/graph-index';
import { unprocessed, unreachable, validateEdge } from '../src/lib/model/graph';

const dir = process.env.DATA_DIR;

describe.skipIf(!dir)('資料目錄驗證', () => {
	it('格式、key、端點、連接限制', () => {
		const paths: string[] = JSON.parse(readFileSync(join(dir!, 'index.json'), 'utf8'));
		const g = buildGraph(paths.map((p) => [p, readFileSync(join(dir!, p), 'utf8')]));
		// 用沒有邊的圖檢查，避免邊自己被當成「已有這條邊」
		const bare = { nodes: g.nodes, edges: [] };
		const idx = buildGraphIndex(bare);
		const errors = g.edges
			.filter((e) => !e.readonly)
			.map((e) => [e, validateEdge(bare, e.from, e.to, e.type, idx)] as const)
			.filter(([, msg]) => msg)
			.map(([e, msg]) => `${e.type}:${e.from}>${e.to}：${msg}`);
		const full = buildGraphIndex(g);
		console.log(
			`節點 ${g.nodes.length}、邊 ${g.edges.length}；未處理 ${unprocessed(g, full).size}；無客戶路徑 ${unreachable(g, full).size}`
		);
		expect(errors).toEqual([]);
	});
});
