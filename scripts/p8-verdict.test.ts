import { describe, expect, it } from 'vitest';
import {
	ANALYSIS_PER_SAMPLE,
	judge,
	line,
	row,
	stabilityTrend,
	summarizeHeapSnapshot,
	workspaceVerdict,
	WORKSPACE_FORMAL,
	type JudgePlan,
	type JudgeSample,
	type WorkspaceSample
} from './p8-verdict.ts';

const mx = (v: number[]) => Math.max(...v);
const f = (p95: number) => ({ intervalMs: { p95 } });
const PLAN: JudgePlan = {
	nodes: 10_000,
	edges: 20_000,
	samples: 5,
	searches: 6,
	picks: 5,
	analysis: true
};

/** 一個完整、全部合格的 3D 樣本 */
function good(): JudgeSample {
	return {
		nodes: 10_000,
		edges: 20_000,
		cold: { operableAndSearchMs: 900, layoutDoneMs: 400 },
		searches: [
			...['A-01', 'B-02', 'C-03', 'D-04'].map((t) => ({
				text: t,
				ms: 40,
				total: 1,
				rows: 1,
				exactOnPage1: true
			})),
			{ text: 'Switch', ms: 60, total: 1200, rows: 50, exactOnPage1: null },
			{ text: 'UPS', ms: 50, total: 300, rows: 50, exactOnPage1: null }
		],
		picks: ['far', 'overlap', 'near', 'overlap', 'behind'].map((kind, i) => ({
			kind,
			target: `n${i}`,
			selected: `n${i}`,
			correct: true,
			ms: 30
		})),
		hub: { id: 'hub', selectMs: 50, drag: f(16.7), wheel: f(16.7) },
		analysis: { samples: Array.from({ length: ANALYSIS_PER_SAMPLE }, () => ({ ms: 200 })) },
		return3d: {
			samples: Array.from({ length: ANALYSIS_PER_SAMPLE }, () => ({
				ms: 120,
				workerStartsBefore: 1,
				workerStartsAfter: 1
			})),
			workerStartsBefore: 1,
			workerStartsAfter: 1
		},
		drag: f(16.7),
		wheel: f(16.7),
		consoleErrors: []
	};
}
const five = (patch?: (x: JudgeSample, k: number) => void) =>
	Array.from({ length: 5 }, (_, k) => {
		const x = good();
		patch?.(x, k);
		return x;
	});
const by = (rows: ReturnType<typeof judge>, m: string) => rows.find((r) => r.metric.startsWith(m))!;

describe('row', () => {
	it('非有限數值算失敗，不會被濾掉後用剩下的快數字 PASS', () => {
		const r = row('x', [10, NaN, 12], 3, 100, mx);
		expect(r.status).toBe('FAIL');
		expect(r.n).toBe(2);
		expect(r.problems.join()).toMatch(/1 sample\(s\) missing\/non-finite/);
	});
	it('筆數不足算失敗', () => {
		expect(row('x', [10, 12], 3, 100, mx).status).toBe('FAIL');
	});
	it('expected 0 且沒量 → SKIP（縮減觀察）；量了反而 FAIL', () => {
		expect(row('x', [], 0, 100, mx).status).toBe('SKIP');
		expect(row('x', [5], 0, 100, mx).status).toBe('FAIL');
	});
	it('全部有效且在門檻內 → PASS', () => {
		const r = row('x', [10, 20], 2, 20, mx);
		expect(r).toMatchObject({ status: 'PASS', pass: true, value: 20, n: 2, expected: 2 });
		expect(line(r)).toBe('PASS x: 20/20 (n=2/2)');
	});
});

