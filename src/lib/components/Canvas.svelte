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
	import { NODE_H, NODE_W, layout } from '#lib/model/graph.js';
	import GraphNode from './GraphNode.svelte';
	import Icon from './Icon.svelte';
	import ViewSync from './ViewSync.svelte';

	let { editor }: { editor: Editor } = $props();

	const nodeTypes = { graph: GraphNode };

	const lay = $derived(layout(editor.visible));

	/** 亮起的節點與邊：找客戶結果優先，否則為選取（或滑過）物件的直接相連 */
	const focus = $derived.by(() => {
		if (editor.result) return editor.result;
		const s =
			editor.selected ??
			(editor.hoverNode ? { kind: 'node' as const, id: editor.hoverNode } : null);
		if (!s) return null;
		const edges =
			s.kind === 'node'
				? editor.visible.edges.filter((e) => e.from === s.id || e.to === s.id)
				: editor.visible.edges.filter((e) => e.id === s.id);
		return {
			nodes: new Set([
				...(s.kind === 'node' ? [s.id] : []),
				...edges.flatMap((e) => [e.from, e.to])
			]),
			edges: new Set(edges.map((e) => e.id))
		};
	});

	const nodes = $derived<Node[]>([
		...editor.visible.nodes.map((n) => ({
			id: n.id,
			type: 'graph',
			position: lay.pos.get(n.id)!,
			width: NODE_W,
			height: NODE_H,
			data: {
				name: n.name,
				type: n.type,
				system: nodeType(n.type).system ?? '通用',
				color: SYSTEM_COLORS[nodeType(n.type).system ?? '通用'],
				readonly: !!n.readonly,
				unprocessed: editor.unprocessed.has(n.id),
				unreachable: editor.unreachable.has(n.id),
				dim: !!focus && !focus.nodes.has(n.id),
				soft: !editor.selected && !editor.result,
				active: editor.selected?.id === n.id,
				origin: editor.result !== null && editor.selected?.id === n.id,
				fresh: editor.fresh === n.id
			}
		}))
	]);

	const edges = $derived<Edge[]>(
		editor.visible.edges.map((e) => {
			const color = EDGE_COLORS[e.type] ?? '#94a3b8';
			const marker = { type: MarkerType.ArrowClosed, color, width: 14, height: 14 };
			const lit = focus?.edges.has(e.id) || editor.hoverEdge === e.id;
			return {
				id: e.id,
				source: e.from,
				target: e.to,
				markerEnd: marker,
				markerStart: e.bidirectional ? marker : undefined,
				interactionWidth: 24,
				animated: !!editor.result?.edges.has(e.id),
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
	);

	function nodeClick(id: string) {
		if (editor.connecting) editor.startEdge(editor.connecting, id);
		else editor.select({ kind: 'node', id });
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
		if (!from || to === from) return;
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
					(id) => id && editor.node(id)
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
		if ((e.target as HTMLElement).closest('.svelte-flow__node-graph') && focus)
			editor.fit([...focus.nodes]);
	}}
>
	<SvelteFlow
		{nodes}
		{edges}
		{nodeTypes}
		fitView
		fitViewOptions={{ padding: 0.06 }}
		minZoom={0.1}
		maxZoom={2}
		nodesDraggable={false}
		zoomOnDoubleClick={false}
		deleteKey={null}
		colorMode="dark"
		class={[editor.connecting && 'connecting', linking && 'linking']}
		clickConnect={false}
		connectionDragThreshold={6}
		onnodeclick={({ node }) => nodeClick(node.id)}
		onedgeclick={({ edge }) => editor.select({ kind: 'edge', id: edge.id })}
		onpaneclick={() => editor.select(null)}
		onnodepointerenter={({ node }) => hover(node.id)}
		onnodepointerleave={() => hover(null)}
		onedgepointerenter={({ edge }) => (editor.hoverEdge = edge.id)}
		onedgepointerleave={() => (editor.hoverEdge = null)}
		onnodecontextmenu={({ event, node }) => {
			editor.select({ kind: 'node', id: node.id });
			editor.menu = { kind: 'node', id: node.id, ...menuAt(event) };
		}}
		onedgecontextmenu={({ event, edge }) => {
			const at = menuAt(event);
			editor.select({ kind: 'edge', id: edge.id });
			editor.menu = { kind: 'edge', id: edge.id, ...at };
		}}
		onpanecontextmenu={({ event }) => (editor.menu = { kind: 'pane', ...menuAt(event) })}
		onconnectstart={() => (linking = true)}
		onconnectend={(e, s) => connectEnd(e, s.fromNode?.id)}
		isValidConnection={(c) => [...editor.edgeErrors(c.source, c.target).values()].some((v) => !v)}
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
		{#if toolbarNode}
			{@const n = editor.node(toolbarNode)}
			<NodeToolbar nodeId={toolbarNode} isVisible position={Position.Top} offset={6}>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="flex animate-rise items-center gap-0.5 rounded-lg border border-white/10 bg-ink-850/95 p-0.5 shadow-xl shadow-black/40 backdrop-blur"
					onpointerenter={() => hover(toolbarNode)}
					onpointerleave={() => hover(null)}
				>
					{@render tool('找客戶（F）', 'target', () => editor.findCustomers(toolbarNode))}
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
