// 3D 宇宙的 LOD 與點選：純計算（不碰 three／DOM），renderer 每次相機改變呼叫一次。
// 遠景：可見系統的全部節點都是 Points（base）。近景：依「每個節點自己的投影半徑」升級為 detail
// （進入 6px、退出 4px），detail 之間的局部邊、高亮邊、標籤都有硬上限；選取／高亮優先佔用同一份預算。
// 空間格網只在座標改變時重建；相機改變只做格網候選查詢＋投影。

/** 單一來源的 LOD 設定（門檻、預算、標籤字型估寬、點選容差） */
export const LOD = {
	/** 節點球的世界半徑（renderer 的 detail 球與 Points 尺寸都以此換算） */
	nodeRadius: 4,
	detailEnterPx: 6,
	detailExitPx: 4,
	maxDetail: 1000,
	maxLocalEdges: 2000,
	maxHighlightEdges: 2000,
	maxLabels: 80,
	/** detail 節點要多大才有標籤（只有選取、滑過不受此限；高亮只是排序優先） */
	labelMinPx: 9,
	labelFontPx: 12,
	labelHeightPx: 18,
	labelPadPx: 8,
	labelMaxWidthPx: 160,
	/** 標籤與節點之間的間距 */
	labelGapPx: 3,
	/** 點選容差（px）；節點畫得比這大時以節點投影半徑為準 */
	pickTolerancePx: 8,
	/** 相機旋轉中標籤重新挑選的最短間隔；期間只重新投影既有標籤 */
	labelThrottleMs: 150,
	/** 平均每格網格幾個點 */
	gridPerCell: 8
} as const;
export type LodConfig = typeof LOD;

export type Vec3 = [number, number, number];

/** 相機的純數值描述：VP 矩陣（column-major）、視錐平面、眼睛位置、CSS 像素尺寸與焦距 */
export type View = {
	vp: Float64Array;
	inv: Float64Array;
	planes: Float64Array;
	eye: Vec3;
	width: number;
	height: number;
	/** 深度 1 時一個世界單位等於幾個 CSS px */
	focal: number;
	near: number;
	far: number;
};

function mul(a: ArrayLike<number>, b: ArrayLike<number>) {
	const o = new Float64Array(16);
	for (let c = 0; c < 4; c++)
		for (let r = 0; r < 4; r++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
			o[c * 4 + r] = s;
		}
	return o;
}

function invert(m: Float64Array) {
	// 高斯消去（4×4，column-major 轉成 row 處理）
	const a = Array.from({ length: 4 }, (_, r) => [
		m[r],
		m[4 + r],
		m[8 + r],
		m[12 + r],
		r === 0 ? 1 : 0,
		r === 1 ? 1 : 0,
		r === 2 ? 1 : 0,
		r === 3 ? 1 : 0
	]);
	for (let c = 0; c < 4; c++) {
		let p = c;
		for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
		[a[c], a[p]] = [a[p], a[c]];
		const d = a[c][c] || 1e-12;
		for (let k = 0; k < 8; k++) a[c][k] /= d;
		for (let r = 0; r < 4; r++)
			if (r !== c) {
				const f = a[r][c];
				for (let k = 0; k < 8; k++) a[r][k] -= f * a[c][k];
			}
	}
	const o = new Float64Array(16);
	for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = a[r][4 + c];
	return o;
}

/** projection、view（camera.matrixWorldInverse）→ View；width／height 是 CSS px */
export function makeView(
	projection: ArrayLike<number>,
	viewMatrix: ArrayLike<number>,
	eye: Vec3,
	width: number,
	height: number
): View {
	const vp = mul(projection, viewMatrix);
	const planes = new Float64Array(24);
	const row = (r: number) => [vp[r], vp[4 + r], vp[8 + r], vp[12 + r]];
	const r3 = row(3);
	[
		[0, 1],
		[0, -1],
		[1, 1],
		[1, -1],
		[2, 1],
		[2, -1]
	].forEach(([r, s], k) => {
		const rr = row(r);
		const p = r3.map((v, j) => v + s * rr[j]);
		const len = Math.hypot(p[0], p[1], p[2]) || 1;
		for (let j = 0; j < 4; j++) planes[k * 4 + j] = p[j] / len;
	});
	const p10 = projection[10];
	const p14 = projection[14];
	return {
		vp,
		inv: invert(vp),
		planes,
		eye: [...eye],
		width,
		height,
		focal: (projection[5] * height) / 2,
		near: p14 / (p10 - 1),
		far: p14 / (p10 + 1)
	};
}

