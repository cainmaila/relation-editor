<script lang="ts">
	import type { Editor } from '#lib/editor.svelte.js';
	import { IDC_MESSAGE, nodeType } from '#lib/model/config.js';
	import type { Props } from '#lib/model/types.js';

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
	const nameOf = (id: string) => editor.node(id)?.name ?? id;

	let propKey = $state('');
	let propValue = $state('');

	function addProp(props: Props) {
		if (!propKey.trim()) return;
		props[propKey.trim()] = propValue;
		propKey = propValue = '';
	}
</script>

{#snippet propsEditor(props: Props)}
	<h3 class="mt-3 font-semibold">屬性</h3>
	<dl class="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
		{#each Object.keys(props) as k (k)}
			<dt>{k}</dt>
			<dd>
				<input aria-label={k} bind:value={props[k]} disabled={ro} class="w-full py-0.5 text-sm" />
			</dd>
		{/each}
	</dl>
	{#if !ro}
		<div class="mt-2 flex gap-1">
			<input
				aria-label="屬性名稱"
				placeholder="名稱"
				bind:value={propKey}
				class="w-20 py-0.5 text-sm"
			/>
			<input
				aria-label="屬性值"
				placeholder="值"
				bind:value={propValue}
				class="w-20 py-0.5 text-sm"
			/>
			<button class="rounded border px-2" onclick={() => addProp(props)}>新增屬性</button>
		</div>
	{/if}
{/snippet}

{#snippet edgeList(title: string, list: typeof incoming, other: 'from' | 'to')}
	<h3 class="mt-3 font-semibold">{title}（{list.length}）</h3>
	<ul>
		{#each list as e (e.id)}
			<li>
				<button
					class="text-left underline"
					onclick={() => editor.select({ kind: 'edge', id: e.id })}
				>
					{e.type}：{nameOf(e[other])}
				</button>
			</li>
		{/each}
	</ul>
{/snippet}

<aside
	class="w-80 shrink-0 overflow-y-auto border-l border-slate-200 p-4 text-sm"
	aria-label="詳情"
>
	<p role="status" class="mb-3 min-h-5 font-semibold text-rose-700">{editor.message}</p>

	{#if node}
		<h2 class="text-base font-semibold">節點詳情</h2>
		<dl class="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
			<dt>類型</dt>
			<dd>{node.type}</dd>
			<dt>系統</dt>
			<dd>{nodeType(node.type).system ?? '（無）'}</dd>
			<dt>名稱</dt>
			<dd>
				<input
					aria-label="名稱"
					bind:value={node.name}
					disabled={ro}
					class="w-full py-0.5 text-sm"
				/>
			</dd>
		</dl>
		{@render propsEditor(node.props)}
		{@render edgeList('連入', incoming, 'from')}
		{@render edgeList('連出', outgoing, 'to')}
		<div class="mt-4 flex gap-2">
			<button
				class="rounded bg-sky-700 px-3 py-1 text-white"
				onclick={() => editor.findCustomers(node.id)}
			>
				找客戶
			</button>
			<button
				class="rounded bg-rose-700 px-3 py-1 text-white disabled:opacity-40"
				disabled={ro}
				onclick={() => editor.deleteNode(node.id)}>刪除節點</button
			>
		</div>
	{:else if edge}
		<h2 class="text-base font-semibold">邊詳情</h2>
		<dl class="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
			<dt>類型</dt>
			<dd>{edge.type}</dd>
			<dt>起點</dt>
			<dd>{nameOf(edge.from)}</dd>
			<dt>終點</dt>
			<dd>{nameOf(edge.to)}</dd>
			<dt>方向</dt>
			<dd>
				<select
					aria-label="方向"
					value={edge.bidirectional ? '雙向' : '單向'}
					onchange={(e) => (edge.bidirectional = e.currentTarget.value === '雙向')}
					disabled={ro}
					class="py-0.5 text-sm"
				>
					<option>單向</option>
					<option>雙向</option>
				</select>
			</dd>
		</dl>
		{@render propsEditor(edge.props)}
		<button
			class="mt-4 rounded bg-rose-700 px-3 py-1 text-white disabled:opacity-40"
			disabled={ro}
			onclick={() => editor.deleteEdge(edge.id)}>刪除邊</button
		>
	{:else}
		<p class="text-slate-400">點選節點或邊查看詳情</p>
	{/if}

	{#if ro}
		<p class="mt-3 rounded bg-slate-100 p-2 text-slate-600">{IDC_MESSAGE}</p>
	{/if}

	{#if editor.result}
		<section aria-label="找客戶結果" class="mt-4 rounded border border-sky-300 bg-sky-50 p-2">
			<h3 class="font-semibold">找客戶結果</h3>
			<ul class="list-inside list-disc">
				{#each editor.result.customers as c (c)}
					<li>{c}</li>
				{:else}
					<li class="list-none text-slate-500">走不到任何客戶</li>
				{/each}
			</ul>
		</section>
	{/if}
</aside>
