// 效能實驗（spike）：量 stacks／collapse／layout 的耗時，結果寫到 spike/results/bench.json。
import { writeFileSync, mkdirSync } from 'node:fs';
import { expect, test } from 'vitest';
import { collapse, layout, stacks, unprocessed, unreachable } from './graph';
import * as ORIG from './graph.orig';
import { bigMock } from './bigMock';
import { graphMock, idcMock } from './mock';
import type { Graph } from './types';

const RUNS = Number(process.env.RUNS ?? 3);
/** 中位數（ms）：跑 RUNS 次取中間值，避免單次抖動 */
function time(fn: () => unknown): number {
	const ts: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const t0 = performance.now();
		fn();
		ts.push(performance.now() - t0);
	}
	ts.sort((a, b) => a - b);
	return Math.round(ts[Math.floor(RUNS / 2)] * 10) / 10;
}

function measure(name: string, g: Graph) {
	const reach = {
		unprocessedOrigMs: time(() => ORIG.unprocessed(g)),
		unprocessedNewMs: time(() => unprocessed(g)),
		unreachableOrigMs: time(() => ORIG.unreachable(g)),
		unreachableNewMs: time(() => unreachable(g))
	};
	const closed = stacks(g);
	const expandedAll = new Map<string, string[]>();
	const row = {
		name,
		nodes: g.nodes.length,
		edges: g.edges.length,
		stacks: closed.size,
		stackedMembers: [...closed.values()].reduce((s, ids) => s + ids.length, 0),
		/** 收疊（預設） */
		stacksMs: time(() => stacks(g)),
		stacksOrigMs: time(() => ORIG.stacks(g)),
		collapseMs: time(() => collapse(g, closed)),
		collapseOrigMs: time(() => ORIG.collapse(g, closed)),
		layoutCollapsedMs: 0,
		layoutOrigCollapsedMs: 0,
		/** 全部展開（收疊關掉）：畫布節點最多 */
		collapseExpandedMs: time(() => collapse(g, expandedAll)),
		layoutExpandedMs: 0
	};
	// layout 只量排版本身：先把 collapse 的結果備好
	const viewCollapsed = collapse(g, closed);
	const viewExpanded = collapse(g, expandedAll);
	row.layoutCollapsedMs = time(() => layout(viewCollapsed));
	row.layoutOrigCollapsedMs = time(() => ORIG.layout(viewCollapsed));
	row.layoutExpandedMs = time(() => layout(viewExpanded));
	return {
		...row,
		...reach,
		canvasNodesCollapsed: viewCollapsed.nodes.length,
		canvasNodesExpanded: viewExpanded.nodes.length
	};
}

test('bench stacks / collapse / layout', () => {
	const real: Graph = {
		nodes: [...graphMock().nodes, ...idcMock().nodes],
		edges: [...graphMock().edges, ...idcMock().edges]
	};
	const results = [measure('real 2066', real), measure('bigMock 10k', bigMock())];
	console.table(results);
	mkdirSync('spike/results', { recursive: true });
	writeFileSync(
		process.env.BENCH_OUT ?? 'spike/results/bench.json',
		JSON.stringify(results, null, 2)
	);
	expect(results[1].nodes).toBeGreaterThan(10000);
}, 300_000);
