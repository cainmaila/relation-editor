import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
	LOD,
	buildAdjacency,
	buildGrid,
	computeFrame,
	labelWidth,
	makeView,
	pick,
	pickRay,
	project,
	type FrameInput,
	type LodState,
	type View
} from './lod';

const W = 800;
const H = 600;

/** 真的 three 相機 → 純數值 View（與 renderer 同一條路徑） */
function cam(eye: [number, number, number], at: [number, number, number] = [0, 0, 0]): View {
	const c = new THREE.PerspectiveCamera(70, W / H, 0.1, 1e5);
	c.position.set(...eye);
	c.lookAt(...at);
	c.updateMatrixWorld();
	c.updateProjectionMatrix();
	return makeView(c.projectionMatrix.elements, c.matrixWorldInverse.elements, eye, W, H);
}

type G = {
	ids: string[];
	positions: Float32Array;
	edges: [number, number][];
};

function graph(points: [number, number, number][], edges: [number, number][] = []): G {
	return {
		ids: points.map((_, i) => `n${i}`),
		positions: new Float32Array(points.flat()),
		edges
	};
}

/** 規則格點：n×n×n，間距 s，以原點為中心 */
function lattice(n: number, s: number): G {
	const pts: [number, number, number][] = [];
	const o = ((n - 1) * s) / 2;
	for (let x = 0; x < n; x++)
		for (let y = 0; y < n; y++)
			for (let z = 0; z < n; z++) pts.push([x * s - o, y * s - o, z * s - o]);
	return graph(pts);
}

function input(g: G, view: View, extra: Partial<FrameInput> = {}): FrameInput {
	const from = new Uint32Array(g.edges.map((e) => e[0]));
	const to = new Uint32Array(g.edges.map((e) => e[1]));
	return {
		ids: g.ids,
		positions: g.positions,
		grid: buildGrid(g.positions),
		visible: new Uint8Array(g.ids.length).fill(1),
		view,
		edges: {
			ids: g.edges.map((_, i) => `e${i}`),
			from,
			to,
			adjacency: buildAdjacency(g.ids.length, from, to)
		},
		selected: -1,
		hover: -1,
		focus: [],
		highlight: [],
		highlightTotal: 0,
		labelWidth: () => 60,
		labels: 'full',
		...extra
	};
}

const run = (i: FrameInput, prev?: LodState) => computeFrame(i, prev);

describe('LOD config', () => {
	it('門檻與預算是規格的精確值', () => {
		expect(LOD).toMatchObject({
			detailEnterPx: 6,
			detailExitPx: 4,
			maxDetail: 1000,
			maxLocalEdges: 2000,
			maxHighlightEdges: 2000,
			maxLabels: 80
		});
	});
});

describe('project', () => {
	it('相機正前方投影到畫面中央，像素半徑隨深度反比', () => {
		const v = cam([0, 0, 100]);
		const p = project(v, 0, 0, 0)!;
		expect(p.x).toBeCloseTo(W / 2);
		expect(p.y).toBeCloseTo(H / 2);
		expect(p.depth).toBeCloseTo(100);
		const q = project(v, 0, 0, 50)!;
		expect(q.depth).toBeCloseTo(50);
		expect((LOD.nodeRadius * v.focal) / q.depth).toBeCloseTo(
			((LOD.nodeRadius * v.focal) / p.depth) * 2
		);
	});
	it('相機背後回傳 null', () => {
		expect(project(cam([0, 0, 100]), 0, 0, 200)).toBeNull();
	});
});

describe('detail 近遠門檻與 hysteresis（每個節點的投影半徑，不看圖心距離）', () => {
	// 單點在正前方：半徑 px = R*focal/depth；以深度控制 px
	const at = (px: number, v: View) => (LOD.nodeRadius * v.focal) / px;
	const v0 = cam([0, 0, 0], [0, 0, -1]);
	const single = (px: number) => graph([[0, 0, -at(px, v0)]]);

	it('≥ 6px 進入、< 6px 不進入', () => {
		expect(run(input(single(6.2), v0)).detailNodeIds).toEqual(['n0']);
		expect(run(input(single(5.8), v0)).detailNodeIds).toEqual([]);
	});

	it('已是 detail 時要降到 < 4px 才退出', () => {
		const prev = run(input(single(7), v0)).state;
		expect(run(input(single(5), v0), prev).detailNodeIds).toEqual(['n0']);
		expect(run(input(single(4.2), v0), prev).detailNodeIds).toEqual(['n0']);
		expect(run(input(single(3.8), v0), prev).detailNodeIds).toEqual([]);
	});

	it('遠處有一群點但相機前的一個點夠大：只有那個點進 detail（不是看到圖心的距離）', () => {
		const pts: [number, number, number][] = [[0, 0, -at(10, v0)]];
		for (let i = 0; i < 200; i++) pts.push([i - 100, 0, -5000]);
		const f = run(input(graph(pts), v0));
		expect(f.detailNodeIds).toEqual(['n0']);
		expect(f.stats.baseNodes).toBe(200);
	});
});

