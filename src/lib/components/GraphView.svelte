<script lang="ts" module>
	import { ImportReloadRequired, retryableImport } from '#lib/universe/retry-import.js';
	type ForceGraphModule = typeof import('3d-force-graph');
	type ThreeModule = typeof import('three');
	// 可重抓的只有本站的 build 資產：production＝與本模組同一個 _app/immutable/ 目錄（同源）；dev＝同源
	const assetRoot = new URL(import.meta.env.DEV ? '/' : '../', import.meta.url);
	const asset = (u: URL) =>
		u.origin === assetRoot.origin && u.pathname.startsWith(assetRoot.pathname);
	// 文件層級：瀏覽器記住失敗的動態載入是整份文件共用，重掛元件後重試也要換 URL
	const loadForceGraph = retryableImport(() => import('3d-force-graph'), {
		accept: (m): m is ForceGraphModule =>
			typeof (m as Partial<ForceGraphModule> | null)?.default === 'function',
		asset
	});
	const loadThree = retryableImport(() => import('three'), {
		accept: (m): m is ThreeModule => {
			const t = m as Partial<ThreeModule> | null;
			return typeof t?.WebGLRenderer === 'function' && typeof t?.Scene === 'function';
		},
		asset
	});
</script>

<script lang="ts">
	// 全圖（只讀）：3d-force-graph 只提供相機／場景／控制（不給它 graphData，不跑它的模擬）。
	// 繪製分層在 universe/renderer.ts：遠景 Points（可見系統全部節點）、近景 detail（依每個節點的投影半徑、
	// 有上限）、局部邊／高亮邊批次、有限標籤池；LOD 決策在 universe/lod.ts。這個元件只負責生命週期與 UI。
	// 座標由 editor.universe（session runtime）持有，背景 Worker 的分段結果就地寫進 GPU buffer，不經 Svelte state。
	import { onMount, untrack } from 'svelte';
	import type { Editor } from '#lib/editor.svelte.js';
	import { SYSTEM_COLORS } from '#lib/components/Canvas.svelte';
	import { SYSTEMS, UNREACHABLE_LABEL, nodeType } from '#lib/model/config.js';
	import type * as THREE from 'three';
	import type { Graph } from '#lib/model/types.js';
	import type { GraphProbe } from '#lib/measure.js';
	import type { CameraDriver, CameraPose, LayoutStatus } from '#lib/universe/runtime.js';
	import { LOD, type LodStats } from '#lib/universe/lod.js';
	import { PALETTE, createUniverseLayers, type Focus } from '#lib/universe/renderer.js';

	// probe：只有量測入口傳入，記錄首幀／相機可操作／版面整理的時間點
	let { editor, probe }: { editor: Editor; probe?: GraphProbe } = $props();

	/** 定位單一節點時鏡頭與節點的距離 */
	const DIST = 160;
	/** 相機入鏡呼叫紀錄只留最近幾筆（e2e 觀察用，不可無限成長） */
	const FITS_CAP = 20;
	/** 按下到放開移動超過這個距離就是拖曳相機，不算點選 */
	const CLICK_SLOP = 5;

	type Api = { build: (g: Graph) => void; paint: () => void; refresh: () => void };
	type Hooks = Record<string, unknown>;

	const rt = untrack(() => editor.universe);
	let host: HTMLDivElement;
	let labelHost: HTMLDivElement;
	let api = $state.raw<Api | null>(null);
	let ready = $state(false);
	/** renderer 層的失敗（載入模組、WebGL 建立、context lost）；搜尋與編輯不受影響 */
	let failure = $state<string | null>(null);
	/** 這份文件內再試也不會成功（瀏覽器記住了共用模組的失敗）：不給重試鈕，只說明要手動重新整理 */
	let needsReload = $state(false);
	let attempt = $state(0);
	let layout = $state.raw<LayoutStatus>(rt.status);
	/** LOD 計數（renderer 最多每 250ms 回報一次） */
	let stats = $state.raw<LodStats | null>(null);
	// 圖例可明確收合（預設展開）；收合時標頭仍標示有無省略
	let legendOpen = $state(true);
	const uid = $props.id();
	const legendBodyId = `${uid}-legend`;
	const omitted = $derived(
		!!stats &&
			!!(
				stats.detailOmitted ||
				stats.localEdgesOmitted ||
				stats.labelsOmitted ||
				stats.highlightOmitted ||
				stats.highlightHidden
			)
	);
	let focusNodes: Set<string> | null = null;
	/** 掛載前就發生的視野請求屬於其他頁（2D）；這次掛載只接手之後的請求 */
	let seenSeq = untrack(() => editor.view.seq);

	/** 圖例：各系統目前可見節點數（隨拓撲／篩選，不隨相機） */
	const perSystem = $derived.by(() => {
		const n: Record<string, number> = {};
		for (const node of editor.sceneGraph.nodes) {
			const s = nodeType(node.type).system ?? '通用';
			n[s] = (n[s] ?? 0) + 1;
		}
		return n;
	});
	const legendSystems = $derived(
		[...SYSTEMS.filter((s) => editor.systems.includes(s)), '通用'].filter((s) => perSystem[s])
	);

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
			needsReload = false;
			init(() => dead)
				.then((f) => {
					if (dead) f.off();
					else [off, api] = [f.off, f.api];
				})
				.catch((e: unknown) => {
					if (dead) return;
					console.error('3D 宇宙載入失敗', e);
					needsReload = e instanceof ImportReloadRequired;
					failure = `3D 宇宙載入失敗：${e instanceof Error ? e.message : String(e)}`;
				});
		});
		return () => {
			dead = true;
			api = null;
			ready = false;
			stats = null;
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

	// 改名／屬性：只重寫標籤文字，不重建 buffer、不碰版面
	$effect(() => {
		const a = api;
		void editor.revision;
		if (a) untrack(() => a.refresh());
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
	const fmt = (n: number) => n.toLocaleString('en-US');

	async function init(isDead: () => boolean): Promise<{ api: Api; off: () => void }> {
		const [{ default: ForceGraph3D }, three] = await Promise.all([loadForceGraph(), loadThree()]);
		const noop = { api: { build: () => {}, paint: () => {}, refresh: () => {} }, off: () => {} };
		// 卸載後才載入完成：不建立任何 GPU 資源
		if (isDead()) return noop;

		// 每建立一項資源就登記釋放；初始化中途失敗時反向釋放已建立的部分
		const undo: (() => void)[] = [];
		const off = () => {
			while (undo.length)
				try {
					undo.pop()!();
				} catch (e) {
					console.warn('3D 宇宙清理失敗', e);
				}
		};
		try {
			return build();
		} catch (e) {
			off();
			throw e;
		}

		function build(): { api: Api; off: () => void } {
			const fg = new ForceGraph3D(host)
				.backgroundColor('#0b1020')
				.showNavInfo(false)
				.enablePointerInteraction(false);
			undo.push(() => fg._destructor());
			const renderer = fg.renderer();
			if (!renderer?.getContext?.()) throw new Error('無法建立 WebGL');
			const canvas = renderer.domElement;
			const controls = fg.controls() as EventTarget & { target: THREE.Vector3 };
			probe?.renderer(renderer);
			probe?.mark('graph:init');
			if (probe) {
				rt.mark = probe.mark;
				undo.push(() => {
					if (rt.mark === probe.mark) rt.mark = null;
				});
			}

			let g: Graph = { nodes: [], edges: [] };
			let sceneIds = new Set<string>();
			let first = true;
			let frame = 0;
			let hoverFrame = 0;

			const layers = createUniverseLayers({
				THREE: three,
				scene: fg.scene(),
				camera: () => fg.camera() as THREE.PerspectiveCamera,
				size: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }),
				pixelRatio: () => renderer.getPixelRatio(),
				labelHost,
				runtime: rt,
				name: (id) => editor.node(id)?.name ?? id,
				nodeColor: (type) => SYSTEM_COLORS[nodeType(type).system ?? '通用'],
				onStats: (s) => (stats = s)
			});
			undo.push(() => layers.dispose());

			/** runtime 的目前座標（全部節點，含被篩掉的） */
			const at = (id: string, v = new three.Vector3()) => {
				const p = rt.position(id);
				return p ? v.set(p[0], p[1], p[2]) : null;
			};

			const fit = (target: readonly string[], ms: number) => {
				const pick = target.length ? target : g.nodes.map((n) => n.id);
				const pts = pick.flatMap((id) => at(id) ?? []);
				if (!pts.length) return;
				const c = pts.reduce((s, p) => s.add(p), new three.Vector3()).divideScalar(pts.length);
				let r = 0;
				for (const p of pts) r = Math.max(r, p.distanceTo(c));
				const d = pts.length === 1 ? DIST : Math.max(r * 2.5, 60);
				fg.cameraPosition({ x: c.x, y: c.y, z: c.z + d }, c, ms);
			};
			const xyz = (v: THREE.Vector3) => ({ x: v.x, y: v.y, z: v.z });
			// 相機入鏡呼叫（含當時版面狀態），供 e2e 觀察「晚到的自動入鏡」；只留最近 FITS_CAP 筆
			const fits: { ids: number; ms: number; phase: string }[] = [];
			const driver: CameraDriver = {
				fit: (target, ms) => {
					fits.push({ ids: target.length, ms, phase: rt.status.phase });
					if (fits.length > FITS_CAP) fits.shift();
					fit(target, ms);
				},
				pose: (): CameraPose => ({
					position: xyz(fg.camera().position),
					target: xyz(controls.target)
				}),
				restore: (p) => fg.cameraPosition(p.position, p.target, 0)
			};
			const interacted = () => rt.camera.interacted();
			controls.addEventListener('start', interacted);
			undo.push(() => controls.removeEventListener('start', interacted));

			const paint = () => {
				const res = editor.result;
				const sel = editor.selected;
				let nodes: Set<string> | null = null;
				let edges: Set<string> | null = null;
				let total = 0;
				let selectedEdge: string | null = null;
				if (res) {
					nodes = res.nodes;
					edges = res.edges;
					total = res.edges.size;
					// 追查中單選一條關係：路徑保留，這條用選取色獨立亮（不在路徑上的也補進來）
					const e = sel?.kind === 'edge' ? editor.edge(sel.id) : undefined;
					if (e) {
						selectedEdge = e.id;
						if (!edges.has(e.id)) {
							nodes = new Set([...nodes, e.from, e.to]);
							edges = new Set([...edges, e.id]);
							total++;
						}
					}
				} else if (sel?.kind === 'node' && sceneIds.has(sel.id)) {
					const all = editor.incidentEdges(sel.id);
					const near = all.filter((e) => sceneIds.has(e.from) && sceneIds.has(e.to));
					nodes = new Set([sel.id, ...near.map((e) => (e.from === sel.id ? e.to : e.from))]);
					edges = new Set(near.map((e) => e.id));
					total = all.length;
				} else if (sel?.kind === 'edge') {
					const e = editor.edge(sel.id);
					if (e && sceneIds.has(e.from) && sceneIds.has(e.to)) {
						nodes = new Set([e.from, e.to]);
						edges = new Set([e.id]);
						total = 1;
					}
				}
				focusNodes = nodes;
				const f: Focus = {
					selected: sel?.kind === 'node' ? sel.id : null,
					nodes,
					edges,
					path: !!res,
					highlightTotal: total,
					selectedEdge,
					warn: editor.unprocessed,
					broken: editor.unreachable
				};
				layers.setFocus(f);
			};

			const build = (graph: Graph) => {
				g = graph;
				sceneIds = new Set(graph.nodes.map((n) => n.id));
				layers.setGraph(graph);
				paint();
				if (!first) return;
				// 首幀：初始座標已上 GPU；相機接手（恢復上次姿態或整體入鏡），再背景開始整理
				first = false;
				ready = true;
				probe?.mark('universe:first-frame', {
					nodes: graph.nodes.length,
					edges: graph.edges.length
				});
				rt.camera.attach(driver);
				requestAnimationFrame(() => {
					if (isDead()) return;
					probe?.mark('camera:interactive');
					rt.startInitial();
				});
			};
			undo.push(() => {
				rt.camera.detach();
				rt.stop('detached');
			});

			// 版面進度：一幀最多寫一次 GPU buffer；格網只在這裡重建
			const offPositions = rt.subscribe((e) => {
				if (e !== 'positions' || frame) return;
				frame = requestAnimationFrame(() => {
					frame = 0;
					layers.positions();
				});
			});
			undo.push(() => {
				offPositions();
				cancelAnimationFrame(frame);
				cancelAnimationFrame(hoverFrame);
			});

			// 點選：事件當下用格網＋投影＋深度挑（不靠 raycast），拖曳相機不算點選
			const local = (e: { clientX: number; clientY: number }) => {
				const r = canvas.getBoundingClientRect();
				return [e.clientX - r.left, e.clientY - r.top] as const;
			};
			// down：按著中的手勢（期間不做滑過）；ended：剛在畫布上放開的手勢，留給緊接的 click 判斷拖曳
			let down: { x: number; y: number } | null = null;
			let travel = 0;
			// at：放開時的座標（pointerup 保留小數；Chrome 的 click 事件會截成整數，小點重疊時差 1px 就選錯）
			let ended: { travel: number; at: { clientX: number; clientY: number } } | null = null;
			const onDown = (e: PointerEvent) => {
				down = { x: e.clientX, y: e.clientY };
				travel = 0;
				ended = null;
			};
			// 放開（任何地方）或取消都結束手勢：在畫布外放開、pointercancel 不會留下永久的 down
			const onUp = (e: PointerEvent) => {
				const d = down;
				if (!d) return;
				down = null;
				travel = Math.max(travel, Math.hypot(e.clientX - d.x, e.clientY - d.y));
				ended =
					e.target === canvas && e.button === 0
						? { travel, at: { clientX: e.clientX, clientY: e.clientY } }
						: null;
			};
			const onCancel = () => {
				down = null;
				ended = null;
			};
			const onMove = (e: PointerEvent) => {
				if (down) {
					travel = Math.max(travel, Math.hypot(e.clientX - down.x, e.clientY - down.y));
					return;
				}
				if (e.buttons || hoverFrame || e.target !== canvas) return;
				const [x, y] = local(e);
				hoverFrame = requestAnimationFrame(() => {
					hoverFrame = 0;
					if (!ready) return;
					canvas.style.cursor = layers.setHover(x, y) >= 0 ? 'pointer' : '';
				});
			};
			const onLeave = () => {
				layers.setHover(null);
				canvas.style.cursor = '';
			};
			const onClick = () => {
				const g = ended;
				ended = null;
				if (!ready || !g) return;
				if (g.travel > CLICK_SLOP) return;
				const id = layers.pick(...local(g.at));
				editor.select(id ? { kind: 'node', id } : null);
			};
			const onLost = (e: Event) => {
				e.preventDefault();
				ready = false;
				failure = '3D 繪圖內容遺失（WebGL context lost）';
			};
			const onRestored = () => {
				failure = null;
				ready = true;
				layers.invalidate();
			};
			const listen = (t: EventTarget, type: string, fn: (e: never) => void) => {
				t.addEventListener(type, fn as EventListener);
				undo.push(() => t.removeEventListener(type, fn as EventListener));
			};
			listen(canvas, 'pointerdown', onDown);
			listen(window, 'pointermove', onMove);
			listen(window, 'pointerup', onUp);
			listen(window, 'pointercancel', onCancel);
			listen(canvas, 'pointerleave', onLeave);
			listen(canvas, 'click', onClick);
			listen(canvas, 'webglcontextlost', onLost);
			listen(canvas, 'webglcontextrestored', onRestored);

			// 尺寸與 DPR：重設 renderer，LOD／標籤以新的 CSS 尺寸重新投影
			const ro = new ResizeObserver(() => {
				fg.width(host.clientWidth).height(host.clientHeight);
				layers.invalidate();
			});
			ro.observe(host);
			undo.push(() => ro.disconnect());
			let dpr: MediaQueryList | null = null;
			const onDpr = () => {
				renderer.setPixelRatio(window.devicePixelRatio);
				fg.width(host.clientWidth).height(host.clientHeight);
				layers.invalidate();
				watchDpr();
			};
			const watchDpr = () => {
				dpr?.removeEventListener('change', onDpr);
				dpr = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
				dpr.addEventListener('change', onDpr);
			};
			watchDpr();
			undo.push(() => dpr?.removeEventListener('change', onDpr));

			const rect = () => canvas.getBoundingClientRect();
			const view = {
				/** renderer 可操作且目前可見圖已畫出（不代表版面整理完成，見 layout()） */
				get ready() {
					return ready;
				},
				selected: () => (editor.selected?.kind === 'node' ? editor.selected.id : null),
				selectedEdge: () => (editor.selected?.kind === 'edge' ? editor.selected.id : null),
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
				nodeCount: () => g.nodes.length,
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
					)?.loseContext(),
				// P6：LOD 與點選（唯讀；project 回傳 viewport 座標，給真滑鼠點）
				lod: () => {
					const f = layers.frame();
					return f && { ...f.stats, ...layers.perf(), config: LOD };
				},
				detailIds: () => [...(layers.frame()?.detailNodeIds ?? [])],
				localEdgeIds: () => [...(layers.frame()?.localEdgeIds ?? [])],
				highlightEdgeIds: () => [...(layers.frame()?.highlightEdgeIds ?? [])],
				labels: () =>
					(layers.frame()?.labels ?? []).map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
				project: (id: string) => {
					const p = layers.project(id);
					const r = rect();
					return p && { ...p, x: p.x + r.left, y: p.y + r.top };
				},
				projectAll: () => {
					const r = rect();
					return layers.projectAll().map((p) => ({ ...p, x: p.x + r.left, y: p.y + r.top }));
				},
				render: () => ({ ...renderer.info.render, pixelRatio: renderer.getPixelRatio() })
			};
			const win = window as unknown as { __graphView?: Hooks };
			win.__graphView = view;
			undo.push(() => {
				if (win.__graphView === view) delete win.__graphView;
			});

			return {
				api: { build, paint, refresh: () => layers.refreshLabels() },
				off
			};
		}
	}
