<script lang="ts" module>
	export type GraphNodeData = {
		name: string;
		type: string;
		color: string;
		readonly: boolean;
		unprocessed: boolean;
		unreachable: boolean;
		dim: boolean;
		active: boolean;
		/** 找客戶的起點 */
		origin: boolean;
		fresh: boolean;
	};
</script>

<script lang="ts">
	import { Handle, Position, type NodeProps, type Node } from '@xyflow/svelte';

	let { data }: NodeProps<Node<GraphNodeData>> = $props();
</script>

<Handle type="target" position={Position.Top} />
<div
	style:--c={data.color}
	class={[
		'relative flex h-11 w-40 flex-col justify-center overflow-hidden rounded-md border pr-2 pl-3 text-left leading-tight shadow-lg shadow-black/30 transition-[opacity,box-shadow,border-color] duration-200',
		'before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-(--c)',
		data.readonly
			? 'border-white/5 bg-ink-850'
			: 'border-white/10 bg-ink-800 hover:border-white/25',
		data.unprocessed && 'border-dashed border-yellow-400/80 bg-yellow-400/5',
		data.unreachable && !data.unprocessed && 'border-rose-500/80 shadow-rose-500/20',
		data.active && 'border-sky-400! ring-2 ring-sky-400/40',
		data.origin && 'ring-4 ring-sky-400/60',
		data.fresh && 'animate-pulse-ring',
		data.dim && 'opacity-20'
	]}
>
	<span class="flex items-center gap-1 truncate text-xs font-semibold text-slate-50">
		{#if data.readonly}
			<svg viewBox="0 0 16 16" class="size-3 shrink-0 fill-slate-500" role="img" aria-label="唯讀">
				<path
					d="M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z"
				/>
			</svg>
		{/if}
		<span class="truncate">{data.name}</span>
	</span>
	<span class="mt-0.5 flex items-center gap-1 truncate font-mono text-[10px] text-slate-400">
		{data.type}
		{#if data.unprocessed}
			<span class="rounded-sm bg-yellow-400/15 px-1 font-sans font-semibold text-yellow-300"
				>未處理</span
			>
		{/if}
		{#if data.unreachable}
			<span class="rounded-sm bg-rose-500/15 px-1 font-sans font-semibold text-rose-300"
				>到不了客戶</span
			>
		{/if}
	</span>
</div>
<Handle type="source" position={Position.Bottom} />