export type Projected = { x: number; y: number; depth: number };

/** 投影到 CSS px（左上為原點）；相機背後或近平面前回傳 null */
export function project(v: View, x: number, y: number, z: number): Projected | null {
	const m = v.vp;
	const w = m[3] * x + m[7] * y + m[11] * z + m[15];
	if (!(w > v.near)) return null;
	const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
	const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
	return { x: ((cx / w + 1) / 2) * v.width, y: ((1 - cy / w) / 2) * v.height, depth: w };
}

/** 均勻格網（CSR）：只在座標改變時重建 */
export type Grid = {
	min: Vec3;
	cell: number;
	dims: Vec3;
	/** 每格在 items 的起點（長度＝格數＋1） */
	start: Uint32Array;
	items: Uint32Array;
	/** 非空的格子 */
	occupied: Uint32Array;
};

export function buildGrid(pos: Float32Array, perCell: number = LOD.gridPerCell): Grid {
	const n = pos.length / 3;
	const min: Vec3 = [Infinity, Infinity, Infinity];
	const max: Vec3 = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < n; i++)
		for (let k = 0; k < 3; k++) {
			const v = pos[i * 3 + k];
			if (v < min[k]) min[k] = v;
			if (v > max[k]) max[k] = v;
		}
	if (!n)
		return {
			min: [0, 0, 0],
			cell: 1,
			dims: [1, 1, 1],
			start: new Uint32Array(2),
			items: new Uint32Array(0),
			occupied: new Uint32Array(0)
		};
	const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
	const k = Math.min(64, Math.max(1, Math.ceil(Math.cbrt(n / perCell))));
	const cell = Math.max(extent / k, 1e-3);
	const dims = [0, 1, 2].map((a) => Math.floor((max[a] - min[a]) / cell) + 1) as Vec3;
	const cells = dims[0] * dims[1] * dims[2];
	const key = new Uint32Array(n);
	const count = new Uint32Array(cells + 1);
	for (let i = 0; i < n; i++) {
		const c = cellOf(min, cell, dims, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
		key[i] = c;
		count[c + 1]++;
	}
	for (let c = 0; c < cells; c++) count[c + 1] += count[c];
	const start = count.slice();
	const fill = count.slice(0, cells);
	const items = new Uint32Array(n);
	for (let i = 0; i < n; i++) items[fill[key[i]]++] = i;
	const occ: number[] = [];
	for (let c = 0; c < cells; c++) if (start[c + 1] > start[c]) occ.push(c);
	return { min, cell, dims, start, items, occupied: Uint32Array.from(occ) };
}

function cellOf(min: Vec3, cell: number, d: Vec3, x: number, y: number, z: number) {
	const cx = Math.min(d[0] - 1, Math.floor((x - min[0]) / cell));
	const cy = Math.min(d[1] - 1, Math.floor((y - min[1]) / cell));
	const cz = Math.min(d[2] - 1, Math.floor((z - min[2]) / cell));
	return (cx * d[1] + cy) * d[2] + cz;
}

/** 格子的 AABB（寫入 out：minx,miny,minz,maxx,maxy,maxz） */
function box(g: Grid, c: number, out: Float64Array) {
	const cz = c % g.dims[2];
	const cy = Math.floor(c / g.dims[2]) % g.dims[1];
	const cx = Math.floor(c / (g.dims[1] * g.dims[2]));
	out[0] = g.min[0] + cx * g.cell;
	out[1] = g.min[1] + cy * g.cell;
	out[2] = g.min[2] + cz * g.cell;
	out[3] = out[0] + g.cell;
	out[4] = out[1] + g.cell;
	out[5] = out[2] + g.cell;
}

