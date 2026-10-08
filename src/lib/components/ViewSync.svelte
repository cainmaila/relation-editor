<script lang="ts">
	// 放在 SvelteFlow 裡才拿得到 useSvelteFlow：依 editor.view 請求與系統勾選縮放視野
	import { untrack } from 'svelte';
	import { useSvelteFlow } from '@xyflow/svelte';
	import type { Editor } from '#lib/editor.svelte.js';

	let { editor }: { editor: Editor } = $props();
	const flow = useSvelteFlow();

	// 單一節點：置中（縮放至少 0.9 讓字讀得到）；多個：縮放到全部入鏡。
	// 一律走 fitView：它會等節點量完才執行、排隊中只留最後一次，先前的整圖入鏡不會蓋掉後來的置中
	// 在 effect 裡呼叫，untrack 免得追蹤到 Svelte Flow 的 store 而一直重跑
	const go = (ids: string[]) =>
		untrack(() => {
			const z = ids.length === 1 ? Math.max(flow.getZoom(), 0.9) : undefined;
			flow.fitView({
				nodes: ids.length ? ids.map((id) => ({ id })) : undefined,
				padding: 0.15,
				minZoom: z,
				maxZoom: z ?? 1.25,
				duration: 350
			});
		});

	// 系統變動整張入鏡。要宣告在視野請求之前：reveal() 同時勾回系統又請求置中時，置中排在後面才會生效
	let first = true;
	$effect(() => {
		void editor.systems.join();
		if (first) first = false;
		else go([]);
	});

	$effect(() => {
		// 收起的成員改對準它的堆疊卡
		if (editor.view.seq) {
			const owner = untrack(() => editor.canvas.owner);
			go([...new Set(editor.view.ids.map((id) => owner.get(id) ?? id))]);
		}
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
