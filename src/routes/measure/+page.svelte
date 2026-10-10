<script lang="ts">
	// 效能量測入口（P1）：/measure?nodes=10000&edges=20000&seed=1&init=zero
	// 正式首頁（/）仍是 mock；這裡改載代表性大圖，並只在此頁掛 window.__measure 唯讀探針。
	// 參數不合法（非整數、超出支援範圍、太密）時在產生任何資料前就顯示錯誤，不靜默改值。
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import App from '#lib/components/App.svelte';
	import { Editor } from '#lib/editor.svelte.js';
	import { createProbe, parseInit } from '#lib/measure.js';
	import { graphStats, parseScaleQuery, scaleFixture } from '#lib/model/scale-fixture.js';

	type Hook = Record<string, unknown>;
	const win = window as unknown as { __measure?: Hook };

	function setup(q: URLSearchParams) {
		let options, init;
		try {
			options = parseScaleQuery(q);
			init = parseInit(q.get('init'));
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			return { error, hook: { error, query: q.toString() } };
		}
		const probe = createProbe(init);
		probe.mark('fixture:start');
		const { graph, meta } = scaleFixture(options);
		const s = graphStats(graph);
		const stats = {
			nodes: s.nodes,
			edges: s.edges,
			maxDegree: s.maxDegree,
			maxDegreeId: s.maxDegreeId,
			components: s.components,
			isolated: s.isolated
		};
		probe.mark('fixture:done', stats);
		const hook = {
			options,
			meta,
			stats,
			marks: probe.marks,
			init: probe.init,
			/** 瀏覽器實際的起始座標：決定性 phyllotaxis 種子（init 參數只供 layout 模式對照） */
			seed: 'phyllotaxis',
			renderInfo: probe.renderInfo,
			gpu: probe.gpu
		};
		return { editor: new Editor(graph), probe, hook };
	}

	// 只在載入時讀一次 URL（量測入口不隨 query 重建大圖）
	const run = setup(new URLSearchParams(page.url.search));
	win.__measure = run.hook;

	onMount(() => {
		run.probe?.mark('app:mounted');
		return () => delete win.__measure;
	});
</script>

{#if run.editor}
	<App editor={run.editor} probe={run.probe} />
{:else}
	<main class="measure-error">
		<p role="alert">
			<strong>不支援的量測參數</strong>：{run.error}
		</p>
	</main>
{/if}

<style>
	.measure-error {
		padding: 2rem;
		font-family: system-ui, sans-serif;
	}
	[role='alert'] {
		color: #b00020;
	}
</style>
