<script lang="ts">
	// 節點的連入／連出清單：完整總數、每頁 50（hub 可能上千條），以邊 ID 為 key
	import type { Editor } from '#lib/editor.svelte.js';
	import type { GEdge } from '#lib/model/types.js';
	import { nodeType } from '#lib/model/config.js';
	import { Pager } from '#lib/pager.svelte.js';
	import { EDGE_COLORS, SYSTEM_COLORS } from './Canvas.svelte';
	import Icon from './Icon.svelte';
	import PageNav from './PageNav.svelte';

	let {
		editor,
		title,
		list,
		other
	}: { editor: Editor; title: string; list: readonly GEdge[]; other: 'from' | 'to' } = $props();

	const pager = new Pager(() => list.length);
	// 翻頁列只在超過一頁時出現，頁碼限制不能跟著它卸載：總數縮到一頁後仍要寫回，長回來才不會跳回舊頁
	$effect.pre(() => pager.clamp());
	const nameOf = (id: string) => editor.node(id)?.name ?? id;
	const colorOf = (id: string) =>
		SYSTEM_COLORS[nodeType(editor.node(id)?.type ?? '').system ?? '通用'];
</script>

<section aria-label={title} class="border-t border-white/6 px-5 py-4">
	<h3 class="mb-2 eyebrow">{title}（{list.length}）</h3>
	{#if list.length > pager.size}<PageNav {pager} unit="條" label="{title}分頁" />{/if}
	<ul class="flex flex-col gap-1">
		{#each pager.slice(list) as e (e.id)}
			<li class="flex items-center gap-1">
				<button
					aria-label="{e.type}：{nameOf(e[other])}"
					class="group flex min-w-0 flex-1 items-center gap-2 rounded-md border border-white/6 bg-white/2 px-2.5 py-1.5 text-left text-xs transition-colors hover:border-white/15 hover:bg-white/5"
					onclick={() => editor.select({ kind: 'edge', id: e.id })}
					onmouseenter={() => (editor.hoverEdge = e.id)}
					onmouseleave={() => (editor.hoverEdge = null)}
				>
					<span style:color={EDGE_COLORS[e.type]} title={e.type}
						><Icon name={e.type} class="size-3.5" /></span
					>
					<span class="text-slate-600">{other === 'from' ? '←' : '→'}</span>
					<span class="size-1.5 shrink-0 rounded-full" style:background={colorOf(e[other])}></span>
					<span class="truncate text-slate-200">{nameOf(e[other])}</span>
					{#if e.bidirectional}<span class="ml-auto text-slate-500" title="雙向"
							><Icon name="swap" class="size-3" /></span
						>{/if}
				</button>
				{#if editor.inWork(e[other])}
					<span class="shrink-0 text-[11px] text-slate-500">已在編輯頁</span>
				{:else}
					<button
						class="btn-ghost shrink-0 px-2 py-1 text-[11px]"
						aria-label="加入編輯頁：{nameOf(e[other])}"
						onclick={() => editor.addToWork([e[other]])}>加入編輯頁</button
					>
				{/if}
			</li>
		{:else}
			<li class="text-xs text-slate-500">無</li>
		{/each}
	</ul>
</section>