describe('視錐與背面排除', () => {
	it('相機背後、畫面外、隱藏系統的點不進 detail', () => {
		const v = cam([0, 0, 0], [0, 0, -1]);
		const g = graph([
			[0, 0, -20], // 前方、夠大
			[0, 0, 20], // 背後
			[500, 0, -20], // 畫面外
			[1, 1, -20] // 前方但隱藏
		]);
		const vis = new Uint8Array([1, 1, 1, 0]);
		const f = run(input(g, v, { visible: vis }));
		expect(f.detailNodeIds).toEqual(['n0']);
		expect(f.stats.visibleNodes).toBe(3);
	});
});

describe('預算', () => {
	it('detail ≤ 1000、local edges ≤ 2000 且兩端都是 detail、labels ≤ 80', () => {
		// 16³ = 4096 點都很近；邊：每點連 +x、+y 鄰居 → 遠多於 2000
		const g = lattice(16, 3);
		const n = 16;
		const id = (x: number, y: number, z: number) => x * n * n + y * n + z;
		for (let x = 0; x < n; x++)
			for (let y = 0; y < n; y++)
				for (let z = 0; z < n; z++) {
					if (x + 1 < n) g.edges.push([id(x, y, z), id(x + 1, y, z)]);
					if (y + 1 < n) g.edges.push([id(x, y, z), id(x, y + 1, z)]);
				}
		const v = cam([0, 0, 60]);
		const frame = run(input(g, v));
		expect(frame.detailNodeIds.length).toBeLessThanOrEqual(1000);
		expect(frame.detailNodeIds.length).toBe(1000);
		expect(frame.stats.detailOmitted).toBeGreaterThan(0);
		expect(frame.localEdgeIds.length).toBeLessThanOrEqual(2000);
		expect(frame.labels.length).toBeLessThanOrEqual(80);
		const detail = new Set(frame.detailNodeIds);
		for (const e of frame.localEdgeIds) {
			const k = Number(e.slice(1));
			expect(detail.has(g.ids[g.edges[k][0]]) && detail.has(g.ids[g.edges[k][1]])).toBe(true);
		}
		expect(frame.stats.localEdgesOmitted).toBe(
			frame.stats.localEdgesEligible - frame.localEdgeIds.length
		);
		// base 不重畫已升級的點
		expect(frame.stats.baseNodes + frame.detailNodeIds.length).toBe(g.ids.length);
	});

	it('highlight 邊 ≤ 2000，總數／已畫／省略誠實', () => {
		const g = lattice(13, 3);
		for (let i = 0; i + 1 < g.ids.length; i++) g.edges.push([i, i + 1]);
		const hl = g.edges.map((_, i) => i);
		const f = run(input(g, cam([0, 0, 200]), { highlight: hl, highlightTotal: hl.length + 5 }));
		expect(f.highlightEdgeIds.length).toBe(2000);
		expect(f.stats).toMatchObject({
			highlightTotal: hl.length + 5,
			highlightVisible: hl.length,
			highlightDrawn: 2000,
			highlightOmitted: hl.length - 2000,
			highlightHidden: 5
		});
	});
});

describe('選取優先（佔用同一個 detail 預算，不另開無上限池）', () => {
	it('選取節點即使低於門檻也是 marker，且有標籤', () => {
		const v = cam([0, 0, 0], [0, 0, -1]);
		const g = graph([[0, 0, -3000]]);
		const f = run(input(g, v, { selected: 0 }));
		expect(f.detailNodeIds).toEqual(['n0']);
		expect(f.labels.map((l) => l.id)).toEqual(['n0']);
	});

	it('預算滿時選取／高亮優先、總數仍 ≤ 1000', () => {
		const g = lattice(16, 3);
		const far = g.ids.length - 1;
		const focus = Array.from({ length: 1500 }, (_, i) => i * 2);
		const f = run(input(g, cam([0, 0, 60]), { selected: far, focus }));
		expect(f.detailNodeIds.length).toBe(1000);
		expect(f.detailNodeIds[0]).toBe(g.ids[far]);
		const focusIds = new Set(focus.map((i) => g.ids[i]));
		expect(f.detailNodeIds.slice(1).every((id) => focusIds.has(id))).toBe(true);
		expect(f.labels[0].id).toBe(g.ids[far]);
	});

	it('遠景的高亮節點是 marker 但沒有標籤（只有選取／hover 可低於標籤門檻）', () => {
		const v = cam([0, 0, 0], [0, 0, -1]);
		const g = graph([
			[0, 0, -3000],
			[20, 0, -3000],
			[-20, 0, -3000]
		]);
		const f = run(input(g, v, { selected: 0, focus: [1, 2] }));
		expect(new Set(f.detailNodeIds)).toEqual(new Set(['n0', 'n1', 'n2']));
		expect(f.labels.map((l) => l.id)).toEqual(['n0']);
	});

	it('hover 的標籤優先於一般節點', () => {
		const g = lattice(6, 4);
		const f = run(input(g, cam([0, 0, 40]), { hover: 7 }));
		expect(f.labels[0].id).toBe('n7');
	});
});

