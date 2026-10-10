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
function cam(
	eye: [number, number, number],
	at: [number, number, number] = [0, 0, 0],
	{ w = W, h = H, far = 1e5 }: { w?: number; h?: number; far?: number } = {}
): View {
	const c = new THREE.PerspectiveCamera(70, w / h, 0.1, far);
	c.position.set(...eye);
	c.lookAt(...at);
	c.updateMatrixWorld();
	c.updateProjectionMatrix();
	return makeView(c.projectionMatrix.elements, c.matrixWorldInverse.elements, eye, w, h);
}

/** 兩兩不重疊且在畫面內 */
function expectNoOverlap(labels: { x: number; y: number; w: number; h: number }[], w = W, h = H) {
	for (const a of labels) {
		expect(a.x).toBeGreaterThanOrEqual(0);
		expect(a.y).toBeGreaterThanOrEqual(0);
		expect(a.x + a.w).toBeLessThanOrEqual(w);
		expect(a.y + a.h).toBeLessThanOrEqual(h);
		for (const b of labels)
			if (a !== b)
				expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(
					false
				);
	}
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
	it('遠平面之外回傳 null（與 near 一致）', () => {
		const v = cam([0, 0, 0], [0, 0, -1], { far: 1000 });
		expect(project(v, 0, 0, -990)).not.toBeNull();
		expect(project(v, 0, 0, -1010)).toBeNull();
	});
});

describe('格網候選以視深度（與投影一致）排除，不用歐氏距離', () => {
	const at = (px: number, v: View) => (LOD.nodeRadius * v.focal) / px;
	it('偏軸、上一幀已是 detail、4–6px：仍是 detail（hysteresis）', () => {
		const v = cam([0, 0, 0], [0, 0, -1]);
		const d = at(4.5, v);
		const g = graph([[0.8 * d, 0, -d]]); // 單點＝極小格子
		const p = project(v, 0.8 * d, 0, -d)!;
		expect(p.x).toBeLessThan(W);
		const prev: LodState = { detail: new Set([0]), labels: [], sides: new Map() };
		expect(run(input(g, v), prev).detailNodeIds).toEqual(['n0']);
	});
	it('寬畫面偏軸 ≥ 6px：進入 detail', () => {
		const v = cam([0, 0, 0], [0, 0, -1], { w: 1600, h: 600 });
		const d = at(6.5, v);
		const g = graph([[1.5 * d, 0, -d]]);
		const p = project(v, 1.5 * d, 0, -d)!;
		expect(p.x).toBeLessThan(1600);
		expect(run(input(g, v)).detailNodeIds).toEqual(['n0']);
	});
});