</script>

<div class="[container-type:size] relative size-full overflow-hidden bg-[#0b1020]">
	<div bind:this={host} class="absolute inset-0"></div>
	<div
		bind:this={labelHost}
		class="pointer-events-none absolute inset-0 overflow-hidden"
		aria-label="節點標籤"
		role="group"
	></div>
	<!-- HUD：圖例與版面狀態同一個底部流式排版；容器變窄時狀態列換到下一行，不會互相覆蓋 -->
	<div
		class="pointer-events-none absolute inset-x-3 bottom-3 flex flex-wrap items-end justify-between gap-2 text-xs"
	>
		<section
			aria-label="宇宙圖例"
			class="pointer-events-auto flex max-h-[calc(100cqh-5rem)] max-w-[22rem] min-w-0 flex-col rounded-lg border border-slate-700/60 bg-[#0b1020]/80 px-3 py-2 text-slate-300 backdrop-blur"
		>
			<div class="flex items-center gap-2">
				<span class="font-medium text-slate-200">圖例</span>
				{#if !legendOpen && omitted}
					<span class="text-amber-300">・有省略</span>
				{/if}
				<button
					class="ml-auto rounded px-2 py-0.5 whitespace-nowrap text-slate-300 hover:bg-slate-700"
					aria-expanded={legendOpen}
					aria-controls={legendBodyId}
					onclick={() => (legendOpen = !legendOpen)}>{legendOpen ? '收合圖例' : '展開圖例'}</button
				>
			</div>
			{#if legendOpen}
				<div id={legendBodyId} class="mt-1.5 min-h-0 space-y-1.5 overflow-y-auto">
					<ul class="flex flex-wrap gap-x-3 gap-y-1" aria-label="系統">
						{#each legendSystems as s (s)}
							<li>
								<span
									class="mr-1 inline-block size-2 rounded-full"
									style:background={SYSTEM_COLORS[s]}
								></span>{s} <span class="text-slate-400 tabular-nums">{fmt(perSystem[s])}</span>
							</li>
						{/each}
					</ul>
					<ul class="flex flex-wrap gap-x-3 gap-y-1">
						<li>
							<span class="mr-1 inline-block size-2 rounded-full" style:background={PALETTE.WARN}
							></span>未處理
						</li>
						<li>
							<span class="mr-1 inline-block size-2 rounded-full" style:background={PALETTE.BROKEN}
							></span>{UNREACHABLE_LABEL}
						</li>
						{#if editor.result}
							<li>
								<span class="mr-1 inline-block size-2 rounded-full" style:background={PALETTE.PATH}
								></span>找客戶路徑
							</li>
						{/if}
					</ul>
					{#if stats}
						<dl
							class="grid grid-cols-[auto_1fr] gap-x-2 border-t border-slate-700/60 pt-1.5 tabular-nums"
							aria-label="細節層級"
							data-detail={stats.detail}
							data-labels={stats.labels}
						>
							<dt class="text-slate-400">遠景點</dt>
							<dd>{fmt(stats.baseNodes)}</dd>
							<dt class="text-slate-400">近景節點</dt>
							<dd>
								{fmt(stats.detail)}／上限 {fmt(LOD.maxDetail)}{#if stats.detailOmitted}・省略 {fmt(
										stats.detailOmitted
									)}{/if}
							</dd>
							<dt class="text-slate-400">局部連線</dt>
							<dd>
								{fmt(stats.localEdges)}／上限 {fmt(
									LOD.maxLocalEdges
								)}{#if stats.localEdgesOmitted}・省略
									{fmt(stats.localEdgesOmitted)}{/if}
							</dd>
							<dt class="text-slate-400">名稱標籤</dt>
							<dd>
								{fmt(stats.labels)}／上限 {LOD.maxLabels}{#if stats.labelsOmitted}・省略 {fmt(
										stats.labelsOmitted
									)}{/if}
							</dd>
							{#if stats.highlightTotal}
								<dt class="text-slate-400">高亮連線</dt>
								<dd>
									共 {fmt(stats.highlightTotal)}・已畫 {fmt(
										stats.highlightDrawn
									)}{#if stats.highlightOmitted}・省略
										{fmt(stats.highlightOmitted)}{/if}{#if stats.highlightHidden}・系統隱藏 {fmt(
											stats.highlightHidden
										)}{/if}
								</dd>
							{/if}
							<dd class="col-span-2 text-slate-500">
								拉近到節點 ≥{LOD.detailEnterPx}px 才顯示細節、局部連線與名稱；遠景只畫點
							</dd>
						</dl>
					{/if}
				</div>
			{/if}
		</section>
		<div
			class="pointer-events-auto ml-auto flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-slate-700/60 bg-[#0b1020]/80 px-3 py-1.5 text-slate-200 backdrop-blur [&_button]:whitespace-nowrap"
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
	</div>
	{#if failure}
		<div
			role="alert"
			class="absolute inset-0 grid place-items-center bg-[#0b1020]/85 text-sm text-slate-200"
		>
			<div class="space-y-2 text-center">
				<p>{failure}</p>
				<p class="text-xs text-slate-400">搜尋與編輯仍可使用</p>
				{#if needsReload}
					<p class="text-xs text-amber-300">
						瀏覽器已記住 3D 程式庫共用模組的載入失敗，這個分頁內重試不會成功；
						請自行重新整理頁面（重新整理會遺失本分頁的所有編輯，包括已按儲存的）。
					</p>
				{:else}
					<button
						class="rounded border border-slate-600 px-3 py-1 hover:bg-slate-700"
						onclick={() => attempt++}>重試</button
					>
				{/if}
			</div>
		</div>
	{:else if !ready}
		<div class="absolute inset-0 grid place-items-center text-sm text-slate-400">載入 3D 宇宙…</div>
	{/if}
</div>
