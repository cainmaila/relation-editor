<script lang="ts">
	import { Editor } from '#lib/editor.svelte.js';
	import Canvas from '#lib/components/Canvas.svelte';
	import DetailPanel from '#lib/components/DetailPanel.svelte';
	import Sidebar from '#lib/components/Sidebar.svelte';

	const editor = new Editor();
</script>

<svelte:head><title>TPKC 關係鏈節點編輯器</title></svelte:head>

<div class="flex h-screen">
	<Sidebar {editor} />
	<main class="min-w-0 flex-1"><Canvas {editor} /></main>
	<DetailPanel {editor} />
</div>