function boxInFrustum(v: View, b: Float64Array, margin: number) {
	const p = v.planes;
	for (let k = 0; k < 6; k++) {
		const a = p[k * 4];
		const bb = p[k * 4 + 1];
		const c = p[k * 4 + 2];
		const x = a >= 0 ? b[3] : b[0];
		const y = bb >= 0 ? b[4] : b[1];
		const z = c >= 0 ? b[5] : b[2];
		if (a * x + bb * y + c * z + p[k * 4 + 3] < -margin) return false;
	}
	return true;
}

const clampDist = (e: Vec3, b: Float64Array) =>
	Math.hypot(
		Math.max(b[0] - e[0], 0, e[0] - b[3]),
		Math.max(b[1] - e[1], 0, e[1] - b[4]),
		Math.max(b[2] - e[2], 0, e[2] - b[5])
	);
const farDist = (e: Vec3, b: Float64Array) =>
	Math.hypot(
		Math.max(Math.abs(e[0] - b[0]), Math.abs(e[0] - b[3])),
		Math.max(Math.abs(e[1] - b[1]), Math.abs(e[1] - b[4])),
		Math.max(Math.abs(e[2] - b[2]), Math.abs(e[2] - b[5]))
	);

/** 節點→相連邊（CSR，邊索引） */
export type Adjacency = { start: Uint32Array; edges: Uint32Array };
export function buildAdjacency(n: number, from: Uint32Array, to: Uint32Array): Adjacency {
	const start = new Uint32Array(n + 1);
	for (let e = 0; e < from.length; e++) {
		start[from[e] + 1]++;
		if (to[e] !== from[e]) start[to[e] + 1]++;
	}
	for (let i = 0; i < n; i++) start[i + 1] += start[i];
	const fill = start.slice(0, n);
	const edges = new Uint32Array(start[n]);
	for (let e = 0; e < from.length; e++) {
		edges[fill[from[e]]++] = e;
		if (to[e] !== from[e]) edges[fill[to[e]]++] = e;
	}
	return { start, edges };
}

/** 標籤寬度估計（px）：CJK 全形、其他半形，加內距，上限 labelMaxWidthPx。DOM 以同寬＋省略號顯示 */
export function labelWidth(text: string, cfg: LodConfig = LOD) {
	let w = cfg.labelPadPx;
	for (const ch of text)
		w += ch.codePointAt(0)! >= 0x2e80 ? cfg.labelFontPx : cfg.labelFontPx * 0.6;
	return Math.min(cfg.labelMaxWidthPx, Math.ceil(w));
}

export type FrameInput = {
	ids: readonly string[];
	positions: Float32Array;
	grid: Grid;
	/** 1＝屬於勾選系統（畫得出來、可點） */
	visible: Uint8Array;
	view: View;
	/** 可見子圖的邊（端點是 ids 的索引） */
	edges: { ids: readonly string[]; from: Uint32Array; to: Uint32Array; adjacency: Adjacency };
	selected: number;
	hover: number;
	/** 高亮節點（選取的鄰居、找客戶路徑） */
	focus: readonly number[];
	/** 高亮邊（edges 的索引，已限定可見子圖） */
	highlight: readonly number[];
	/** 高亮邊的完整數量（含被系統篩掉的） */
	highlightTotal: number;
	labelWidth: (node: number) => number;
	/** full＝重新挑選並避碰；reproject＝只重算上一幀標籤的位置（相機轉動中節流用） */
	labels: 'full' | 'reproject';
	config?: LodConfig;
};

