<script lang="ts">
	import type { Editor } from '#lib/editor.svelte.js';
	import { IDC_MESSAGE, nodeType } from '#lib/model/config.js';
	import type { Props } from '#lib/model/types.js';
	import { EDGE_COLORS, SYSTEM_COLORS } from './Canvas.svelte';

	let { editor }: { editor: Editor } = $props();

	const node = $derived(
		editor.selected?.kind === 'node' ? editor.node(editor.selected.id) : undefined
	);
	const edge = $derived(
		editor.selected?.kind === 'edge' ? editor.edge(editor.selected.id) : undefined
	);
	const ro = $derived(!!(node ?? edge)?.readonly);
	const incoming = $derived(node ? editor.visible.edges.filter((e) => e.to === node.id) : []);
	const outgoing = $derived(node ? editor.visible.edges.filter((e) => e.from === node.id) : []);
	const nodeEdges = $derived(
		node ? editor.graph.edges.filter((e) => e.from === node.id || e.to === node.id).length : 0
	);
	const block = $derived(node ? editor.deleteBlock(node.id) : null);
	const nameOf = (id: string) => editor.node(id)?.name ?? id;
	const colorOf = (id: string) =>
		SYSTEM_COLORS[nodeType(editor.node(id)?.type ?? '').system ?? '通用'];

	let propKey = $state('');
	let propValue = $state('');

	function addProp(props: Props) {
		if (!propKey.trim()) return;
		props[propKey.trim()] = propValue;
		propKey = propValue = '';
	}

	function removeNode(id: string) {
		if (nodeEdges && editor.armDelete !== id) editor.armDelete = id;
		else editor.deleteNode(id);
	}

	const SHORTCUTS = [
		['⌘K', '搜尋節點'],
		['N', '新增節點'],
		['E', '新增邊'],
		['F', '對選取節點找客戶'],
		['Delete', '刪除選取'],
		['Esc', '取消選取／關閉'],
		['⇧1', '全部顯示'],
		['⌘B / ⌘I', '收合左／右欄'],
		['⌘.', '專注模式']
	];
</script>

