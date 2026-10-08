<script lang="ts" module>
	export type GraphNodeData = {
		name: string;
		type: string;
		readonly: boolean;
		unprocessed: boolean;
		unreachable: boolean;
		dim: boolean;
		active: boolean;
	};
</script>

<script lang="ts">
	import { Handle, Position, type NodeProps, type Node } from '@xyflow/svelte';

	let { data }: NodeProps<Node<GraphNodeData>> = $props();
</script>

<Handle type="target" position={Position.Top} />
<div
	class={[
		'flex h-11 w-40 flex-col justify-center rounded-md border-2 bg-white px-2 text-left leading-tight transition-opacity',
		data.readonly ? 'border-slate-400 bg-slate-100' : 'border-slate-500',
		data.unprocessed && 'border-dashed border-amber-500 bg-amber-50',
		data.unreachable && !data.unprocessed && 'border-red-500',
		data.active && 'ring-4 ring-sky-400',
		data.dim && 'opacity-20'
	]}
>
	<span class="truncate text-xs font-semibold text-slate-900">{data.name}</span>
	<span class="flex gap-1 truncate text-[10px] text-slate-500">
		{data.type}
		{#if data.unprocessed}<span class="font-semibold text-amber-700">未處理</span>{/if}
		{#if data.unreachable}<span class="font-semibold text-red-600">到不了客戶</span>{/if}
	</span>
</div>
<Handle type="source" position={Position.Bottom} />
