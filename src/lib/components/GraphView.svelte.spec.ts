// P6 整合：真 Chromium WebGL 掛上 GraphView，驗證「改名只刷新標籤、不重排版面」與
// 「相機（滾輪）改變時逐點投影 LOD：拉近升級細節、拉遠只剩點」，並且預算不超過上限。
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { Editor } from '#lib/editor.svelte.js';
import GraphView from './GraphView.svelte';

type Stats = {
	visibleNodes: number;
	baseNodes: number;
	detail: number;
	localEdges: number;
	labels: number;
	config: { maxDetail: number; maxLocalEdges: number; maxLabels: number };
};
type Hooks = {
	ready: boolean;
	version(): number;
	workerStarts(): number;
	lod(): Stats | null;
	labels(): { id: string }[];
	detailIds(): string[];
	position(id: string): [number, number, number] | undefined;
};
const hooks = () => (window as unknown as { __graphView?: Hooks }).__graphView;

const graph = (n: number) => ({
	nodes: Array.from({ length: n }, (_, i) => ({
		id: `n${i}`,
		type: '通用節點',
		name: `節點${i}`,
		props: {}
	})),
	edges: Array.from({ length: n - 1 }, (_, i) => ({
		id: `e${i}`,
		type: '包含',
		from: `n${i}`,
		to: `n${i + 1}`,
		bidirectional: false,
		props: {}
	}))
});

let host: HTMLDivElement | null = null;
afterEach(() => {
	host?.remove();
	host = null;
});

async function mount(e: Editor) {
	host = document.createElement('div');
	host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px';
	document.body.append(host);
	render(GraphView, { target: host, props: { editor: e } });
	await expect.poll(() => hooks()?.ready ?? false, { timeout: 20_000 }).toBe(true);
	await expect.poll(() => hooks()!.lod() !== null).toBe(true);
	return host;
}
const labelText = (el: HTMLElement) =>
	[...el.querySelectorAll<HTMLElement>('.universe-label')]
		.filter((l) => l.style.display !== 'none')
		.map((l) => l.textContent);

/** 對畫布送滾輪（TrackballControls 監聽 wheel），每次一格；等畫面跟上 */
async function wheel(el: HTMLElement, dy: number, times: number) {
	const canvas = el.querySelector('canvas')!;
	const r = canvas.getBoundingClientRect();
	for (let i = 0; i < times; i++) {
		canvas.dispatchEvent(
			new WheelEvent('wheel', {
				deltaY: dy,
				deltaMode: 0,
				clientX: r.left + r.width / 2,
				clientY: r.top + r.height / 2,
				bubbles: true,
				cancelable: true
			})
		);
		await new Promise((res) => requestAnimationFrame(() => res(null)));
	}
}

describe('GraphView（P6 LOD 整合）', () => {
	it('改名：標籤立即換字，不動版面、不重啟 worker、座標不變', async () => {
		const e = new Editor(graph(4));
		const el = await mount(e);
		e.select({ kind: 'node', id: 'n1' });
		// 選取的節點一定有標籤（優先）
		await expect.poll(() => labelText(el)).toContain('節點1');
		const before = {
			v: hooks()!.version(),
			w: hooks()!.workerStarts(),
			p: hooks()!.position('n1')
		};
		expect(e.updateNode('n1', { name: '改名後' })).toBe(true);
		await expect.poll(() => labelText(el)).toContain('改名後');
		expect(labelText(el)).not.toContain('節點1');
		expect(hooks()!.version()).toBe(before.v);
		expect(hooks()!.workerStarts()).toBe(before.w);
		expect(hooks()!.position('n1')).toEqual(before.p);
	});

	it('滾輪拉遠只剩點、沒有標籤與局部邊；拉近升級細節，且都在預算內', async () => {
		const e = new Editor(graph(60));
		const el = await mount(e);
		const lod = () => hooks()!.lod()!;
		// 拉遠：所有可見節點都是遠景點
		await wheel(el, 400, 40);
		await expect
			.poll(() => {
				const s = lod();
				return [s.detail, s.localEdges, s.labels, s.baseNodes === s.visibleNodes];
			})
			.toEqual([0, 0, 0, true]);
		// 拉近：有節點升級成細節；遠景點與細節互斥（同一節點不重畫）
		await wheel(el, -400, 60);
		await expect.poll(() => lod().detail, { timeout: 10_000 }).toBeGreaterThan(0);
		const s = lod();
		expect(s.baseNodes + s.detail).toBe(s.visibleNodes);
		expect(s.detail).toBeLessThanOrEqual(s.config.maxDetail);
		expect(s.localEdges).toBeLessThanOrEqual(s.config.maxLocalEdges);
		expect(s.labels).toBeLessThanOrEqual(s.config.maxLabels);
	});
});
