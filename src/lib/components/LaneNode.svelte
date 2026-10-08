<script lang="ts">
	import type { NodeProps, Node } from '@xyflow/svelte';

	let { data, width, height }: NodeProps<Node<{ label: string; color: string; count: number }>> =
		$props();
</script>

<div
	style:--c={data.color}
	style:width="{width}px"
	style:height="{height}px"
	class={[
		'rounded-xl border',
		data.label
			? 'border-white/6 bg-linear-to-b from-(--c)/8 via-white/2 to-transparent'
			: 'border-dashed border-white/8'
	]}
>
	{#if data.label}
		<div class="flex items-center gap-2 px-4 pt-3.5">
			<span class="size-2 rounded-full bg-(--c) shadow-[0_0_10px_var(--c)]"></span>
			<h2 class="text-sm font-semibold tracking-wide text-slate-100">{data.label}</h2>
			<span class="ml-auto font-mono text-[11px] text-slate-500">{data.count}</span>
		</div>
	{/if}
</div>