describe('遠平面之外（選取／高亮也一樣）', () => {
	it('選取與高亮節點在 far 之外：不是 detail、沒有標籤', () => {
		const v = cam([0, 0, 0], [0, 0, -1], { far: 1000 });
		const g = graph([
			[0, 0, -2000],
			[30, 0, -1500],
			[0, 0, -50]
		]);
		const f = run(input(g, v, { selected: 0, hover: 1, focus: [1] }));
		expect(f.detailNodeIds).toEqual(['n2']);
		expect(f.labels.map((l) => l.id)).not.toContain('n0');
		expect(f.labels.map((l) => l.id)).not.toContain('n1');
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

	it('追查中單選的關係：即使排在 2,000 條之外也一定畫、排第一（獨立高亮），總數不變', () => {
		const g = lattice(13, 3);
		for (let i = 0; i + 1 < g.ids.length; i++) g.edges.push([i, i + 1]);
		const hl = g.edges.map((_, i) => i);
		const last = hl.length - 1;
		const f = run(
			input(g, cam([0, 0, 200]), { highlight: hl, highlightTotal: hl.length, selectedEdge: last })
		);
		expect(f.highlightEdges[0]).toBe(last);
		expect(f.highlightEdgeIds.length).toBe(2000);
		expect(f.stats.highlightDrawn + f.stats.highlightOmitted).toBe(hl.length);
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

	it('reproject：相機造成的重疊也要避碰（不保留重疊標籤）', () => {
		const g = graph([
			[-5, 0, 0],
			[5, 0, 0]
		]);
		const a = run(input(g, cam([0, 0, 40], [0, 0, 0])));
		expect(a.labels.map((l) => l.id).sort()).toEqual(['n0', 'n1']);
		expectNoOverlap(a.labels);
		// 拉遠：兩個點靠近，原本右側的標籤會互相重疊
		const b = run(input(g, cam([0, 0, 80], [0, 0, 0]), { labels: 'reproject' }), a.state);
		expect(b.labels.length).toBeGreaterThan(0);
		expectNoOverlap(b.labels);
		expect(b.labels.length).toBeLessThanOrEqual(LOD.maxLabels);
	});

	it('reproject：不再是 detail（或低於標籤門檻）的標籤移除；選取仍優先', () => {
		const g = graph([
			[-5, 0, 0],
			[5, 0, 0],
			[0, 8, 0]
		]);
		const a = run(input(g, cam([0, 0, 40], [0, 0, 0])));
		expect(a.labels.length).toBe(3);
		const far = cam([0, 0, 4000], [0, 0, 0]);
		const b = run(input(g, far, { labels: 'reproject', selected: 2 }), a.state);
		expect(b.detailNodeIds).toEqual(['n2']);
		expect(b.labels.map((l) => l.id)).toEqual(['n2']);
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

	it('未升級（被預算排除）的近處點只有畫出的封頂點大小可點，不是無形大圓', () => {
		const g = graph([[0, 0, 60]]); // 深度 40 → 物理半徑 ≫ 6px
		const r = (LOD.nodeRadius * v.focal) / 40;
		expect(r).toBeGreaterThan(30);
		const x = W / 2 + 20;
		const base = { positions: g.positions, grid: buildGrid(g.positions), view: v };
		const vis = new Uint8Array([1]);
		const ray = pickRay(v, x, H / 2);
		// 不是 detail：Points 封頂 detailEnterPx（×倍率），20px 外不中
		expect(pick({ ...base, visible: vis, ray, x, y: H / 2, detail: new Set() })).toBe(-1);
		// 是 detail：球畫出物理大小，命中
		expect(pick({ ...base, visible: vis, ray, x, y: H / 2, detail: new Set([0]) })).toBe(0);
	});

	it('問題節點（1.6 倍）：detail 外緣與封頂點都依實際大小判定', () => {
		const g = graph([[0, 0, 20]]); // 深度 80
		const r = (LOD.nodeRadius * v.focal) / 80;
		const base = { positions: g.positions, grid: buildGrid(g.positions), view: v };
		const vis = new Uint8Array([1]);
		const hit = (dx: number, detail: Set<number>, scale: number) =>
			pick({
				...base,
				visible: vis,
				ray: pickRay(v, W / 2 + dx, H / 2),
				x: W / 2 + dx,
				y: H / 2,
				detail,
				scale: new Float32Array([scale])
			});
		const rim = r * 1.4; // 介於 1 倍與 1.6 倍半徑之間
		expect(hit(rim, new Set([0]), 1)).toBe(-1);
		expect(hit(rim, new Set([0]), 1.6)).toBe(0);
		// 未升級的問題點：封頂 6×1.6=9.6px，比容差 8px 大
		expect(hit(9, new Set(), 1.6)).toBe(0);
		expect(hit(9, new Set(), 1)).toBe(-1);
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
				const drawn = Math.min((LOD.nodeRadius * view.focal) / p.depth, LOD.detailEnterPx);
				const r = Math.max(LOD.pickTolerancePx, drawn);
				if (Math.hypot(p.x - x, p.y - y) <= r && p.depth < bd) [bd, best] = [p.depth, i];
			}
			expect(
				pick({ positions: g.positions, grid, visible: vis, view, ray: pickRay(view, x, y), x, y })
			).toBe(best);
		}
	});
});
