<script lang="ts">
	// 游標處浮動選單：右鍵節點／邊／空白，及拖曳連線放開處。子選單 hover 或 → 展開
	import { tick } from 'svelte';
	import { CREATABLE_EDGE_TYPES, CREATABLE_NODE_TYPES, type Editor } from '#lib/editor.svelte.js';
	import { IDC_MESSAGE, SYSTEMS, nodeType } from '#lib/model/config.js';
	import { EDGE_COLORS, SYSTEM_COLORS } from './Canvas.svelte';
	import Icon from './Icon.svelte';

	let { editor }: { editor: Editor } = $props();

	type Item = {
		label: string;
		icon?: string;
		color?: string;
		keys?: string;
		/** 停用原因；有值即停用 */
		why?: string | null;
		danger?: boolean;
		run?: () => void;
		sub?: Item[];
	};

	const m = $derived(editor.menu!);
	let el = $state<HTMLElement>();
	let pos = $state({ x: 0, y: 0, flip: false });
	/** 刪節點兩段式：第一次點只換成確認字樣 */
	let armed = $state(false);

	const nameOf = (id: string) => editor.node(id)?.name ?? id;
	const sysOf = (type: string) => nodeType(type).system ?? '通用';
	const done = (f: () => void) => () => {
		editor.menu = null;
		f();
	};

	/** 依系統分組的可新增類型；pick 收到類型名 */
	function typeMenu(pick: (t: string) => void, only?: string): Item[] {
		return [...SYSTEMS, null]
			.map((s) => ({ s: s ?? '通用', types: CREATABLE_NODE_TYPES.filter((t) => t.system === s) }))
			.filter((g) => g.types.length && (!only || g.s === only))
			.map((g) => ({
				label: g.s,
				icon: g.s,
				color: SYSTEM_COLORS[g.s],
				sub: g.types.map((t) => ({ label: t.name, run: () => pick(t.name) }))
			}));
	}

	const add = (t: string) => done(() => editor.addNode(t))();

	const head = $derived.by(() => {
		if (m.kind === 'node') return nameOf(m.id);
		if (m.kind === 'edge') {
			const e = editor.edge(m.id)!;
			return `${nameOf(e.from)} → ${nameOf(e.to)}`;
		}
		if (m.kind === 'connect') return `${nameOf(m.from)} → ${nameOf(m.to)}`;
		if (m.kind === 'drop') return `從 ${nameOf(m.from)} 新增並連線`;
		return m.lane && m.lane !== '通用' ? `${m.lane} 泳道` : '';
	});
	const ro = $derived(
		m.kind === 'node'
			? editor.node(m.id)?.readonly
			: m.kind === 'edge' && editor.edge(m.id)?.readonly
	);

	const items = $derived.by((): Item[] => {
		if (m.kind === 'node') {
			const n = editor.node(m.id)!;
			const s = nodeType(n.type).system;
			const count = editor.graph.edges.filter((e) => e.from === n.id || e.to === n.id).length;
			const block = editor.deleteBlock(n.id);
			return [
				{ label: '找客戶', icon: 'target', keys: 'F', run: done(() => editor.findCustomers(n.id)) },
				{
					label: '連到…',
					icon: 'link',
					keys: 'E',
					run: done(() => {
						editor.select({ kind: 'node', id: n.id });
						editor.connecting = n.id;
					})
				},
				{
					label: '聚焦鄰居',
					icon: 'focus',
					run: done(() => {
						editor.select({ kind: 'node', id: n.id });
						const near = editor.visible.edges
							.filter((e) => e.from === n.id || e.to === n.id)
							.flatMap((e) => [e.from, e.to]);
						editor.fit([n.id, ...near]);
					})
				},
				...(s ? [{ label: `只看${s}`, icon: 'solo', run: done(() => editor.solo(s)) }] : []),
				{
					label: armed ? `確認刪除（連同 ${count} 條邊）` : '刪除節點',
					icon: 'trash',
					keys: '⌫',
					danger: true,
					why: ro ? IDC_MESSAGE : block,
					run: () => {
						if (count && !armed) armed = true;
						else done(() => editor.deleteNode(n.id))();
					}
				}
			];
		}
		if (m.kind === 'edge') {
			const e = editor.edge(m.id)!;
			return [
				{
					label: e.bidirectional ? '改為單向' : '改為雙向',
					icon: 'swap',
					why: ro ? IDC_MESSAGE : null,
					run: done(() => (e.bidirectional = !e.bidirectional))
				},
				{ label: '前往起點', icon: 'chevron', run: done(() => editor.reveal(e.from)) },
				{ label: '前往終點', icon: 'chevron', run: done(() => editor.reveal(e.to)) },
				{
					label: '刪除邊',
					icon: 'trash',
					keys: '⌫',
					danger: true,
					why: ro ? IDC_MESSAGE : null,
					run: done(() => editor.deleteEdge(e.id))
				}
			];
		}
		if (m.kind === 'connect') {
			const errs = editor.edgeErrors(m.from, m.to);
			const { from, to, x, y } = m;
			return [
				// 可建立的排前面
				...[...CREATABLE_EDGE_TYPES]
					.sort((a, b) => +!!errs.get(a.name) - +!!errs.get(b.name))
					.map((t) => ({
						label: t.name,
						icon: t.name,
						color: EDGE_COLORS[t.name],
						why: errs.get(t.name),
						run: done(() => editor.addEdge(from, to, t.name))
					})),
				{
					label: '對調方向',
					icon: 'swap',
					run: () => (editor.menu = { kind: 'connect', from: to, to: from, x, y })
				}
			];
		}
		if (m.kind === 'drop') {
			const { from, x, y } = m;
			return typeMenu((t) => {
				const to = editor.addNode(t);
				if (to) editor.menu = { kind: 'connect', from, to, x, y };
			});
		}
		const lane = m.lane && m.lane !== '通用' ? m.lane : undefined;
		const own = lane ? typeMenu(add, lane)[0]?.sub : undefined;
		return [
			...(own ?? []).map((t) => ({ ...t, label: `新增${t.label}`, icon: 'node-plus' })),
			{ label: own ? '其他節點' : '新增節點', icon: 'node-plus', keys: 'N', sub: typeMenu(add) },
			{ label: '新增邊…', icon: 'edge-plus', keys: 'E', run: done(() => (editor.dialog = 'edge')) },
			{
				label: '搜尋節點',
				icon: 'search',
				keys: '⌘K',
				run: done(() => (editor.dialog = 'search'))
			},
			{ label: '全部顯示', icon: 'fit', keys: '⇧1', run: done(() => editor.fit()) }
		];
	});

	const none = $derived(m.kind === 'connect' && items.slice(0, -1).every((i) => i.why));

	// 開啟或換位置後：貼齊視窗邊界；右側放不下子選單就往左開
	$effect(() => {
		const { x, y } = m;
		armed = false;
		tick().then(() => {
			if (!el) return;
			const r = el.getBoundingClientRect();
			pos = {
				x: Math.min(x, innerWidth - r.width - 8),
				y: Math.min(y, innerHeight - r.height - 8),
				flip: x + r.width * 2 > innerWidth
			};
			el.focus();
		});
	});

	/** ↑↓ 在同層移動，→ 進子選單，← 回上層 */
	function key(e: KeyboardEvent) {
		const cur = document.activeElement as HTMLElement;
		const list = cur.closest('[role=menu]') ?? el!;
		const own = [...list.querySelectorAll<HTMLElement>(':scope > li > [role=menuitem]')];
		const i = own.indexOf(cur);
		if (e.key === 'ArrowDown') own[(i + 1) % own.length]?.focus();
		else if (e.key === 'ArrowUp') own[(i - 1 + own.length) % own.length]?.focus();
		else if (e.key === 'ArrowRight')
			cur.parentElement?.querySelector<HTMLElement>('[role=menu] [role=menuitem]')?.focus();
		else if (e.key === 'ArrowLeft' && list !== el)
			list.parentElement?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
		else return;
		e.preventDefault();
	}

	function outside(e: PointerEvent) {
		if (!el?.contains(e.target as Node)) editor.menu = null;
	}
