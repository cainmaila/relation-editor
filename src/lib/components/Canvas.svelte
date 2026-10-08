<script lang="ts" module>
	export const EDGE_COLORS: Record<string, string> = {
		包含: '#64748b',
		供電: '#ea580c',
		冷卻: '#0891b2',
		連線: '#2563eb',
		服務: '#16a34a',
		承載: '#9333ea',
		監測: '#db2777'
	};
</script>

<script lang="ts">
	import { SvelteFlow, Controls, MarkerType, type Node, type Edge } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import type { Editor } from '#lib/editor.svelte.js';
	import { LANES, NODE_H, NODE_W, layout } from '#lib/model/graph.js';
	import GraphNode from './GraphNode.svelte';
	import LaneNode from './LaneNode.svelte';

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
			data: { label: b.lane === '通用' ? '' : b.lane },
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
				readonly: !!n.readonly,
				unprocessed: editor.unprocessed.has(n.id),
				unreachable: editor.unreachable.has(n.id),
				dim: !!focus && !focus.nodes.has(n.id),
				active: editor.selected?.id === n.id
			}
		}))
	]);

	const edges = $derived<Edge[]>(
		editor.visible.edges.map((e) => {
			const color = EDGE_COLORS[e.type] ?? '#64748b';
			const marker = { type: MarkerType.ArrowClosed, color };
			const lit = focus?.edges.has(e.id);
			return {
				id: e.id,
				source: e.from,
				target: e.to,
				markerEnd: marker,
				markerStart: e.bidirectional ? marker : undefined,
				style: [
					`stroke: ${color}`,
					`stroke-width: ${lit ? 3 : 1.5}`,
					e.props['確認狀態'] === '推定' ? 'stroke-dasharray: 5 4' : '',
					focus && !lit ? 'opacity: 0.1' : ''
				].join(';')
			};
		})
	);
</script>

<SvelteFlow
	{nodes}
	{edges}
	{nodeTypes}
	fitView
	minZoom={0.1}
	nodesDraggable={false}
	deleteKey={null}
	colorMode="light"
	onnodeclick={({ node }) =>
		editor.select(node.type === 'lane' ? null : { kind: 'node', id: node.id })}
	onedgeclick={({ edge }) => editor.select({ kind: 'edge', id: edge.id })}
	onpaneclick={() => editor.select(null)}
	onbeforeconnect={({ source, target }) => {
		// 拉線只帶入起點終點，由表單選邊類型後才建立；不讓 Svelte Flow 自己加邊
		editor.startEdge(source, target);
		return false;
	}}
>
	<Controls />
</SvelteFlow>
