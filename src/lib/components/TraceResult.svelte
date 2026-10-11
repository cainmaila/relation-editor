<script lang="ts">
	// 找客戶結果：客戶、沿途節點、沿途關係三份完整清單，各自每頁 50、顯示完整總數、以 ID 為 key。
	// 點客戶＝定位（隱藏系統會勾回並選取）；點關係＝單獨亮這條邊並保留整個追查；可把兩端整批加入編輯頁（受 200／1,000 預算限制）
	import type { Editor } from '#lib/editor.svelte.js';
	import { Pager } from '#lib/pager.svelte.js';
	import PageNav from './PageNav.svelte';
	import { LOD } from '#lib/universe/lod.js';

	let { editor }: { editor: Editor } = $props();

	const result = $derived(editor.result!);
	const source = $derived(editor.trace!.source);
	const nameOf = (id: string) => editor.node(id)?.name ?? id;
	const nodes = $derived([...result.nodes]);
	const edges = $derived([...result.edges]);
	/** 同名客戶要分開顯示：名稱重複的加註 ID */
	const dupNames = $derived.by(() => {
		const seen: Record<string, number> = {};
		for (const id of result.customerIds) seen[nameOf(id)] = (seen[nameOf(id)] ?? 0) + 1;
		return seen;
	});
	const label = (id: string) => (dupNames[nameOf(id)] > 1 ? `${nameOf(id)}（${id}）` : nameOf(id));

	const customers = new Pager(() => result.customerIds.length);
	const nodePager = new Pager(() => nodes.length);
	const edgePager = new Pager(() => edges.length);
	/** 沿途清單收起時不渲染（上萬筆也只在展開時畫當頁 50 筆） */
	let showNodes = $state(false);
	let showEdges = $state(false);
	const selectedEdge = $derived(editor.selected?.kind === 'edge' ? editor.selected.id : null);
</script>

<section
	aria-label="找客戶結果"
	class="m-4 mb-0 overflow-hidden rounded-lg border border-sky-400/30 bg-linear-to-br from-sky-400/15 to-indigo-500/5"
>
	<div class="flex items-center gap-2 px-4 pt-3">
		<p class="eyebrow text-sky-300!">找客戶結果</p>
		<button
			class="ml-auto text-[11px] text-slate-400 hover:text-slate-200"
			onclick={() => editor.clearTrace()}>清除 <span class="kbd">Esc</span></button
		>
	</div>
	<p class="px-4 pt-1 text-sm text-slate-300">
		從 <b class="text-slate-50">{nameOf(source)}</b> 沿方向走得到
		<b class="text-2xl font-semibold text-sky-300 tabular-nums">{result.customerIds.length}</b>
		位客戶
	</p>
	<p aria-label="分析版本" class="px-4 pt-0.5 text-[11px] text-slate-400">
		完整標準圖・拓撲版本 {editor.traceRevision}
		{#if editor.traceChanged}
			<span class="text-amber-300">・拓撲已變更，已依最新資料重算</span>
		{/if}
	</p>
	<div class="px-4 pt-2">
		{#if result.customerIds.length}<PageNav pager={customers} unit="位客戶" label="客戶分頁" />{/if}
		<ul aria-label="客戶" class="flex flex-wrap gap-1.5">
			{#each customers.slice(result.customerIds) as id (id)}
				<li>
					<button
						class="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-0.5 text-xs text-emerald-200 hover:bg-emerald-400/20"
						onclick={() => editor.locate(id)}>{label(id)}</button
					>
				</li>
			{:else}
				<li class="text-xs text-rose-300">走不到任何客戶</li>
			{/each}
		</ul>
	</div>
	<div class="mt-2 border-t border-white/6 px-4 py-2 text-[11px] text-slate-400">
		<p>完整查詢：沿途 {nodes.length} 個節點、{edges.length} 條邊</p>
		<p class="pt-0.5 text-slate-500">
			畫布高亮最多畫 {LOD.maxHighlightEdges.toLocaleString('en-US')} 條、隱藏系統的不畫；已畫／省略／系統隱藏數見畫布「細節層級」的高亮連線。清單永遠是完整結果
		</p>
	</div>
	<details bind:open={showNodes} class="border-t border-white/6 px-4 py-2 text-xs">
		<summary class="cursor-pointer text-[11px] text-slate-400">沿途節點（{nodes.length}）</summary>
		{#if showNodes}
			<div class="pt-1.5">
				<PageNav pager={nodePager} label="沿途節點分頁" />
				<ul aria-label="沿途節點" class="flex flex-col gap-0.5">
					{#each nodePager.slice(nodes) as id (id)}
						<li>
							<button
								class="w-full truncate rounded px-1.5 py-0.5 text-left text-slate-200 hover:bg-white/5"
								onclick={() => editor.reveal(id)}>{nameOf(id)}</button
							>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</details>
	<details bind:open={showEdges} class="border-t border-white/6 px-4 py-2 text-xs">
		<summary class="cursor-pointer text-[11px] text-slate-400">沿途關係（{edges.length}）</summary>
		{#if showEdges}
			<div class="pt-1.5">
				<PageNav pager={edgePager} unit="條" label="沿途關係分頁" />
				<ul aria-label="沿途關係" class="flex flex-col gap-0.5">
					{#each edgePager.slice(edges) as id (id)}
						{@const e = editor.edge(id)}
						{#if e}
							<li class="flex items-center gap-1">
								<button
									aria-current={selectedEdge === id ? 'true' : undefined}
									class={[
										'flex min-w-0 flex-1 items-center gap-1 rounded px-1.5 py-0.5 text-left hover:bg-white/5',
										selectedEdge === id ? 'bg-white/10 text-white' : 'text-slate-200'
									]}
									onclick={() => editor.focusEdge(id)}
								>
									<span class="truncate">{nameOf(e.from)}</span>
									<span class="shrink-0 text-slate-500"
										>{e.bidirectional ? '⇄' : '→'} {e.type} {e.bidirectional ? '⇄' : '→'}</span
									>
									<span class="truncate">{nameOf(e.to)}</span>
								</button>
								{#if selectedEdge === id}
									{#if editor.inWork(e.from) && editor.inWork(e.to)}
										<span class="shrink-0 text-[11px] text-slate-500">已在編輯頁</span>
									{:else}
										<button
											class="btn-ghost shrink-0 px-1.5 py-0.5 text-[11px]"
											onclick={() => editor.admitEdgeEnds(id)}>兩端加入編輯頁</button
										>
									{/if}
								{/if}
							</li>
						{/if}
					{/each}
				</ul>
			</div>
		{/if}
	</details>
</section>