export type LodState = {
	detail: ReadonlySet<number>;
	labels: readonly number[];
	sides: ReadonlyMap<number, 1 | -1>;
};
export type Label = { id: string; node: number; x: number; y: number; w: number; h: number };
export type LodStats = {
	visibleNodes: number;
	baseNodes: number;
	detail: number;
	detailEligible: number;
	detailOmitted: number;
	localEdges: number;
	localEdgesEligible: number;
	localEdgesOmitted: number;
	highlightTotal: number;
	highlightVisible: number;
	highlightDrawn: number;
	highlightOmitted: number;
	/** 被系統篩選隱藏的高亮邊 */
	highlightHidden: number;
	labels: number;
	labelCandidates: number;
	labelsOmitted: number;
};
export type Frame = {
	detail: number[];
	detailNodeIds: string[];
	localEdges: number[];
	localEdgeIds: string[];
	highlightEdges: number[];
	highlightEdgeIds: string[];
	labels: Label[];
	stats: LodStats;
	state: LodState;
};

const EMPTY: LodState = { detail: new Set(), labels: [], sides: new Map() };

export function computeFrame(inp: FrameInput, prev: LodState = EMPTY): Frame {
	const cfg = inp.config ?? LOD;
	const { positions: P, view: v, visible, grid } = inp;
	const R = cfg.nodeRadius;
	const proj = (i: number) => project(v, P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
	const rpx = (p: Projected) => (R * v.focal) / p.depth;
	const onScreen = (p: Projected, m: number) =>
		p.x >= -m && p.y >= -m && p.x <= v.width + m && p.y <= v.height + m;

	let visibleNodes = 0;
	for (let i = 0; i < visible.length; i++) visibleNodes += visible[i];

	// 1. detail：格網候選（視錐＋近距離），再逐點投影
	const seen = new Map<number, Projected>();
	const general: { i: number; r: number }[] = [];
	const reach = (R * v.focal) / cfg.detailExitPx;
	const b = new Float64Array(6);
	for (const c of grid.occupied) {
		box(grid, c, b);
		if (clampDist(v.eye, b) > reach || !boxInFrustum(v, b, R)) continue;
		for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
			const i = grid.items[k];
			if (!visible[i]) continue;
			const p = proj(i);
			if (!p) continue;
			const r = rpx(p);
			if (!onScreen(p, r)) continue;
			if (r >= (prev.detail.has(i) ? cfg.detailExitPx : cfg.detailEnterPx)) {
				seen.set(i, p);
				general.push({ i, r });
			}
		}
	}
	const forced: number[] = [];
	const forcedSet = new Set<number>();
	const force = (i: number, needView: boolean) => {
		if (i < 0 || forcedSet.has(i) || !visible[i]) return;
		const p = seen.get(i) ?? proj(i);
		if (!p || (needView && !onScreen(p, rpx(p)))) return;
		seen.set(i, p);
		forced.push(i);
		forcedSet.add(i);
	};
	force(inp.selected, false);
	force(inp.hover, true);
	const focus = inp.focus
		.flatMap((i) => {
			if (!visible[i] || forcedSet.has(i)) return [];
			const p = seen.get(i) ?? proj(i);
			return p && onScreen(p, rpx(p)) ? [{ i, r: rpx(p), p }] : [];
		})
		.sort((a, c) => c.r - a.r || a.i - c.i);
	for (const f of focus) {
		seen.set(f.i, f.p);
		force(f.i, true);
	}
	general.sort((a, c) => c.r - a.r || a.i - c.i);
	const detail: number[] = forced.slice(0, cfg.maxDetail);
	let eligible = forced.length;
	for (const g of general) {
		if (forcedSet.has(g.i)) continue;
		eligible++;
		if (detail.length < cfg.maxDetail) detail.push(g.i);
	}
	const inDetail = new Set(detail);

	// 2. 高亮邊：連到選取節點的優先、再來在畫面內的、再依索引
	const E = inp.edges;
	const viewOf = (i: number) => {
		const p = seen.get(i) ?? proj(i);
		return !!p && onScreen(p, 0);
	};
	const hl = inp.highlight
		.map((e) => {
			const s = inp.selected;
			const touch = E.from[e] === s || E.to[e] === s ? 0 : 1;
			const vis = viewOf(E.from[e]) || viewOf(E.to[e]) ? 0 : 1;
			return { e, k: touch * 2 + vis };
		})
		.sort((a, c) => a.k - c.k || a.e - c.e)
		.slice(0, cfg.maxHighlightEdges)
		.map((x) => x.e);
	const hlSet = new Set(inp.highlight);

	// 3. 局部邊：兩端都是 detail（高亮邊另畫，不重複）
	const local: number[] = [];
	const counted = new Set<number>();
	let localEligible = 0;
	for (const i of detail)
		for (let k = E.adjacency.start[i]; k < E.adjacency.start[i + 1]; k++) {
			const e = E.adjacency.edges[k];
			if (counted.has(e) || hlSet.has(e)) continue;
			const o = E.from[e] === i ? E.to[e] : E.from[e];
			if (!inDetail.has(o)) continue;
			counted.add(e);
			localEligible++;
			if (local.length < cfg.maxLocalEdges) local.push(e);
		}

	// 4. 標籤
	const labels: Label[] = [];
	const sides = new Map<number, 1 | -1>();
	let labelCandidates: number;
	const H = cfg.labelHeightPx;
	const place = (i: number, side: 1 | -1, p: Projected) => {
		const w = inp.labelWidth(i);
		const r = rpx(p);
		const x = side > 0 ? p.x + r + cfg.labelGapPx : p.x - r - cfg.labelGapPx - w;
		return { id: inp.ids[i], node: i, x, y: p.y - H / 2, w, h: H };
	};
	const fits = (l: Label) => l.x >= 0 && l.y >= 0 && l.x + l.w <= v.width && l.y + l.h <= v.height;
	const free = (l: Label) =>
		labels.every(
			(o) => !(l.x < o.x + o.w && o.x < l.x + l.w && l.y < o.y + o.h && o.y < l.y + l.h)
		);
	if (inp.labels === 'reproject') {
		for (const i of prev.labels) {
			if (!visible[i]) continue;
			const p = seen.get(i) ?? proj(i);
			if (!p) continue;
			const l = place(i, prev.sides.get(i) ?? 1, p);
			if (!fits(l)) continue;
			labels.push(l);
			sides.set(i, prev.sides.get(i) ?? 1);
		}
		labelCandidates = labels.length;
	} else {
		const had = new Set(prev.labels);
		const pri = new Set([inp.selected, inp.hover]);
		const cand = detail.filter((i) => pri.has(i) || rpx(seen.get(i)!) >= cfg.labelMinPx);
		const tier = (i: number) =>
			pri.has(i) ? (i === inp.selected ? 0 : 1) : forcedSet.has(i) ? 2 : 3;
		cand.sort(
			(a, c) =>
				tier(a) - tier(c) ||
				(had.has(a) ? 0 : 1) - (had.has(c) ? 0 : 1) ||
				rpx(seen.get(c)!) - rpx(seen.get(a)!) ||
				a - c
		);
		labelCandidates = cand.length;
		for (const i of cand) {
			if (labels.length >= cfg.maxLabels) break;
			const p = seen.get(i)!;
			const first = prev.sides.get(i) ?? 1;
			let done = false;
			for (const side of [first, -first as 1 | -1]) {
				const l = place(i, side, p);
				if (fits(l) && free(l)) {
					labels.push(l);
					sides.set(i, side);
					done = true;
					break;
				}
			}
			// 選取節點一定要有標籤：放不下就夾進畫面內（它是第一個，不會撞到別人）
			if (!done && i === inp.selected && !labels.length) {
				const l = place(i, 1, p);
				l.x = Math.min(Math.max(0, l.x), Math.max(0, v.width - l.w));
				l.y = Math.min(Math.max(0, l.y), Math.max(0, v.height - l.h));
				labels.push(l);
				sides.set(i, 1);
			}
		}
	}

	const total = Math.max(inp.highlightTotal, inp.highlight.length);
	return {
		detail,
		detailNodeIds: detail.map((i) => inp.ids[i]),
		localEdges: local,
		localEdgeIds: local.map((e) => E.ids[e]),
		highlightEdges: hl,
		highlightEdgeIds: hl.map((e) => E.ids[e]),
		labels,
		stats: {
			visibleNodes,
			baseNodes: visibleNodes - detail.length,
			detail: detail.length,
			detailEligible: eligible,
			detailOmitted: eligible - detail.length,
			localEdges: local.length,
			localEdgesEligible: localEligible,
			localEdgesOmitted: localEligible - local.length,
			highlightTotal: total,
			highlightVisible: inp.highlight.length,
			highlightDrawn: hl.length,
			highlightOmitted: inp.highlight.length - hl.length,
			highlightHidden: total - inp.highlight.length,
			labels: labels.length,
			labelCandidates,
			labelsOmitted: labelCandidates - labels.length
		},
		state: { detail: inDetail, labels: labels.map((l) => l.node), sides }
	};
}

