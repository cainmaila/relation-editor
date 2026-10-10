<script lang="ts">
	import type { Editor } from '#lib/editor.svelte.js';
	import type { GraphProbe } from '#lib/measure.js';
	import Canvas from '#lib/components/Canvas.svelte';
	import GraphView from '#lib/components/GraphView.svelte';
	import Legend from '#lib/components/Legend.svelte';
	import ContextMenu from '#lib/components/ContextMenu.svelte';
	import DetailPanel from '#lib/components/DetailPanel.svelte';
	import EdgeDialog from '#lib/components/EdgeDialog.svelte';
	import OutlinePanel from '#lib/components/OutlinePanel.svelte';
	import NodeDialog from '#lib/components/NodeDialog.svelte';
	import Pane from '#lib/components/Pane.svelte';
	import SearchPalette from '#lib/components/SearchPalette.svelte';
	import TopBar from '#lib/components/TopBar.svelte';

	// probe 只有量測入口（/measure）會傳
	let { editor, probe }: { editor: Editor; probe?: GraphProbe } = $props();

	const graph = $derived(editor.page === 'graph');
	const origin = $derived(
		editor.result && editor.trace ? editor.node(editor.trace.source)?.name : null
	);

	$effect(() => {
		if (!editor.message) return;
		const t = setTimeout(() => (editor.message = ''), 5000);
		return () => clearTimeout(t);
	});

	function key(e: KeyboardEvent) {
		const mod = e.metaKey || e.ctrlKey;
		const k = e.key.toLowerCase();
		if (mod && k === 'k') editor.dialog = editor.dialog === 'search' ? null : 'search';
		else if (mod && k === 'b') editor.panels.left = !editor.panels.left;
		else if (mod && k === 'i') editor.panels.right = !editor.panels.right;
		else if (mod && k === '.') {
			const v = !editor.panels.left && !editor.panels.right;
			editor.panels.left = editor.panels.right = v;
		} else if (e.key === 'Escape') {
			if (editor.menu) editor.menu = null;
			else if (editor.dialog) editor.dialog = null;
			else if (editor.connecting || editor.armDelete) {
				editor.connecting = null;
				editor.cancelDelete();
			} else if (editor.legend) editor.legend = false;
			else if (editor.result) editor.clearTrace();
			else editor.select(null);
		} else {
			// 以下單鍵快捷鍵：輸入中或對話框開著時不觸發
			const t = e.target as HTMLElement;
			if (mod || e.altKey || editor.dialog || editor.menu || t.closest('input, select, textarea'))
				return;
			const s = editor.selected;
			// 全圖只讀：編輯快捷鍵無效
			if (k === 'n' && !graph) editor.dialog = 'node';
			else if (e.key === '?' && !graph) editor.legend = !editor.legend;
			else if (k === 'e' && !graph) {
				if (s?.kind === 'node') editor.draft = { from: s.id, to: '', type: '' };
				editor.dialog = 'edge';
			} else if (k === 'f' && graph && s?.kind === 'node') editor.findCustomers(s.id);
			else if (e.code === 'Digit1' && e.shiftKey) editor.fit();
			else if ((e.key === 'Delete' || e.key === 'Backspace') && s && !graph) {
				// 與詳情、右鍵同一規則：刪資料一律在詳情欄確認（被擋的由 Editor 說明原因）
				if (editor.requestDelete(s.kind, s.id)) editor.panels.right = true;
			} else return;
		}
		e.preventDefault();
	}
</script>

<svelte:head><title>TPKC 關係鏈編輯器</title></svelte:head>
<svelte:window onkeydown={key} />

<div class="flex h-screen flex-col">
	<TopBar {editor} />
	<div class="flex min-h-0 flex-1">
		<Pane
			side="left"
			label="大綱"
			bind:open={editor.panels.left}
			width={260}
			min={220}
			max={420}
			attention={graph && editor.unprocessed.size + editor.unreachable.size > 0}
		>
			<OutlinePanel {editor} />
		</Pane>
		<main class="relative min-w-0 flex-1">
			{#if graph}
				<GraphView {editor} {probe} />
			{:else}
				<Canvas {editor} />
				<Legend {editor} />
			{/if}
			{#if editor.connecting}
				<div
					class="pointer-events-none absolute top-4 left-1/2 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 animate-rise items-center gap-2 rounded-full border border-sky-400/40 bg-ink-850/90 px-4 py-2 text-xs text-sky-100 shadow-xl backdrop-blur"
				>
					<span class="size-1.5 animate-pulse rounded-full bg-sky-400"></span>
					從「{editor.node(editor.connecting)?.name}」連線：點選終點節點
					<span class="kbd">Esc</span>
				</div>
			{:else if graph && origin}
				<div
					role="group"
					aria-label="影響分析"
					class="absolute top-4 left-1/2 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 animate-rise items-center gap-3 rounded-full border border-sky-400/40 bg-ink-850/90 py-1.5 pr-1.5 pl-4 text-xs text-slate-200 shadow-xl backdrop-blur"
				>
					<span class="size-1.5 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_8px] shadow-cyan-400"
					></span>
					<span class="min-w-0"
						>影響分析（青色路徑）：<b class="text-slate-50">{origin}</b> → {editor.result!.customers
							.length} 位客戶</span
					>
					<button
						class="btn-ghost shrink-0 rounded-full px-2.5 py-0.5 text-xs whitespace-nowrap"
						onclick={() => editor.clearTrace()}>清除 <span class="kbd">Esc</span></button
					>
				</div>
			{/if}
		</main>
		<Pane
			side="right"
			label="檢視器"
			bind:open={editor.panels.right}
			width={340}
			min={280}
			max={520}
			attention={!!editor.selected}
		>
			<DetailPanel {editor} />
		</Pane>
	</div>
</div>

<p
	role="status"
	class={[
		'fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border bg-ink-850/95 px-4 py-2.5 text-sm shadow-2xl shadow-black/50 backdrop-blur transition-all duration-200',
		editor.message.startsWith('已加入編輯頁')
			? 'border-emerald-400/40 text-emerald-100'
			: 'border-rose-500/40 text-rose-100',
		editor.message ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0'
	]}
>
	{editor.message}
</p>

{#if editor.menu}<ContextMenu {editor} />{/if}
{#if editor.dialog === 'node'}<NodeDialog {editor} />{/if}
{#if editor.dialog === 'edge'}<EdgeDialog {editor} />{/if}
{#if editor.dialog === 'search'}<SearchPalette {editor} />{/if}
