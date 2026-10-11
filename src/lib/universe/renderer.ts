// 3D 宇宙的分層繪製（three.js）：星塵背景、遠景 Points、全圖連線、近景 detail InstancedMesh、局部邊、
// 高亮邊＋方向箭頭、標籤池。連線不走 LOD（遠景也看得到關係網），只有名稱與 detail 走 LOD。
// 每一層都是固定容量的 GPU buffer，相機改變只改寫有上限的內容；Points 只在拓撲改變時重配、
// 座標改變時就地寫入。LOD 與點選的決策在 lod.ts（純計算），這裡只負責把結果寫進 buffer／DOM。
import type * as THREE_NS from 'three';
import { ROOT_ID } from '#lib/model/config.js';
import type { Graph } from '#lib/model/types.js';
import type { UniverseRuntime } from './runtime';
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
	type Adjacency,
	type Frame,
	type Grid,
	type LodState,
	type LodStats,
	type View
} from './lod';

export const PALETTE = {
	DIM: '#1e293b',
	LINK_HL: '#e2e8f0',
	PATH: '#22d3ee',
	SEL: '#ffffff',
	WARN: '#facc15',
	BROKEN: '#fb7185',
	/** 根節點：空間靛色的淺色版（白色留給選取） */
	ROOT: '#c7d2fe',
	ROOT_RING: '#a5b4fc'
} as const;

/** 選取／找客戶的高亮輸入（ID 層級；renderer 自己轉成索引） */
export type Focus = {
	selected: string | null;
	/** 亮起的節點；null＝沒有聚焦 */
	nodes: ReadonlySet<string> | null;
	/** 亮起的邊（edge id） */
	edges: ReadonlySet<string> | null;
	path: boolean;
	/** 高亮邊的完整數量（含系統篩選隱藏的） */
	highlightTotal: number;
	/** 單選的關係（追查中點一條邊）：必在 edges 內，用選取色獨立亮、一定畫 */
	selectedEdge?: string | null;
	warn: ReadonlySet<string>;
	broken: ReadonlySet<string>;
};

export type ScreenPoint = { id: string; x: number; y: number; depth: number; px: number };

type Three = typeof THREE_NS;

export type UniverseLayersOptions = {
	THREE: Three;
	scene: THREE_NS.Scene;
	camera: () => THREE_NS.PerspectiveCamera;
	/** 畫布 CSS 尺寸 */
	size: () => { width: number; height: number };
	pixelRatio: () => number;
	labelHost: HTMLElement;
	runtime: UniverseRuntime;
	/** 目前名稱（metadata 可能比 scene 新） */
	name: (id: string) => string;
	nodeColor: (type: string) => string;
	onStats: (s: LodStats) => void;
};

const STATS_MS = 250;
/** 遠景點的光暈範圍（核心半徑的倍數） */
const GLOW = 2.5;
/** 全圖連線的不透明度：邊越多越淡（疊加混色，密處自然變亮）；聚焦時退到背景 */
const baseOpacity = (edges: number) =>
	Math.min(0.5, Math.max(0.08, 0.5 * Math.sqrt(400 / Math.max(edges, 1))));
const BASE_DIM_OPACITY = 0.04;
const STARS = 1600;
/** 根節點核心的尺寸倍率（一般 1、問題節點 1.6） */
const ROOT_SIZE = 3;
/** 根節點光環半徑（核心半徑的倍數）與畫面上的最小半徑（px） */
const RING = 2.6;
const RING_MIN_PX = 32;
/** 高亮邊上的流動光點：每條邊幾顆、世界速度（單位／秒）、世界半徑與畫面最小半徑（px） */
const FLOW = 3;
const FLOW_SPEED = 60;
const FLOW_R = 2.5;
const FLOW_MIN_PX = 2.5;

export function createUniverseLayers(o: UniverseLayersOptions) {
	// 建構中途失敗（GPU 資源、標籤 DOM）：已建的全部倒序收回，不留場景物件／hook／DOM
	const undo: (() => void)[] = [];
	try {
		return buildLayers(o, undo);
	} catch (e) {
		for (const f of undo.reverse()) {
			try {
				f();
			} catch (cleanup) {
				// 收回失敗不蓋掉原始錯誤（下面照樣丟 e），但要留下紀錄；其餘收回步驟繼續
				console.warn('[universe] renderer cleanup failed after construction error', cleanup, e);
			}
		}
		throw e;
	}
}