describe('judge（3D formal／stress）', () => {
	it('完整樣本：30 搜尋、30 選取（25 點選＋5 hub）、5 冷啟動，全部 PASS', () => {
		const v = judge(five(), PLAN);
		expect(v.map((r) => r.status)).toEqual(v.map(() => 'PASS'));
		expect(by(v, 'search').expected).toBe(30);
		expect(by(v, 'selection').expected).toBe(30);
		expect(by(v, 'cold').expected).toBe(5);
		expect(by(v, 'browser analysis').expected).toBe(30);
		expect(by(v, 'return to 3D').expected).toBe(30);
	});
	it('搜尋逾時（NaN）→ 搜尋 FAIL', () => {
		const v = judge(
			five((x, k) => k === 2 && (x.searches[1].ms = NaN)),
			PLAN
		);
		expect(by(v, 'search').status).toBe('FAIL');
		expect(by(v, 'search').n).toBe(29);
	});
	it('搜尋很快但第一頁沒有那個名稱 → FAIL（不拿快數字掩蓋語意錯）', () => {
		const v = judge(
			five((x, k) => k === 0 && (x.searches[0].exactOnPage1 = false)),
			PLAN
		);
		expect(by(v, 'search').status).toBe('FAIL');
	});
	it('點選選錯或找不到目標 → 選取 FAIL；hub 選取逾時也 FAIL', () => {
		const wrong = judge(
			five((x, k) => {
				if (k === 1) Object.assign(x.picks[0], { selected: 'other', correct: false });
			}),
			PLAN
		);
		expect(by(wrong, 'selection').status).toBe('FAIL');
		const missing = judge(
			five((x, k) => {
				if (k === 1) x.picks[4] = { kind: 'behind', target: null, correct: false, ms: NaN };
			}),
			PLAN
		);
		expect(by(missing, 'selection').status).toBe('FAIL');
		const hub = judge(
			five((x, k) => k === 4 && (x.hub!.selectMs = NaN)),
			PLAN
		);
		expect(by(hub, 'selection').status).toBe('FAIL');
	});
	it('少一次點選（只記 4 次）→ FAIL', () => {
		const v = judge(
			five((x, k) => k === 3 && x.picks.pop()),
			PLAN
		);
		expect(by(v, 'selection').problems.join()).toMatch(/recorded 29 sample\(s\), expected 30/);
	});
	it('分析／回 3D 有一筆 NaN 或少一筆 → FAIL；worker 重啟 → FAIL', () => {
		expect(
			by(
				judge(
					five((x, k) => k === 0 && (x.analysis!.samples[3].ms = NaN)),
					PLAN
				),
				'browser analysis'
			).status
		).toBe('FAIL');
		expect(
			by(
				judge(
					five((x, k) => k === 0 && (x.analysis = null)),
					PLAN
				),
				'browser analysis'
			).status
		).toBe('FAIL');
		expect(
			by(
				judge(
					five((x, k) => k === 0 && (x.return3d!.samples[0].workerStartsAfter = 2)),
					PLAN
				),
				'return to 3D'
			).status
		).toBe('FAIL');
	});
	it('樣本數或規模不對 → 每一列都 FAIL', () => {
		const fewer = judge(five().slice(0, 4), PLAN);
		expect(fewer.every((r) => r.status === 'FAIL')).toBe(true);
		const scale = judge(
			five((x, k) => k === 0 && (x.edges = 19_000)),
			PLAN
		);
		expect(scale.every((r) => r.status === 'FAIL')).toBe(true);
	});
	it('frame 量不到（null）→ FAIL；console error → FAIL', () => {
		expect(
			by(
				judge(
					five((x, k) => k === 0 && (x.drag = null)),
					PLAN
				),
				'pointer rotation'
			).status
		).toBe('FAIL');
		expect(
			by(
				judge(
					five((x, k) => k === 0 && x.consoleErrors.push('boom')),
					PLAN
				),
				'console'
			).status
		).toBe('FAIL');
	});
	it('縮減觀察（不跑分析、2 次搜尋）：hub／分析／回 3D 標 SKIP，其餘照常判', () => {
		const plan = { ...PLAN, samples: 1, searches: 2, analysis: false };
		const x = good();
		x.searches = x.searches.slice(4);
		x.hub = null;
		x.analysis = null;
		x.return3d = null;
		const v = judge([x], plan);
		expect(by(v, 'hub').status).toBe('SKIP');
		expect(by(v, 'browser analysis').status).toBe('SKIP');
		expect(by(v, 'return to 3D').status).toBe('SKIP');
		expect(by(v, 'search').status).toBe('PASS');
		expect(by(v, 'selection').expected).toBe(5);
	});
});

