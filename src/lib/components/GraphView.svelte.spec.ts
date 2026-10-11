// P6 整合：真 Chromium WebGL 掛上 GraphView，驗證「改名只刷新標籤、不重排版面」與
// 「相機（滾輪）改變時逐點投影 LOD：拉近升級細節、拉遠只剩點」，並且預算不超過上限。
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { Editor } from '#lib/editor.svelte.js';
import GraphView from './GraphView.svelte';
// HUD 版面斷言需要真的 Tailwind 樣式
import '../../routes/layout.css';

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
	labels(): { id: string; w: number }[];
	detailIds(): string[];
	project(id: string): { x: number; y: number; px: number } | null;
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

async function mount(e: Editor, w = 800, h = 600) {
	host = document.createElement('div');
	host.style.cssText = `position:fixed;left:0;top:0;width:${w}px;height:${h}px`;
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

/** 畫面上看得到的標籤 DOM（id、寬、字、是否選取樣式） */
const domLabels = (el: HTMLElement) =>
	[...el.querySelectorAll<HTMLElement>('.universe-label')]
		.filter((l) => l.style.display !== 'none')
		.map((l) => ({
			id: l.dataset.id,
			w: parseFloat(l.style.width),
			text: l.textContent,
			sel: l.style.outline !== 'none' || l.style.fontWeight === '600'
		}));
/** 一幀之後（labels 寫入 DOM 在 render 前） */
const frames = async (n = 3) => {
	for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
};
/** DOM 與目前 frame 的標籤完全一致：同一組 id、同寬，沒有殘留 */
async function expectDomMatchesFrame(el: HTMLElement) {
	await frames();
	const want = hooks()!
		.labels()
		.map((l) => `${l.id}:${l.w}`)
		.sort();
	const got = domLabels(el)
		.map((l) => `${l.id}:${l.w}`)
		.sort();
	expect(got).toEqual(want);
}

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

	it('改名刷新後標籤變少：沒有殘留可見標籤，DOM 與 frame 一致（含寬度）', async () => {
		const e = new Editor(graph(4));
		const el = await mount(e);
		e.select({ kind: 'node', id: 'n1' });
		await expect.poll(() => labelText(el)).toContain('節點1');
		// 拉遠：只剩選取與相鄰（高亮）節點有標籤（相鄰的可能被避碰擠掉）
		await wheel(el, 400, 40);
		await expect
			.poll(() => {
				const ids = hooks()!
					.labels()
					.map((l) => l.id);
				return ids.includes('n1') && !ids.includes('n3');
			})
			.toBe(true);
		await expectDomMatchesFrame(el);
		// 同一個 tick：改名（刷新標籤池）＋取消選取（標籤變 0）
		e.updateNode('n1', { name: '很長很長很長的新名字' });
		e.select(null);
		await expect.poll(() => hooks()!.labels().length).toBe(0);
		await expectDomMatchesFrame(el);
		expect(domLabels(el)).toEqual([]);
		// 再選回：新名字、新寬度
		e.select({ kind: 'node', id: 'n1' });
		await expect.poll(() => labelText(el)).toContain('很長很長很長的新名字');
		await expectDomMatchesFrame(el);
	});

	it('選取改變而標籤留在同一個池位：選取樣式也跟著更新', async () => {
		const e = new Editor(graph(4));
		const el = await mount(e);
		await expect.poll(() => hooks()!.labels().length).toBeGreaterThan(1);
		// 選最大的那個（取消選取後它仍排第一，池位不變）
		const ids = hooks()!
			.labels()
			.map((l) => l.id);
		const big = ids.reduce((a, b) => (hooks()!.project(b)!.px > hooks()!.project(a)!.px ? b : a));
		e.select({ kind: 'node', id: big });
		await expect
			.poll(() =>
				domLabels(el)
					.filter((l) => l.sel)
					.map((l) => l.id)
			)
			.toEqual([big]);
		e.select(null);
		await expect.poll(() => hooks()!.labels().length).toBeGreaterThan(1);
		await frames();
		expect(domLabels(el).filter((l) => l.sel)).toEqual([]);
		await expectDomMatchesFrame(el);
	});

	it('點選用放開時的精確（小數）座標，不用 click 事件被截成整數的座標', async () => {
		// Chrome 的 click 事件 clientX/Y 會截成整數，pointerup 保留小數；重疊小點時差 1px 就換人
		const e = new Editor(graph(4));
		const el = await mount(e);
		const canvas = el.querySelector('canvas')!;
		const p = hooks()!.project('n1')!;
		const init = (type: string, x: number, y: number, extra: PointerEventInit = {}) =>
			new PointerEvent(type, {
				pointerId: 1,
				pointerType: 'mouse',
				isPrimary: true,
				clientX: x,
				clientY: y,
				button: 0,
				bubbles: true,
				cancelable: true,
				composed: true,
				...extra
			});
		canvas.dispatchEvent(init('pointerdown', p.x, p.y, { buttons: 1 }));
		canvas.dispatchEvent(init('pointerup', p.x, p.y, { buttons: 0 }));
		// click 的座標刻意偏離到空白處（模擬截斷造成的偏差，放大到必然失準）
		canvas.dispatchEvent(init('click', 1, 1));
		await expect.poll(() => e.selected).toEqual({ kind: 'node', id: 'n1' });
	});

	for (const end of ['pointercancel', 'pointerup-outside'] as const)
		it(`按下後 ${end}：放棄的手勢不會永久關掉滑過`, async () => {
			const e = new Editor(graph(4));
			const el = await mount(e);
			const canvas = el.querySelector('canvas')!;
			const p = hooks()!.project('n1')!;
			const ev = (type: string, init: PointerEventInit = {}) =>
				new PointerEvent(type, {
					pointerId: 1,
					pointerType: 'mouse',
					isPrimary: true,
					clientX: p.x,
					clientY: p.y,
					bubbles: true,
					cancelable: true,
					composed: true,
					...init
				});
			canvas.dispatchEvent(ev('pointerdown', { button: 0, buttons: 1 }));
			if (end === 'pointercancel') canvas.dispatchEvent(ev('pointercancel'));
			else document.body.dispatchEvent(ev('pointerup', { button: 0, buttons: 0 }));
			await frames();
			// 之後滑到節點上：要有滑過（游標變手指）
			canvas.dispatchEvent(ev('pointermove', { buttons: 0 }));
			await expect.poll(() => canvas.style.cursor).toBe('pointer');
		});
});

