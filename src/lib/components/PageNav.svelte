<script lang="ts">
	// 完整清單的總數與翻頁（每頁 50）：總數永遠是完整數量，只有一頁時不顯示翻頁
	import type { Pager } from '#lib/pager.svelte.js';

	let {
		pager,
		unit = '個',
		label = '分頁'
	}: { pager: Pager; unit?: string; label?: string } = $props();

	// 總數縮小後頁碼固定在限制後的頁，不會在總數長回來時跳回原頁
	$effect.pre(() => pager.clamp());
</script>

<nav aria-label={label} class="mb-1.5 flex items-center gap-2 text-[11px] text-slate-500">
	共 {pager.total}
	{unit}
	{#if pager.pages > 1}
		<span class="ml-auto">第 {pager.page + 1} / {pager.pages} 頁</span>
		<button class="btn-ghost px-1.5 py-0.5" disabled={pager.page === 0} onclick={() => pager.prev()}
			>上一頁</button
		>
		<button
			class="btn-ghost px-1.5 py-0.5"
			disabled={pager.page + 1 >= pager.pages}
			onclick={() => pager.next()}>下一頁</button
		>
	{/if}
</nav>
