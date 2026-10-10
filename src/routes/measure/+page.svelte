<script lang="ts">
	// 效能量測入口（P1）：/measure?edges=20000&seed=1&init=zero
	// 正式首頁（/）仍是 mock；這裡改載代表性大圖，並只在此頁掛 window.__measure 唯讀探針。
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import App from '#lib/components/App.svelte';
	import { Editor } from '#lib/editor.svelte.js';
	import { createProbe } from '#lib/measure.js';
	import { graphStats, scaleFixture } from '#lib/model/scale-fixture.js';

	const q = page.url.searchParams;
	const options = {
		nodes: Number(q.get('nodes') ?? 10_000),
		edges: Number(q.get('edges') ?? 20_000),
		seed: Number(q.get('seed') ?? 1)
	};
	const probe = createProbe(q.get('init') === 'd3' ? 'd3' : 'zero');
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
	const editor = new Editor(graph);

	const hook = {
		options,
		meta,
		stats,
		marks: probe.marks,
		init: probe.init,
		renderInfo: probe.renderInfo,
		gpu: probe.gpu
	};
	(window as unknown as { __measure?: typeof hook }).__measure = hook;

	onMount(() => {
		probe.mark('app:mounted');
		return () => delete (window as unknown as { __measure?: typeof hook }).__measure;
	});
</script>

<App {editor} {probe} />
