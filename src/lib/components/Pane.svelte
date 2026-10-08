<script lang="ts">
	// 可收合、可拖拉調寬的側欄殼
	import type { Snippet } from 'svelte';

	let {
		side,
		open = $bindable(),
		label,
		width: initial,
		min,
		max,
		attention = false,
		children
	}: {
		side: 'left' | 'right';
		open: boolean;
		label: string;
		width: number;
		min: number;
		max: number;
		/** 收合時在細條上亮點提示 */
		attention?: boolean;
		children: Snippet;
	} = $props();

	// ponytail: 寬度不存 localStorage，重新整理回預設
	// svelte-ignore state_referenced_locally
	let width = $state(initial);
	let dragging = $state(false);

	function drag(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		dragging = true;
		const x0 = e.clientX;
		const w0 = width;
		const move = (ev: PointerEvent) => {
			const dx = side === 'left' ? ev.clientX - x0 : x0 - ev.clientX;
			width = Math.min(max, Math.max(min, w0 + dx));
		};
		const up = () => {
			dragging = false;
			el.removeEventListener('pointermove', move);
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up, { once: true });
	}
</script>

<div
	class={[
		'relative shrink-0 border-white/8 bg-ink-900',
		side === 'left' ? 'border-r' : 'border-l',
		!dragging && 'transition-[width] duration-200 ease-out'
	]}
	style:width="{open ? width : 12}px"
>
	{#if open}
		<div class="h-full overflow-x-hidden overflow-y-auto" style:width="{width}px">
			{@render children()}
		</div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class={[
				'absolute inset-y-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-sky-400/50',
				side === 'left' ? '-right-1' : '-left-1',
				dragging && 'bg-sky-400/70'
			]}
			title="拖拉調整寬度，雙擊回預設"
			onpointerdown={drag}
			ondblclick={() => (width = initial)}
		></div>
	{:else}
		<button
			class="group flex h-full w-full items-start justify-center pt-3 hover:bg-white/5"
			aria-label="展開{label}"
			title="展開{label}"
			onclick={() => (open = true)}
		>
			<span
				class={[
					'size-1.5 rounded-full',
					attention ? 'bg-sky-400 shadow-[0_0_8px] shadow-sky-400' : 'bg-slate-600'
				]}
			></span>
		</button>
	{/if}
</div>
