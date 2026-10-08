<script lang="ts">
	import { CREATABLE_EDGE_TYPES, type Editor } from '#lib/editor.svelte.js';
	import { SYSTEMS, nodeType } from '#lib/model/config.js';
	import { EDGE_COLORS } from './Canvas.svelte';
	import Modal from './Modal.svelte';

	let { editor }: { editor: Editor } = $props();

	const d = $derived(editor.draft);
	const groups = $derived(
		[...SYSTEMS, null].map((s) => ({
			s,
			nodes: editor.graph.nodes
				.filter((n) => nodeType(n.type).system === s)
				.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
		}))
	);
	/** 起終點都選了才檢查；各類型不合法的原因 */
	const errors = $derived(d.from && d.to ? editor.edgeErrors(d.from, d.to) : null);
	const none = $derived(!!errors && [...errors.values()].every(Boolean));

	$effect(() => {
		// 起終點換了，原本選的類型若變不合法就清掉
		if (d.type && errors?.get(d.type)) d.type = '';
	});

	function submit(e: SubmitEvent) {
		e.preventDefault();
		editor.addEdge(d.from, d.to, d.type);
	}
</script>

{#snippet endpoint(key: 'from' | 'to', label: string)}
	<label class="flex min-w-0 flex-1 flex-col gap-1.5 text-xs text-slate-400">
		{label}
		<select bind:value={editor.draft[key]} class="field">
			<option value="">請選擇</option>
			{#each groups as g (g.s)}
				<optgroup label={g.s ?? '通用'}>
					{#each g.nodes as n (n.id)}
						<option value={n.id}>{n.name}</option>
					{/each}
				</optgroup>
			{/each}
		</select>
	</label>
{/snippet}

<Modal label="新增邊" onclose={() => (editor.dialog = null)}>
	<form onsubmit={submit} aria-label="新增邊" class="flex flex-col gap-4 p-5">
		<div>
			<p class="eyebrow">新增邊</p>
			<p class="mt-1 text-xs text-slate-400">
				選起點、終點與邊類型；不符連接限制的類型會直接標出原因。
			</p>
		</div>
		<div class="flex items-end gap-2">
			{@render endpoint('from', '起點')}
			<button
				type="button"
				class="mb-0.5 btn-ghost px-2"
				aria-label="對調方向"
				title="對調方向"
				onclick={() => (editor.draft = { from: d.to, to: d.from, type: d.type })}>⇄</button
			>
			{@render endpoint('to', '終點')}
		</div>
		<fieldset class="flex flex-col gap-1">
			<legend class="mb-1.5 text-xs text-slate-400">邊類型</legend>
			{#each CREATABLE_EDGE_TYPES as t (t.name)}
				{@const err = errors?.get(t.name)}
				<label
					class={[
						'flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors',
						err
							? 'cursor-not-allowed border-transparent text-slate-500'
							: 'cursor-pointer border-white/6 hover:border-white/15 has-checked:border-sky-400/60 has-checked:bg-sky-400/10'
					]}
				>
					<input
						type="radio"
						name="edge-type"
						value={t.name}
						bind:group={editor.draft.type}
						disabled={!!err}
						aria-describedby={err ? `why-${t.name}` : undefined}
						class="size-3.5 border-white/20 bg-transparent text-sky-400 focus:ring-sky-400 focus:ring-offset-0"
					/>
					<span class="h-0.5 w-4 rounded" style:background={EDGE_COLORS[t.name]}></span>
					{t.name}
					{#if err}
						<span
							id="why-{t.name}"
							aria-hidden="true"
							class="ml-auto truncate text-[11px] text-rose-300/80">{err}</span
						>
					{/if}
				</label>
			{/each}
		</fieldset>
		{#if none}
			<p class="-mt-2 text-xs text-rose-300">
				這兩個節點不能直接相連，可試試對調方向或改連其他節點。
			</p>
		{/if}
		<div class="flex items-center gap-2 border-t border-white/6 pt-4">
			<span class="text-xs text-slate-500">方向預設單向，建立後可改</span>
			<button type="button" class="ml-auto btn-ghost" onclick={() => (editor.dialog = null)}
				>取消</button
			>
			<button class="btn-primary" disabled={none}>新增邊</button>
		</div>
	</form>
</Modal>
