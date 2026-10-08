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
	/** 系統識別色：節點色條、泳道表頭、篩選膠囊共用 */
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
		type Node,
		type Edge
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import type { Editor } from '#lib/editor.svelte.js';
	import { nodeType } from '#lib/model/config.js';
	import { LANES, NODE_H, NODE_W, laneOf, layout } from '#lib/model/graph.js';
	import GraphNode from './GraphNode.svelte';
	import LaneNode from './LaneNode.svelte';
	import ViewSync from './ViewSync.svelte';

	let { editor }: { editor: Editor } = $props();

	const nodeTypes = { graph: GraphNode, lane: LaneNode };

	const lanes = $derived(LANES.filter((l) => l === '通用' || editor.systems.some((s) => s === l)));
	const lay = $derived(layout(editor.visible, lanes));

	/** 亮起的節點與邊：找客戶結果優先，否則為選取物件的直接相連 */
	const focus = $derived.by(() => {
		if (editor.result) return editor.result;
		const s = editor.selected;
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
		...lay.boxes.map((b) => ({
			id: `lane:${b.lane}`,
			type: 'lane',
			position: { x: b.x, y: 0 },
			data: {
				label: b.lane === '通用' ? '' : b.lane,
				color: SYSTEM_COLORS[b.lane],
				count: editor.visible.nodes.filter((n) => laneOf(n) === b.lane).length
			},
			width: b.width,
			height: b.height,
			selectable: false,
			connectable: false,
			zIndex: -1
		})),
		...editor.visible.nodes.map((n) => ({
			id: n.id,
			type: 'graph',
			position: lay.pos.get(n.id)!,
			width: NODE_W,
			height: NODE_H,
			data: {
				name: n.name,
				type: n.type,
				color: SYSTEM_COLORS[nodeType(n.type).system ?? '通用'],
				readonly: !!n.readonly,
				unprocessed: editor.unprocessed.has(n.id),
				unreachable: editor.unreachable.has(n.id),
				dim: !!focus && !focus.nodes.has(n.id),
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
					focus && !lit ? 'opacity: 0.08' : 'opacity: 0.75'
				].join(';')
			};
		})
	);

	function nodeClick(id: string) {
		if (editor.connecting) editor.startEdge(editor.connecting, id);
		else editor.select({ kind: 'node', id });
	}
</script>

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
		class={editor.connecting ? 'connecting' : ''}
		onnodeclick={({ node }) => node.type !== 'lane' && nodeClick(node.id)}
		onedgeclick={({ edge }) => editor.select({ kind: 'edge', id: edge.id })}
		onpaneclick={() => editor.select(null)}
		onbeforeconnect={({ source, target }) => {
			// 拉線只帶入起點終點，由對話框選邊類型後才建立；不讓 Svelte Flow 自己加邊
			editor.startEdge(source, target);
			return false;
		}}
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
			nodeColor={(n) => (n.type === 'lane' ? 'transparent' : (n.data.color as string))}
			nodeStrokeColor={(n) => (n.type === 'lane' ? '#1f2a3d' : 'transparent')}
			nodeBorderRadius={4}
		/>
		<ViewSync {editor} />
	</SvelteFlow>
</div>
