<script lang="ts">
	import { CREATABLE_NODE_TYPES, type Editor } from '#lib/editor.svelte.js';
	import { SYSTEMS, nodeType } from '#lib/model/config.js';
	import { SYSTEM_COLORS } from './Canvas.svelte';
	import Modal from './Modal.svelte';

	let { editor }: { editor: Editor } = $props();

	let type = $state('');
	let name = $state('');
	const groups = [...SYSTEMS, null].map((s) => ({
		s,
		types: CREATABLE_NODE_TYPES.filter((t) => t.system === s)
	}));
	const lane = $derived(type ? (nodeType(type).system ?? '中間帶（通用）') : '');

	function submit(e: SubmitEvent) {
		e.preventDefault();
		editor.addNode(type, name);
	}
</script>

<Modal label="新增節點" onclose={() => (editor.dialog = null)}>
	<form onsubmit={submit} aria-label="新增節點" class="flex flex-col gap-4 p-5">
		<div>
			<p class="eyebrow">新增節點</p>
			<p class="mt-1 text-xs text-slate-400">選類型、填名稱。系統由類型決定。</p>
		</div>
		<label class="flex flex-col gap-1.5 text-xs text-slate-400">
			類型
			<!-- svelte-ignore a11y_autofocus -->
			<select bind:value={type} class="field" autofocus>
				<option value="">請選擇</option>
				{#each groups as g (g.s)}
					{#if g.types.length}
						<optgroup label={g.s ?? '通用'}>
							{#each g.types as t (t.name)}
								<option value={t.name}>{t.name}</option>
							{/each}
						</optgroup>
					{/if}
				{/each}
			</select>
		</label>
		<label class="flex flex-col gap-1.5 text-xs text-slate-400">
			名稱
			<input bind:value={name} class="field" placeholder="例：攝影機 CAM-04" />
		</label>
		<div class="flex items-center gap-2 border-t border-white/6 pt-4">
			{#if lane}
				<span class="flex items-center gap-1.5 text-xs text-slate-400">
					<span
						class="size-2 rounded-full"
						style:background={SYSTEM_COLORS[nodeType(type).system ?? '通用']}
					></span>
					將放在 <b class="text-slate-200">{lane}</b>
				</span>
			{:else}
				<span class="text-xs text-slate-500">機框、主機、客戶由 IDC 維護，不能在此新增</span>
			{/if}
			<button type="button" class="ml-auto btn-ghost" onclick={() => (editor.dialog = null)}
				>取消</button
			>
			<button class="btn-primary">新增節點</button>
		</div>
	</form>
</Modal>
