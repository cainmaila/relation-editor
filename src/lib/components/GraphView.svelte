<script lang="ts">
	// 全圖（只讀）：3d-force-graph 的相機與渲染，節點用 InstancedMesh、邊用單一 LineSegments（10k 節點仍 60 fps）。
	// 版面在 Web Worker 算好才畫；選取／找客戶／標示都只改顏色，不重算版面。
	import { onMount, untrack } from 'svelte';
	import { fade } from 'svelte/transition';
	import type { Editor } from '#lib/editor.svelte.js';
	import { SYSTEM_COLORS } from '#lib/components/Canvas.svelte';
	import { UNREACHABLE_LABEL, nodeType } from '#lib/model/config.js';
	import type * as THREE from 'three';
	import type { Graph } from '#lib/model/types.js';
	import type { LayoutOut } from '#lib/layout-sim.js';
	import type { GraphProbe } from '#lib/measure.js';

	// probe：只有量測入口傳入，記錄 layout／相機可操作的時間點
	let { editor, probe }: { editor: Editor; probe?: GraphProbe } = $props();

	const DIM = '#1e293b';
	const LINK_HL = '#e2e8f0';
	const PATH = '#22d3ee';
	const SEL = '#ffffff';
	const WARN = '#facc15';
	const BROKEN = '#fb7185';
	/** 定位單一節點時鏡頭與節點的距離 */
	const DIST = 160;
	const TICKS = 100;

	type Api = {
		build: (g: Graph) => void;
		paint: () => void;
		fly: (ids: string[], ms?: number) => void;
		pick: (id: string) => void;
	};

	let host: HTMLDivElement;
	let api = $state.raw<Api | null>(null);
	let loading = $state(true);
	let ready = $state(false);
	let focusNodes: Set<string> | null = null;

	onMount(() => {
		let dead = false;
		let off: (() => void) | undefined;
		init().then((f) => (dead ? f.off() : ((off = f.off), (api = f.api))));
		return () => {
			dead = true;
			api = null;
			off?.();
		};
	});

	// 系統勾選改變才重建資料、重算版面
	$effect(() => {
		const a = api;
		const g = editor.graphVisible;
		if (a) untrack(() => a.build(g));
	});

	$effect(() => {
		const a = api;
		void [editor.selected, editor.result, editor.unprocessed, editor.unreachable];
		if (a) untrack(() => a.paint());
	});

	// 視野請求（reveal／findCustomers／fit）；版面還沒好時 build 完成後補上
	$effect(() => {
		const a = api;
		const v = editor.view;
		if (a && v.seq) untrack(() => a.fly(v.ids));
	});

	async function init() {
		const [{ default: ForceGraph3D }, THREE] = await Promise.all([
			import('3d-force-graph'),
			import('three')
		]);
		const fg = new ForceGraph3D(host).backgroundColor('#0b1020').showNavInfo(false);
		const canvas = fg.renderer().domElement;
		probe?.renderer(fg.renderer());
		probe?.mark('graph:init');

		let g: Graph = { nodes: [], edges: [] };
		let ids: string[] = [];
		let pos: Float32Array = new Float32Array(0);
		let idx = new Map<string, number>();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 非響應的內部索引
		let inc = new Map<string, { edge: number; other: string }[]>();
		let colors: string[] = [];
		let worker: Worker | null = null;
		let im: THREE.InstancedMesh | null = null;
		let pendingView = false;
		let center = new THREE.Vector3();
		let radius = 1;

		const nodeMat = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.85 });
		const edgeMat = new THREE.LineBasicMaterial({
			vertexColors: true,
			transparent: true,
			opacity: 0.3,
			depthWrite: false
		});
		const hiMat = new THREE.LineBasicMaterial({ vertexColors: true, depthWrite: false });
		const nodeGeom = new THREE.SphereGeometry(4, 8, 8);
		let edgeLine: THREE.LineSegments | null = null;
		let hiLine: THREE.LineSegments | null = null;

		const clearScene = () => {
			for (const o of [im, edgeLine, hiLine]) {
				o?.removeFromParent();
				if (o && o !== im) o.geometry.dispose();
			}
			im?.dispose();
			im = edgeLine = hiLine = null;
		};

		const at = (id: string) => {
			const i = idx.get(id)! * 3;
			return new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]);
		};

		const fly = (target: string[], ms = 600) => {
			if (!ids.length) return void (pendingView = true);
			const sel = target.filter((id) => idx.has(id));
			const pts = sel.length ? sel.map(at) : ids.map((_, i) => at(ids[i]));
			const c = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(pts.length);
			const r = Math.max(...pts.map((p) => p.distanceTo(c)));
			const d = pts.length === 1 ? DIST : Math.max(r * 2.5, 60);
			fg.cameraPosition({ x: c.x, y: c.y, z: c.z + d }, c, ms);
		};

		// 相機離圖心越遠邊越淡，拉近越清楚
		const lod = () => {
			const t = Math.min(
				1,
				Math.max(0, (1.5 - fg.camera().position.distanceTo(center) / radius) / 1.2)
			);
			edgeMat.opacity = 0.04 + 0.5 * t;
		};
		(fg.controls() as EventTarget).addEventListener('change', lod);

		const paint = () => {
			if (!im || !edgeLine) return;
			const res = editor.result;
			const sel = editor.selected;
			const edgeAt = (i: number) => g.edges[i];
			let fn: Set<string> | null = null;
			let fl: Set<number> | null = null;
			const path = !!res;
			if (res) {
				fn = res.nodes;
				fl = new Set(g.edges.flatMap((e, i) => (res.edges.has(e.id) ? [i] : [])));
			} else if (sel?.kind === 'node' && idx.has(sel.id)) {
				const near = inc.get(sel.id) ?? [];
				fn = new Set([sel.id, ...near.map((x) => x.other)]);
				fl = new Set(near.map((x) => x.edge));
			} else if (sel?.kind === 'edge') {
				const i = g.edges.findIndex((e) => e.id === sel.id);
				if (i >= 0) {
					fn = new Set([g.edges[i].from, g.edges[i].to]);
					fl = new Set([i]);
				}
			}
			focusNodes = fn;

			const c = new THREE.Color();
			ids.forEach((id, i) => {
				let col = colors[i];
				if (editor.unprocessed.has(id)) col = WARN;
				else if (editor.unreachable.has(id)) col = BROKEN;
				if (fn && !fn.has(id)) col = DIM;
				else if (sel?.kind === 'node' && id === sel.id) col = SEL;
				else if (path && fn) col = PATH;
				im!.setColorAt(i, c.set(col));
			});
			im.instanceColor!.needsUpdate = true;

			const ec = edgeLine.geometry.getAttribute('color') as THREE.BufferAttribute;
			g.edges.forEach((e, i) => {
				c.set(fl ? DIM : colors[idx.get(e.from)!]);
				ec.setXYZ(i * 2, c.r, c.g, c.b);
				ec.setXYZ(i * 2 + 1, c.r, c.g, c.b);
			});
			ec.needsUpdate = true;

			// 高亮邊另畫在不透明的一層；找客戶路徑加箭頭（V 形，畫在終點節點外緣）
			hiLine?.removeFromParent();
			hiLine?.geometry.dispose();
			hiLine = null;
			if (!fl) return;
			const p: number[] = [];
			const seg = (a: THREE.Vector3, b: THREE.Vector3) => p.push(a.x, a.y, a.z, b.x, b.y, b.z);
			const arrow = (a: THREE.Vector3, b: THREE.Vector3) => {
				const d = b.clone().sub(a);
				const len = d.length();
				if (len < 14) return;
				d.divideScalar(len);
				const side = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0));
				if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
				side.normalize().multiplyScalar(3);
				const tip = b.clone().addScaledVector(d, -5);
				const back = tip.clone().addScaledVector(d, -6);
				seg(tip, back.clone().add(side));
				seg(tip, back.clone().sub(side));
			};
			for (const i of fl) {
				const e = edgeAt(i);
				const a = at(e.from);
				const b = at(e.to);
				seg(a, b);
				if (path) {
					arrow(a, b);
					if (e.bidirectional) arrow(b, a);
				}
			}
			const hc = new THREE.Color(path ? PATH : LINK_HL);
			const col = Array.from({ length: p.length }, (_, k) => [hc.r, hc.g, hc.b][k % 3]);
			const geom = new THREE.BufferGeometry();
			geom.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
			geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
			hiLine = new THREE.LineSegments(geom, hiMat);
			hiLine.frustumCulled = false;
			fg.scene().add(hiLine);
		};

		const done = () => {
			const n = ids.length;
			const m = new THREE.Matrix4();
			clearScene();
			im = new THREE.InstancedMesh(nodeGeom, nodeMat, n);
			im.frustumCulled = false;
			ids.forEach((id, i) => {
				const s = editor.unprocessed.has(id) || editor.unreachable.has(id) ? 1.6 : 1;
				im!.setMatrixAt(
					i,
					m.makeScale(s, s, s).setPosition(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
				);
				im!.setColorAt(i, new THREE.Color(colors[i]));
			});
			fg.scene().add(im);

			const ep = new Float32Array(g.edges.length * 6);
			g.edges.forEach((e, i) => {
				ep.set(at(e.from).toArray(), i * 6);
				ep.set(at(e.to).toArray(), i * 6 + 3);
			});
			const eg = new THREE.BufferGeometry();
			eg.setAttribute('position', new THREE.BufferAttribute(ep, 3));
			eg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.edges.length * 6), 3));
			edgeLine = new THREE.LineSegments(eg, edgeMat);
			edgeLine.frustumCulled = false;
			fg.scene().add(edgeLine);

			center = new THREE.Vector3();
			for (let i = 0; i < n; i++) center.add(at(ids[i]));
			center.divideScalar(Math.max(n, 1));
			radius = Math.max(1, ...ids.map((id) => at(id).distanceTo(center))) * 1.2;
			lod();
			paint();
			fly(pendingView ? editor.view.ids : [], 0);
			pendingView = false;
			ready = true;
			loading = false;
			probe?.mark('layout:ready', { nodes: n, edges: g.edges.length });
		};

		const build = (graph: Graph) => {
			worker?.terminate();
			ready = false;
			loading = true;
			g = graph;
			ids = graph.nodes.map((n) => n.id);
			idx = new Map(ids.map((id, i) => [id, i]));
			colors = graph.nodes.map((n) => SYSTEM_COLORS[nodeType(n.type).system ?? '通用']);
			inc = new Map();
			const list = (id: string) => inc.get(id) ?? inc.set(id, []).get(id)!;
			graph.edges.forEach((e, i) => {
				list(e.from).push({ edge: i, other: e.to });
				list(e.to).push({ edge: i, other: e.from });
			});
			if (!ids.length) {
				pos = new Float32Array(0);
				clearScene();
				loading = false;
				return;
			}
			worker = new Worker(new URL('../layout.worker.ts', import.meta.url), { type: 'module' });
			worker.onmessage = (e: MessageEvent<LayoutOut & { recvAt: number; doneAt: number }>) => {
				pos = e.data.pos;
				const t0 = performance.timeOrigin;
				probe?.mark('layout:worker-done', {
					tickMs: [...e.data.tickMs],
					recvAt: e.data.recvAt - t0,
					doneAt: e.data.doneAt - t0
				});
				worker?.terminate();
				worker = null;
				done();
			};
			probe?.mark('layout:start', { nodes: ids.length, edges: graph.edges.length });
			worker.postMessage({
				n: ids.length,
				links: graph.edges.map((e) => [idx.get(e.from)!, idx.get(e.to)!]),
				ticks: TICKS,
				init: probe?.init ?? 'zero'
			});
		};

		// InstancedMesh 不走 raycast，點擊改以螢幕座標找最近的節點（10px 內）
		let down = { x: 0, y: 0 };
		const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
		const onClick = (e: MouseEvent) => {
			if (!ready || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
			const r = canvas.getBoundingClientRect();
			let best: string | null = null;
			let bd = 10;
			ids.forEach((id) => {
				const q = fg.graph2ScreenCoords(...(at(id).toArray() as [number, number, number]));
				const d = Math.hypot(q.x + r.left - e.clientX, q.y + r.top - e.clientY);
				if (d < bd) [bd, best] = [d, id];
			});
			editor.select(best ? { kind: 'node', id: best } : null);
		};
		canvas.addEventListener('pointerdown', onDown);
		canvas.addEventListener('click', onClick);

		const ro = new ResizeObserver(() => fg.width(host.clientWidth).height(host.clientHeight));
		ro.observe(host);

		const view = {
			get ready() {
				return ready;
			},
			selected: () => (editor.selected?.kind === 'node' ? editor.selected.id : null),
			highlighted: () => [...(focusNodes ?? [])],
			click: (id: string) => editor.select({ kind: 'node', id }),
			search: (name: string) => {
				const ns = editor.graphVisible.nodes;
				const n = ns.find((x) => x.name === name) ?? ns.find((x) => x.name.includes(name));
				if (!n) return null;
				editor.select({ kind: 'node', id: n.id });
				editor.fit([n.id]);
				return n.id;
			},
			find: (id: string) => editor.findCustomers(id),
			// 唯讀掛勾，供 e2e 驗證 PRD 的節點／邊數量（3D 畫面讀不到 DOM）
			nodeCount: () => ids.length,
			edgeCount: () => g.edges.length
		};
		(window as unknown as { __graphView?: typeof view }).__graphView = view;

		return {
			api: { build, paint, fly, pick: () => {} } satisfies Api,
			off: () => {
				delete (window as unknown as { __graphView?: typeof view }).__graphView;
				ro.disconnect();
				canvas.removeEventListener('pointerdown', onDown);
				canvas.removeEventListener('click', onClick);
				(fg.controls() as EventTarget).removeEventListener('change', lod);
				worker?.terminate();
				clearScene();
				nodeGeom.dispose();
				nodeMat.dispose();
				edgeMat.dispose();
				hiMat.dispose();
				fg._destructor();
			}
		};
	}
</script>

<div class="relative size-full bg-[#0b1020]">
	<div bind:this={host} class="absolute inset-0"></div>
	<ul class="absolute bottom-3 left-3 space-y-1 text-xs text-slate-300">
		<li>
			<span class="mr-1.5 inline-block size-2 rounded-full" style:background={WARN}></span>未處理
		</li>
		<li>
			<span class="mr-1.5 inline-block size-2 rounded-full" style:background={BROKEN}
			></span>{UNREACHABLE_LABEL}
		</li>
		{#if editor.result}
			<li>
				<span class="mr-1.5 inline-block size-2 rounded-full" style:background={PATH}
				></span>找客戶路徑
			</li>
		{/if}
	</ul>
	{#if loading}
		<div
			out:fade={{ duration: 300 }}
			onoutroend={() => probe?.mark('camera:interactive')}
			class="absolute inset-0 grid place-items-center bg-[#0b1020]/70 text-sm text-slate-200"
		>
			計算版面中…
		</div>
	{/if}
</div>