describe('workspaceVerdict（2D 工作區）', () => {
	const ws = (k: number): WorkspaceSample => ({
		name: `s${k}`,
		admitted: true,
		ws: { nodes: 200, edges: 1000 },
		set: { nodes: 200, edges: 1000 },
		dom: { cards: 200, edges: 1000 },
		readable: { zoom: 0.86, cardPx: 138, namePx: 10.3, targets: 12 },
		problems: [],
		pan: Array.from({ length: 5 }, () => ({ frames: f(16.7), zoom: 0.86 })),
		connect: [0, 1, 2].map((i) => ({
			from: `a${i}`,
			to: `b${i}`,
			frames: f(16.8),
			menuMs: 40,
			pair: true,
			zoom: 0.86
		})),
		commits: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, ms: 50, zoom: 0.9 })),
		consoleErrors: []
	});
	const three = (patch?: (x: WorkspaceSample, k: number) => void) =>
		[0, 1, 2].map((k) => {
			const x = ws(k);
			patch?.(x, k);
			return x;
		});
	const wv = (xs: WorkspaceSample[]) => workspaceVerdict(xs, WORKSPACE_FORMAL);

	it('完整：15 平移、9 連線、30 提交、9 選單，全部 PASS', () => {
		const v = wv(three());
		expect(v.map((r) => r.status)).toEqual(v.map(() => 'PASS'));
		expect(v.map((r) => r.expected)).toEqual([15, 9, 30, 9, 1]);
	});
	it('提交逾時（NaN＋error）→ 提交 FAIL，不被濾掉', () => {
		const v = wv(
			three((x, k) => k === 1 && (x.commits![4] = { id: 'c4', ms: NaN, error: 'timeout' }))
		);
		expect(by(v, 'edit commit').status).toBe('FAIL');
		expect(by(v, 'edit commit').problems.join()).toMatch(/timeout/);
	});
	it('選單沒出現（NaN）或顯示別對卡片 → 選單 FAIL', () => {
		expect(
			by(wv(three((x, k) => k === 0 && (x.connect![2].menuMs = NaN))), 'connection release').status
		).toBe('FAIL');
		expect(
			by(wv(three((x, k) => k === 2 && (x.connect![0].pair = false))), 'connection release').status
		).toBe('FAIL');
	});
	it('少一次連線／提交（例：找不到卡片就跳過）→ FAIL', () => {
		expect(by(wv(three((x, k) => k === 0 && x.connect!.pop())), '2D connection-drag').status).toBe(
			'FAIL'
		);
		expect(by(wv(three((x, k) => k === 0 && x.commits!.pop())), 'edit commit').status).toBe('FAIL');
		expect(by(wv(three((x, k) => k === 0 && x.pan!.pop())), '2D pan').status).toBe('FAIL');
	});
	it('沒有收進 200／1000（被拒或規模不同、畫出來不是 200／1000）→ 每列 FAIL', () => {
		for (const patch of [
			(x: WorkspaceSample) => (x.admitted = false),
			(x: WorkspaceSample) => (x.ws = { nodes: 200, edges: 999 }),
			(x: WorkspaceSample) => (x.set = { nodes: 199, edges: 1000 }),
			(x: WorkspaceSample) => (x.dom = { cards: 200, edges: 640 }),
			(x: WorkspaceSample) => (x.dom = null)
		]) {
			const v = wv(three((x, k) => k === 1 && patch(x)));
			expect(v.every((r) => r.status === 'FAIL')).toBe(true);
		}
	});
	it('只跑 2 個樣本 → FAIL', () => {
		expect(wv(three().slice(0, 2)).every((r) => r.status === 'FAIL')).toBe(true);
	});
	it('frame 超標仍 FAIL（33.4 > 33.3）', () => {
		const v = wv(three((x, k) => k === 0 && (x.connect![0].frames = f(33.4))));
		expect(by(v, '2D connection-drag')).toMatchObject({ status: 'FAIL', value: 33.4 });
	});
	it('縮放 0.1（整張入鏡、讀不到字）即使數字很快 → 每列 FAIL', () => {
		const v = wv(
			three((x) => {
				x.readable = { zoom: 0.1, cardPx: 16, namePx: 1.2, targets: 200 };
				for (const p of x.pan!) p.zoom = 0.1;
				for (const c of x.connect!) c.zoom = 0.1;
				for (const c of x.commits!) c.zoom = 0.1;
			})
		);
		expect(v.every((r) => r.status === 'FAIL')).toBe(true);
		expect(by(v, '2D pan').problems.join()).toMatch(/zoom 0\.1/);
	});
	it('沒記錄可讀縮放（舊產物）、卡片太窄、字太小、縮太大 → FAIL', () => {
		for (const patch of [
			(x: WorkspaceSample) => delete x.readable,
			(x: WorkspaceSample) => (x.readable!.cardPx = 100),
			(x: WorkspaceSample) => (x.readable!.namePx = 7),
			(x: WorkspaceSample) => (x.readable!.zoom = 1.8)
		])
			expect(wv(three((x, k) => k === 2 && patch(x))).every((r) => r.status === 'FAIL')).toBe(true);
	});
	it('任一操作不在可讀縮放（例：提交時被縮回去）→ FAIL', () => {
		const v = wv(three((x, k) => k === 1 && (x.commits![3].zoom = 0.5)));
		expect(v.every((r) => r.status === 'FAIL')).toBe(true);
		expect(by(v, 'edit commit').problems.join()).toMatch(/commit c3 at zoom 0\.5/);
	});
	it('harness 找不到可見卡片／平移點（problems）→ FAIL', () => {
		const v = wv(three((x, k) => k === 0 && x.problems!.push('only 1 in-pane target card(s)')));
		expect(v.every((r) => r.status === 'FAIL')).toBe(true);
		expect(by(v, '2D pan').readable).toEqual([0.86, 0.86, 0.86]);
	});
});

