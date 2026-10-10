<script lang="ts" module>
	export const EDGE_COLORS: Record<string, string> = {
		包含: '#94a3b8',
		供電: '#fb923c',
		冷卻: '#22d3ee',
		連線: '#60a5fa',
		服務: '#4ade80',
		承載: '#e879f9',
		監測: '#f472b6'
	};
	/** 系統識別色：節點色條、篩選膠囊、圖例共用 */
	export const SYSTEM_COLORS: Record<string, string> = {
		空間: '#a5b4fc',
		通用: '#e2e8f0',
		電力: '#fb923c',
		空調: '#22d3ee',
		網路: '#60a5fa',
		消防: '#fb7185',
		CCTV: '#f472b6',
		IDC: '#4ade80'
	};
</script>

<script lang="ts">
	import {
		SvelteFlow,
		Controls,
		MiniMap,
		Background,
		BackgroundVariant,
		MarkerType,
		NodeToolbar,
		Position,
		type Node,
		type Edge
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import type { Editor } from '#lib/editor.svelte.js';
	import { nodeType } from '#lib/model/config.js';
	import { NODE_H, NODE_W } from '#lib/model/graph.js';
	import { StableById } from '#lib/model/stable.js';
	import GraphNode from './GraphNode.svelte';
	import Icon from './Icon.svelte';
	import ViewSync from './ViewSync.svelte';

	let { editor }: { editor: Editor } = $props();

	const nodeTypes = { graph: GraphNode };

	const view = $derived(editor.canvas);
	// 版面與位置由 Editor 保存：切到 3D 卸載畫布再回來，卡片不搬動；改名不重排
	const lay = $derived(editor.editLayout);
	const pos = $derived(editor.editPositions);
	/** 堆疊卡代表的節點；一般節點就是自己 */
	const members = (id: string) => editor.closed.get(id) ?? [id];

	/** 亮起的節點與邊：找客戶結果優先，其次選取（或滑過）物件的直接相連，最後是大綱篩選 */
	const focus = $derived.by(() => {
		if (editor.result) return editor.result;
		const s =
			editor.selected ??
			(editor.hoverNode ? { kind: 'node' as const, id: editor.hoverNode } : null);
		const m = editor.matched;
		if (!s)
			return (
				m && {
					nodes: m,
					edges: new Set(
						editor.editVisible.edges.filter((e) => m.has(e.from) && m.has(e.to)).map((e) => e.id)
					)
				}
			);
		const ids = members(s.id);
		const edges =
			s.kind === 'node'
				? editor.editVisible.edges.filter((e) => ids.includes(e.from) || ids.includes(e.to))
				: editor.editVisible.edges.filter((e) => e.id === s.id);
		return {
			nodes: new Set([...(s.kind === 'node' ? ids : []), ...edges.flatMap((e) => [e.from, e.to])]),
			edges: new Set(edges.map((e) => e.id))
		};
	});

	// 內容沒變的卡片／邊沿用上一次的物件：改一張卡片的名稱不讓 Svelte Flow 重新採用、量測全部（P8 實測）
	const stableNodes = new StableById<Node>();
	const stableEdges = new StableById<Edge>();

	const nodes = $derived<Node[]>(
		stableNodes.take(
			view.nodes.map((n) => {
				const ids = members(n.id);
				const any = (set: ReadonlySet<string>) => ids.some((id) => set.has(id));
				const stack = ids.length > 1;
				const active = !!editor.selected && ids.includes(editor.selected.id);
				return {
					id: n.id,
					connectable: !stack,
					type: 'graph',
					position: pos.get(n.id)!,
					width: NODE_W,
					height: NODE_H,
					// 卡片尺寸固定：先給量測值，Svelte Flow 重新採用卡片時沿用把手位置，不必整批重量、邊不會整批重建
					measured: { width: NODE_W, height: NODE_H },
					data: {
						name: n.name,
						type: n.type,
						system: nodeType(n.type).system ?? '通用',
						color: SYSTEM_COLORS[nodeType(n.type).system ?? '通用'],
						readonly: !!n.readonly,
						stack: stack ? ids.length : 0,
						unprocessed: any(editor.unprocessed),
						unreachable: any(editor.unreachable),
						dim: !!focus && !any(focus.nodes),
						soft: !editor.selected && !editor.result && !editor.matched,
						active,
						origin: editor.result !== null && active,
						fresh: editor.fresh === n.id
					}
				};
			})
		)
	);

	// 只有主機：機框→主機（包含）與主機→機框（承載）畫成一條雙向線（資料仍是兩條邊）
	const hostPair = $derived.by(() => {
		const type = new Map(view.nodes.map((n) => [n.id, n.type]));
		const back = new Map(
			view.edges
				.filter((e) => e.type === '承載' && type.get(e.from) === '主機')
				.map((e) => [`${e.to}>${e.from}`, e])
		);
		return new Map(
			view.edges
				.filter((e) => e.type === '包含' && type.get(e.to) === '主機')
				.flatMap((e) => {
					const b = back.get(`${e.from}>${e.to}`);
					return b ? [[e.id, b] as const] : [];
				})
		);
	});
	const merged = $derived(new Set([...hostPair.values()].map((b) => b.id)));

	const edges = $derived<Edge[]>(
		stableEdges.take(
			view.edges
				.filter((e) => !merged.has(e.id))
				.map((e) => {
					const pair = hostPair.get(e.id);
					if (pair) e = { ...e, bidirectional: true, members: [...e.members, ...pair.members] };
					const color = EDGE_COLORS[e.type] ?? '#94a3b8';
					const marker = { type: MarkerType.ArrowClosed, color, width: 14, height: 14 };
					const lit =
						e.members.some((id) => focus?.edges.has(id) || editor.hoverEdge === id) ||
						editor.hoverEdge === e.id;
					// 反向邊（例：承載 主機→機框）改由左畫到右、箭頭放起點，走卡片下方的 back 把手，不和同對節點的邊疊在一起
					// 用排版的層級判斷（不用保留的位置），編輯後一般邊不會被當成反向
					const back = lay.pos.get(e.from)!.x > lay.pos.get(e.to)!.x;
					const animated = e.members.some((id) => editor.result?.edges.has(id));
					return {
						id: e.id,
						// 沒有包含可合併的承載邊只在相關時畫出
						hidden: e.type === '承載' && !lit && !animated,
						...(back
							? {
									source: e.to,
									target: e.from,
									sourceHandle: 'back',
									targetHandle: 'back',
									markerStart: marker,
									markerEnd: e.bidirectional ? marker : undefined
								}
							: {
									source: e.from,
									target: e.to,
									markerEnd: marker,
									markerStart: e.bidirectional ? marker : undefined
								}),
						interactionWidth: 24,
						animated,
						style: [
							`stroke: ${color}`,
							`stroke-width: ${lit ? 2.75 : 1.25}`,
							e.props['確認狀態'] === '推定' ? 'stroke-dasharray: 5 4' : '',
							lit ? `filter: drop-shadow(0 0 4px ${color})` : '',
							focus && !lit
								? `opacity: ${editor.selected || editor.result ? 0.08 : 0.3}`
								: 'opacity: 0.75'
						].join(';')
					};
				})
		)
	);

	/** 這一下點擊展開了疊卡（雙擊的後半不該再選取／縮放重排後的卡片） */
	let expandedByClick = false;

	// 疊卡不存在了就忘掉展開記錄，免得之後同 key 重新成疊時直接展開
	$effect(() => {
		if (editor.expanded.some((k) => !editor.stacks.has(k)))
			editor.expanded = editor.expanded.filter((k) => editor.stacks.has(k));
	});

	function nodeClick(id: string, detail: number) {
		if (detail > 1 && expandedByClick) return;
		expandedByClick = false;
		if (editor.stacks.has(id)) {
			expandedByClick = true;
			editor.expand(id);
		} else if (editor.connecting) editor.startEdge(editor.connecting, id);
		else editor.select({ kind: 'node', id });
	}

	/** 點合併邊（接在收起的堆疊上）：展開那一疊 */
	function edgeClick(id: string) {
		const e = view.edges.find((x) => x.id === id)!;
		const k = [e.from, e.to].find((x) => editor.stacks.has(x));
		if (k) editor.expand(k);
		else editor.select({ kind: 'edge', id });
	}

	/** 拖曳連線中（目標卡片的 target 把手要浮到最上層才接得到） */
	let linking = $state(false);

	/** 拖曳放開：放在節點上 → 選邊類型；放在空白 → 新增節點並連線 */
	function connectEnd(e: MouseEvent | TouchEvent, from?: string) {
		linking = false;
		editor.hoverNode = null;
		const p = 'changedTouches' in e ? e.changedTouches[0] : e;
		const to = document
			.elementFromPoint(p.clientX, p.clientY)
			?.closest('.svelte-flow__node-graph')
			?.getAttribute('data-id');
		if (!from || to === from || (to && !editor.node(to))) return;
		editor.select({ kind: 'node', id: from });
		const at = { x: p.clientX, y: p.clientY };
		editor.menu = to ? { kind: 'connect', from, to, ...at } : { kind: 'drop', from, ...at };
	}

	const menuAt = (e: MouseEvent) => {
		e.preventDefault();
		return { x: e.clientX, y: e.clientY };
	};

	// hover 工具列：離開節點後留 200ms，讓滑鼠移得到工具列上
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	function hover(id: string | null) {
		clearTimeout(hoverTimer);
		if (linking) return;
		if (id) editor.hoverNode = id;
		else hoverTimer = setTimeout(() => (editor.hoverNode = null), 200);
	}
	const toolbarNode = $derived(
		linking || editor.menu
			? null
			: [editor.hoverNode, editor.selected?.kind === 'node' && editor.selected.id].find(
					(id) => id && editor.node(id) && pos.has(id)
				) || null
	);
</script>

{#snippet tool(label: string, icon: string, run: (e: MouseEvent) => void, danger = false)}
	<button
		aria-label={label}
		title={label}
		class={[
			'grid size-7 place-items-center rounded-md text-slate-300 transition-colors',
			danger ? 'hover:bg-rose-500/15 hover:text-rose-300' : 'hover:bg-sky-400/15 hover:text-sky-200'
		]}
		onclick={run}
	>
		<Icon name={icon} />
	</button>
{/snippet}

<!-- 雙擊節點：縮放到它與鄰居（Svelte Flow 沒有節點雙擊事件，改用 DOM 委派） -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class={[
		'h-full',
		editor.connecting && 'cursor-crosshair [&_.svelte-flow__node]:cursor-crosshair'
	]}
	ondblclick={(e) => {
		if (!expandedByClick && (e.target as HTMLElement).closest('.svelte-flow__node-graph') && focus)
			editor.fit([...focus.nodes]);
	}}
>
	<SvelteFlow
		{nodes}
		{edges}
		{nodeTypes}
		fitView={!editor.canvasViewport}
		initialViewport={editor.canvasViewport ?? undefined}
		fitViewOptions={{ padding: 0.06 }}
		onmoveend={(_, v) => (editor.canvasViewport = v)}
		minZoom={0.1}
		maxZoom={2}
		nodesDraggable={false}
		zoomOnDoubleClick={false}
		deleteKey={null}
		colorMode="dark"
		class={[editor.connecting && 'connecting', linking && 'linking']}
		clickConnect={false}
		connectionDragThreshold={6}
		onnodeclick={({ node, event }) => nodeClick(node.id, event.detail)}
		onedgeclick={({ edge }) => edgeClick(edge.id)}
		onpaneclick={() => editor.select(null)}
		onnodepointerenter={({ node }) => hover(node.id)}
		onnodepointerleave={() => hover(null)}
		onedgepointerenter={({ edge }) => (editor.hoverEdge = edge.id)}
		onedgepointerleave={() => (editor.hoverEdge = null)}
		onnodecontextmenu={({ event, node }) => {
			if (editor.stacks.has(node.id)) return void menuAt(event);
			editor.select({ kind: 'node', id: node.id });
			editor.menu = { kind: 'node', id: node.id, ...menuAt(event) };
		}}
		onedgecontextmenu={({ event, edge }) => {
			const at = menuAt(event);
			if (!editor.edge(edge.id)) return edgeClick(edge.id);
			editor.select({ kind: 'edge', id: edge.id });
			editor.menu = { kind: 'edge', id: edge.id, ...at };
		}}
		onpanecontextmenu={({ event }) => (editor.menu = { kind: 'pane', ...menuAt(event) })}
		onconnectstart={() => (linking = true)}
		onconnectend={(e, s) => connectEnd(e, s.fromNode?.id)}
		isValidConnection={(c) =>
			!!editor.node(c.target) &&
			[...editor.edgeErrors(c.source, c.target).values()].some((v) => !v)}
		onbeforeconnect={() => false}
	>
		<Background
			variant={BackgroundVariant.Dots}
			gap={24}
			size={1}
			bgColor="var(--color-ink-950)"
			patternColor="#1f2a3d"
		/>
		<Controls position="bottom-left" showLock={false} />
		<MiniMap
			width={150}
			height={90}
			class="opacity-70 transition-opacity hover:opacity-100"
			position="bottom-right"
			pannable
			zoomable
			nodeColor={(n) => n.data.color as string}
			nodeBorderRadius={4}
		/>
		<ViewSync {editor} />
		{#if editor.working.length === 0}
			<p
				class="pointer-events-none absolute inset-0 z-10 grid place-items-center px-6 text-center text-sm text-slate-400"
			>
				編輯頁是空的：用 ⌘K 搜尋節點加入，或到全圖選取節點加入
			</p>
		{/if}
		{#if toolbarNode}
			{@const n = editor.node(toolbarNode)}
			<NodeToolbar nodeId={toolbarNode} isVisible position={Position.Top} offset={6}>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="flex animate-rise items-center gap-0.5 rounded-lg border border-white/10 bg-ink-850/95 p-0.5 shadow-xl shadow-black/40 backdrop-blur"
					onpointerenter={() => hover(toolbarNode)}
					onpointerleave={() => hover(null)}
				>
					{@render tool('連到…（或直接拖曳卡片到目標）', 'link', () => {
						editor.select({ kind: 'node', id: toolbarNode });
						editor.connecting = toolbarNode;
					})}
					{@render tool('聚焦鄰居（雙擊）', 'focus', () => {
						editor.select({ kind: 'node', id: toolbarNode });
						editor.fit([...(focus?.nodes ?? [toolbarNode])]);
					})}
					{#if !n?.readonly}
						{@const block = editor.deleteBlock(toolbarNode)}
						<span class="mx-0.5 h-4 w-px bg-white/10"></span>
						{@render tool(
							block ? `無法刪除：${block}` : '刪除（⌫）',
							'trash',
							(e) => {
								const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
								editor.select({ kind: 'node', id: toolbarNode });
								editor.menu = { kind: 'node', id: toolbarNode, x: r.left, y: r.bottom + 4 };
							},
							true
						)}
					{/if}
				</div>
			</NodeToolbar>
		{/if}
	</SvelteFlow>
</div>
