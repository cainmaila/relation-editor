<script lang="ts">
	import type { Editor } from '#lib/editor.svelte.js';
	import { nodeType } from '#lib/model/config.js';
	import { SYSTEM_COLORS } from './Canvas.svelte';
	import Modal from './Modal.svelte';

	let { editor }: { editor: Editor } = $props();

	let q = $state('');
	let i = $state(0);
	const hits = $derived(
		editor.graph.nodes
			.filter((n) => `${n.name} ${n.type}`.toLowerCase().includes(q.trim().toLowerCase()))
			.slice(0, 8)
	);

	function go(id: string) {
		editor.dialog = null;
		// 全圖只選取＋飛過去；編輯頁加入後置中。超過上限時 addToWork 已設 message，不 reveal（會清掉提示）
		if (editor.page === 'graph' || editor.addToWork([id])) editor.reveal(id);
	}

	function key(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') i = Math.min(i + 1, hits.length - 1);
		else if (e.key === 'ArrowUp') i = Math.max(i - 1, 0);
		else if (e.key === 'Enter' && hits[i]) go(hits[i].id);
		else return;
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
			bind:value={q}
			oninput={() => (i = 0)}
			onkeydown={key}
			autofocus
			aria-label="搜尋節點"
			placeholder="輸入名稱或類型，例：A-01、UPS、客戶"
			class="w-full border-0 bg-transparent py-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:ring-0"
		/>
		<span class="kbd">Esc</span>
	</div>
	<ul class="max-h-80 overflow-y-auto p-1.5" role="listbox" aria-label="搜尋結果">
		{#each hits as n, k (n.id)}
			{@const s = nodeType(n.type).system}
			<li role="option" aria-selected={k === i}>
				<button
					class={[
						'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm',
						k === i ? 'bg-sky-400/15 text-slate-50' : 'text-slate-300'
					]}
					onmouseenter={() => (i = k)}
					onclick={() => go(n.id)}
				>
					<span class="size-2 rounded-full" style:background={SYSTEM_COLORS[s ?? '通用']}></span>
					{n.name}
					<span class="ml-auto font-mono text-[10px] text-slate-500">{s ?? '通用'} · {n.type}</span>
				</button>
			</li>
		{:else}
			<li class="px-3 py-6 text-center text-xs text-slate-500">找不到「{q}」</li>
		{/each}
	</ul>
	<p class="flex gap-3 border-t border-white/6 px-4 py-2 text-[10px] text-slate-500">
		<span><span class="kbd">↑↓</span> 移動</span><span
			><span class="kbd">Enter</span> 選取並置中</span
		>
	</p>
</Modal>