export type Ray = { origin: Vec3; dir: Vec3 };

/** 螢幕 CSS px → 世界射線（從眼睛出發） */
export function pickRay(v: View, x: number, y: number): Ray {
	const nx = (x / v.width) * 2 - 1;
	const ny = 1 - (y / v.height) * 2;
	const un = (z: number): Vec3 => {
		const m = v.inv;
		const w = m[3] * nx + m[7] * ny + m[11] * z + m[15];
		return [
			(m[0] * nx + m[4] * ny + m[8] * z + m[12]) / w,
			(m[1] * nx + m[5] * ny + m[9] * z + m[13]) / w,
			(m[2] * nx + m[6] * ny + m[10] * z + m[14]) / w
		];
	};
	const a = un(-1);
	const b = un(1);
	const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
	const len = Math.hypot(...d) || 1;
	return { origin: [...v.eye], dir: [d[0] / len, d[1] / len, d[2] / len] };
}

function rayHits(r: Ray, b: Float64Array, e: number) {
	let t0 = 0;
	let t1 = Infinity;
	for (let k = 0; k < 3; k++) {
		const lo = b[k] - e;
		const hi = b[k + 3] + e;
		const o = r.origin[k];
		const d = r.dir[k];
		if (Math.abs(d) < 1e-12) {
			if (o < lo || o > hi) return false;
			continue;
		}
		let a = (lo - o) / d;
		let c = (hi - o) / d;
		if (a > c) [a, c] = [c, a];
		t0 = Math.max(t0, a);
		t1 = Math.min(t1, c);
		if (t0 > t1) return false;
	}
	return true;
}

