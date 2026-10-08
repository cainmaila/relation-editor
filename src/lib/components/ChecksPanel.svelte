<script lang="ts">
	import type { Editor } from '#lib/editor.svelte.js';
	import type { GNode } from '#lib/model/types.js';
	import { EDGE_COLORS, SYSTEM_COLORS } from './Canvas.svelte';
	import Icon from './Icon.svelte';

	let { editor }: { editor: Editor } = $props();

	const unprocessedNodes = $derived(editor.graph.nodes.filter((n) => editor.unprocessed.has(n.id)));
	const unreachableNodes = $derived(editor.graph.nodes.filter((n) => editor.unreachable.has(n.id)));
</script>

{#snippet list(
	label: string,
	title: string,
	hint: string,
	items: GNode[],
	icon: string,
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
			<Icon name={icon} class={['size-3.5', items.length ? tone : 'text-slate-600']} />
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
							<Icon name={icon} class={['size-3', tone]} />
							<span class="truncate">{n.name}</span>
						</button>
					</li>
				{:else}
					<li class="flex items-center gap-2 text-xs text-emerald-400/80">
						<Icon name="check" class="size-3.5" />{empty}
					</li>
				{/each}
			</ul>
		</div>
	</details>
{/snippet}

<div class="flex min-h-full flex-col">
	<p class="px-4 pt-4 pb-2 eyebrow" title="依當下的圖即時計算">檢查</p>
	{@render list(
		'未處理節點',
		'未處理節點',
		'沒連到根節點「TPKC 大樓」，還沒整理進主圖。',
		unprocessedNodes,
		'warn',
		'text-yellow-300',
		'全部已整理進主圖'
	)}
	{@render list(
		'到不了客戶節點',
		'到不了客戶',
		'沿邊的方向走不到任何客戶，關係鏈在此有缺口。',
		unreachableNodes,
		'broken',
		'text-rose-300',
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
			<ul class="grid grid-cols-2 gap-x-3 gap-y-1.5" aria-label="系統">
				{#each Object.entries(SYSTEM_COLORS) as [name, color] (name)}
					<li class="flex items-center gap-2">
						<span style:color><Icon {name} class="size-3.5" /></span>{name}
					</li>
				{/each}
			</ul>
			<ul
				class="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-white/6 pt-3"
				aria-label="邊類型"
			>
				{#each Object.entries(EDGE_COLORS) as [name, color] (name)}
					<li class="flex items-center gap-2">
						<span style:color><Icon {name} class="size-3.5" /></span>{name}
					</li>
				{/each}
			</ul>
			<ul class="flex flex-col gap-1.5 border-t border-white/6 pt-3">
				<li class="flex items-center gap-2">
					<svg viewBox="0 0 24 6" class="h-1.5 w-3.5"
						><path d="M0 3h24" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 3" /></svg
					>虛線＝推定
				</li>
				<li class="flex items-center gap-2">
					<Icon name="warn" class="size-3.5 text-yellow-300" />未處理（虛框）
				</li>
				<li class="flex items-center gap-2">
					<Icon name="broken" class="size-3.5 text-rose-300" />到不了客戶（紅框）
				</li>
				<li class="flex items-center gap-2">
					<Icon name="lock" class="size-3.5 text-slate-500" />IDC 維護（唯讀）
				</li>
			</ul>
		</div>
	</details>
</div>
