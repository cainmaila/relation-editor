<script lang="ts">
	import type { Editor } from '#lib/editor.svelte.js';
	import type { GNode } from '#lib/model/types.js';
	import { EDGE_COLORS } from './Canvas.svelte';

	let { editor }: { editor: Editor } = $props();

	const unprocessedNodes = $derived(editor.graph.nodes.filter((n) => editor.unprocessed.has(n.id)));
	const unreachableNodes = $derived(editor.graph.nodes.filter((n) => editor.unreachable.has(n.id)));
</script>

{#snippet list(
	label: string,
	title: string,
	hint: string,
	items: GNode[],
	tone: string,
	empty: string
)}
	<details open class="group border-b border-white/6" aria-label={label} role="region">
		<summary
			class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-xs font-semibold text-slate-200 hover:bg-white/3"
		>
			<svg
				viewBox="0 0 16 16"
				class="size-3 fill-slate-500 transition-transform group-open:rotate-90"
				><path d="M6 4l4 4-4 4z" /></svg
			>
			<h2>{title}（{items.length}）</h2>
		</summary>
		<div class="px-4 pb-4">
			<p class="mb-2 text-[11px] leading-relaxed text-slate-500">{hint}</p>
			<ul class="flex flex-col gap-1">
				{#each items as n (n.id)}
					<li>
						<button
							class="flex w-full items-center gap-2 rounded-md border border-white/6 bg-white/2 px-2.5 py-1.5 text-left text-xs text-slate-200 transition-colors hover:border-white/15 hover:bg-white/5"
							onclick={() => editor.reveal(n.id)}
						>
							<span class={['size-1.5 shrink-0 rounded-full', tone]}></span>
							<span class="truncate">{n.name}</span>
						</button>
					</li>
				{:else}
					<li class="flex items-center gap-2 text-xs text-emerald-400/80">
						<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="2"
							><path d="m3.5 8.5 3 3 6-7" /></svg
						>{empty}
					</li>
				{/each}
			</ul>
		</div>
	</details>
{/snippet}

<div class="flex min-h-full flex-col">
	<div class="px-4 pt-4 pb-2">
		<p class="eyebrow">檢查</p>
		<p class="mt-1 text-[11px] text-slate-500">依當下的圖即時計算</p>
	</div>
	{@render list(
		'未處理節點',
		'未處理節點',
		'沒連到根節點「TPKC 大樓」，還沒整理進主圖。',
		unprocessedNodes,
		'bg-yellow-400',
		'全部已整理進主圖'
	)}
	{@render list(
		'到不了客戶節點',
		'到不了客戶',
		'沿邊的方向走不到任何客戶，關係鏈在此有缺口。',
		unreachableNodes,
		'bg-rose-500',
		'每個節點都走得到客戶'
	)}

	<details open class="group mt-auto border-t border-white/6" aria-label="圖例" role="region">
		<summary
			class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-xs font-semibold text-slate-200 hover:bg-white/3"
		>
			<svg
				viewBox="0 0 16 16"
				class="size-3 fill-slate-500 transition-transform group-open:rotate-90"
				><path d="M6 4l4 4-4 4z" /></svg
			>
			<h2>圖例</h2>
		</summary>
		<div class="flex flex-col gap-3 px-4 pb-4 text-[11px] text-slate-400">
			<ul class="grid grid-cols-2 gap-x-3 gap-y-1.5">
				{#each Object.entries(EDGE_COLORS) as [name, color] (name)}
					<li class="flex items-center gap-2">
						<svg viewBox="0 0 24 6" class="h-1.5 w-6" style:color
							><path d="M0 3h20" stroke="currentColor" stroke-width="2" /><path
								d="M18 0l6 3-6 3z"
								fill="currentColor"
							/></svg
						>{name}
					</li>
				{/each}
			</ul>
			<ul class="flex flex-col gap-1.5">
				<li class="flex items-center gap-2">
					<svg viewBox="0 0 24 6" class="h-1.5 w-6"
						><path d="M0 3h24" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 3" /></svg
					>虛線＝推定
				</li>
				<li class="flex items-center gap-2">
					<span class="h-3 w-6 rounded-sm border border-dashed border-yellow-400"
					></span>虛框＝未處理
				</li>
				<li class="flex items-center gap-2">
					<span class="h-3 w-6 rounded-sm border border-rose-500"></span>紅框＝到不了客戶
				</li>
				<li class="flex items-center gap-2">
					<svg viewBox="0 0 16 16" class="mx-1.5 size-3 fill-slate-500"
						><path
							d="M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z"
						/></svg
					>鎖頭＝IDC 維護（唯讀）
				</li>
			</ul>
		</div>
	</details>
</div>
