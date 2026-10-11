<script lang="ts">
	// 拉線預覽：畫在 viewport 外、自己一層的螢幕座標 SVG，外觀與內建連線相同（同一條貝茲曲線）。
	// P8 量測（200／1,000、縮放 0.87）：拉線 frame p95 16.8ms
	import { getBezierPath, useConnection, useViewport } from '@xyflow/svelte';

	const connection = useConnection();
	const viewport = useViewport();

	const line = $derived.by(() => {
		const c = connection.current;
		if (!c.inProgress) return null;
		const [d] = getBezierPath({
			sourceX: c.from.x,
			sourceY: c.from.y,
			sourcePosition: c.fromPosition,
			targetX: c.to.x,
			targetY: c.to.y,
			targetPosition: c.toPosition
		});
		return { d, status: c.isValid === null ? '' : c.isValid ? 'valid' : 'invalid' };
	});
</script>

{#if line}
	{@const v = viewport.current}
	<svg class="connection-preview" aria-hidden="true">
		<g
			class={['svelte-flow__connection', line.status]}
			transform="translate({v.x} {v.y}) scale({v.zoom})"
		>
			<path d={line.d} fill="none" class="svelte-flow__connection-path" />
		</g>
	</svg>
{/if}

<style>
	.connection-preview {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
		pointer-events: none;
		/* 在 pane（含 viewport）之上、控制列／小地圖之下；自己一層，重畫不碰 viewport */
		z-index: 4;
		will-change: transform;
	}
</style>
