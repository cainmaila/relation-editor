<script lang="ts">
	// ⌘K 快捷搜尋：查完整資料（含 3D 隱藏的系統），分頁、跨頁勾選。
	// Enter／點列＝定位（編輯頁：加入後定位）；勾選後「加入編輯頁」不換畫面、不改系統篩選。
	import type { Editor } from '#lib/editor.svelte.js';
	import { nodeType } from '#lib/model/config.js';
	import Modal from './Modal.svelte';
	import SearchResults from './SearchResults.svelte';

	let { editor }: { editor: Editor } = $props();

	const c = $derived(editor.palette);
	const graph = $derived(editor.page === 'graph');
	let active = $state(0);
	/** 結果更新中按了 Enter：新結果回來後再執行 */
	let queued = $state(false);
	let added = $state(false);

	// 每次打開從空查詢開始（勾選保留）
	$effect(() => {
		editor.palette.set({ text: '' });
	});

	$effect(() => {
		if (!queued || c.status !== 'ready') return;
		queued = false;
		const id = c.ids[active];
		if (id) go(id);
	});

	function go(id: string) {
		editor.dialog = null;
		// 全圖：選取＋飛過去；編輯頁：加入後定位。超過上限時 addToWork 已設 message
		if (graph || editor.addToWork([id])) editor.locate(id);
	}

	function key(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') active = Math.min(active + 1, c.ids.length - 1);
		else if (e.key === 'ArrowUp') active = Math.max(active - 1, 0);
		else if (e.key === 'Enter') {
			if (c.status === 'ready') {
				if (c.ids[active]) go(c.ids[active]);
			} else queued = true;
		} else return;
		e.preventDefault();
	}
</script>

<Modal label="搜尋節點" onclose={() => (editor.dialog = null)}>
	<div class="flex items-center gap-2.5 border-b border-white/8 px-4">
		<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-slate-500" stroke-width="1.6"
			><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg
		>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			value={c.text}
			oninput={(e) => {
				c.set({ text: e.currentTarget.value });
				active = 0;
			}}
			onkeydown={key}
			autofocus
			aria-label="搜尋節點"
			placeholder="名稱、ID、類型或屬性，例：A-01、UPS、客戶"
			class="w-full border-0 bg-transparent py-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:ring-0"
		/>
		<span class="kbd">Esc</span>
	</div>
	<div class="flex max-h-[60vh] flex-col">
		<SearchResults
			controller={c}
			node={editor.node}
			label="搜尋結果"
			listbox
			selectable
			bind:active
			onpick={go}
		>
			{#snippet row(n)}
				{@const s = nodeType(n.type)?.system ?? '通用'}
				<span class="ml-auto shrink-0 font-mono text-[10px] text-slate-500">{s} · {n.type}</span>
			{/snippet}
			{#snippet actions(ids)}
				{#if added && graph}
					<button class="text-sky-300 hover:text-sky-200" onclick={() => editor.setPage('edit')}
						>前往編輯頁</button
					>
				{/if}
				<button
					class="btn-primary px-2 py-0.5 text-[11px]"
					onclick={() => (added = editor.addToWorkspace(ids))}>加入編輯頁（{ids.length}）</button
				>
			{/snippet}
			{#snippet empty()}找不到「{c.text}」{/snippet}
		</SearchResults>
	</div>
	<p class="flex gap-3 border-t border-white/6 px-4 py-2 text-[10px] text-slate-500">
		<span><span class="kbd">↑↓</span> 移動</span>
		<span><span class="kbd">Enter</span> {graph ? '定位' : '加入並定位'}</span>
		<span>勾選可跨頁，再一次加入編輯頁</span>
	</p>
</Modal>
