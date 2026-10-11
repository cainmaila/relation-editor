<script lang="ts">
	import { Editor } from '#lib/editor.svelte.js';
	import App from '#lib/components/App.svelte';

	let { data } = $props();
	// 圖只在載入時讀一次，之後由 Editor 持有
	// svelte-ignore state_referenced_locally
	const editor = new Editor(data.graph);
</script>

<App {editor} />
