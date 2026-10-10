<script lang="ts">
	// 全圖（只讀）：3d-force-graph 只提供相機／場景／控制（不給它 graphData，不跑它的模擬），
	// 節點用 InstancedMesh、邊用單一 LineSegments。座標由 editor.universe（session runtime）持有：
	// 掛載當下就畫初始座標，背景 Worker 的分段結果直接就地更新 GPU buffer，不經 Svelte state。
	// 系統篩選、選取、找客戶只換繪製子集合或顏色，不重算版面；重新整理版面只由按鈕觸發。
	import { onMount, untrack } from 'svelte';
	import type { Editor } from '#lib/editor.svelte.js';
	import { SYSTEM_COLORS } from '#lib/components/Canvas.svelte';
	import { UNREACHABLE_LABEL, nodeType } from '#lib/model/config.js';
	import type * as THREE from 'three';
	import type { Graph } from '#lib/model/types.js';
	import type { GraphProbe } from '#lib/measure.js';
	import type { CameraDriver, CameraPose, LayoutStatus } from '#lib/universe/runtime.js';

	// probe：只有量測入口傳入，記錄首幀／相機可操作／版面整理的時間點
	let { editor, probe }: { editor: Editor; probe?: GraphProbe } = $props();

	const DIM = '#1e293b';
	const LINK_HL = '#e2e8f0';
	const PATH = '#22d3ee';
	const SEL = '#ffffff';
	const WARN = '#facc15';
	const BROKEN = '#fb7185';
	/** 定位單一節點時鏡頭與節點的距離 */
	const DIST = 160;

	type Api = { build: (g: Graph) => void; paint: () => void };
	type Hooks = Record<string, unknown>;

	const rt = untrack(() => editor.universe);
	let host: HTMLDivElement;
	let api = $state.raw<Api | null>(null);
	let ready = $state(false);
	/** renderer 層的失敗（載入模組、WebGL 建立、context lost）；搜尋與編輯不受影響 */
	let failure = $state<string | null>(null);
	let attempt = $state(0);
	let layout = $state.raw<LayoutStatus>(rt.status);
	let focusNodes: Set<string> | null = null;
	/** 掛載前就發生的視野請求屬於其他頁（2D）；這次掛載只接手之後的請求 */
	let seenSeq = untrack(() => editor.view.seq);

	// 版面狀態（約每 200ms 一次）才進 Svelte；座標不進
	onMount(() =>
		rt.subscribe((e) => {
			if (e === 'status') layout = rt.status;
		})
	);

	$effect(() => {
		void attempt;
		let dead = false;
		let off: (() => void) | undefined;
		untrack(() => {
			failure = null;
			init(() => dead)
				.then((f) => {
					if (dead) f.off();
					else [off, api] = [f.off, f.api];
				})
				.catch((e: unknown) => {
					if (dead) return;
					console.error('3D 宇宙載入失敗', e);
					failure = `3D 宇宙載入失敗：${e instanceof Error ? e.message : String(e)}`;
				});
		});
		return () => {
			dead = true;
			api = null;
			ready = false;
			off?.();
		};
	});

	// 只有拓撲（topologyRevision）或系統勾選改變才換繪製子集合；改名／屬性不觸發，也不碰版面
	$effect(() => {
		const a = api;
		const g = editor.sceneGraph;
		if (a) untrack(() => a.build(g));
	});

	$effect(() => {
		const a = api;
		void [editor.selected, editor.result, editor.unprocessed, editor.unreachable];
		if (a) untrack(() => a.paint());
	});

	// 視野請求（reveal／找客戶／全景）；renderer 未就緒時由 runtime 排隊，只留最後一次
	$effect(() => {
		const v = editor.view;
		if (v.seq === seenSeq) return;
		seenSeq = v.seq;
		untrack(() => rt.camera.request(v.ids));
	});

	const phaseText = (s: LayoutStatus) => {
		const t = `${s.tick}/${s.budget}`;
		if (s.phase === 'running') return `初始版面・背景整理中 ${t}`;
		if (s.phase === 'done') return `版面已凍結（計算預算 ${s.budget} 步，非保證收斂）`;
		if (s.phase === 'error') return `版面整理失敗：${s.message ?? ''}`;
		if (s.phase === 'stopped')
			return s.reason === 'topology'
				? '資料已變更，整理已取消'
				: s.reason === 'detached'
					? `離開畫面時已停止整理（${t}）`
					: `已停止整理（${t}）`;
		return '初始版面（尚未整理）';
	};

	async function init(isDead: () => boolean): Promise<{ api: Api; off: () => void }> {
		const [{ default: ForceGraph3D }, THREE] = await Promise.all([
			import('3d-force-graph'),
			import('three')
		]);
		const noop = { api: { build: () => {}, paint: () => {} }, off: () => {} };
		// 卸載後才載入完成：不建立任何 GPU 資源
		if (isDead()) return noop;

		const fg = new ForceGraph3D(host).backgroundColor('#0b1020').showNavInfo(false);
		const renderer = fg.renderer();
		if (!renderer?.getContext?.()) {
			fg._destructor();
			throw new Error('無法建立 WebGL');
		}
		const canvas = renderer.domElement;
		const controls = fg.controls() as EventTarget & { target: THREE.Vector3; update(): void };
		probe?.renderer(renderer);
		probe?.mark('graph:init');
		if (probe) rt.mark = probe.mark;

		let g: Graph = { nodes: [], edges: [] };
		let ids: string[] = [];
		let idx = new Map<string, number>();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 非響應的內部索引
		let inc = new Map<string, { edge: number; other: string }[]>();
		let colors: string[] = [];
		let im: THREE.InstancedMesh | null = null;
		let center = new THREE.Vector3();
		let radius = 1;
		let first = true;
		let frame = 0;

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

		/** runtime 的目前座標（全部節點，含被篩掉的） */
		const at = (id: string, v = new THREE.Vector3()) => {
			const s = rt.snapshot();
			const i = s.index.get(id);
			if (i === undefined) return null;
			return v.set(s.positions[i * 3], s.positions[i * 3 + 1], s.positions[i * 3 + 2]);
		};

		const fit = (target: readonly string[], ms: number) => {
			const pick = target.length ? target : ids;
			const pts = pick.flatMap((id) => at(id) ?? []);
			if (!pts.length) return;
			const c = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(pts.length);
			const r = Math.max(...pts.map((p) => p.distanceTo(c)));
			const d = pts.length === 1 ? DIST : Math.max(r * 2.5, 60);
			fg.cameraPosition({ x: c.x, y: c.y, z: c.z + d }, c, ms);
		};
		const xyz = (v: THREE.Vector3) => ({ x: v.x, y: v.y, z: v.z });
		// 每次相機入鏡呼叫（含當時版面狀態），供 e2e 直接觀察「晚到的自動入鏡」有沒有發生
		const fits: { ids: number; ms: number; phase: string }[] = [];
		const driver: CameraDriver = {
			fit: (target, ms) => {
				fits.push({ ids: target.length, ms, phase: rt.status.phase });
				fit(target, ms);
			},
			pose: (): CameraPose => ({
				position: xyz(fg.camera().position),
				target: xyz(controls.target)
			}),
			restore: (p) => fg.cameraPosition(p.position, p.target, 0)
		};

		// 相機離圖心越遠邊越淡，拉近越清楚
		const lod = () => {
			const t = Math.min(
				1,
				Math.max(0, (1.5 - fg.camera().position.distanceTo(center) / radius) / 1.2)
			);
			edgeMat.opacity = 0.04 + 0.5 * t;
		};
		const interacted = () => rt.camera.interacted();
		controls.addEventListener('change', lod);
		controls.addEventListener('start', interacted);

		/** 高亮邊另畫在不透明的一層；找客戶路徑加箭頭（V 形，畫在終點節點外緣） */
		const highlight = (fl: Set<number> | null, path: boolean) => {
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
				const e = g.edges[i];
				const a = at(e.from);
				const b = at(e.to);
				if (!a || !b) continue;
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

		let lastFocus: { fl: Set<number> | null; path: boolean } = { fl: null, path: false };
		const paint = () => {
			if (!im || !edgeLine) return;
			const res = editor.result;
			const sel = editor.selected;
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
			lastFocus = { fl, path };
			highlight(fl, path);
		};

		/** 把 runtime 目前座標就地寫進 GPU buffer（版面每段進度、拓撲 reconcile 後） */
		const place = () => {
			if (!im || !edgeLine) return;
			const m = new THREE.Matrix4();
			const v = new THREE.Vector3();
			center = new THREE.Vector3();
			ids.forEach((id, i) => {
				const p = at(id, v) ?? v.set(0, 0, 0);
				center.add(p);
				const s = editor.unprocessed.has(id) || editor.unreachable.has(id) ? 1.6 : 1;
				im!.setMatrixAt(i, m.makeScale(s, s, s).setPosition(p));
			});
			im.instanceMatrix.needsUpdate = true;
			center.divideScalar(Math.max(ids.length, 1));
			let r = 1;
			for (const id of ids) r = Math.max(r, at(id, v)?.distanceTo(center) ?? 0);
			radius = r * 1.2;

			const ep = edgeLine.geometry.getAttribute('position') as THREE.BufferAttribute;
			const w = new THREE.Vector3();
			g.edges.forEach((e, i) => {
				const a = at(e.from, v);
				const b = at(e.to, w);
				if (a) ep.setXYZ(i * 2, a.x, a.y, a.z);
				if (b) ep.setXYZ(i * 2 + 1, b.x, b.y, b.z);
			});
			ep.needsUpdate = true;
			lod();
			highlight(lastFocus.fl, lastFocus.path);
		};

		const build = (graph: Graph) => {
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
			clearScene();
			im = new THREE.InstancedMesh(nodeGeom, nodeMat, ids.length);
			im.frustumCulled = false;
			ids.forEach((_, i) => im!.setColorAt(i, new THREE.Color(colors[i])));
			fg.scene().add(im);
			const eg = new THREE.BufferGeometry();
			const n6 = graph.edges.length * 6;
			eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n6), 3));
			eg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n6), 3));
			edgeLine = new THREE.LineSegments(eg, edgeMat);
			edgeLine.frustumCulled = false;
			fg.scene().add(edgeLine);
			place();
			paint();
			if (!first) return;
			// 首幀：初始座標已上 GPU；相機接手（恢復上次姿態或整體入鏡），再背景開始整理
			first = false;
			ready = true;
			probe?.mark('universe:first-frame', { nodes: ids.length, edges: graph.edges.length });
			rt.camera.attach(driver);
			requestAnimationFrame(() => {
				if (isDead()) return;
				probe?.mark('camera:interactive');
				rt.startInitial();
			});
		};

		// 版面進度：一幀最多寫一次 GPU buffer
		const offPositions = rt.subscribe((e) => {
			if (e !== 'positions' || frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				place();
			});
		});

		// InstancedMesh 不走 raycast，點擊改以螢幕座標找最近的節點（10px 內）
		let down = { x: 0, y: 0 };
		const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
		const onClick = (e: MouseEvent) => {
			if (!ready || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
			const r = canvas.getBoundingClientRect();
			const v = new THREE.Vector3();
			let best: string | null = null;
			let bd = 10;
			for (const id of ids) {
				const p = at(id, v);
				if (!p) continue;
				const q = fg.graph2ScreenCoords(p.x, p.y, p.z);
				const d = Math.hypot(q.x + r.left - e.clientX, q.y + r.top - e.clientY);
				if (d < bd) [bd, best] = [d, id];
			}
			editor.select(best ? { kind: 'node', id: best } : null);
		};
		const onLost = (e: Event) => {
			e.preventDefault();
			ready = false;
			failure = '3D 繪圖內容遺失（WebGL context lost）';
		};
		const onRestored = () => {
			failure = null;
			ready = true;
			place();
			paint();
		};
		canvas.addEventListener('pointerdown', onDown);
		canvas.addEventListener('click', onClick);
		canvas.addEventListener('webglcontextlost', onLost);
		canvas.addEventListener('webglcontextrestored', onRestored);

		const ro = new ResizeObserver(() => fg.width(host.clientWidth).height(host.clientHeight));
		ro.observe(host);

		const view = {
			/** renderer 可操作且目前可見圖已畫出（不代表版面整理完成，見 layout()） */
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
			edgeCount: () => g.edges.length,
			// P5：版面與相機分開觀察
			layout: () => rt.status,
			workerStarts: () => rt.workerStarts,
			version: () => rt.snapshot().version,
			position: (id: string) => rt.position(id),
			pose: () => driver.pose(),
			fits: () => fits.map((f) => ({ ...f })),
			autoFit: () => rt.camera.autoFit,
			loseContext: () =>
				(
					renderer.getContext().getExtension('WEBGL_lose_context') as {
						loseContext(): void;
					} | null
				)?.loseContext()
		};
		const win = window as unknown as { __graphView?: Hooks };
		win.__graphView = view;

		return {
			api: { build, paint },
			off: () => {
				if (win.__graphView === view) delete win.__graphView;
				rt.camera.detach();
				rt.stop('detached');
				offPositions();
				cancelAnimationFrame(frame);
				ro.disconnect();
				canvas.removeEventListener('pointerdown', onDown);
				canvas.removeEventListener('click', onClick);
				canvas.removeEventListener('webglcontextlost', onLost);
				canvas.removeEventListener('webglcontextrestored', onRestored);
				controls.removeEventListener('change', lod);
				controls.removeEventListener('start', interacted);
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
	<div
		class="absolute right-3 bottom-3 flex items-center gap-2 rounded-lg border border-slate-700/60 bg-[#0b1020]/80 px-3 py-1.5 text-xs text-slate-200 backdrop-blur"
		role="group"
		aria-label="版面狀態"
		data-phase={layout.phase}
	>
		<span class="tabular-nums" aria-live="polite">{phaseText(layout)}</span>
		{#if layout.stale && layout.phase !== 'running'}
			<span class="text-amber-300">・資料已變更，版面未重整</span>
		{/if}
		{#if layout.phase === 'running'}
			<button class="rounded px-2 py-0.5 hover:bg-slate-700" onclick={() => rt.stop('user')}
				>停止</button
			>
		{:else}
			<button class="rounded px-2 py-0.5 hover:bg-slate-700" onclick={() => rt.start()}
				>{layout.phase === 'error' ? '重試整理' : '重新整理版面'}</button
			>
		{/if}
		<button
			class="rounded px-2 py-0.5 hover:bg-slate-700"
			title="相機看全部可見節點（不重算版面）"
			onclick={() => editor.fit()}>全景</button
		>
	</div>
	{#if failure}
		<div
			role="alert"
			class="absolute inset-0 grid place-items-center bg-[#0b1020]/85 text-sm text-slate-200"
		>
			<div class="space-y-2 text-center">
				<p>{failure}</p>
				<p class="text-xs text-slate-400">搜尋與編輯仍可使用</p>
				<button
					class="rounded border border-slate-600 px-3 py-1 hover:bg-slate-700"
					onclick={() => attempt++}>重試</button
				>
			</div>
		</div>
	{:else if !ready}
		<div class="absolute inset-0 grid place-items-center text-sm text-slate-400">載入 3D 宇宙…</div>
	{/if}
</div>
