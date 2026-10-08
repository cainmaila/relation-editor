<script lang="ts" module>
	export type GraphNodeData = {
		name: string;
		type: string;
		system: string;
		color: string;
		readonly: boolean;
		unprocessed: boolean;
		unreachable: boolean;
		dim: boolean;
		/** 只是滑過（沒選取）：淡化較輕 */
		soft: boolean;
		active: boolean;
		/** 找客戶的起點 */
		origin: boolean;
		fresh: boolean;
	};
</script>

<script lang="ts">
	import { Handle, Position, type NodeProps, type Node } from '@xyflow/svelte';
	import { IDC_MESSAGE } from '#lib/model/config.js';
	import Icon from './Icon.svelte';

	let { data }: NodeProps<Node<GraphNodeData>> = $props();
</script>

<!-- 整張卡片就是連線把手：拖到別的卡片上即建立關聯（target 在拖曳中才浮上來接） -->
<Handle type="target" position={Position.Left} class="easy" />
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
		data.dim && (data.soft ? 'opacity-55' : 'opacity-20')
	]}
>
	<span class="flex items-center gap-1.5 text-xs font-semibold text-slate-50">
		<span class="text-(--c)" title={data.system}><Icon name={data.system} class="size-3.5" /></span>
		<span class="truncate">{data.name}</span>
		{#if data.readonly}
			<span class="relative z-2 ml-auto text-slate-500" title="唯讀・{IDC_MESSAGE}">
				<Icon name="lock" class="size-3" label="唯讀" />
			</span>
		{/if}
	</span>
	<span class="mt-0.5 flex items-center gap-1 pl-5 font-mono text-[10px] text-slate-400">
		<span class="truncate">{data.type}</span>
		{#if data.unprocessed}
			<span class="relative z-2 ml-auto text-yellow-300" title="未處理：還沒連到 TPKC 大樓">
				<Icon name="warn" class="size-3" label="未處理" />
			</span>
		{/if}
		{#if data.unreachable}
			<span
				class={['relative z-2 text-rose-300', !data.unprocessed && 'ml-auto']}
				title="到不了客戶"
			>
				<Icon name="broken" class="size-3" label="到不了客戶" />
			</span>
		{/if}
	</span>
</div>
<Handle type="source" position={Position.Right} class="easy" />