{#snippet section(title: string)}
	<h3 class="mb-2 eyebrow">{title}</h3>
{/snippet}

{#snippet propsEditor(props: Props)}
	<section class="border-t border-white/6 px-5 py-4">
		{@render section('屬性')}
		<dl class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-sm">
			{#each Object.keys(props) as k (k)}
				<dt class="text-xs text-slate-400">{k}</dt>
				<dd>
					<input aria-label={k} bind:value={props[k]} disabled={ro} class="field py-1" />
				</dd>
			{:else}
				<p class="col-span-2 text-xs text-slate-500">尚無屬性</p>
			{/each}
		</dl>
		{#if !ro}
			<div class="mt-3 flex gap-1.5">
				<input aria-label="屬性名稱" placeholder="名稱" bind:value={propKey} class="field py-1" />
				<input aria-label="屬性值" placeholder="值" bind:value={propValue} class="field py-1" />
				<button class="btn-ghost shrink-0 px-2.5 py-1 text-xs" onclick={() => addProp(props)}
					>新增屬性</button
				>
			</div>
		{/if}
	</section>
{/snippet}

{#snippet edgeList(title: string, list: typeof incoming, other: 'from' | 'to')}
	<section class="border-t border-white/6 px-5 py-4">
		<h3 class="mb-2 eyebrow">{title}（{list.length}）</h3>
		<ul class="flex flex-col gap-1">
			{#each list as e (e.id)}
				<li>
					<button
						aria-label="{e.type}：{nameOf(e[other])}"
						class="group flex w-full items-center gap-2 rounded-md border border-white/6 bg-white/2 px-2.5 py-1.5 text-left text-xs transition-colors hover:border-white/15 hover:bg-white/5"
						onclick={() => editor.select({ kind: 'edge', id: e.id })}
						onmouseenter={() => (editor.hoverEdge = e.id)}
						onmouseleave={() => (editor.hoverEdge = null)}
					>
						<span class="w-8 shrink-0 font-mono text-[10px]" style:color={EDGE_COLORS[e.type]}
							>{e.type}</span
						>
						<span class="text-slate-500">{other === 'from' ? '←' : '→'}</span>
						<span class="size-1.5 shrink-0 rounded-full" style:background={colorOf(e[other])}
						></span>
						<span class="truncate text-slate-200">{nameOf(e[other])}</span>
						{#if e.bidirectional}<span class="ml-auto text-[10px] text-slate-500">雙向</span>{/if}
					</button>
				</li>
			{:else}
				<li class="text-xs text-slate-500">無</li>
			{/each}
		</ul>
	</section>
{/snippet}

{#snippet idcBanner()}
	<div
		class="mx-5 mb-1 flex items-center gap-2 rounded-md border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-xs text-emerald-200"
	>
		<svg viewBox="0 0 16 16" class="size-3.5 shrink-0 fill-current">
			<path
				d="M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z"
			/>
		</svg>
		<span>唯讀・{IDC_MESSAGE}</span>
	</div>
{/snippet}

<aside class="flex min-h-full flex-col" aria-label="詳情">
	{#if editor.result && node}
		<section
			aria-label="找客戶結果"
			class="m-4 mb-0 overflow-hidden rounded-lg border border-sky-400/30 bg-linear-to-br from-sky-400/15 to-indigo-500/5"
		>
			<div class="flex items-center gap-2 px-4 pt-3">
				<p class="eyebrow text-sky-300!">找客戶結果</p>
				<button
					class="ml-auto text-[11px] text-slate-400 hover:text-slate-200"
					onclick={() => (editor.result = null)}>清除 <span class="kbd">Esc</span></button
				>
			</div>
			<p class="px-4 pt-1 text-sm text-slate-300">
				從 <b class="text-slate-50">{node.name}</b> 沿方向走得到
				<b class="text-2xl font-semibold text-sky-300 tabular-nums"
					>{editor.result.customers.length}</b
				>
				位客戶
			</p>
			<ul class="flex flex-wrap gap-1.5 px-4 pt-2 pb-3">
				{#each editor.result.customers as c (c)}
					<li>
						<button
							class="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-0.5 text-xs text-emerald-200 hover:bg-emerald-400/20"
							onclick={() => {
								const id = editor.graph.nodes.find((n) => n.name === c)?.id;
								if (id) editor.fit([id]);
							}}>{c}</button
						>
					</li>
				{:else}
					<li class="text-xs text-rose-300">走不到任何客戶</li>
				{/each}
			</ul>
			<p class="border-t border-white/6 px-4 py-2 text-[11px] text-slate-400">
				沿途 {editor.result.nodes.size} 個節點、{editor.result.edges.size} 條邊已亮起
			</p>
		</section>
	{/if}

	{#if node}
		{@const sys = nodeType(node.type).system}
		<header class="px-5 pt-5 pb-3">
			<p class="flex items-center gap-1.5 text-xs text-slate-400">
				<span class="size-2 rounded-full" style:background={SYSTEM_COLORS[sys ?? '通用']}></span>
				節點
			</p>
			<input
				aria-label="名稱"
				bind:value={node.name}
				disabled={ro}
				class="-mx-1.5 mt-1.5 field border-transparent bg-transparent px-1.5 text-lg font-semibold hover:border-white/10 disabled:mx-0 disabled:px-0"
			/>
			<dl class="mt-2 grid grid-cols-[3rem_1fr] gap-y-1 text-xs">
				<dt class="text-slate-500">類型</dt>
				<dd class="font-mono text-slate-200">{node.type}</dd>
				<dt class="text-slate-500">系統</dt>
				<dd class="text-slate-200">{sys ?? '（無）'}</dd>
			</dl>
		</header>

		{#if ro}{@render idcBanner()}{/if}
		{#if editor.unprocessed.has(node.id)}
			<p
				class="mx-5 mb-1 rounded-md border border-yellow-400/25 bg-yellow-400/5 px-3 py-2 text-xs leading-relaxed text-yellow-200"
			>
				還沒連到「TPKC 大樓」。從節點下方圓點拉線，或按「連到…」整理進主圖。
			</p>
		{:else if editor.unreachable.has(node.id)}
			<p
				class="mx-5 mb-1 rounded-md border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-xs leading-relaxed text-rose-200"
			>
				沿方向走不到任何客戶：補一條往下游的邊即可接上關係鏈。
			</p>
		{/if}

		<div class="flex flex-wrap items-center gap-2 px-5 py-3">
			<button class="btn-primary" onclick={() => editor.findCustomers(node.id)}>
				找客戶 <span class="kbd border-ink-950/20 bg-ink-950/10 text-ink-950/70">F</span>
			</button>
			<button
				class={['btn-ghost', editor.connecting === node.id && 'border-sky-400 text-sky-300']}
				onclick={() => (editor.connecting = editor.connecting === node.id ? null : node.id)}
				>連到…</button
			>
			{#if editor.armDelete !== node.id}
				<button class="ml-auto btn-danger" disabled={!!block} onclick={() => removeNode(node.id)}
					>刪除節點</button
				>
			{/if}
		</div>
		{#if editor.armDelete === node.id}
			<div
				role="alertdialog"
				aria-label="確認刪除"
				class="mx-5 mb-3 flex animate-rise items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-100"
			>
				連同 {nodeEdges} 條邊一起刪除？
				<button
					class="ml-auto btn-ghost px-2 py-0.5 text-xs"
					onclick={() => (editor.armDelete = null)}>取消</button
				>
				<button
					class="btn bg-rose-500 px-2 py-0.5 text-xs text-white hover:bg-rose-400"
					onclick={() => editor.deleteNode(node.id)}>確認刪除</button
				>
			</div>
		{:else if block && !ro}
			<p class="mx-5 mb-3 text-[11px] leading-relaxed text-slate-400">無法刪除：{block}</p>
		{/if}

		{@render propsEditor(node.props)}
		{@render edgeList('連入', incoming, 'from')}
		{@render edgeList('連出', outgoing, 'to')}
	{:else if edge}
		<header class="px-5 pt-5 pb-3">
			<p class="flex items-center gap-1.5 text-xs text-slate-400">
				<span class="h-0.5 w-3 rounded" style:background={EDGE_COLORS[edge.type]}></span>
				邊
			</p>
			<dl class="mt-2 grid grid-cols-[3rem_1fr] items-center gap-y-1.5 text-sm">
				<dt class="text-xs text-slate-500">類型</dt>
				<dd class="font-semibold" style:color={EDGE_COLORS[edge.type]}>{edge.type}</dd>
				<dt class="text-xs text-slate-500">起點</dt>
				<dd>
					<button
						class="text-left text-slate-100 hover:text-sky-300"
						onclick={() => editor.reveal(edge.from)}>{nameOf(edge.from)}</button
					>
				</dd>
				<dt class="text-xs text-slate-500">終點</dt>
				<dd>
					<button
						class="text-left text-slate-100 hover:text-sky-300"
						onclick={() => editor.reveal(edge.to)}>{nameOf(edge.to)}</button
					>
				</dd>
				<dt class="text-xs text-slate-500">方向</dt>
				<dd>
					<select
						aria-label="方向"
						value={edge.bidirectional ? '雙向' : '單向'}
						onchange={(e) => (edge.bidirectional = e.currentTarget.value === '雙向')}
						disabled={ro}
						class="field w-28 py-1"
					>
						<option>單向</option>
						<option>雙向</option>
					</select>
				</dd>
			</dl>
		</header>
		{#if ro}{@render idcBanner()}{/if}
		<div class="flex px-5 py-3">
			<button class="ml-auto btn-danger" disabled={ro} onclick={() => editor.deleteEdge(edge.id)}
				>刪除邊</button
			>
		</div>
		{@render propsEditor(edge.props)}
	{:else}
		<div class="flex flex-1 flex-col px-5 py-6">
			<p class="eyebrow">檢視器</p>
			<p class="mt-3 text-sm leading-relaxed text-slate-300">
				點選節點或邊查看詳情、修改屬性；選節點後可<b class="text-sky-300">找客戶</b
				>，看它壞掉會影響誰。
			</p>
			<ol class="mt-5 flex flex-col gap-3 text-xs text-slate-400">
				<li class="flex gap-3">
					<span class="font-mono text-sky-300">01</span>上方膠囊切換系統，⌥＋點只看一個
				</li>
				<li class="flex gap-3">
					<span class="font-mono text-sky-300">02</span>點節點聚焦，雙擊放大到它的鄰居
				</li>
				<li class="flex gap-3">
					<span class="font-mono text-sky-300">03</span>滑到節點，從下方圓點拉線到另一節點即可連線
				</li>
			</ol>
			<h3 class="mt-8 mb-2 eyebrow">快捷鍵</h3>
			<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
				{#each SHORTCUTS as [k, v] (k)}
					<dt><span class="kbd">{k}</span></dt>
					<dd class="text-slate-400">{v}</dd>
				{/each}
			</dl>
		</div>
	{/if}
</aside>
