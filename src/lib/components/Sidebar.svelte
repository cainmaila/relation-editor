<script lang="ts">
	import { CREATABLE_EDGE_TYPES, CREATABLE_NODE_TYPES, type Editor } from '#lib/editor.svelte.js';
	import { SYSTEMS } from '#lib/model/config.js';
	import { EDGE_COLORS } from './Canvas.svelte';

	let { editor }: { editor: Editor } = $props();

	let nodeTypeName = $state('');
	let nodeName = $state('');
	const sorted = $derived(
		[...editor.graph.nodes].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
	);
	const unprocessedNodes = $derived(editor.graph.nodes.filter((n) => editor.unprocessed.has(n.id)));

	function addNode(e: SubmitEvent) {
		e.preventDefault();
		if (editor.addNode(nodeTypeName, nodeName)) nodeName = '';
	}

	function addEdge(e: SubmitEvent) {
		e.preventDefault();
		const d = editor.draft;
		editor.addEdge(d.from, d.to, d.type);
	}
</script>

<aside
	class="flex w-64 shrink-0 flex-col gap-5 overflow-y-auto border-r border-slate-200 p-4 text-sm"
>
	<fieldset>
		<legend class="mb-1 font-semibold">系統</legend>
		{#each SYSTEMS as s (s)}
			<label class="mr-3 inline-flex items-center gap-1">
				<input type="checkbox" value={s} bind:group={editor.systems} />
				{s}
			</label>
		{/each}
	</fieldset>

	<form onsubmit={addNode} class="flex flex-col gap-2" aria-label="新增節點">
		<h2 class="font-semibold">新增節點</h2>
		<label class="flex flex-col gap-1">
			類型
			<select bind:value={nodeTypeName} class="text-sm">
				<option value="">請選擇</option>
				{#each CREATABLE_NODE_TYPES as t (t.name)}
					<option value={t.name}>{t.name}</option>
				{/each}
			</select>
		</label>
		<label class="flex flex-col gap-1">
			名稱
			<input bind:value={nodeName} class="text-sm" />
		</label>
		<button class="rounded bg-slate-800 px-3 py-1 text-white">新增節點</button>
	</form>

	<form onsubmit={addEdge} class="flex flex-col gap-2" aria-label="新增邊">
		<h2 class="font-semibold">新增邊</h2>
		<p class="text-xs text-slate-500">可從節點下方圓點拉線到另一節點，或直接選擇。</p>
		{#each [['from', '起點'], ['to', '終點']] as const as [key, label] (key)}
			<label class="flex flex-col gap-1">
				{label}
				<select bind:value={editor.draft[key]} class="text-sm">
					<option value="">請選擇</option>
					{#each sorted as n (n.id)}
						<option value={n.id}>{n.name}</option>
					{/each}
				</select>
			</label>
		{/each}
		<label class="flex flex-col gap-1">
			邊類型
			<select bind:value={editor.draft.type} class="text-sm">
				<option value="">請選擇</option>
				{#each CREATABLE_EDGE_TYPES as t (t.name)}
					<option value={t.name}>{t.name}</option>
				{/each}
			</select>
		</label>
		<button class="rounded bg-slate-800 px-3 py-1 text-white">新增邊</button>
	</form>

	<section aria-label="未處理節點">
		<h2 class="font-semibold">未處理節點（{unprocessedNodes.length}）</h2>
		<ul>
			{#each unprocessedNodes as n (n.id)}
				<li>
					<button
						class="text-amber-700 underline"
						onclick={() => editor.select({ kind: 'node', id: n.id })}>{n.name}</button
					>
				</li>
			{:else}
				<li class="text-slate-400">無</li>
			{/each}
		</ul>
	</section>

	<section aria-label="圖例" class="text-xs text-slate-600">
		<h2 class="mb-1 text-sm font-semibold text-slate-900">圖例</h2>
		<ul class="grid grid-cols-2 gap-1">
			{#each Object.entries(EDGE_COLORS) as [name, color] (name)}
				<li class="flex items-center gap-1">
					<span class="inline-block h-0.5 w-4" style:background={color}></span>{name}
				</li>
			{/each}
		</ul>
		<p class="mt-2">虛線＝推定；虛框＝未處理；紅框＝到不了客戶；灰底＝IDC 維護（唯讀）</p>
	</section>
</aside>
