<script lang="ts">
	// 對話框殼：頂部置中浮卡，點背景關閉（Esc 由頁面統一處理）
	import type { Snippet } from 'svelte';

	let { label, onclose, children }: { label: string; onclose: () => void; children: Snippet } =
		$props();
</script>

<div class="fixed inset-0 z-40 flex justify-center bg-ink-950/50 pt-[12vh] backdrop-blur-[2px]">
	<button class="absolute inset-0 cursor-default" aria-label="關閉" tabindex="-1" onclick={onclose}
	></button>
	<div
		role="dialog"
		aria-label={label}
		class="relative h-fit max-h-[86vh] w-[440px] animate-rise overflow-y-auto rounded-xl border border-white/10 bg-ink-850/95 shadow-2xl shadow-black/60 backdrop-blur-xl"
	>
		{@render children()}
	</div>
</div>
