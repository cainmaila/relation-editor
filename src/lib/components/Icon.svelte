<script lang="ts" module>
	// 16×16 線條圖示；系統、邊類型、動作共用。名稱即 key，找不到就畫空白
	const PATHS: Record<string, string> = {
		// 系統
		空間: 'M2.5 14V3.5l5-2v12.5M7.5 6h6v8M2 14h12M4.5 5.5v.01M4.5 8v.01M4.5 10.5v.01M10 8.5h1M10 11h1',
		電力: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z',
		空調: 'M8 1.5v13M2.4 4.75l11.2 6.5M2.4 11.25l11.2-6.5M6 2.5l2 1.5 2-1.5M6 13.5l2-1.5 2 1.5',
		網路: 'M6 1.5h4v3.5H6zM1.5 11h4v3.5h-4zM10.5 11h4v3.5h-4zM8 5v3M3.5 11V8h9v3',
		消防: 'M8 14.5a4.5 4.5 0 0 0 4.5-4.5c0-3-2.5-4.5-3-8-1.5 1.5-2 3-2 4.5C6.5 5.5 6 5 5.5 4 4.2 5.5 3.5 7.6 3.5 10A4.5 4.5 0 0 0 8 14.5Z',
		CCTV: 'M1.5 5.5 11 2.5l1.5 4.5L3 10zM12 5.5l2.5-.8.8 2.5-2.5.8M5.5 9.2 6.5 12H2M2 10v4',
		IDC: 'M2.5 2h11v4.5h-11zM2.5 9.5h11V14h-11zM5 4.25h.01M5 11.75h.01M8 4.25h3M8 11.75h3',
		通用: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4',
		// 邊類型
		包含: 'M2 2.5h12v11H2zM5 6h6v4.5H5z',
		供電: 'M5.5 1.5v3M10.5 1.5v3M3.5 4.5h9V7a4.5 4.5 0 0 1-9 0zM8 11.5v3',
		冷卻: 'M1.5 5h8.5a2 2 0 1 0-2-2M1.5 8h11.5a2 2 0 1 1-2 2M1.5 11h5',
		連線: 'M6.5 9.5l3-3M7 4.5l1.5-1.5a2.8 2.8 0 0 1 4 4L11 8.5M9 11.5 7.5 13a2.8 2.8 0 0 1-4-4L5 7.5',
		服務: 'M8 7.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5ZM2.5 14.5c.5-3 2.6-4.5 5.5-4.5s5 1.5 5.5 4.5',
		承載: 'M8 1.5 14.5 5 8 8.5 1.5 5zM1.5 8 8 11.5 14.5 8M1.5 11 8 14.5l6.5-3.5',
		監測: 'M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
		// 動作與狀態
		search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM10.5 10.5l3.5 3.5',
		'node-plus': 'M1.5 3.5h9v6h-9zM12.5 9.5v5M10 12h5',
		'edge-plus':
			'M3 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM4.2 10.3 10 4.5M8 4.5h2v2M12.5 9.5v5M10 12h5',
		target:
			'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8 0v3M8 13v3M0 8h3M13 8h3',
		link: 'M3 8h7M8 4.5 11.5 8 8 11.5M13.5 3v10',
		focus:
			'M1.5 5V1.5H5M11 1.5h3.5V5M14.5 11v3.5H11M5 14.5H1.5V11M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
		trash: 'M2.5 4h11M6 4V2.5h4V4M4 4l.7 10h6.6L12 4M6.75 7v4.5M9.25 7v4.5',
		lock: 'M4 7.5h8v6.5H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5',
		warn: 'M8 1.5 15 14H1zM8 6v3.5M8 11.75v.01',
		broken: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM3.4 3.4l9.2 9.2',
		swap: 'M2 5h11l-3-3M14 11H3l3 3',
		solo: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z',
		fit: 'M5 1.5H1.5V5M11 1.5h3.5V5M14.5 11v3.5H11M5 14.5H1.5V11M5 5h6v6H5z',
		chevron: 'm6 3.5 4.5 4.5L6 12.5',
		check: 'm3 8.5 3 3 7-7',
		close: 'm3.5 3.5 9 9M12.5 3.5l-9 9',
		'panel-left': 'M1.5 2.5h13v11h-13zM5.5 2.5v11',
		'panel-right': 'M1.5 2.5h13v11h-13zM10.5 2.5v11',
		'panel-none': 'M1.5 2.5h13v11h-13zM4 6V5h1M12 6V5h-1M4 10v1h1M12 10v1h-1',
		mouse: 'M4 5.5a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0zM8 1.5V6M4 6h4',
		drag: 'M3 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM13 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM4.5 4.5 11.5 11.5M8 11.5h3.5V8'
	};
</script>

<script lang="ts">
	import type { ClassValue } from 'svelte/elements';

	let {
		name,
		class: cls = 'size-4',
		label
	}: { name: string; class?: ClassValue; label?: string } = $props();
</script>

<svg
	viewBox="0 0 16 16"
	class={['shrink-0 fill-none stroke-current', cls]}
	stroke-width="1.4"
	stroke-linecap="round"
	stroke-linejoin="round"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
>
	<path d={PATHS[name] ?? ''} />
</svg>
