<script lang="ts">
	// 共用搜尋結果清單：總數、每頁 50 筆翻頁、跨頁勾選；快捷搜尋、大綱、建邊端點共用。
	// 只畫當頁的列，不常駐全部節點的 DOM；更新中明示，不把舊結果當最新。
	import type { Snippet } from 'svelte';
	import { nodeType } from '#lib/model/config.js';
	import type { GNode } from '#lib/model/types.js';
	import type { SearchController } from '#lib/search/search-client.svelte.js';
	import { SYSTEM_COLORS } from './Canvas.svelte';

	let {
		controller: c,
		node,
		label,
		onpick,
		listbox = false,
		selectable = false,
		active = $bindable(-1),
		current = null,
		muted,
		onhover,
		row,
		actions,
		empty
	}: {
		controller: SearchController;
		node: (id: string) => GNode | undefined;
		label: string;
		/** 主要動作（定位／選為端點）；不影響勾選 */
		onpick: (id: string) => void;
		/** 鍵盤選取用的 listbox／option 語意（快捷搜尋、端點） */
		listbox?: boolean;
		/** 顯示勾選框與「已選 N／清除已選」 */
		selectable?: boolean;
		active?: number;
		/** 目前選取的節點，標示該列 */
		current?: string | null;
		/** 淡化的列（例：全圖隱藏中的系統） */
		muted?: (n: GNode) => boolean;
		onhover?: (id: string | null) => void;
		row?: Snippet<[GNode]>;
		actions?: Snippet<[string[]]>;
		empty?: Snippet;
	} = $props();

	const rows = $derived(c.ids.map((id) => node(id)).filter((n): n is GNode => !!n));
	const pending = $derived(c.status === 'pending' || c.status === 'idle');
	const from = $derived(c.total ? c.offset + 1 : 0);
	const to = $derived(Math.min(c.offset + c.limit, c.total));

	let list = $state<HTMLElement>();
	// 選取的節點若在當頁，捲到該列
	$effect(() => {
		if (!current || !rows.some((n) => n.id === current)) return;
		list?.querySelector(`[data-id="${CSS.escape(current)}"]`)?.scrollIntoView({ block: 'nearest' });
	});
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-500">
		{#if c.status === 'error'}
			<span role="alert" class="text-rose-300">搜尋失敗：{c.error}</span>
			<button class="ml-auto text-sky-300 hover:text-sky-200" onclick={() => c.retry()}>重試</button
			>
		{:else}
			<span aria-live="polite">{pending ? '更新中…' : `共 ${c.total} 筆`}</span>
			{#if !pending && c.total > c.limit}
				<span class="ml-auto font-mono">{from}–{to}</span>
			{/if}
		{/if}
	</div>

	{#if selectable && c.picked.length}
		<div
			class="flex flex-wrap items-center gap-2 border-y border-white/6 bg-sky-400/5 px-3 py-1.5 text-[11px] text-slate-300"
		>
			<span>已選 <b class="font-mono text-slate-50">{c.picked.length}</b></span>
			<button class="text-slate-400 hover:text-slate-100" onclick={() => c.clearPicked()}
				>清除已選</button
			>
			<span class="ml-auto flex items-center gap-2">{@render actions?.(c.picked)}</span>
		</div>
	{/if}

	<ul
		bind:this={list}
		role={listbox ? 'listbox' : undefined}
		aria-label={label}
		aria-busy={pending}
		class={['min-h-0 overflow-y-auto p-1', rows.length && 'flex-1', pending && 'opacity-60']}
	>
		{#each rows as n, k (n.id)}
			{@const s = nodeType(n.type)?.system ?? '通用'}
			{@const on = n.id === current}
			<li
				role={listbox ? 'option' : undefined}
				aria-selected={listbox ? k === active : undefined}
				class="flex items-center"
			>
				{#if selectable}
					<input
						type="checkbox"
						class="mx-1.5 size-3.5 shrink-0 rounded border-white/20 bg-transparent text-sky-400 focus:ring-sky-400 focus:ring-offset-0"
						aria-label="勾選 {n.name}"
						checked={c.picked.includes(n.id)}
						onchange={() => c.toggle(n.id)}
					/>
				{/if}
				<button
					type="button"
					data-id={n.id}
					title={n.type}
					aria-current={on || undefined}
					class={[
						'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
						on
							? 'bg-sky-400/12 text-slate-50'
							: listbox && k === active
								? 'bg-sky-400/15 text-slate-50'
								: muted?.(n)
									? 'text-slate-500 hover:bg-white/4'
									: 'text-slate-300 hover:bg-white/4 hover:text-slate-50'
					]}
					onclick={() => onpick(n.id)}
					onpointerenter={() => {
						// 更新中畫的是舊結果：游標不動、列在底下換掉也會觸發 pointerenter，
						// 不能讓舊列的索引變成新結果的作用列（新結果較少時 Enter 會落空）
						if (!pending) active = k;
						onhover?.(n.id);
					}}
					onpointerleave={() => onhover?.(null)}
				>
					<span class="size-2 shrink-0 rounded-full" style:background={SYSTEM_COLORS[s]}></span>
					<span class="truncate">{n.name}</span>
					{@render row?.(n)}
				</button>
			</li>
		{/each}
	</ul>
	{#if !rows.length && c.status === 'ready'}
		<p class="flex items-center justify-center gap-2 px-4 py-6 text-xs text-slate-500">
			{#if empty}{@render empty()}{:else}沒有符合的節點{/if}
		</p>
	{/if}

	{#if c.total > c.limit}
		<div class="flex items-center gap-2 border-t border-white/6 px-3 py-1.5 text-[11px]">
			<button
				type="button"
				class="btn-ghost px-2 py-0.5 text-[11px]"
				disabled={pending || c.offset === 0}
				onclick={() => c.goto(c.offset - c.limit)}>上一頁</button
			>
			<span class="mx-auto font-mono text-slate-500"
				>第 {Math.floor(c.offset / c.limit) + 1} / {Math.ceil(c.total / c.limit)} 頁</span
			>
			<button
				type="button"
				class="btn-ghost px-2 py-0.5 text-[11px]"
				disabled={pending || to >= c.total}
				onclick={() => c.goto(c.offset + c.limit)}>下一頁</button
			>
		</div>
	{/if}
</div>