export type PickInput = {
	positions: Float32Array;
	grid: Grid;
	visible: Uint8Array;
	view: View;
	ray: Ray;
	/** CSS px（相對畫布左上） */
	x: number;
	y: number;
	config?: LodConfig;
};

/**
 * 點選：沿射線找格網候選，逐點投影；只接受勾選系統、相機前方、視錐內、
 * 在容差（或節點投影半徑）內的點；重疊時取最近的正深度。沒有回傳 -1。
 */
export function pick(inp: PickInput): number {
	const cfg = inp.config ?? LOD;
	const { positions: P, view: v, grid } = inp;
	const R = cfg.nodeRadius;
	const tol = cfg.pickTolerancePx;
	const b = new Float64Array(6);
	let best = -1;
	let bd = Infinity;
	let bs = Infinity;
	for (const c of grid.occupied) {
		box(grid, c, b);
		if (!rayHits(inp.ray, b, R + (tol * farDist(v.eye, b)) / v.focal)) continue;
		for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
			const i = grid.items[k];
			if (!inp.visible[i]) continue;
			const p = project(v, P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
			if (!p || p.depth > v.far) continue;
			if (p.x < 0 || p.y < 0 || p.x > v.width || p.y > v.height) continue;
			const s = Math.hypot(p.x - inp.x, p.y - inp.y);
			if (s > Math.max(tol, (R * v.focal) / p.depth)) continue;
			if (p.depth < bd || (p.depth === bd && (s < bs || (s === bs && i < best)))) {
				[best, bd, bs] = [i, p.depth, s];
			}
		}
	}
	return best;
}
