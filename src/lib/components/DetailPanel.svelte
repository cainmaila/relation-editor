<script lang="ts">
	import type { Editor } from '#lib/editor.svelte.js';
	import { CONFIRM_STATES, IDC_MESSAGE, UNREACHABLE_LABEL, nodeType } from '#lib/model/config.js';
	import { EDGE_COLORS, SYSTEM_COLORS } from './Canvas.svelte';
	import Icon from './Icon.svelte';
	import EdgeList from './EdgeList.svelte';
	import NeighborPicker from './NeighborPicker.svelte';
	import TraceResult from './TraceResult.svelte';

	let { editor }: { editor: Editor } = $props();

	const node = $derived(
		editor.selected?.kind === 'node' ? editor.node(editor.selected.id) : undefined
	);
	const edge = $derived(
		editor.selected?.kind === 'edge' ? editor.edge(editor.selected.id) : undefined
	);
	/** 全圖只讀 */
	const graph = $derived(editor.page === 'graph');
	const idc = $derived(!!(node ?? edge)?.readonly);
	/** 編輯頁的邊有一端在工作區外：只能看，不能悄悄改畫面外的拓撲 */
	const outsideEdge = $derived(
		!graph && !!edge && !(editor.inWork(edge.from) && editor.inWork(edge.to))
	);
	/** 經其他路徑選到工作區外的節點：加入編輯頁前唯讀 */
	const outsideNode = $derived(!graph && !!node && !editor.inWork(node.id));
	const ro = $derived(idc || graph || outsideEdge || outsideNode);
	const incoming = $derived(node ? editor.incomingEdges(node.id) : []);
	const outgoing = $derived(node ? editor.outgoingEdges(node.id) : []);
	const nodeEdges = $derived(node ? editor.incidentEdges(node.id).length : 0);
	/** 刪除會一起刪掉的工作區外的邊（畫面上看不到，確認時要講清楚） */
	const hiddenEdges = $derived(
		node
			? editor.incidentEdges(node.id).filter((e) => !editor.inWork(e.from) || !editor.inWork(e.to))
					.length
			: 0
	);
	const block = $derived(node ? editor.deleteBlock(node.id) : null);
	const nameOf = (id: string) => editor.node(id)?.name ?? id;

	let propKey = $state('');
	let propValue = $state('');

	type Draft = { name: string; bidirectional: boolean; props: { key: string; value: string }[] };
	const fromEntity = (): Draft => ({
		name: node?.name ?? '',
		bidirectional: edge?.bidirectional ?? false,
		props: Object.entries((node ?? edge)?.props ?? {}).map(([key, value]) => ({ key, value }))
	});
	/** 本地草稿：選取或標準資料換新物件時重建；儲存才經命令一次寫回，標準圖不直接 bind */
	const draft = $derived.by(() => {
		const d = $state(fromEntity());
		return d;
	});
	const draftProps = () => Object.fromEntries(draft.props.map((p) => [p.key, p.value]));
	const same = (a: Record<string, string>, b: Record<string, string>) =>
		Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
	const dirty = $derived(
		node
			? draft.name !== node.name || !same(draftProps(), node.props)
			: edge
				? draft.bidirectional !== edge.bidirectional || !same(draftProps(), edge.props)
				: false
	);

	function save() {
		if (!dirty) return;
		const props = draftProps();
		if (node) editor.updateNode(node.id, { name: draft.name, props }, node);
		else if (edge) editor.updateEdge(edge.id, { bidirectional: draft.bidirectional, props }, edge);
	}

	function cancel() {
		Object.assign(draft, fromEntity());
		propKey = propValue = '';
		editor.message = '';
	}

	/** 只加到草稿；按儲存才寫回 */
	function addProp() {
		const key = propKey.trim();
		if (!key) return;
		if (key === '確認狀態' && !CONFIRM_STATES.includes(propValue))
			return void (editor.message = `確認狀態只能是：${CONFIRM_STATES.join('、')}`);
		const hit = draft.props.find((p) => p.key === key);
		if (hit) hit.value = propValue;
		else draft.props.push({ key, value: propValue });
		propKey = propValue = '';
	}

	/** 加入編輯頁：整批 admission，訊息由 Editor 給（新增節點與帶入邊數） */
	const addWork = (ids: string[]) => editor.addToWork(ids);

	function removeNode(id: string) {
		if (nodeEdges && editor.armDelete !== id) editor.armDelete = id;
		else editor.deleteNode(id);
	}

	const TIPS = $derived(
		graph
			? [
					['mouse', '點節點', '看詳情與鄰居；找客戶、加入編輯頁都從詳情欄操作'],
					['solo', '系統開關', '頂列切換要看的系統（⌥＋點：只看該系統）']
				]
			: [
					['drag', '拖曳建立關聯', '把一張卡片拖到另一張；拖到空白處可順手新增節點'],
					['mouse', '右鍵', '節點、邊、空白處都有就地選單'],
					['target', '滑過節點', '浮出工具列：連到、聚焦、刪除']
				]
	);
	const SHORTCUTS = $derived([
		['⌘K', '搜尋節點'],
		...(graph
			? [['F', '對選取節點找客戶']]
			: [
					['N', '新增節點'],
					['E', '新增邊'],
					['Delete', '刪除選取']
				]),
		['Esc', '取消選取／關閉'],
		['⇧1', '全部顯示'],
		['⌘B / ⌘I', '收合左／右欄'],
		['⌘.', '專注模式'],
		...(graph ? [] : [['?', '圖例']])
	]);
