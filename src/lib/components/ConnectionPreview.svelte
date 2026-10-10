<script lang="ts">
	// 拉線預覽：畫在 viewport 外的螢幕座標層（Svelte Flow 子元件，不跟著 viewport 變形）。
	// P8 實測：內建連線 SVG 在 viewport 裡、夾在上千條邊與卡片之間，每移動一下就要重畫整個 viewport
	// （200 節點／1,000 邊時每幀約 14ms Paint＋7ms Layerize，拉線 p95 33.4ms）。
	// 這裡用同一條貝茲曲線（flow 座標算路徑，再套 viewport 的平移／縮放），外觀、起訖點與原本一致。
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