/** 兩個矩形是否重疊（貼邊不算） */
const overlaps = (a: DOMRect, b: DOMRect) =>
	a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const inside = (a: DOMRect, b: DOMRect) =>
	a.left >= b.left - 0.5 &&
	a.right <= b.right + 0.5 &&
	a.top >= b.top - 0.5 &&
	a.bottom <= b.bottom + 0.5;

describe('GraphView HUD 版面（圖例與狀態列不重疊）', () => {
	// 440 寬≈1024 視窗、預設側欄時的主畫面；寬度來自容器而非視窗
	for (const [w, h] of [
		[440, 420],
		[320, 360],
		[1100, 800]
	] as const)
		it(`容器 ${w}×${h}：圖例、狀態列不重疊，按鈕完整可見且單行，LOD 計數都在可視範圍`, async () => {
			const e = new Editor(graph(60));
			const el = await mount(e, w, h);
			await frames();
			const box = el.getBoundingClientRect();
			const legend = el.querySelector<HTMLElement>('[aria-label="宇宙圖例"]')!;
			const status = el.querySelector<HTMLElement>('[aria-label="版面狀態"]')!;
			const [lr, sr] = [legend.getBoundingClientRect(), status.getBoundingClientRect()];
			expect(overlaps(lr, sr), `legend ${JSON.stringify(lr)} status ${JSON.stringify(sr)}`).toBe(
				false
			);
			expect(inside(lr, box)).toBe(true);
			expect(inside(sr, box)).toBe(true);
			const buttons = [...el.querySelectorAll<HTMLElement>('button')];
			expect(buttons.length).toBeGreaterThanOrEqual(3);
			for (const b of buttons) {
				const r = b.getBoundingClientRect();
				expect(inside(r, box), b.textContent!).toBe(true);
				if (!legend.contains(b)) expect(overlaps(r, lr), b.textContent!).toBe(false);
				// 單行：不會一字一行（「全景」不換行）
				expect(r.height, b.textContent!).toBeLessThan(32);
			}
			// LOD 計數：每一列都在圖例可視範圍內（不被裁切、不被其他面板蓋住）
			const rows = [...legend.querySelectorAll<HTMLElement>('[aria-label="細節層級"] dd')];
			expect(rows.length).toBeGreaterThanOrEqual(3);
			for (const d of rows) {
				d.scrollIntoView({ block: 'nearest' });
				const r = d.getBoundingClientRect();
				expect(inside(r, legend.getBoundingClientRect()), d.textContent!).toBe(true);
				expect(overlaps(r, status.getBoundingClientRect()), d.textContent!).toBe(false);
			}
		});

	it('圖例可明確收合／展開；收合後不蓋住狀態列，按鈕標示清楚', async () => {
		const e = new Editor(graph(60));
		const el = await mount(e, 440, 420);
		const toggle = el.querySelector<HTMLButtonElement>('button[aria-controls]')!;
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(toggle.textContent).toContain('收合');
		const before = el.querySelector('[aria-label="宇宙圖例"]')!.getBoundingClientRect().height;
		toggle.click();
		await frames(2);
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(toggle.textContent).toContain('展開');
		expect(el.querySelector('[aria-label="細節層級"]')).toBeNull();
		const after = el.querySelector('[aria-label="宇宙圖例"]')!.getBoundingClientRect().height;
		expect(after).toBeLessThan(before / 2);
		toggle.click();
		await frames(2);
		expect(el.querySelector('[aria-label="細節層級"]')).not.toBeNull();
	});
});
