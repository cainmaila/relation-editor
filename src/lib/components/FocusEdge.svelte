<script lang="ts" module>
	/** 亮起時的描邊（畫在另一層）；null＝沒亮。back：畫成反向（流動要倒過來才是資料方向）；label：邊類型 */
	export type FocusEdgeData = {
		lit: string | null;
		animated: boolean;
		back: boolean;
		label: string;
	};
</script>

<script lang="ts">
	// 預設貝茲邊＋亮起時的副本。底層的邊樣式不隨選取／滑過改變，暗化改由整個邊容器的 opacity 做；
	// 亮起的邊另畫一份到 edge-labels 層（邊之上、卡片之下）。
	// P8 實測（200／1,000、縮放 0.87）：逐條改樣式會讓整片長虛線重新點陣化，一次滑過約 350ms
	import { BaseEdge, EdgeLabel, getBezierPath, portal, type EdgeProps } from '@xyflow/svelte';

	let {
		id,
		data,
		interactionWidth,
		markerEnd,
		markerStart,
		sourcePosition,
		sourceX,
		sourceY,
		style,
		targetPosition,
		targetX,
		targetY
	}: EdgeProps = $props();

	const [path, labelX, labelY] = $derived(
		getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
	);
	const focus = $derived(data as FocusEdgeData | undefined);
</script>

<BaseEdge {id} {path} {markerStart} {markerEnd} {interactionWidth} {style} />
{#if focus?.lit}
	<svg class="lit-edge" data-lit-for={id} aria-hidden="true" use:portal={'edge-labels'}>
		<path
			d={path}
			class={[focus.animated && 'animated', focus.back && 'back']}
			marker-start={markerStart}
			marker-end={markerEnd}
			fill="none"
			style={focus.lit}
		/>
	</svg>
	<!-- 只標亮起的邊：1,000 個常駐標籤讓平移掉到 30fps（P8 workspace 實測 p95 33.4）；pointer-events 蓋過 EdgeLabel 內建的 all，不擋點邊與拖曳 -->
	<EdgeLabel x={labelX} y={labelY} class="pointer-events-none! text-slate-400"
		>{focus.label}</EdgeLabel
	>
{/if}

<style>
	.lit-edge {
		position: absolute;
		left: 0;
		top: 0;
		width: 1px;
		height: 1px;
		overflow: visible;
		pointer-events: none;
		/* 自己一層：亮起／熄滅不讓底下上千條邊重新點陣化 */
		will-change: transform;
	}
	.animated {
		stroke-dasharray: 5;
		animation: dashdraw 0.5s linear infinite;
	}
	/* dashdraw 沿路徑方向流；反向畫的邊倒過來播，流向才是資料方向 */
	.back {
		animation-direction: reverse;
	}
</style>
