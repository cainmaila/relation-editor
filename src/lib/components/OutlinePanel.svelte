<script lang="ts">
	// 左欄大綱：搜尋、問題篩選、依系統分組的節點清單。點列＝選取並置中，滑過＝畫布亮起
	import { tick, untrack } from 'svelte';
	import type { Editor } from '#lib/editor.svelte.js';
	import { SYSTEMS, UNREACHABLE_LABEL, nodeType } from '#lib/model/config.js';
	import { SYSTEM_COLORS } from './Canvas.svelte';
	import Icon from './Icon.svelte';

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

	/** 收合的分組 */
	let closed = $state<string[]>([]);
	let list = $state<HTMLElement>();

	const graph = $derived(editor.page === 'graph');
	// 全圖列整張圖（隱藏的系統變淡，仍可從這裡重新打開）
	const vis = $derived(graph ? editor.graph : editor.editVisible);
	const issue = $derived(ISSUES.find((i) => i.key === editor.issue));
	const filtering = $derived(!!editor.matched);
	/** 只看文字有沒有命中（判斷空結果是不是問題篩選造成的） */
	const textHits = $derived(vis.nodes.some((n) => editor.byText(n.name)));
	const groups = $derived(
		[...SYSTEMS, null]
			.map((s) => ({
				s,
				name: s ?? '通用',
				nodes: vis.nodes.filter(
					(n) => nodeType(n.type).system === s && (!editor.matched || editor.matched.has(n.id))
				)
			}))
			.filter((g) => g.nodes.length)
	);

	// 選取時，大綱展開所屬分組並捲到該列
	$effect(() => {
		const id = editor.selected?.kind === 'node' && editor.selected.id;
		if (!id) return;
		const name = nodeType(editor.node(id)!.type).system ?? '通用';
		untrack(() => (closed = closed.filter((x) => x !== name)));
		tick().then(() =>
			list?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
		);
	});
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
				bind:value={editor.query}
				onkeydown={(e) => {
					if (e.key === 'Escape' && editor.query) {
						editor.query = '';
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

	<div bind:this={list} class="min-h-0 flex-1 overflow-y-auto py-1">
		{#each groups as g (g.name)}
			{@const open = filtering || !closed.includes(g.name)}
			{@const shown = !graph || !g.s || editor.systems.includes(g.s)}
			<section aria-label={g.name}>
				<div
					class="group/h sticky top-0 z-10 flex items-center bg-ink-900/95 pr-2 backdrop-blur"
					style:--c={SYSTEM_COLORS[g.name]}
				>
					<button
						class="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left text-xs font-medium text-slate-300 hover:text-slate-50"
						aria-expanded={open}
						onclick={() =>
							(closed = closed.includes(g.name)
								? closed.filter((x) => x !== g.name)
								: [...closed, g.name])}
					>
						<Icon
							name="chevron"
							class={['size-3 text-slate-600 transition-transform', open && 'rotate-90']}
						/>
						<span class={shown ? 'text-(--c)' : 'text-slate-600'}
							><Icon name={g.name} class="size-3.5" /></span
						>
						<span class={shown ? '' : 'text-slate-500'}>{g.name}</span>
						<span class="font-mono text-[10px] text-slate-600">{g.nodes.length}</span>
					</button>
					{#if graph && g.s}
						{@const s = g.s}
						<button
							class={[
								'grid size-6 place-items-center rounded transition-opacity hover:bg-white/8',
								shown
									? 'text-slate-400 opacity-0 group-hover/h:opacity-100 focus:opacity-100'
									: 'text-slate-600'
							]}
							aria-label="顯示{s}"
							aria-pressed={shown}
							title="{shown ? '隱藏' : '顯示'}{s}（⌥＋點：只看{s}）"
							onclick={(e) => {
								if (e.altKey) editor.solo(s);
								else if (shown) editor.systems = editor.systems.filter((x) => x !== s);
								else editor.systems.push(s);
							}}
						>
							<Icon name={shown ? 'solo' : 'eye-off'} class="size-3.5" />
						</button>
					{/if}
				</div>
				{#if open}
					<ul>
						{#each g.nodes as n (n.id)}
							{@const sel = editor.selected?.kind === 'node' && editor.selected.id === n.id}
							<li>
								<button
									data-id={n.id}
									class={[
										'relative flex w-full items-center gap-2 py-1 pr-3 pl-8 text-left text-xs transition-colors',
										sel
											? 'bg-sky-400/12 text-slate-50 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-sky-400'
											: shown
												? 'text-slate-300 hover:bg-white/4 hover:text-slate-50'
												: 'text-slate-500 hover:bg-white/4'
									]}
									title={n.type}
									onclick={() => editor.reveal(n.id)}
									onpointerenter={() => shown && (editor.hoverNode = n.id)}
									onpointerleave={() => (editor.hoverNode = null)}
								>
									<span class="truncate">{n.name}</span>
									<span class="ml-auto flex items-center gap-1">
										{#each ISSUES as i (i.key)}
											{#if graph && editor[i.key].has(n.id)}
												<Icon name={i.icon} label={i.label} class={['size-3', i.tone]} />
											{/if}
										{/each}
										{#if n.readonly}<Icon
												name="lock"
												label="IDC 維護"
												class="size-3 text-slate-600"
											/>{/if}
									</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{:else}
			<p class="flex items-center gap-2 px-4 py-6 text-xs text-slate-500">
				{#if issue && !editor.query.trim()}
					<Icon name="check" class="size-3.5 text-emerald-400" />
					<span class="text-emerald-300/90">{issue.ok}</span>
				{:else if issue && textHits}
					<span>「{editor.query.trim()}」裡沒有{issue.label}的節點</span>
					<button
						class="ml-auto text-sky-300 hover:text-sky-200"
						onclick={() => (editor.issue = null)}>清除{issue.label}篩選</button
					>
				{:else}
					沒有符合的節點
				{/if}
			</p>
		{/each}
	</div>
</nav>