function buildLayers(o: UniverseLayersOptions, undo: (() => void)[]) {
	const { THREE, scene, runtime: rt } = o;
	const R = LOD.nodeRadius;
	const disposables: { dispose(): void }[] = [];
	const own = <T extends { dispose(): void }>(x: T) => (
		disposables.push(x),
		undo.push(() => x.dispose()),
		x
	);
	const add = <T extends THREE_NS.Object3D>(x: T) => (
		scene.add(x),
		undo.push(() => x.removeFromParent()),
		x
	);

	// ---- 狀態（非 Svelte） ----
	let ids: readonly string[] = [];
	let grid: Grid = buildGrid(new Float32Array(0));
	let visible = new Uint8Array(0);
	let base = new Float32Array(0); // 每個節點的 Points 尺寸倍率（0＝隱藏）
	let graph: Graph = { nodes: [], edges: [] };
	let colors: Float32Array = new Float32Array(0); // 每個節點目前顏色（含高亮）
	let typeColor: string[] = [];
	let root = -1;
	let edgeIds: string[] = [];
	let edgeIndex = new Map<string, number>();
	let from = new Uint32Array(0);
	let to = new Uint32Array(0);
	let bidi = new Uint8Array(0);
	let adjacency: Adjacency = buildAdjacency(0, from, to);
	let focus: Focus | null = null;
	let focusIdx = { selected: -1, nodes: [] as number[], edges: [] as number[], edge: -1 };
	let hover = -1;
	let state: LodState | undefined;
	let frame: Frame | null = null;
	let view: View | null = null;
	let dirty = true;
	let labelsDirty = true;
	let lastFull = 0;
	let lastStats = 0;
	let statsPending = false;
	let prevDetail: number[] = [];
	let lastCam = new Float64Array(20);
	let lodMs = 0;
	let lodMaxMs = 0;
	let frames = 0;

	// ---- 遠景 Points ----
	const pointMat = own(
		new THREE.ShaderMaterial({
			uniforms: { focal: { value: 1 }, dpr: { value: 1 }, radius: { value: R } },
			vertexShader: /* glsl */ `
				attribute vec3 tint;
				attribute float size;
				uniform float focal;
				uniform float dpr;
				uniform float radius;
				varying vec3 vTint;
				void main() {
					vTint = tint;
					vec4 mv = modelViewMatrix * vec4(position, 1.0);
					if (size <= 0.0 || -mv.z <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
					gl_Position = projectionMatrix * mv;
					float px = size * radius * focal / -mv.z;
					// 畫成核心的 GLOW 倍大：外圈是光暈，核心大小與點選半徑一致
					gl_PointSize = clamp(2.0 * px, 2.0, 2.0 * ${LOD.detailEnterPx.toFixed(1)} * size) * dpr * ${GLOW.toFixed(1)};
				}`,
			fragmentShader: /* glsl */ `
				varying vec3 vTint;
				void main() {
					float d = length(gl_PointCoord - 0.5) * ${(2 * GLOW).toFixed(1)};
					if (d > ${GLOW.toFixed(1)}) discard;
					float core = 1.0 - smoothstep(0.75, 1.0, d);
					float halo = exp(-d * d * 2.2) * 0.3;
					vec3 col = vTint * (1.0 + core * 0.3); // 核心提亮但不混白：暗化的節點保持暗
					gl_FragColor = vec4(col * max(core, halo), 1.0);
				}`,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending
		})
	);
	let pointGeom = new THREE.BufferGeometry();
	undo.push(() => pointGeom.dispose());
	const points = new THREE.Points(pointGeom, pointMat);
	points.frustumCulled = false;
	add(points);

	// ---- 近景 detail（固定容量） ----
	const sphere = own(new THREE.SphereGeometry(R, 12, 10));
	// 不打光：與遠景的發光點同一種質感，光暈交給 bloom
	const detailMat = own(new THREE.MeshBasicMaterial());
	const detailMesh = new THREE.InstancedMesh(sphere, detailMat, LOD.maxDetail);
	detailMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
	detailMesh.setColorAt(0, new THREE.Color());
	detailMesh.count = 0;
	detailMesh.frustumCulled = false;
	add(detailMesh);
	undo.push(() => detailMesh.dispose());

	// ---- 邊（固定容量的 LineSegments） ----
	const lines = (cap: number, mat: THREE_NS.LineBasicMaterial) => {
		const g = own(new THREE.BufferGeometry());
		g.setAttribute(
			'position',
			new THREE.BufferAttribute(new Float32Array(cap * 6), 3).setUsage(THREE.DynamicDrawUsage)
		);
		g.setAttribute(
			'color',
			new THREE.BufferAttribute(new Float32Array(cap * 6), 3).setUsage(THREE.DynamicDrawUsage)
		);
		g.setDrawRange(0, 0);
		const l = new THREE.LineSegments(g, mat);
		l.frustumCulled = false;
		add(l);
		return l;
	};
	const localMat = own(
		new THREE.LineBasicMaterial({
			vertexColors: true,
			transparent: true,
			opacity: 0.45,
			depthWrite: false
		})
	);
	const hiMat = own(new THREE.LineBasicMaterial({ vertexColors: true, depthWrite: false }));
	const localLines = lines(LOD.maxLocalEdges, localMat);
	const hiLines = lines(LOD.maxHighlightEdges, hiMat);

	// ---- 全圖連線（不走 LOD）：容量＝可見邊數，只在可見子圖改變時重配；相機移動不碰 ----
	const baseMat = own(
		new THREE.LineBasicMaterial({
			vertexColors: true,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending
		})
	);
	let baseGeom = new THREE.BufferGeometry();
	undo.push(() => baseGeom.dispose());
	const baseLines = new THREE.LineSegments(baseGeom, baseMat);
	baseLines.frustumCulled = false;
	baseLines.renderOrder = -1;
	add(baseLines);

	// ---- 星塵（純裝飾，固定、遠在版面之外） ----
	const starGeom = own(new THREE.BufferGeometry());
	const star = new Float32Array(STARS * 3);
	for (let k = 0; k < STARS; k++) {
		const u = Math.random() * 2 - 1;
		const t = Math.random() * Math.PI * 2;
		const r = 3000 + Math.random() * 5000;
		const s = Math.sqrt(1 - u * u) * r;
		star.set([s * Math.cos(t), s * Math.sin(t), u * r], k * 3);
	}
	starGeom.setAttribute('position', new THREE.BufferAttribute(star, 3));
	const starMat = own(
		new THREE.PointsMaterial({
			color: '#8ea3d6',
			size: 1.4,
			sizeAttenuation: false,
			transparent: true,
			opacity: 0.45,
			depthWrite: false
		})
	);
	const stars = new THREE.Points(starGeom, starMat);
	stars.renderOrder = -2;
	add(stars);

	// ---- 根節點光環（單點 Points：雙環＋外圈緩慢呼吸；畫面上有最小尺寸，全圖縮遠也看得到） ----
	const ringMat = own(
		new THREE.ShaderMaterial({
			uniforms: {
				focal: { value: 1 },
				dpr: { value: 1 },
				time: { value: 0 },
				strength: { value: 0 },
				color: { value: new THREE.Color(PALETTE.ROOT_RING) }
			},
			vertexShader: /* glsl */ `
				uniform float focal;
				uniform float dpr;
				void main() {
					vec4 mv = modelViewMatrix * vec4(position, 1.0);
					if (-mv.z <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
					gl_Position = projectionMatrix * mv;
					float px = ${(ROOT_SIZE * RING * LOD.nodeRadius).toFixed(1)} * focal / -mv.z;
					gl_PointSize = 2.0 * max(px, ${RING_MIN_PX.toFixed(1)}) * dpr;
				}`,
			fragmentShader: /* glsl */ `
				uniform float time;
				uniform float strength;
				uniform vec3 color;
				void main() {
					float d = length(gl_PointCoord - 0.5) * 2.0;
					if (d > 1.0) discard;
					float breath = 0.5 + 0.5 * sin(time * 1.6);
					float inner = exp(-pow((d - 0.55) / 0.035, 2.0));
					float outer = exp(-pow((d - (0.82 + breath * 0.08)) / 0.03, 2.0)) * (0.35 + 0.45 * (1.0 - breath));
					float glow = exp(-d * d * 4.0) * 0.18;
					gl_FragColor = vec4(color * (inner * 0.8 + outer + glow) * strength, 1.0);
				}`,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending
		})
	);
	const ringGeom = own(new THREE.BufferGeometry());
	ringGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
	const ring = new THREE.Points(ringGeom, ringMat);
	ring.frustumCulled = false;
	add(ring);

	// ---- 方向箭頭（只有選取／找客戶的高亮邊；固定容量） ----
	const cone = own(new THREE.ConeGeometry(1.8, 6, 6));
	const arrowMat = own(new THREE.MeshBasicMaterial());
	const arrows = new THREE.InstancedMesh(cone, arrowMat, LOD.maxHighlightEdges * 2);
	arrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
	arrows.setColorAt(0, new THREE.Color());
	arrows.count = 0;
	arrows.frustumCulled = false;
	add(arrows);
	undo.push(() => arrows.dispose());

	// ---- 流動光點（選取／找客戶的單向高亮邊：每條 FLOW 顆，由來源流向目標；位置全在 GPU 算） ----
	const flowMat = own(
		new THREE.ShaderMaterial({
			uniforms: { focal: { value: 1 }, dpr: { value: 1 }, time: { value: 0 } },
			vertexShader: /* glsl */ `
				attribute vec3 b;
				attribute float phase;
				attribute vec3 tint;
				uniform float focal;
				uniform float dpr;
				uniform float time;
				varying vec3 vTint;
				void main() {
					vTint = tint;
					// 除以邊長：長短邊上的光點世界速度相近
					float t = fract(phase + time * ${FLOW_SPEED.toFixed(1)} / max(distance(position, b), 1.0));
					vec4 mv = modelViewMatrix * vec4(mix(position, b, t), 1.0);
					if (-mv.z <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
					gl_Position = projectionMatrix * mv;
					gl_PointSize = 2.0 * max(${FLOW_R.toFixed(1)} * focal / -mv.z, ${FLOW_MIN_PX.toFixed(1)}) * dpr;
				}`,
			fragmentShader: /* glsl */ `
				varying vec3 vTint;
				void main() {
					float d = length(gl_PointCoord - 0.5) * 2.0;
					if (d > 1.0) discard;
					gl_FragColor = vec4(vTint * (exp(-d * d * 5.0) + (1.0 - smoothstep(0.2, 0.35, d)) * 0.6), 1.0);
				}`,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending
		})
	);
	const flowGeom = own(new THREE.BufferGeometry());
	for (const [name, size] of [
		['position', 3],
		['b', 3],
		['phase', 1],
		['tint', 3]
	] as const)
		flowGeom.setAttribute(
			name,
			new THREE.BufferAttribute(
				new Float32Array(LOD.maxHighlightEdges * FLOW * size),
				size
			).setUsage(THREE.DynamicDrawUsage)
		);
	flowGeom.setDrawRange(0, 0);
	const flow = new THREE.Points(flowGeom, flowMat);
	flow.frustumCulled = false;
	add(flow);
	const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

	// ---- 標籤池（DOM，最多 maxLabels 個，建立一次） ----
	const pool = Array.from({ length: LOD.maxLabels }, () => {
		const el = document.createElement('div');
		el.className = 'universe-label';
		el.style.cssText =
			'position:absolute;left:0;top:0;display:none;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
			`height:${LOD.labelHeightPx}px;line-height:${LOD.labelHeightPx}px;font-size:${LOD.labelFontPx}px;padding:0 4px;` +
			'border-radius:4px;font-weight:400;outline:none;color:#e2e8f0;background:rgba(5,7,15,.62);box-shadow:inset 0 0 0 1px rgba(148,163,184,.14);letter-spacing:.01em;pointer-events:none;will-change:transform';
		o.labelHost.appendChild(el);
		undo.push(() => el.remove());
		// DOM 狀態快取：只在真的變了才寫 DOM；gen 落後＝名稱刷新過，要重寫字與寬度
		return { el, node: -1, shown: false, sel: false, w: -1, gen: 0 };
	});
	// 根節點名稱常駐（不受 LOD 與標籤上限限制）
	const rootLabel = document.createElement('div');
	rootLabel.className = 'universe-root-label';
	rootLabel.style.cssText =
		'position:absolute;left:0;top:0;display:none;white-space:nowrap;pointer-events:none;text-align:center;' +
		'padding:3px 10px 4px;border-radius:6px;background:rgba(5,7,15,.7);box-shadow:inset 0 0 0 1px rgba(165,180,252,.35),0 0 18px rgba(129,140,248,.25);' +
		'color:#e0e7ff;font-size:13px;font-weight:600;letter-spacing:.04em;line-height:1.25;will-change:transform';
	o.labelHost.appendChild(rootLabel);
	undo.push(() => rootLabel.remove());
	let rootText = '';
	let labelGen = 0;
	const widths = new Map<number, number>();
	const widthOf = (i: number) => {
		let w = widths.get(i);
		if (w === undefined) widths.set(i, (w = labelWidth(o.name(ids[i]))));
		return w;
	};

	const c = new THREE.Color();
	const m4 = new THREE.Matrix4();
	const v3 = new THREE.Vector3();
	const q = new THREE.Quaternion();
	const UP = new THREE.Vector3(0, 1, 0);
	const S1 = new THREE.Vector3(1, 1, 1);

	/** 拓撲改變（runtime 的 ids 換了）才重配 Points buffer */
	function syncIds() {
		const s = rt.snapshot();
		if (s.ids === ids) return;
		ids = s.ids;
		const n = ids.length;
		pointGeom.dispose();
		pointGeom = new THREE.BufferGeometry();
		pointGeom.setAttribute(
			'position',
			new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage)
		);
		pointGeom.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
		pointGeom.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n), 1));
		points.geometry = pointGeom;
		colors = (pointGeom.getAttribute('tint') as THREE_NS.BufferAttribute).array as Float32Array;
		base = new Float32Array(n);
		prevDetail = [];
		// 索引重新對應：舊的 hover 索引指向別的節點
		hover = -1;
		state = undefined;
		widths.clear();
		// 舊邊索引對應舊的節點索引：先清空，applyScene 重建
		from = to = new Uint32Array(0);
		writePositions();
		applyScene();
	}

	/** runtime 座標 → Points buffer＋空間格網（只在座標改變時） */
	function writePositions() {
		const s = rt.snapshot();
		if (s.ids !== ids) return syncIds();
		const a = pointGeom.getAttribute('position') as THREE_NS.BufferAttribute;
		(a.array as Float32Array).set(s.positions);
		a.needsUpdate = true;
		grid = buildGrid(s.positions);
		writeRing();
		writeBase();
		dirty = true;
	}

	function writeRing() {
		if (root < 0) return;
		const pos = P();
		const a = ringGeom.getAttribute('position') as THREE_NS.BufferAttribute;
		a.setXYZ(0, pos[root * 3], pos[root * 3 + 1], pos[root * 3 + 2]);
		a.needsUpdate = true;
	}

	/** 全圖連線的座標（座標改變時就地寫入，O(邊數)） */
	function writeBase() {
		const a = baseGeom.getAttribute('position') as THREE_NS.BufferAttribute | undefined;
		if (!a || a.count !== from.length * 2) return;
		const pos = P();
		const arr = a.array as Float32Array;
		for (let e = 0; e < from.length; e++) {
			arr.set(pos.subarray(from[e] * 3, from[e] * 3 + 3), e * 6);
			arr.set(pos.subarray(to[e] * 3, to[e] * 3 + 3), e * 6 + 3);
		}
		a.needsUpdate = true;
	}

	/** 可見子圖 → 可見遮罩、邊索引、基本顏色 */
	function applyScene() {
		const index = rt.snapshot().index;
		const n = ids.length;
		visible = new Uint8Array(n);
		typeColor = new Array(n).fill(PALETTE.DIM);
		for (const node of graph.nodes) {
			const i = index.get(node.id);
			if (i === undefined) continue;
			visible[i] = 1;
			typeColor[i] = o.nodeColor(node.type);
		}
		root = index.get(ROOT_ID) ?? -1;
		if (root >= 0 && visible[root]) typeColor[root] = PALETTE.ROOT;
		writeRing();
		const es = graph.edges.filter((e) => index.has(e.from) && index.has(e.to));
		edgeIds = es.map((e) => e.id);
		edgeIndex = new Map(edgeIds.map((id, k) => [id, k]));
		from = Uint32Array.from(es, (e) => index.get(e.from)!);
		to = Uint32Array.from(es, (e) => index.get(e.to)!);
		bidi = Uint8Array.from(es, (e) => (e.bidirectional ? 1 : 0));
		adjacency = buildAdjacency(n, from, to);
		// 全圖連線重配：每端用自己系統的顏色（線呈漸層）
		baseGeom.dispose();
		baseGeom = new THREE.BufferGeometry();
		const m = es.length;
		const col = new Float32Array(m * 6);
		for (let e = 0; e < m; e++)
			for (const [k, i] of [
				[0, from[e]],
				[1, to[e]]
			]) {
				c.set(typeColor[i]);
				col.set([c.r, c.g, c.b], e * 6 + k * 3);
			}
		baseGeom.setAttribute(
			'position',
			new THREE.BufferAttribute(new Float32Array(m * 6), 3).setUsage(THREE.DynamicDrawUsage)
		);
		baseGeom.setAttribute('color', new THREE.BufferAttribute(col, 3));
		baseLines.geometry = baseGeom;
		writeBase();
		applyFocus();
	}

	/** 高亮／狀態 → 每個節點的顏色與 Points 尺寸（選取改變時，不是每次相機改變） */
	function applyFocus() {
		const f = focus;
		const index = rt.snapshot().index;
		const fn = f?.nodes ?? null;
		focusIdx = {
			selected: f?.selected ? (index.get(f.selected) ?? -1) : -1,
			nodes: fn ? [...fn].flatMap((id) => index.get(id) ?? []) : [],
			edges: f?.edges ? [...f.edges].flatMap((id) => edgeIndex.get(id) ?? []) : [],
			edge: f?.selectedEdge ? (edgeIndex.get(f.selectedEdge) ?? -1) : -1
		};
		for (let i = 0; i < ids.length; i++) {
			const id = ids[i];
			let col = typeColor[i];
			const issue = !!f && (f.warn.has(id) || f.broken.has(id));
			if (f?.warn.has(id)) col = PALETTE.WARN;
			else if (f?.broken.has(id)) col = PALETTE.BROKEN;
			if (fn && !fn.has(id)) col = PALETTE.DIM;
			else if (i === focusIdx.selected) col = PALETTE.SEL;
			else if (f?.path && fn) col = PALETTE.PATH;
			c.set(col);
			colors[i * 3] = c.r;
			colors[i * 3 + 1] = c.g;
			colors[i * 3 + 2] = c.b;
			base[i] = visible[i] ? (i === root ? ROOT_SIZE : issue ? 1.6 : 1) : 0;
		}
		// 光環：根節點被篩掉就關；聚焦時退到背景（根節點在聚焦集合內則照亮）
		ringMat.uniforms.strength.value =
			root < 0 || !visible[root] ? 0 : fn && !fn.has(ROOT_ID) ? 0.25 : 1;
		(pointGeom.getAttribute('tint') as THREE_NS.BufferAttribute).needsUpdate = true;
		writeSizes([], true);
		baseMat.opacity = fn ? BASE_DIM_OPACITY : baseOpacity(from.length);
		dirty = labelsDirty = true;
	}

	/** Points 尺寸：升級為 detail 的節點設 0（不重複繪製） */
	function writeSizes(detail: readonly number[], reset = false) {
		const a = pointGeom.getAttribute('size') as THREE_NS.BufferAttribute | undefined;
		if (!a) return;
		const arr = a.array as Float32Array;
		if (reset) arr.set(base);
		else for (const i of prevDetail) arr[i] = base[i];
		for (const i of detail) arr[i] = 0;
		prevDetail = [...detail];
		a.needsUpdate = true;
	}

	const camKey = (cam: THREE_NS.PerspectiveCamera, w: number, h: number) => {
		const k = new Float64Array(20);
		k.set(cam.matrixWorldInverse.elements);
		k[16] = w;
		k[17] = h;
		k[18] = cam.projectionMatrix.elements[0];
		k[19] = cam.projectionMatrix.elements[5];
		return k;
	};
	const same = (a: Float64Array, b: Float64Array) => a.every((x, k) => x === b[k]);

	function currentView() {
		const cam = o.camera();
		const { width, height } = o.size();
		const p = cam.position;
		return makeView(
			cam.projectionMatrix.elements,
			cam.matrixWorldInverse.elements,
			[p.x, p.y, p.z],
			width,
			height
		);
	}

	/** 每次 render 前：相機或資料有變才重算 LOD 並寫入有上限的 buffer */
	function update(now = performance.now()) {
		const cam = o.camera();
		const { width, height } = o.size();
		if (!width || !height) return;
		const key = camKey(cam, width, height);
		const moved = !same(key, lastCam);
		if (moved) lastCam = key;
		if (statsPending && now - lastStats >= STATS_MS) emitStats(now);
		if (!moved && !dirty && !labelsDirty) return;
		const t0 = performance.now();
		view = currentView();
		pointMat.uniforms.focal.value = view.focal;
		pointMat.uniforms.dpr.value = o.pixelRatio();
		ringMat.uniforms.focal.value = view.focal;
		ringMat.uniforms.dpr.value = o.pixelRatio();
		flowMat.uniforms.focal.value = view.focal;
		flowMat.uniforms.dpr.value = o.pixelRatio();
		// 轉動中只重新投影既有標籤；停下（或間隔到了）才重新挑選與避碰
		const full = !state || !moved || now - lastFull >= LOD.labelThrottleMs;
		const f = computeFrame(
			{
				ids,
				positions: rt.snapshot().positions,
				grid,
				visible,
				view,
				edges: { ids: edgeIds, from, to, adjacency },
				selected: focusIdx.selected,
				hover,
				focus: focusIdx.nodes,
				highlight: focusIdx.edges,
				highlightTotal: focus?.highlightTotal ?? 0,
				selectedEdge: focusIdx.edge,
				labelWidth: widthOf,
				labels: full ? 'full' : 'reproject'
			},
			state
		);
		state = f.state;
		frame = f;
		if (full) {
			lastFull = now;
			labelsDirty = false;
		} else labelsDirty = true;
		dirty = false;
		writeDetail(f);
		writeLocal(f);
		writeHighlight(f);
		writeLabels(f);
		writeRootLabel(view);
		frames++;
		lodMs = performance.now() - t0;
		lodMaxMs = Math.max(lodMaxMs, lodMs);
		statsPending = true;
		if (now - lastStats >= STATS_MS) emitStats(now);
	}

	function emitStats(now: number) {
		if (!frame) return;
		lastStats = now;
		statsPending = false;
		o.onStats(frame.stats);
	}

	const P = () => rt.snapshot().positions;

	function writeDetail(f: Frame) {
		const pos = P();
		f.detail.forEach((i, k) => {
			const s = base[i];
			m4.makeScale(s, s, s).setPosition(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
			detailMesh.setMatrixAt(k, m4);
			detailMesh.setColorAt(k, c.setRGB(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]));
		});
		detailMesh.count = f.detail.length;
		detailMesh.instanceMatrix.needsUpdate = true;
		detailMesh.instanceColor!.needsUpdate = true;
		writeSizes(f.detail);
	}

	function seg(l: THREE_NS.LineSegments, k: number, a: number, b: number, col: THREE_NS.Color) {
		const pos = P();
		const pa = l.geometry.getAttribute('position') as THREE_NS.BufferAttribute;
		const ca = l.geometry.getAttribute('color') as THREE_NS.BufferAttribute;
		pa.setXYZ(k * 2, pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]);
		pa.setXYZ(k * 2 + 1, pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]);
		ca.setXYZ(k * 2, col.r, col.g, col.b);
		ca.setXYZ(k * 2 + 1, col.r, col.g, col.b);
	}
	const finish = (l: THREE_NS.LineSegments, n: number) => {
		l.geometry.setDrawRange(0, n * 2);
		l.geometry.getAttribute('position').needsUpdate = true;
		l.geometry.getAttribute('color').needsUpdate = true;
	};

	function writeLocal(f: Frame) {
		const dim = !!focus?.nodes;
		f.localEdges.forEach((e, k) => {
			const i = from[e];
			if (dim) c.set(PALETTE.DIM);
			else c.set(typeColor[i]);
			seg(localLines, k, from[e], to[e], c);
		});
		finish(localLines, f.localEdges.length);
	}

	function writeHighlight(f: Frame) {
		const tone = focus?.path ? PALETTE.PATH : PALETTE.LINK_HL;
		const pos = P();
		let n = 0;
		const arrow = (a: number, b: number) => {
			const dx = pos[b * 3] - pos[a * 3];
			const dy = pos[b * 3 + 1] - pos[a * 3 + 1];
			const dz = pos[b * 3 + 2] - pos[a * 3 + 2];
			const len = Math.hypot(dx, dy, dz);
			if (len < 14) return;
			v3.set(dx / len, dy / len, dz / len);
			q.setFromUnitVectors(UP, v3);
			const back = R * base[b] + 4;
			m4.compose(
				new THREE.Vector3(
					pos[b * 3] - v3.x * back,
					pos[b * 3 + 1] - v3.y * back,
					pos[b * 3 + 2] - v3.z * back
				),
				q,
				S1
			);
			arrows.setMatrixAt(n, m4);
			arrows.setColorAt(n, c);
			n++;
		};
		const fa = flowGeom.attributes;
		let m = 0;
		f.highlightEdges.forEach((e, k) => {
			c.set(e === focusIdx.edge ? PALETTE.SEL : tone);
			seg(hiLines, k, from[e], to[e], c);
			arrow(from[e], to[e]);
			if (bidi[e]) arrow(to[e], from[e]);
			// 雙向邊沒有單一流向：不放光點
			else
				for (let j = 0; j < FLOW; j++, m++) {
					fa.position.setXYZ(m, pos[from[e] * 3], pos[from[e] * 3 + 1], pos[from[e] * 3 + 2]);
					fa.b.setXYZ(m, pos[to[e] * 3], pos[to[e] * 3 + 1], pos[to[e] * 3 + 2]);
					fa.phase.setX(m, j / FLOW);
					fa.tint.setXYZ(m, c.r, c.g, c.b);
				}
		});
		finish(hiLines, f.highlightEdges.length);
		flowGeom.setDrawRange(0, m);
		for (const a of Object.values(fa)) (a as THREE_NS.BufferAttribute).needsUpdate = true;
		arrows.count = n;
		arrows.instanceMatrix.needsUpdate = true;
		arrows.instanceColor!.needsUpdate = true;
	}

	function writeLabels(f: Frame) {
		const sel = focusIdx.selected;
		const ls = f.labels.filter((l) => l.node !== root);
		pool.forEach((slot, k) => {
			const l = ls[k];
			const st = slot.el.style;
			if (!l) {
				if (slot.shown) st.display = 'none';
				slot.shown = false;
				slot.node = -1;
				return;
			}
			if (slot.node !== l.node || slot.gen !== labelGen) {
				slot.node = l.node;
				slot.gen = labelGen;
				slot.el.textContent = o.name(l.id);
				slot.el.dataset.id = l.id;
			}
			if (slot.w !== l.w) st.width = `${(slot.w = l.w)}px`;
			if (!slot.shown) st.display = 'block';
			slot.shown = true;
			const isSel = l.node === sel;
			if (slot.sel !== isSel) {
				slot.sel = isSel;
				st.fontWeight = isSel ? '600' : '400';
				st.outline = isSel ? '1px solid #fff' : 'none';
			}
			st.transform = `translate(${l.x}px,${l.y}px)`;
		});
	}

	function writeRootLabel(v: View) {
		const st = rootLabel.style;
		const pos = P();
		const p =
			root >= 0 && visible[root]
				? project(v, pos[root * 3], pos[root * 3 + 1], pos[root * 3 + 2])
				: null;
		if (!p || p.x < 0 || p.y < 0 || p.x > v.width || p.y > v.height) {
			st.display = 'none';
			return;
		}
		const text = o.name(ROOT_ID);
		if (text !== rootText) {
			rootText = text;
			rootLabel.dataset.id = ROOT_ID;
			rootLabel.innerHTML =
				'<div style="font-size:9px;font-weight:500;letter-spacing:.3em;color:#a5b4fc">ROOT</div>';
			rootLabel.append(text);
		}
		const ringPx = Math.max((ROOT_SIZE * RING * R * v.focal) / p.depth, RING_MIN_PX);
		st.display = 'block';
		st.opacity = focus?.nodes && !focus.nodes.has(ROOT_ID) ? '.35' : '1';
		st.transform = `translate(${p.x}px,${p.y + ringPx + 6}px) translateX(-50%)`;
	}

	// ---- 外部介面 ----
	const off = (() => {
		const prev = scene.onBeforeRender;
		scene.onBeforeRender = (...args) => {
			prev.apply(scene, args);
			ringMat.uniforms.time.value = performance.now() / 1000;
			if (!still?.matches) flowMat.uniforms.time.value = performance.now() / 1000;
			update();
		};
		const restore = () => (scene.onBeforeRender = prev);
		undo.push(restore);
		return restore;
	})();
	syncIds();

	return {
		/** 可見子圖（拓撲或系統篩選改變） */
		setGraph(g: Graph) {
			graph = g;
			syncIds();
			applyScene();
		},
		setFocus(f: Focus) {
			focus = f;
			applyFocus();
		},
		/** runtime 座標改變 */
		positions: writePositions,
		/** 名稱改了：標籤重寫文字與寬度，不碰版面 */
		refreshLabels() {
			widths.clear();
			rootText = '';
			labelGen++;
			labelsDirty = true;
		},
		/** 尺寸／DPR 改變 */
		invalidate() {
			dirty = labelsDirty = true;
		},
		setHover(x: number | null, y = 0) {
			const h = x === null ? -1 : pickIndex(x, y);
			if (h === hover) return h;
			hover = h;
			labelsDirty = dirty = true;
			return h;
		},
		/** 畫布 CSS 座標 → 節點 id（沒有點中回 null） */
		pick(x: number, y: number) {
			const i = pickIndex(x, y);
			return i < 0 ? null : ids[i];
		},
		/** 立即算一次（測試／量測用，不等下一幀） */
		flush() {
			dirty = true;
			update();
		},
		frame: () => frame,
		perf: () => ({ lodMs, lodMaxMs, frames }),
		/** 節點在畫布上的 CSS 座標；相機背後或隱藏回 null */
		project(id: string): ScreenPoint | null {
			const i = rt.snapshot().index.get(id);
			if (i === undefined || !visible[i]) return null;
			const v = currentView();
			const pos = P();
			const p = project(v, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
			return p && { id, ...p, px: (R * v.focal) / p.depth };
		},
		/** 畫面內所有可見節點的投影（e2e 找重疊點用） */
		projectAll(): ScreenPoint[] {
			const v = currentView();
			const pos = P();
			const out: ScreenPoint[] = [];
			for (let i = 0; i < ids.length; i++) {
				if (!visible[i]) continue;
				const p = project(v, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
				if (p && p.x >= 0 && p.y >= 0 && p.x <= v.width && p.y <= v.height)
					out.push({ id: ids[i], ...p, px: (R * v.focal) / p.depth });
			}
			return out;
		},
		dispose() {
			off();
			for (const x of [
				points,
				detailMesh,
				localLines,
				hiLines,
				arrows,
				baseLines,
				stars,
				ring,
				flow
			])
				x.removeFromParent();
			pointGeom.dispose();
			baseGeom.dispose();
			detailMesh.dispose();
			arrows.dispose();
			for (const d of disposables) d.dispose();
			for (const s of pool) s.el.remove();
			rootLabel.remove();
		}
	};

	function pickIndex(x: number, y: number) {
		const v = currentView();
		// 與畫面一致：detail 球用物理大小、其他是封頂的 Points；倍率＝Points 的 base（問題節點 1.6）
		return pick({
			positions: P(),
			grid,
			visible,
			view: v,
			ray: pickRay(v, x, y),
			x,
			y,
			scale: base,
			detail: state?.detail
		});
	}
}

export type UniverseLayers = ReturnType<typeof createUniverseLayers>;
