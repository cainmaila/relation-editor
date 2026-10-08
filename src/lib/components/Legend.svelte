<script lang="ts">
	// 畫布左下角的圖例卡；? 鍵或按鈕開關（鍵盤處理在 +page.svelte）
	import type { Editor } from '#lib/editor.svelte.js';
	import { EDGE_COLORS, SYSTEM_COLORS } from './Canvas.svelte';
	import Icon from './Icon.svelte';

	let { editor }: { editor: Editor } = $props();
</script>

<div
	class="absolute bottom-[15px] left-[54px] z-10 flex max-w-[calc(100%-219px)] flex-col items-start gap-2"
>
	{#if editor.legend}
		<section
			aria-label="圖例"
			class="w-72 max-w-full animate-rise rounded-lg border border-white/10 bg-ink-850/95 p-3 text-[11px] text-slate-400 shadow-2xl shadow-black/50 backdrop-blur-xl"
		>
			<ul class="grid grid-cols-4 gap-x-2 gap-y-1.5" aria-label="系統">
				{#each Object.entries(SYSTEM_COLORS) as [name, color] (name)}
					<li class="flex items-center gap-1.5">
						<span style:color><Icon {name} class="size-3.5" /></span>{name}
					</li>
				{/each}
			</ul>
			<ul
				class="mt-2.5 grid grid-cols-4 gap-x-2 gap-y-1.5 border-t border-white/6 pt-2.5"
				aria-label="邊類型"
			>
				{#each Object.entries(EDGE_COLORS) as [name, color] (name)}
					<li class="flex items-center gap-1.5">
						<span style:color><Icon {name} class="size-3.5" /></span>{name}
					</li>
				{/each}
			</ul>
			<ul class="mt-2.5 grid grid-cols-2 gap-x-2 gap-y-1.5 border-t border-white/6 pt-2.5">
				<li class="flex items-center gap-1.5">
					<svg viewBox="0 0 24 6" class="h-1.5 w-3.5"
						><path d="M0 3h24" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 3" /></svg
					>虛線＝推定
				</li>
				<li class="flex items-center gap-1.5">
					<Icon name="lock" class="size-3.5 text-slate-500" />IDC 維護
				</li>
				<li class="flex items-center gap-1.5">
					<Icon name="warn" class="size-3.5 text-yellow-300" />未處理
				</li>
				<li class="flex items-center gap-1.5">
					<Icon name="broken" class="size-3.5 text-rose-300" />到不了客戶
				</li>
				<li class="col-span-2 text-slate-500">
					承載（主機→所屬機框）只在選取或滑過主機、機框，或找客戶時畫出
				</li>
			</ul>
		</section>
	{/if}
	<button
		class={[
			'grid size-[27px] place-items-center rounded-sm border border-white/10 shadow-md transition-colors',
			editor.legend
				? 'bg-ink-700 text-slate-100'
				: 'bg-ink-800 text-slate-400 hover:bg-ink-700 hover:text-slate-100'
		]}
		aria-label="圖例"
		aria-pressed={editor.legend}
		title="圖例（?）"
		onclick={() => (editor.legend = !editor.legend)}
	>
		<Icon name="help" />
	</button>
</div>
