<script lang="ts">
	import type { Editor } from '#lib/editor.svelte.js';
	import { SYSTEMS, nodeType } from '#lib/model/config.js';
	import { SYSTEM_COLORS } from './Canvas.svelte';
	import Icon from './Icon.svelte';

	let { editor }: { editor: Editor } = $props();

	/** 開左欄大綱並只列該問題的節點 */
	const show = (i: 'unprocessed' | 'unreachable') => {
		editor.panels.left = true;
		editor.issue = i;
	};

	const count = (s: string) =>
		editor.graph.nodes.filter((n) => nodeType(n.type).system === s).length;
	const all = $derived(editor.systems.length === SYSTEMS.length);
	const focusMode = $derived(!editor.panels.left && !editor.panels.right);
</script>

{#snippet iconBtn(label: string, keys: string, icon: string, run: () => void)}
	<button
		class="grid size-8 place-items-center rounded-md text-slate-300 transition-colors hover:bg-white/8 hover:text-slate-50"
		aria-label={label}
		title="{label}（{keys}）"
		onclick={run}
	>
		<Icon name={icon} />
	</button>
{/snippet}

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
		<Icon name={icon} />
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
		<h1 class="text-sm font-semibold text-slate-50">關係鏈編輯器</h1>
		<span
			class="rounded-full border border-amber-300/20 px-1.5 py-px text-[10px] text-amber-200/80"
			title="示意資料，重新整理即還原，不會存檔">示意</span
		>
	</div>

	<fieldset class="flex items-center gap-1 border-l border-white/8 pl-3">
		<legend class="sr-only">系統</legend>
		<button
			class={[
				'mr-0.5 rounded-md px-2 py-1.5 text-xs transition-colors',
				all ? 'text-slate-500' : 'bg-sky-400/15 text-sky-200 hover:bg-sky-400/25'
			]}
			title="顯示全部系統"
			onclick={() => (editor.systems = [...SYSTEMS])}>全部</button
		>
		{#each SYSTEMS as s (s)}
			{@const on = editor.systems.includes(s)}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
			<label
				style:--c={SYSTEM_COLORS[s]}
				title="{s} · {count(s)} 節點（⌥＋點：只看{s}）"
				class={[
					'relative grid size-8 cursor-pointer place-items-center rounded-md border transition-colors select-none',
					on
						? 'border-(--c)/35 bg-(--c)/12 text-(--c)'
						: 'border-transparent text-slate-600 hover:bg-white/5 hover:text-slate-400'
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
					class="absolute inset-0 size-full cursor-pointer appearance-none rounded-md border-0 bg-transparent opacity-0 focus:ring-0"
				/>
				<span class="sr-only">{s}</span>
				<Icon name={s} />
				<span
					class={[
						'absolute -right-1 -bottom-1 rounded-sm px-0.5 font-mono text-[9px] leading-3',
						on ? 'bg-ink-900 text-slate-300' : 'text-slate-600'
					]}>{count(s)}</span
				>
			</label>
		{/each}
	</fieldset>

	<div class="ml-auto flex items-center gap-1 font-mono text-xs">
		<button
			class="flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-white/5"
			aria-label="未處理 {editor.unprocessed.size}"
			title="未處理節點：沒連到 TPKC 大樓"
			onclick={() => show('unprocessed')}
		>
			<Icon
				name="warn"
				class={['size-4', editor.unprocessed.size ? 'text-yellow-300' : 'text-slate-600']}
			/>
			<b class={editor.unprocessed.size ? 'text-yellow-200' : 'text-slate-500'}
				>{editor.unprocessed.size}</b
			>
		</button>
		<button
			class="flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-white/5"
			aria-label="無客戶路徑 {editor.unreachable.size}"
			title="無客戶路徑：沿方向走不到任何客戶"
			onclick={() => show('unreachable')}
		>
			<Icon
				name="broken"
				class={['size-4', editor.unreachable.size ? 'text-rose-300' : 'text-slate-600']}
			/>
			<b class={editor.unreachable.size ? 'text-rose-200' : 'text-slate-500'}
				>{editor.unreachable.size}</b
			>
		</button>
	</div>

	<div class="flex items-center gap-0.5 border-l border-white/8 pl-3">
		{@render iconBtn('搜尋節點', '⌘K', 'search', () => (editor.dialog = 'search'))}
		{@render iconBtn('新增節點', 'N 或右鍵畫布', 'node-plus', () => (editor.dialog = 'node'))}
		{@render iconBtn('新增邊', 'E 或拖曳卡片', 'edge-plus', () => (editor.dialog = 'edge'))}
	</div>

	<div class="flex items-center gap-0.5 border-l border-white/8 pl-3">
		{@render toggle(
			editor.stacking,
			'收疊同類',
			'同類型、上游相同的兄弟節點收成一疊，點開才展開',
			() => {
				editor.stacking = !editor.stacking;
				editor.expanded = [];
			},
			'stack'
		)}
	</div>

	<div class="flex items-center gap-0.5 border-l border-white/8 pl-3">
		{@render toggle(
			editor.panels.left,
			'左欄 大綱',
			'⌘B',
			() => (editor.panels.left = !editor.panels.left),
			'panel-left'
		)}
		{@render toggle(
			focusMode,
			'專注模式',
			'⌘.',
			() => {
				const v = focusMode;
				editor.panels.left = editor.panels.right = v;
			},
			'panel-none'
		)}
		{@render toggle(
			editor.panels.right,
			'右欄 檢視器',
			'⌘I',
			() => (editor.panels.right = !editor.panels.right),
			'panel-right'
		)}
	</div>
</header>
