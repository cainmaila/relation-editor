<script lang="ts">
	// 放在 SvelteFlow 裡才拿得到 useSvelteFlow：依 editor.view 請求與系統勾選縮放視野
	import { untrack } from 'svelte';
	import { useSvelteFlow } from '@xyflow/svelte';
	import type { Editor } from '#lib/editor.svelte.js';

	let { editor }: { editor: Editor } = $props();
	const flow = useSvelteFlow();

	// 單一節點：平移置中（縮放至少 0.9 讓字讀得到）；多個：縮放到全部入鏡
	const go = (ids: string[]) =>
		// 等 Svelte Flow 量完新節點再縮放
		requestAnimationFrame(() => {
			const n = ids.length === 1 ? flow.getNode(ids[0]) : undefined;
			if (n)
				flow.setCenter(n.position.x + (n.width ?? 0) / 2, n.position.y + (n.height ?? 0) / 2, {
					zoom: Math.max(flow.getZoom(), 0.9),
					duration: 350
				});
			else
				flow.fitView({
					nodes: ids.length ? ids.map((id) => ({ id })) : undefined,
					padding: 0.15,
					maxZoom: 1.25,
					duration: 350
				});
		});

	$effect(() => {
		if (editor.view.seq) go(editor.view.ids);
	});

	let first = true;
	$effect(() => {
		void editor.systems.join();
		if (first) first = false;
		else go([]);
	});

	// 面板收合／展開後畫布變寬：沒選東西時等寬度動畫完重新入鏡
	let firstPanels = true;
	$effect(() => {
		void [editor.panels.left, editor.panels.right];
		if (firstPanels) return void (firstPanels = false);
		if (untrack(() => editor.selected)) return;
		const t = setTimeout(() => go([]), 220);
		return () => clearTimeout(t);
	});
</script>