describe('stabilityTrend (same-phase, no linear growth)', () => {
	// 10 輪週期：相位 p 的 DOM／heap 基準不同（不同卡片面板大小），加上可選的每輪成長
	const mk = (
		n: number,
		heapAt: (c: number) => number,
		offPerCycle = 0,
		docAt: (c: number) => number = () => 0
	) =>
		Array.from({ length: n }, (_, i) => {
			const c = i + 1;
			const phase = c % 10;
			return {
				cycle: c,
				heapMB: heapAt(c) + phase * 0.1,
				docElements: 700 + phase * 30 + docAt(c),
				offDocNodes: 990 + offPerCycle * c
			};
		});

	it('plateau after warm-up → heap PASS, identical same-phase DOM → PASS', () => {
		const t = stabilityTrend(mk(60, (c) => 22 - 3 * Math.exp(-c / 8)));
		expect(t.windows).toBe(6);
		expect(t.heap.status).toBe('PASS');
		expect(t.dom.status).toBe('PASS');
		expect(t.docElementsSamePhaseDelta).toEqual({ min: 0, max: 0, n: 40 });
		expect(t.offDocSamePhaseDelta).toEqual({ min: 0, max: 0, n: 40 });
	});

	it('constant per-cycle growth (linear leak) → heap FAIL even if slope is below the old 0.1 MB/cycle gate', () => {
		const t = stabilityTrend(mk(60, (c) => 20 + 0.02 * c));
		expect(t.heap.status).toBe('FAIL');
		expect(t.tailMBPerCycle).toBeCloseTo(0.02, 5);
	});

	it('fewer than 4 windows → INCONCLUSIVE, not PASS', () => {
		const t = stabilityTrend(mk(30, () => 20));
		expect(t.heap.status).toBe('INCONCLUSIVE');
	});

	it('in-document element growth at the same phase → FAIL even if off-document is attributed', () => {
		const t = stabilityTrend(
			mk(
				40,
				() => 20,
				0,
				(c) => (c > 25 ? 1 : 0)
			),
			10,
			0
		);
		expect(t.dom.status).toBe('FAIL');
	});

	it('off-document +1/cycle: FAIL unless exactly matched by the snapshot-attributed source', () => {
		const rows = mk(40, () => 20, 1);
		expect(stabilityTrend(rows).dom.status).toBe('FAIL');
		expect(stabilityTrend(rows, 10, 1).dom.status).toBe('ATTRIBUTED');
		expect(
			stabilityTrend(
				mk(40, () => 20, 2),
				10,
				1
			).dom.status
		).toBe('FAIL');
	});
});

describe('summarizeHeapSnapshot', () => {
	it('counts named nodes, code bytes, detached and unknown-detachedness Text', () => {
		const snap = {
			snapshot: {
				meta: {
					node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
					node_types: [['hidden', 'object', 'native', 'code'] as string[]] as [string[]]
				}
			},
			strings: ['Text', 'PerformanceMark', 'x', '<div>'],
			nodes: [
				2,
				0,
				1,
				10,
				0,
				0, // Text det=0
				2,
				0,
				3,
				10,
				0,
				1, // Text attached
				2,
				1,
				5,
				20,
				0,
				0, // PerformanceMark
				3,
				2,
				7,
				100,
				0,
				0, // code
				2,
				3,
				9,
				5,
				0,
				2 // detached div
			]
		};
		expect(summarizeHeapSnapshot(snap, ['PerformanceMark', 'blink::UndoStep'])).toEqual({
			totalSelfBytes: 145,
			codeBytes: 100,
			detached: 1,
			textUnknown: 1,
			counts: { PerformanceMark: 1, 'blink::UndoStep': 0 }
		});
	});
});