</script>

<svelte:window onpointerdown={outside} onresize={() => (editor.menu = null)} />

{#snippet list(items: Item[], sub: boolean)}
	{#each items as it (it.label)}
		<li class="group/it relative">
			<button
				role="menuitem"
				disabled={!!it.why}
				aria-haspopup={it.sub ? 'menu' : undefined}
				class={[
					'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] outline-none',
					it.why
						? 'cursor-not-allowed text-slate-500'
						: it.danger
							? 'text-rose-300 hover:bg-rose-500/15 focus:bg-rose-500/15'
							: 'text-slate-200 hover:bg-sky-400/15 focus:bg-sky-400/15'
				]}
				onclick={it.run}
			>
				<span class="grid size-4 place-items-center" style:color={it.why ? undefined : it.color}>
					{#if it.icon}<Icon name={it.icon} class="size-4" />{/if}
				</span>
				<span class="flex min-w-0 flex-col">
					<span class="truncate">{it.label}</span>
					{#if it.why}<span class="text-[11px] leading-snug text-rose-300/70">{it.why}</span>{/if}
				</span>
				{#if it.sub}
					<Icon name="chevron" class="ml-auto size-3 text-slate-500" />
				{:else if it.keys}
					<span class="ml-auto pl-4 font-mono text-[10px] text-slate-500">{it.keys}</span>
				{/if}
			</button>
			{#if it.sub}
				<!-- 子選單：hover／focus 時出現；隱藏延遲 120ms 讓滑鼠斜移不會一離開就關 -->
				<ul
					role="menu"
					aria-label={it.label}
					class={[
						'invisible absolute -top-1.5 z-10 min-w-40 rounded-lg border border-white/10 bg-ink-850/98 p-1 opacity-0 shadow-2xl shadow-black/60 backdrop-blur-xl transition-[opacity,visibility] delay-120 duration-100',
						'group-focus-within/it:visible group-focus-within/it:opacity-100 group-focus-within/it:delay-0 group-hover/it:visible group-hover/it:opacity-100 group-hover/it:delay-0',
						pos.flip ? 'right-full mr-1' : 'left-full ml-1'
					]}
				>
					{@render list(it.sub, true)}
				</ul>
			{/if}
		</li>
	{/each}
	{#if !sub && none}
		<li class="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-rose-300">
			這兩個節點不能直接相連，試試對調方向
		</li>
	{/if}
{/snippet}

<ul
	bind:this={el}
	role="menu"
	aria-label={m.kind === 'connect' ? '建立邊' : m.kind === 'drop' ? '新增節點並連線' : '選單'}
	tabindex="-1"
	class="fixed z-50 min-w-52 animate-rise rounded-lg border border-white/10 bg-ink-850/98 p-1 shadow-2xl shadow-black/60 backdrop-blur-xl outline-none"
	style:left="{pos.x || m.x}px"
	style:top="{pos.y || m.y}px"
	oncontextmenu={(e) => e.preventDefault()}
	onkeydown={key}
>
	{#if head}
		<li
			class="mb-1 flex items-center gap-2 border-b border-white/6 px-2 pt-1 pb-2 text-[11px] text-slate-400"
		>
			{#if m.kind === 'node'}
				<span
					style:color={SYSTEM_COLORS[sysOf(editor.node(m.id)!.type)]}
					class="grid place-items-center"
				>
					<Icon name={sysOf(editor.node(m.id)!.type)} class="size-3.5" />
				</span>
			{/if}
			<span class="max-w-56 truncate font-medium text-slate-200">{head}</span>
			{#if ro}
				<span class="ml-auto flex items-center gap-1 text-emerald-300" title={IDC_MESSAGE}>
					<Icon name="lock" class="size-3" />IDC
				</span>
			{/if}
		</li>
	{/if}
	{@render list(items, false)}
</ul>