</script>

{#snippet act(label: string, tip: string, icon: string, run: () => void, on = false)}
	<button
		class={[
			'grid size-8 place-items-center rounded-md transition-colors',
			on ? 'bg-sky-400/20 text-sky-200' : 'text-slate-300 hover:bg-white/8 hover:text-slate-50'
		]}
		aria-label={label}
		aria-pressed={on}
		title={tip}
		onclick={run}><Icon name={icon} /></button
	>
{/snippet}

{#snippet section(title: string)}
	<h3 class="mb-2 eyebrow">{title}</h3>
{/snippet}

{#snippet propsEditor()}
	<section class="border-t border-white/6 px-5 py-4">
		{@render section('屬性')}
		<dl class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-sm">
			{#each draft.props as p (p.key)}
				<dt class="text-xs text-slate-400">{p.key}</dt>
				<dd>
					{#if p.key === '確認狀態'}
						<select aria-label={p.key} bind:value={p.value} disabled={ro} class="field py-1">
							{#each CONFIRM_STATES as v (v)}<option>{v}</option>{/each}
						</select>
					{:else}
						<input aria-label={p.key} bind:value={p.value} disabled={ro} class="field py-1" />
					{/if}
				</dd>
			{:else}
				<p class="col-span-2 text-xs text-slate-500">尚無屬性</p>
			{/each}
		</dl>
		{#if !ro}
			<div class="mt-3 flex gap-1.5">
				<input aria-label="屬性名稱" placeholder="名稱" bind:value={propKey} class="field py-1" />
				<input aria-label="屬性值" placeholder="值" bind:value={propValue} class="field py-1" />
				<button
					class="btn-ghost shrink-0 px-2"
					aria-label="新增屬性"
					title="新增屬性"
					onclick={addProp}><Icon name="node-plus" /></button
				>
			</div>
		{/if}
	</section>
	{#if !ro}
		<div class="flex justify-end gap-1.5 border-t border-white/6 px-5 py-3">
			{#if dirty}<span class="mr-auto self-center text-[11px] text-amber-300">尚未儲存</span>{/if}
			<button class="btn-ghost px-2.5 py-1 text-xs" disabled={!dirty} onclick={cancel}
				>取消變更</button
			>
			<button class="btn-primary px-2.5 py-1 text-xs" disabled={!dirty} onclick={save}>儲存</button>
		</div>
	{/if}
{/snippet}

{#snippet idcBanner()}
	<div
		class="mx-5 mb-1 flex items-center gap-2 rounded-md border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-xs text-emerald-200"
	>
		<Icon name="lock" class="size-3.5" />
		<span>唯讀・{IDC_MESSAGE}</span>
	</div>
{/snippet}

<aside class="flex min-h-full flex-col" aria-label="詳情">
	{#if editor.result && editor.trace}
		{#key editor.trace.source}<TraceResult {editor} />{/key}
	{/if}

	{#if node}
		{@const sys = nodeType(node.type).system}
		<header class="px-5 pt-5 pb-3">
			<p class="flex items-center gap-2 text-xs text-slate-400">
				<span
					class="grid size-6 place-items-center rounded-md bg-(--c)/12 text-(--c)"
					style:--c={SYSTEM_COLORS[sys ?? '通用']}
					title="系統：{sys ?? '無（通用）'}"><Icon name={sys ?? '通用'} class="size-3.5" /></span
				>
				<span class="text-slate-500">類型</span>
				<span class="font-mono text-slate-200">{node.type}</span>
				<span class="ml-1 text-slate-500">系統</span>
				<span class="text-slate-200">{sys ?? '（無）'}</span>
			</p>
			<input
				aria-label="名稱"
				bind:value={draft.name}
				onkeydown={(e) => e.key === 'Enter' && save()}
				disabled={ro}
				class="-mx-1.5 mt-1.5 field border-transparent bg-transparent px-1.5 text-lg font-semibold hover:border-white/10 disabled:mx-0 disabled:px-0"
			/>
		</header>

		{#if idc}{@render idcBanner()}{/if}
		{#if editor.unprocessed.has(node.id)}
			<p
				class="mx-5 mb-1 flex gap-2 rounded-md border border-yellow-400/25 bg-yellow-400/5 px-3 py-2 text-xs leading-relaxed text-yellow-200"
			>
				<Icon name="warn" class="mt-0.5 size-3.5" />
				<span
					>未處理：{graph
						? '沒連到「TPKC 大樓」，加入編輯頁後補邊。'
						: '把這張卡片拖到主圖上的節點，就能接上「TPKC 大樓」。'}</span
				>
			</p>
		{:else if editor.unreachable.has(node.id)}
			<p
				class="mx-5 mb-1 flex gap-2 rounded-md border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-xs leading-relaxed text-rose-200"
			>
				<Icon name="broken" class="mt-0.5 size-3.5" />
				<span
					>{UNREACHABLE_LABEL}：{graph
						? '沿方向走不到客戶，加入編輯頁後補邊。'
						: '拖到下游節點補一條邊即可接上。'}</span
				>
			</p>
		{/if}

		<div class="flex items-center gap-1 px-5 py-3">
			{#if graph}
				<button
					class="btn-primary px-2.5"
					aria-label="找客戶"
					title="找客戶：它壞了影響哪些客戶（F）"
					onclick={() => editor.findCustomers(node.id)}
				>
					<Icon name="target" />找客戶
				</button>
			{:else}
				{@render act(
					'連到…',
					'連到…：再點目標節點（或直接拖曳卡片）',
					'link',
					() => (editor.connecting = editor.connecting === node.id ? null : node.id),
					editor.connecting === node.id
				)}
			{/if}
			{@render act('聚焦鄰居', '聚焦鄰居（雙擊節點）', 'focus', () =>
				editor.fit(
					[node.id, ...incoming.map((e) => e.from), ...outgoing.map((e) => e.to)].filter(
						(id) => graph || editor.working.includes(id)
					)
				)
			)}
			{#if graph}
				{#if sys}{@render act('只看此系統', `只看${sys}`, 'solo', () => editor.solo(sys))}{/if}
				{#if editor.working.includes(node.id)}
					<span class="ml-auto text-[11px] text-slate-500">已在編輯頁</span>
				{:else}
					<button
						class="ml-auto btn-ghost px-2 py-1 text-xs"
						aria-label="加入編輯頁"
						onclick={() => addWork([node.id])}>加入編輯頁</button
					>
				{/if}
			{:else if outsideNode}
				<button
					class="ml-auto btn-ghost px-2 py-1 text-xs"
					aria-label="加入編輯頁"
					onclick={() => addWork([node.id])}>加入編輯頁</button
				>
			{:else}
				<button
					class="ml-auto btn-ghost px-2 py-1 text-xs"
					title="只從工作區拿掉，不刪除資料"
					onclick={() => editor.removeFromWork([node.id])}>移出工作區</button
				>
				{#if editor.armDelete !== node.id}
					<button
						class="grid size-8 place-items-center rounded-md text-rose-300 transition-colors hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
						aria-label="刪除節點"
						title={block ? `無法刪除：${block}` : '刪除節點（⌫）'}
						disabled={!!block}
						onclick={() => removeNode(node.id)}><Icon name="trash" /></button
					>
				{/if}
			{/if}
		</div>
		{#if outsideNode}
			<p class="mx-5 mb-3 text-[11px] text-slate-400">不在編輯頁：先加入編輯頁才能修改</p>
		{/if}
		{#if editor.armDelete === node.id && !graph && !outsideNode}
			<div
				role="alertdialog"
				aria-label="確認刪除"
				class="mx-5 mb-3 flex animate-rise items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-100"
			>
				永久刪除資料，連同 {nodeEdges} 條邊{hiddenEdges
					? `（含工作區外 ${hiddenEdges} 條）`
					: ''}一起刪除？
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

		{@render propsEditor()}
		{#key node.id}<NeighborPicker {editor} id={node.id} />{/key}
		{#key node.id}
			<EdgeList {editor} title="連入" list={incoming} other="from" />
			<EdgeList {editor} title="連出" list={outgoing} other="to" />
		{/key}
	{:else if edge}
		<header class="px-5 pt-5 pb-3">
			<p class="flex items-center gap-2 text-xs text-slate-400">
				<span
					class="grid size-6 place-items-center rounded-md bg-(--c)/12 text-(--c)"
					style:--c={EDGE_COLORS[edge.type]}><Icon name={edge.type} class="size-3.5" /></span
				>
				邊
			</p>
			<dl class="mt-2 grid grid-cols-[3rem_1fr] items-center gap-y-1.5 text-sm">
				<dt class="text-xs text-slate-500">類型</dt>
				<dd class="font-semibold" style:color={EDGE_COLORS[edge.type]}>{edge.type}</dd>
				<dt class="text-xs text-slate-500">起點</dt>
				<dd>
					<button
						class="text-left text-slate-100 hover:text-sky-300"
						aria-label="起點：{nameOf(edge.from)}"
						onclick={() => editor.locate(edge.from)}>{nameOf(edge.from)}</button
					>
				</dd>
				<dt class="text-xs text-slate-500">終點</dt>
				<dd>
					<button
						class="text-left text-slate-100 hover:text-sky-300"
						aria-label="終點：{nameOf(edge.to)}"
						onclick={() => editor.locate(edge.to)}>{nameOf(edge.to)}</button
					>
				</dd>
				<dt class="text-xs text-slate-500">方向</dt>
				<dd>
					<select
						aria-label="方向"
						value={draft.bidirectional ? '雙向' : '單向'}
						onchange={(e) => (draft.bidirectional = e.currentTarget.value === '雙向')}
						disabled={ro}
						class="field w-28 py-1"
					>
						<option>單向</option>
						<option>雙向</option>
					</select>
				</dd>
			</dl>
		</header>
		{#if idc}{@render idcBanner()}{:else if outsideEdge}
			<div class="mx-5 mb-1 flex items-center gap-2 text-[11px] text-slate-400">
				<span>有一端不在編輯頁：先把兩端都加入編輯頁才能修改這條邊</span>
				<button
					class="ml-auto btn-ghost shrink-0 px-2 py-1 text-[11px]"
					onclick={() => editor.admitEdgeEnds(edge.id)}>將兩端加入編輯頁</button
				>
			</div>
		{/if}
		{#if !graph}
			<div class="flex px-5 py-3">
				<button
					class="ml-auto grid size-8 place-items-center rounded-md text-rose-300 transition-colors hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
					aria-label="刪除邊"
					title={ro ? IDC_MESSAGE : '刪除邊（⌫）'}
					disabled={ro}
					onclick={() => editor.deleteEdge(edge.id)}><Icon name="trash" /></button
				>
			</div>
		{/if}
		{@render propsEditor()}
	{:else}
		<div class="flex flex-1 flex-col px-5 py-6">
			<p class="eyebrow">檢視器</p>
			<ul class="mt-4 flex flex-col gap-2">
				{#each TIPS as [icon, title, text] (title)}
					<li class="flex gap-3 rounded-lg border border-white/6 bg-white/2 p-3">
						<span
							class="grid size-8 shrink-0 place-items-center rounded-md bg-sky-400/10 text-sky-300"
							><Icon name={icon} /></span
						>
						<span class="text-xs leading-relaxed text-slate-400"
							><b class="block text-[13px] font-medium text-slate-100">{title}</b>{text}</span
						>
					</li>
				{/each}
			</ul>
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
