<script lang="ts">
	import { Editor } from '#lib/editor.svelte.js';
	import App from '#lib/components/App.svelte';

	const editor = new Editor();
</script>

<App {editor} />
