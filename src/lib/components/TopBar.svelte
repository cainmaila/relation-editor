<script lang="ts">
	import type { Editor } from '#lib/editor.svelte.js';
	import { SYSTEMS, nodeType } from '#lib/model/config.js';
	import { SYSTEM_COLORS } from './Canvas.svelte';

	let { editor, onjump }: { editor: Editor; onjump: (region: string) => void } = $props();

	const count = (s: string) =>
		editor.graph.nodes.filter((n) => nodeType(n.type).system === s).length;
	const all = $derived(editor.systems.length === SYSTEMS.length);
	const focusMode = $derived(!editor.panels.left && !editor.panels.right);
</script>

{#snippet toggle(on: boolean, label: string, keys: string, flip: () => void, icon: string)}
	<button
		class={[
			'grid size-7 place-items-center rounded-md transition-colors',
			on ? 'bg-white/10 text-slate-100' : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
		]}
		aria-pressed={on}
		aria-label={label}
		title="{label}（{keys}）"
		onclick={flip}
	>
		<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.4">
			<rect x="1.5" y="2.5" width="13" height="11" rx="2" />
			<path d={icon} />
		</svg>
	</button>
{/snippet}

<header
	class="relative z-20 flex h-12 shrink-0 items-center gap-3 border-b border-white/8 bg-ink-900/90 px-3 whitespace-nowrap backdrop-blur"
>
	<div class="flex items-center gap-2.5 pr-1">
		<span
			class="grid size-7 place-items-center rounded-md bg-linear-to-br from-sky-400 to-indigo-500 font-mono text-[11px] font-bold text-ink-950"
			>TP</span
		>
		<div class="leading-tight">
			<h1 class="text-sm font-semibold text-slate-50">關係鏈編輯器</h1>
			<p class="text-[10px] text-slate-500">示意資料・不存檔</p>
		</div>
	</div>

	<fieldset class="flex items-center gap-1" title="點：切換，⌥/Alt＋點：只看此系統">
		<legend class="sr-only">系統</legend>
		<button
			class={[
				'rounded-full px-2.5 py-1 text-xs transition-colors',
				all ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:bg-white/5'
			]}
			onclick={() => (editor.systems = [...SYSTEMS])}>全部</button
		>
		{#each SYSTEMS as s (s)}
			{@const on = editor.systems.includes(s)}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
			<label
				style:--c={SYSTEM_COLORS[s]}
				class={[
					'flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors select-none',
					on
						? 'border-(--c)/40 bg-(--c)/10 text-slate-100'
						: 'border-white/8 text-slate-500 hover:text-slate-300'
				]}
				onclick={(e) => {
					if (!e.altKey) return;
					e.preventDefault();
					editor.solo(s);
				}}
			>
				<input
					type="checkbox"
					value={s}
					bind:group={editor.systems}
					class="size-2 appearance-none rounded-full border-0 bg-slate-600 ring-0 checked:bg-(--c) checked:bg-none focus:ring-0 focus:ring-offset-0"
				/>
				{s}
				<span class="font-mono text-[10px] text-slate-500">{count(s)}</span>
			</label>
		{/each}
	</fieldset>

	<button
		class="ml-auto flex w-40 items-center gap-2 rounded-md border border-white/10 bg-ink-950/60 px-2.5 py-1.5 text-xs text-slate-500 hover:border-white/20"
		onclick={() => (editor.dialog = 'search')}
	>
		<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.6"
			><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg
		>
		搜尋節點
		<span class="ml-auto kbd">⌘K</span>
	</button>

	<div class="flex items-center gap-1 font-mono text-xs">
		<span class="hidden px-1.5 text-slate-400 2xl:inline"
			><b class="text-slate-100">{editor.graph.nodes.length}</b> 節點</span
		>
		<span class="hidden px-1.5 text-slate-400 2xl:inline"
			><b class="text-slate-100">{editor.graph.edges.length}</b> 邊</span
		>
		<button
			class="rounded px-1.5 py-0.5 text-slate-400 hover:bg-white/5"
			onclick={() => onjump('未處理節點')}
			><b class={editor.unprocessed.size ? 'text-yellow-300' : 'text-slate-100'}
				>{editor.unprocessed.size}</b
			> 未處理</button
		>
		<button
			class="rounded px-1.5 py-0.5 text-slate-400 hover:bg-white/5"
			onclick={() => onjump('到不了客戶節點')}
			><b class={editor.unreachable.size ? 'text-rose-300' : 'text-slate-100'}
				>{editor.unreachable.size}</b
			> 到不了客戶</button
		>
	</div>

	<div class="flex items-center gap-1.5">
		<button
			class="btn-ghost py-1 text-xs"
			title="新增節點（N）"
			onclick={() => (editor.dialog = 'node')}>＋ 節點 <span class="kbd">N</span></button
		>
		<button
			class="btn-ghost py-1 text-xs"
			title="新增邊（E）"
			onclick={() => (editor.dialog = 'edge')}>＋ 邊 <span class="kbd">E</span></button
		>
	</div>

	<div class="flex items-center gap-0.5 border-l border-white/8 pl-3">
		{@render toggle(
			editor.panels.left,
			'左欄 檢查',
			'⌘B',
			() => (editor.panels.left = !editor.panels.left),
			'M5.5 2.5v11'
		)}
		{@render toggle(
			focusMode,
			'專注模式',
			'⌘.',
			() => {
				const v = focusMode;
				editor.panels.left = editor.panels.right = v;
			},
			'M4 6V5h1M12 6V5h-1M4 10v1h1M12 10v1h-1'
		)}
		{@render toggle(
			editor.panels.right,
			'右欄 檢視器',
			'⌘I',
			() => (editor.panels.right = !editor.panels.right),
			'M10.5 2.5v11'
		)}
	</div>
</header>
