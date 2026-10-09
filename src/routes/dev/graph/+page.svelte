<script lang="ts">
	// 暫時的驗證頁（T5 會移除）：只掛 GraphView，能開關系統
	import { Editor } from '#lib/editor.svelte.js';
	import GraphView from '#lib/components/GraphView.svelte';
	import { SYSTEMS } from '#lib/model/config.js';

	const editor = new Editor();
	(window as unknown as { __editor: Editor }).__editor = editor;
</script>

<div class="flex h-screen flex-col">
	<div class="flex gap-3 bg-slate-900 p-2 text-sm text-slate-200">
		{#each SYSTEMS as s (s)}
			<label><input type="checkbox" bind:group={editor.systems} value={s} /> {s}</label>
		{/each}
	</div>
	<div class="min-h-0 flex-1"><GraphView {editor} /></div>
</div>
