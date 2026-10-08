<script lang="ts">
	import type { NodeProps, Node } from '@xyflow/svelte';

	let { data, width, height }: NodeProps<Node<{ label: string }>> = $props();
</script>

<div
	class="rounded-lg border border-slate-300 bg-slate-50/70"
	style:width="{width}px"
	style:height="{height}px"
>
	<h2 class="border-b border-slate-300 px-3 py-2 text-sm font-semibold text-slate-600">
		{data.label}
	</h2>
</div>
