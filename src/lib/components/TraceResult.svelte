<script lang="ts">
	// 找客戶結果：客戶、沿途節點、沿途關係三份完整清單，各自每頁 50、顯示完整總數、以 ID 為 key。
	// 點客戶＝畫布只亮通往他的路徑並列出沿途機櫃（再點一次或「顯示全部客戶」回到全部）；點關係＝單獨亮這條邊並保留整個追查；可把兩端整批加入編輯頁（受 200／1,000 預算限制）
	import type { Editor } from '#lib/editor.svelte.js';
	import { Pager } from '#lib/pager.svelte.js';
	import PageNav from './PageNav.svelte';
	import { LOD } from '#lib/universe/lod.js';
	import { WORKSPACE_NODE_LIMIT } from '#lib/model/workspace.js';

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
	const picked = $derived(editor.highlight === result ? null : editor.traceCustomer);
	const cabinets = $derived(
		picked ? [...editor.highlight!.nodes].filter((id) => editor.node(id)?.type === '機櫃') : []
	);
	/** 沿途節點的勾選：跨頁保留；換起點時整個元件重建，自然清空 */
	let checked = $state.raw<string[]>([]);
	let added = $state(false);
	const allChecked = $derived(nodes.length > 0 && checked.length === nodes.length);
	const toggle = (id: string) =>
		(checked = checked.includes(id) ? checked.filter((x) => x !== id) : [...checked, id]);
	let checkedEdges = $state.raw<string[]>([]);
	let addedEdges = $state(false);
	const allEdgesChecked = $derived(edges.length > 0 && checkedEdges.length === edges.length);
	const toggleEdge = (id: string) =>
		(checkedEdges = checkedEdges.includes(id)
			? checkedEdges.filter((x) => x !== id)
			: [...checkedEdges, id]);
	/** 勾選的邊：兩端節點一起加入，邊就會跟著帶入 */
	const edgeEnds = () => [
		...new Set(
			checkedEdges.flatMap((id) => {
				const e = editor.edge(id);
				return e ? [e.from, e.to] : [];
			})
		)
	];
	/** 整條鏈路加入後會超過編輯頁節點上限（只算還不在編輯頁的） */
	const tooMany = $derived(
		editor.working.length + nodes.filter((id) => !editor.inWork(id)).length > WORKSPACE_NODE_LIMIT
	);
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
						aria-pressed={picked === id}
						class={[
							'rounded-full border px-2.5 py-0.5 text-xs hover:bg-emerald-400/20',
							picked === id
								? 'border-emerald-300 bg-emerald-400/30 text-white'
								: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
						]}
						onclick={() => editor.pickCustomer(id)}>{label(id)}</button
					>
				</li>
			{:else}
				<li class="text-xs text-rose-300">走不到任何客戶</li>
			{/each}
		</ul>
		{#if picked}
			<div class="flex items-center gap-2 pt-2 text-[11px] text-slate-400">
				<span>沿途機櫃（{cabinets.length}）</span>
				<button class="ml-auto hover:text-slate-200" onclick={() => editor.pickCustomer(null)}
					>顯示全部客戶</button
				>
			</div>
			<ul aria-label="沿途機櫃" class="flex flex-wrap gap-1 pt-1">
				{#each cabinets as id (id)}
					<li>
						<button
							class="rounded px-1.5 py-0.5 text-xs text-slate-200 hover:bg-white/5"
							onclick={() => editor.reveal(id)}>{nameOf(id)}</button
						>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
	<div class="mt-2 border-t border-white/6 px-4 py-2 text-[11px] text-slate-400">
		<div class="flex items-center gap-2">
			<p>完整查詢：沿途 {nodes.length} 個節點、{edges.length} 條邊</p>
			<button
				class="ml-auto btn-primary px-2 py-0.5 text-[11px]"
				disabled={tooMany}
				title={tooMany
					? `超過編輯頁上限 ${WORKSPACE_NODE_LIMIT} 節點：展開沿途節點勾選需要的`
					: '整條鏈路的節點與邊一起帶入；要挑選就展開下方清單勾選'}
				onclick={() => editor.addToWorkspace(nodes) && editor.setPage('edit')}
				>全部加入編輯頁（{nodes.length}）</button
			>
		</div>
		<p class="pt-0.5 text-slate-500">
			畫布最多高亮 {LOD.maxHighlightEdges.toLocaleString('en-US')} 條，隱藏系統不繪製；清單為完整結果
		</p>
	</div>
	<details bind:open={showNodes} class="border-t border-white/6 px-4 py-2 text-xs">
		<summary class="cursor-pointer text-[11px] text-slate-400">沿途節點（{nodes.length}）</summary>
		{#if showNodes}
			<div class="pt-1.5">
				<div class="flex flex-wrap items-center gap-2 pb-1 text-[11px] text-slate-300">
					<label class="flex items-center gap-1.5">
						<input
							type="checkbox"
							class="size-3.5 shrink-0 rounded border-white/20 bg-transparent text-sky-400 focus:ring-sky-400 focus:ring-offset-0"
							checked={allChecked}
							indeterminate={checked.length > 0 && !allChecked}
							onchange={() => (checked = allChecked ? [] : nodes)}
						/>
						全部勾選（{nodes.length}）
					</label>
					{#if checked.length}
						<span>已選 <b class="font-mono text-slate-50">{checked.length}</b></span>
						<button class="text-slate-400 hover:text-slate-100" onclick={() => (checked = [])}
							>清除</button
						>
						<span class="ml-auto flex items-center gap-2">
							{#if added}
								<button
									class="text-sky-300 hover:text-sky-200"
									onclick={() => editor.setPage('edit')}>前往編輯頁</button
								>
							{/if}
							<button
								class="btn-primary px-2 py-0.5 text-[11px]"
								onclick={() =>
									(added = editor.addToWorkspace(checked.filter((id) => result.nodes.has(id))))}
								>加入編輯頁（{checked.length}）</button
							>
						</span>
					{/if}
				</div>
				<PageNav pager={nodePager} label="沿途節點分頁" />
				<ul aria-label="沿途節點" class="flex flex-col gap-0.5">
					{#each nodePager.slice(nodes) as id (id)}
						<li class="flex items-center">
							<input
								type="checkbox"
								class="mr-1.5 size-3.5 shrink-0 rounded border-white/20 bg-transparent text-sky-400 focus:ring-sky-400 focus:ring-offset-0"
								aria-label="勾選 {nameOf(id)}"
								checked={checked.includes(id)}
								onchange={() => toggle(id)}
							/>
							<button
								class="min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left text-slate-200 hover:bg-white/5"
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
				<div class="flex flex-wrap items-center gap-2 pb-1 text-[11px] text-slate-300">
					<label class="flex items-center gap-1.5">
						<input
							type="checkbox"
							class="size-3.5 shrink-0 rounded border-white/20 bg-transparent text-sky-400 focus:ring-sky-400 focus:ring-offset-0"
							checked={allEdgesChecked}
							indeterminate={checkedEdges.length > 0 && !allEdgesChecked}
							onchange={() => (checkedEdges = allEdgesChecked ? [] : edges)}
						/>
						全部勾選（{edges.length}）
					</label>
					{#if checkedEdges.length}
						<span>已選 <b class="font-mono text-slate-50">{checkedEdges.length}</b></span>
						<button class="text-slate-400 hover:text-slate-100" onclick={() => (checkedEdges = [])}
							>清除</button
						>
						<span class="ml-auto flex items-center gap-2">
							{#if addedEdges}
								<button
									class="text-sky-300 hover:text-sky-200"
									onclick={() => editor.setPage('edit')}>前往編輯頁</button
								>
							{/if}
							<button
								class="btn-primary px-2 py-0.5 text-[11px]"
								onclick={() => (addedEdges = editor.addToWorkspace(edgeEnds()))}
								>加入編輯頁（{checkedEdges.length} 條邊）</button
							>
						</span>
					{/if}
				</div>
				<PageNav pager={edgePager} unit="條" label="沿途關係分頁" />
				<ul aria-label="沿途關係" class="flex flex-col gap-0.5">
					{#each edgePager.slice(edges) as id (id)}
						{@const e = editor.edge(id)}
						{#if e}
							<li class="flex items-center gap-1">
								<input
									type="checkbox"
									class="size-3.5 shrink-0 rounded border-white/20 bg-transparent text-sky-400 focus:ring-sky-400 focus:ring-offset-0"
									aria-label="勾選關係 {nameOf(e.from)} 到 {nameOf(e.to)}"
									checked={checkedEdges.includes(id)}
									onchange={() => toggleEdge(id)}
								/>
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
