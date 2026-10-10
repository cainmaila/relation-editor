<script lang="ts">
	// 左欄大綱：全量搜尋、問題篩選、分頁結果（不常駐全部節點的 DOM）。點列＝定位，滑過＝畫布亮起；全圖可勾選後加入編輯頁
	import { untrack } from 'svelte';
	import type { Editor } from '#lib/editor.svelte.js';
	import { UNREACHABLE_LABEL, nodeType } from '#lib/model/config.js';
	import { SearchController } from '#lib/search/search-client.svelte.js';
	import Icon from './Icon.svelte';
	import SearchResults from './SearchResults.svelte';

	let { editor }: { editor: Editor } = $props();

	const ISSUES = [
		{
			key: 'unprocessed',
			label: '未處理',
			icon: 'warn',
			tone: 'text-yellow-300',
			on: 'border-yellow-300/40 bg-yellow-300/10 text-yellow-100',
			hint: '沒連到根節點「TPKC 大樓」',
			ok: '全部已整理進主圖'
		},
		{
			key: 'unreachable',
			label: UNREACHABLE_LABEL,
			icon: 'broken',
			tone: 'text-rose-300',
			on: 'border-rose-300/40 bg-rose-300/10 text-rose-100',
			hint: '沿邊的方向走不到任何客戶',
			ok: '每個節點都走得到客戶'
		}
	] as const;

	const c = $derived(editor.outline);
	const graph = $derived(editor.page === 'graph');
	const issue = $derived(ISSUES.find((i) => i.key === editor.issue));
	let added = $state(false);

	// 全圖查全部節點（隱藏系統變淡，仍可從這裡定位）；編輯頁只查工作區
	$effect(() => {
		editor.outline.set({
			within: graph ? null : [...editor.working],
			issues: editor.issue ? [editor.issue] : []
		});
	});

	/** 文字＋問題篩選沒結果時，另查「只看文字」有沒有命中，才知道該不該怪問題篩選 */
	const textOnly = new SearchController(
		untrack(() => editor.search),
		{ limit: 0 }
	);
	const empty = $derived(!!issue && !!c.text.trim() && c.status === 'ready' && c.total === 0);
	$effect(() => {
		if (empty) textOnly.set({ text: c.text, within: c.within });
	});
	$effect(() => () => textOnly.dispose());
	const textHits = $derived(empty && textOnly.status === 'ready' && textOnly.total > 0);
</script>

<nav aria-label="大綱" class="flex h-full flex-col">
	<div class="flex flex-col gap-2 border-b border-white/6 p-3">
		<label class="relative block">
			<Icon
				name="search"
				class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-slate-500"
			/>
			<input
				type="search"
				aria-label="篩選節點"
				placeholder="篩選節點"
				value={c.text}
				oninput={(e) => c.set({ text: e.currentTarget.value })}
				onkeydown={(e) => {
					if (e.key === 'Escape' && c.text) {
						c.set({ text: '' });
						e.stopPropagation();
					}
				}}
				class="w-full rounded-md border border-white/8 bg-white/3 py-1.5 pr-2 pl-8 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-400/50 focus:bg-white/5 focus:ring-0 focus:outline-none"
			/>
		</label>
		{#if graph}
			<div class="flex gap-1.5">
				{#each ISSUES as i (i.key)}
					{@const n = editor[i.key].size}
					{@const on = editor.issue === i.key}
					<button
						aria-pressed={on}
						aria-label="只列{i.label}"
						title="{i.label}：{i.hint}"
						class={[
							'flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors',
							on ? i.on : 'border-white/8 text-slate-400 hover:bg-white/5'
						]}
						onclick={() => (editor.issue = on ? null : i.key)}
					>
						<Icon name={i.icon} class={['size-3.5', n ? i.tone : 'text-slate-600']} />
						{i.label}
						<b class={['font-mono', n ? 'text-slate-100' : 'text-slate-600']}>{n}</b>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<p class="px-3 pt-2 text-[10px] text-slate-500">
		{graph ? '全圖所有節點' : '編輯頁內的節點'}{issue ? `・只列${issue.label}` : ''}
	</p>
	<SearchResults
		controller={c}
		node={editor.node}
		label="節點"
		selectable={graph}
		current={editor.selected?.kind === 'node' ? editor.selected.id : null}
		muted={(n) => {
			const s = nodeType(n.type)?.system;
			return graph && !!s && !editor.systems.includes(s);
		}}
		onpick={(id) => editor.locate(id)}
		onhover={(id) => {
			const s = id && nodeType(editor.node(id)!.type)?.system;
			editor.hoverNode = id && (!graph || !s || editor.systems.includes(s)) ? id : null;
		}}
	>
		{#snippet row(n)}
			<span class="ml-auto flex items-center gap-1">
				{#each ISSUES as i (i.key)}
					{#if graph && editor[i.key].has(n.id)}
						<Icon name={i.icon} label={i.label} class={['size-3', i.tone]} />
					{/if}
				{/each}
				{#if n.readonly}<Icon name="lock" label="IDC 維護" class="size-3 text-slate-600" />{/if}
			</span>
		{/snippet}
		{#snippet actions(ids)}
			{#if added}
				<button class="text-sky-300 hover:text-sky-200" onclick={() => editor.setPage('edit')}
					>前往編輯頁</button
				>
			{/if}
			<button
				class="btn-primary px-2 py-0.5 text-[11px]"
				onclick={() => (added = editor.addToWorkspace(ids))}>加入編輯頁（{ids.length}）</button
			>
		{/snippet}
		{#snippet empty()}
			{#if issue && !c.text.trim()}
				<Icon name="check" class="size-3.5 text-emerald-400" />
				<span class="text-emerald-300/90">{issue.ok}</span>
			{:else if issue && textHits}
				<span>「{c.text.trim()}」裡沒有{issue.label}的節點</span>
				<button class="text-sky-300 hover:text-sky-200" onclick={() => (editor.issue = null)}
					>清除{issue.label}篩選</button
				>
			{:else}
				沒有符合的節點
			{/if}
		{/snippet}
	</SearchResults>
</nav>
