<script lang="ts">
	// 一跳鄰居預覽：方向／邊類型篩選、每頁 50；預設不勾、不自動加入，按下加入才整批 admission
	import { SvelteSet } from 'svelte/reactivity';
	import type { Editor } from '#lib/editor.svelte.js';
	import {
		edgeTypesAround,
		neighborIds,
		planWorkspaceAdmission,
		type Direction
	} from '#lib/model/workspace.js';

	let { editor, id }: { editor: Editor; id: string } = $props();

	const PAGE = 50;
	const FIRST = 20;

	let dir = $state<Direction>('all');
	let type = $state('');
	let offset = $state(0);
	const checked = new SvelteSet<string>();

	const types = $derived(edgeTypesAround(editor.index, id, dir));
	const all = $derived(neighborIds(editor.index, id, dir, types.includes(type) ? type : null));
	const rows = $derived(all.slice(offset, offset + PAGE));
	const pages = $derived(Math.max(1, Math.ceil(all.length / PAGE)));
	const outside = $derived(editor.outsideCount(id));
	/** 勾選中仍不在工作區的（加入後或資料變動時自動排除） */
	const picked = $derived([...checked].filter((x) => editor.node(x) && !editor.inWork(x)));
	/** 純計算預覽：要新增的節點與帶入的邊；不改任何狀態 */
	const plan = $derived(
		picked.length ? planWorkspaceAdmission(editor.index, editor.working, picked) : null
	);

	/** 換條件回第一頁 */
	function filter(next: () => void) {
		next();
		offset = 0;
	}

	function pickFirst() {
		for (const x of rows.filter((r) => !editor.inWork(r)).slice(0, FIRST)) checked.add(x);
	}

	function add() {
		if (editor.addToWork(picked)) checked.clear();
	}
</script>

<section aria-label="鄰居預覽" class="border-t border-white/6 px-5 py-4">
	<div class="mb-2 flex items-baseline gap-2">
		<h3 class="eyebrow">鄰居預覽</h3>
		<span class="ml-auto text-[11px] text-slate-400">工作區外 {outside} 個鄰居</span>
	</div>
	<div class="mb-2 flex gap-1.5">
		<select
			aria-label="方向"
			class="field py-1 text-xs"
			value={dir}
			onchange={(e) => filter(() => (dir = e.currentTarget.value as Direction))}
		>
			<option value="all">全部</option>
			<option value="in">連入</option>
			<option value="out">連出</option>
		</select>
		<select
			aria-label="邊類型"
			class="field py-1 text-xs"
			value={types.includes(type) ? type : ''}
			onchange={(e) => filter(() => (type = e.currentTarget.value))}
		>
			<option value="">全部邊類型</option>
			{#each types as t (t)}<option value={t}>{t}</option>{/each}
		</select>
	</div>
	<p class="mb-1.5 flex items-center gap-2 text-[11px] text-slate-500">
		共 {all.length} 個
		{#if pages > 1}
			<span class="ml-auto">第 {offset / PAGE + 1} / {pages} 頁</span>
			<button
				class="btn-ghost px-1.5 py-0.5"
				disabled={offset === 0}
				onclick={() => (offset -= PAGE)}>上一頁</button
			>
			<button
				class="btn-ghost px-1.5 py-0.5"
				disabled={offset + PAGE >= all.length}
				onclick={() => (offset += PAGE)}>下一頁</button
			>
		{/if}
	</p>
	<ul class="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
		{#each rows as n (n)}
			{@const inside = editor.inWork(n)}
			<li>
				<label class="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-white/5">
					<input
						type="checkbox"
						class="size-3.5 rounded border-white/20 bg-transparent text-sky-400"
						disabled={inside}
						checked={inside || checked.has(n)}
						onchange={(e) => (e.currentTarget.checked ? checked.add(n) : checked.delete(n))}
					/>
					<span class="truncate text-slate-200">{editor.node(n)?.name ?? n}</span>
					{#if inside}<span class="ml-auto shrink-0 text-[11px] text-slate-500">已在編輯頁</span
						>{/if}
				</label>
			</li>
		{:else}
			<li class="text-xs text-slate-500">無</li>
		{/each}
	</ul>
	<div class="mt-2 flex flex-wrap items-center gap-1.5">
		<button class="btn-ghost px-2 py-1 text-[11px]" onclick={pickFirst}
			>勾選本頁前 {FIRST} 個</button
		>
		{#if checked.size}
			<button class="btn-ghost px-2 py-1 text-[11px]" onclick={() => checked.clear()}
				>取消勾選</button
			>
		{/if}
		<button class="ml-auto btn-primary px-2 py-1 text-[11px]" disabled={!plan?.ok} onclick={add}
			>加入勾選的 {picked.length} 個</button
		>
	</div>
	{#if plan}
		<p class={['mt-1.5 text-[11px]', plan.ok ? 'text-slate-400' : 'text-rose-300']}>
			{plan.ok
				? `將新增 ${plan.value.addedIds.length} 個節點、帶入 ${plan.value.addedEdgeCount} 條邊`
				: plan.message}
		</p>
	{/if}
</section>