describe('標籤：避碰、畫面內、穩定排序', () => {
	it('標籤框兩兩不重疊且都在畫面內', () => {
		const g = lattice(12, 3);
		const f = run(input(g, cam([0, 0, 50])));
		expect(f.labels.length).toBeGreaterThan(0);
		for (const a of f.labels) {
			expect(a.x).toBeGreaterThanOrEqual(0);
			expect(a.y).toBeGreaterThanOrEqual(0);
			expect(a.x + a.w).toBeLessThanOrEqual(W);
			expect(a.y + a.h).toBeLessThanOrEqual(H);
			for (const b of f.labels)
				if (a !== b)
					expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(
						false
					);
		}
		expect(f.stats.labelsOmitted).toBe(f.stats.labelCandidates - f.labels.length);
	});

	it('相同輸入結果相同；上一幀的標籤在同級中優先保留', () => {
		const g = lattice(12, 3);
		const v = cam([0, 0, 50]);
		const a = run(input(g, v));
		const b = run(input(g, v));
		expect(b.labels).toEqual(a.labels);
		const c = run(input(g, cam([0.5, 0.3, 50])), a.state);
		const keep = c.labels.filter((l) => a.labels.some((x) => x.id === l.id)).length;
		expect(keep).toBeGreaterThanOrEqual(Math.floor(a.labels.length * 0.8));
	});

	it('reproject 只更新既有標籤位置，不重選', () => {
		const g = lattice(8, 3);
		const a = run(input(g, cam([0, 0, 40])));
		const b = run(input(g, cam([1, 0, 40]), { labels: 'reproject' }), a.state);
		expect(b.labels.map((l) => l.id)).toEqual(a.labels.map((l) => l.id));
		expect(b.labels[0].x).not.toBe(a.labels[0].x);
	});

	it('labelWidth：中文較寬、有上限', () => {
		expect(labelWidth('機櫃機櫃')).toBeGreaterThan(labelWidth('abcd'));
		expect(labelWidth('機'.repeat(200))).toBe(LOD.labelMaxWidthPx);
	});
});

describe('點選', () => {
	const v = cam([0, 0, 100]);
	const at = (x: number, y: number, view = v) => {
		const r = pickRay(view, x, y);
		return (g: G, vis?: Uint8Array) =>
			pick({
				positions: g.positions,
				grid: buildGrid(g.positions),
				visible: vis ?? new Uint8Array(g.ids.length).fill(1),
				view,
				ray: r,
				x,
				y
			});
	};

	it('遠景點（非 detail）也點得到', () => {
		const g = graph([[0, 0, -2000]]);
		expect(run(input(g, v)).detailNodeIds).toEqual([]);
		const p = project(v, 0, 0, -2000)!;
		expect(at(p.x + 3, p.y)(g)).toBe(0);
	});

	it('重疊時選最近的正深度', () => {
		const g = graph([
			[0, 0, -500],
			[0, 0, 0],
			[0, 0, 50]
		]);
		expect(at(W / 2, H / 2)(g)).toBe(2);
	});

	it('相機背後的點不會被選到', () => {
		const behind = graph([
			[0, 0, 150],
			[0, 0, -200]
		]);
		// 正後方的點若誤用 |depth| 投影會落在中央
		expect(at(W / 2, H / 2)(behind)).toBe(1);
		expect(at(W / 2, H / 2)(graph([[0, 0, 150]]))).toBe(-1);
	});

	it('隱藏系統的點不可選', () => {
		const g = graph([
			[0, 0, 50],
			[0, 0, -50]
		]);
		expect(at(W / 2, H / 2)(g, new Uint8Array([0, 1]))).toBe(1);
	});

	it('空白處回 -1；超出容差不選', () => {
		const g = graph([[0, 0, 0]]);
		expect(at(W / 2 + LOD.pickTolerancePx + 20, H / 2)(g)).toBe(-1);
	});

	it('格網候選與暴力法一致', () => {
		const g = lattice(14, 7);
		const view = cam([30, 20, 120], [0, 0, 0]);
		const grid = buildGrid(g.positions);
		const vis = new Uint8Array(g.ids.length).fill(1);
		for (const [x, y] of [
			[400, 300],
			[123, 77],
			[700, 500],
			[402, 298]
		]) {
			let best = -1;
			let bd = Infinity;
			for (let i = 0; i < g.ids.length; i++) {
				const p = project(view, g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]);
				if (!p || p.x < 0 || p.y < 0 || p.x > W || p.y > H) continue;
				const r = Math.max(LOD.pickTolerancePx, (LOD.nodeRadius * view.focal) / p.depth);
				if (Math.hypot(p.x - x, p.y - y) <= r && p.depth < bd) [bd, best] = [p.depth, i];
			}
			expect(
				pick({ positions: g.positions, grid, visible: vis, view, ray: pickRay(view, x, y), x, y })
			).toBe(best);
		}
	});
});
