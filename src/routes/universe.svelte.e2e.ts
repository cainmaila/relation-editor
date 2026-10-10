// P5 穩定座標與非阻塞宇宙：首幀用種子座標、版面在背景分段整理，
// 篩選／選取／搜尋／切頁不重啟版面；只有「重新整理版面」會重新整理；相機姿態跨重掛保留。
import { expect, test, type Page } from '@playwright/test';

type Pose = {
	position: { x: number; y: number; z: number };
	target: { x: number; y: number; z: number };
};
type Status = { phase: string; tick: number; budget: number; stale: boolean; reason?: string };
type Hook = {
	ready: boolean;
	selected(): string | null;
	nodeCount(): number;
	layout(): Status;
	workerStarts(): number;
	version(): number;
	position(id: string): [number, number, number] | undefined;
	pose(): Pose;
	fits(): Fit[];
	autoFit(): boolean;
	loseContext(): void;
	lod(): Lod | null;
	detailIds(): string[];
	localEdgeIds(): string[];
	highlightEdgeIds(): string[];
	labels(): { id: string; x: number; y: number; w: number; h: number }[];
	project(id: string): Pt | null;
	projectAll(): Pt[];
	render(): { calls: number; points: number; triangles: number; lines: number };
};
type Pt = { id: string; x: number; y: number; depth: number; px: number };
type Lod = {
	visibleNodes: number;
	baseNodes: number;
	detail: number;
	detailOmitted: number;
	localEdges: number;
	localEdgesOmitted: number;
	highlightTotal: number;
	highlightDrawn: number;
	highlightOmitted: number;
	highlightHidden: number;
	labels: number;
	labelsOmitted: number;
	config: {
		maxDetail: number;
		maxLocalEdges: number;
		maxHighlightEdges: number;
		maxLabels: number;
		pickTolerancePx: number;
		nodeRadius: number;
	};
};
const gv = <T>(page: Page, f: (h: Hook) => T) =>
	page.evaluate(
		(src) =>
			new Function('h', `return (${src})(h)`)(
				(window as unknown as { __graphView: Hook }).__graphView
			),
		f.toString()
	) as Promise<T>;
const ready = (page: Page) =>
	expect
		.poll(
			() =>
				page.evaluate(
					() => (window as unknown as { __graphView?: Hook }).__graphView?.ready ?? false
				),
			{
				timeout: 60_000
			}
		)
		.toBe(true);
const phase = (page: Page) => gv(page, (h) => h.layout().phase);
const badge = (page: Page) => page.getByRole('group', { name: '版面狀態' });
const tab = (page: Page, p: 'graph' | 'edit') =>
	page
		.getByRole('group', { name: '畫面' })
		.getByRole('button', { name: p === 'graph' ? '全圖' : /^編輯頁/ });
async function toGraph(page: Page) {
	await tab(page, 'graph').click();
	await ready(page);
}
type Fit = { ids: number; ms: number; phase: string };
/** 真實滑鼠拖曳（經 TrackballControls 的 pointer 事件） */
async function drag(page: Page) {
	const box = (await page.locator('main canvas').first().boundingBox())!;
	const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 160, y + 60, { steps: 3 });
	await page.mouse.up();
}
/**
 * TrackballControls 有慣性（每次 update 衰減 √0.8）。以「動畫幀」判斷停止，不用牆鐘取樣：
 * 負載高時一秒可能不到一幀，隔 500ms 的兩次取樣會誤判為靜止。
 * 連續 10 幀每幀位移 < 1e-3 → 之後剩餘位移的幾何級數總和 < 0.01 單位。
 */
async function settle(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const h = (window as unknown as { __graphView: { pose(): Pose } }).__graphView;
				const flat = (p: Pose) => [
					p.position.x,
					p.position.y,
					p.position.z,
					p.target.x,
					p.target.y,
					p.target.z
				];
				let prev = flat(h.pose());
				let still = 0;
				let frames = 0;
				const step = () => {
					const now = flat(h.pose());
					const d = Math.max(...now.map((v, i) => Math.abs(v - prev[i])));
					prev = now;
					still = d < 1e-3 ? still + 1 : 0;
					if (still >= 10) resolve();
					else if (++frames > 5_000) reject(new Error(`相機 ${frames} 幀後仍在動：${d}`));
					else requestAnimationFrame(step);
				};
				requestAnimationFrame(step);
			})
	);
}
const expectPose = (a: Pose, b: Pose) => {
	for (const k of ['position', 'target'] as const)
		for (const c of ['x', 'y', 'z'] as const) expect(Math.abs(a[k][c] - b[k][c])).toBeLessThan(2);
};
const marked = (page: Page, name: string) =>
	page.waitForFunction(
		(n) =>
			(window as unknown as { __measure?: { marks: { name: string }[] } }).__measure?.marks.some(
				(m) => m.name === n
			),
		name,
		{ timeout: 80_000 }
	);

test.describe('正式 mock（2,066 節點）', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await ready(page);
	});

	test('首幀即可操作；背景整理到預算後凍結，狀態列誠實標示', async ({ page }) => {
		expect(await gv(page, (h) => h.workerStarts())).toBe(1);
		await expect.poll(() => phase(page), { timeout: 60_000 }).toBe('done');
		await expect(badge(page)).toContainText('版面已凍結');
		await expect(badge(page).getByRole('button', { name: '重新整理版面' })).toBeVisible();
		const p = await gv(page, (h) => h.position('Core Switch-1'));
		expect(p!.every(Number.isFinite)).toBe(true);
	});

	test('篩選、選取、搜尋、全景、切頁都不重啟版面、不動座標', async ({ page }) => {
		await expect.poll(() => phase(page), { timeout: 60_000 }).toBe('done');
		const before = await gv(page, (h) => [h.version(), h.position('Core Switch-1')]);
		await page.getByRole('checkbox', { name: '網路' }).click({ modifiers: ['Alt'] });
		await expect.poll(() => gv(page, (h) => h.nodeCount())).toBe(346);
		await page.getByRole('checkbox', { name: '網路' }).click({ modifiers: ['Alt'] });
		await page.keyboard.press('ControlOrMeta+k');
		await page.getByRole('textbox', { name: '搜尋節點' }).fill('機櫃 A-03');
		await page.keyboard.press('Enter');
		await expect.poll(() => gv(page, (h) => h.selected())).toBe('機櫃 A-03');
		await badge(page).getByRole('button', { name: '全景' }).click();
		await tab(page, 'edit').click();
		await toGraph(page);
		expect(await gv(page, (h) => h.workerStarts())).toBe(1);
		expect(await phase(page)).toBe('done');
		expect(await gv(page, (h) => [h.version(), h.position('Core Switch-1')])).toEqual(before);
	});

	test('切頁後返回：相機與控制目標保留，不自動重新整理', async ({ page }) => {
		await expect.poll(() => phase(page), { timeout: 60_000 }).toBe('done');
		await drag(page);
		await settle(page);
		const pose = await gv(page, (h) => h.pose());
		await tab(page, 'edit').click();
		await toGraph(page);
		expectPose(await gv(page, (h) => h.pose()), pose);
		expect(await gv(page, (h) => h.workerStarts())).toBe(1);
	});

	test('全景只移相機，和重新整理版面不同', async ({ page }) => {
		await expect.poll(() => phase(page), { timeout: 60_000 }).toBe('done');
		await drag(page);
		await settle(page);
		const moved = await gv(page, (h) => h.pose());
		const v = await gv(page, (h) => h.version());
		await badge(page).getByRole('button', { name: '全景' }).click();
		await expect
			.poll(async () => (await gv(page, (h) => h.pose())).position)
			.not.toEqual(moved.position);
		expect(await gv(page, (h) => [h.workerStarts(), h.version()])).toEqual([1, v]);
		await badge(page).getByRole('button', { name: '重新整理版面' }).click();
		expect(await gv(page, (h) => h.workerStarts())).toBe(2);
		await expect.poll(() => phase(page), { timeout: 60_000 }).toBe('done');
	});

	test('編輯頁新增節點：回全圖有座標、既有座標不動，不自動整理，標示資料已變更', async ({
		page
	}) => {
		await expect.poll(() => phase(page), { timeout: 60_000 }).toBe('done');
		const core = await gv(page, (h) => h.position('Core Switch-1'));
		await tab(page, 'edit').click();
		const pane = page.locator('.svelte-flow__pane');
		await expect(pane).toBeVisible();
		await pane.click({ button: 'right', position: { x: 5, y: 5 } });
		const menu = page.getByRole('menu').first();
		await menu.getByRole('menuitem', { name: '新增節點' }).hover();
		await menu.getByRole('menuitem', { name: 'CCTV' }).hover();
		await menu.getByRole('menuitem', { name: '攝影機' }).click();
		await expect(page.locator('.svelte-flow__node-graph')).toHaveCount(1);
		await toGraph(page);
		const id = await page.evaluate(
			() => (window as unknown as { __graphView: Hook }).__graphView.selected() ?? ''
		);
		expect(await gv(page, (h) => h.nodeCount())).toBe(2067);
		expect(await gv(page, (h) => h.position('Core Switch-1'))).toEqual(core);
		const p = await page.evaluate(
			(x) => (window as unknown as { __graphView: Hook }).__graphView.position(x),
			id
		);
		expect(p?.every(Number.isFinite)).toBe(true);
		expect(await gv(page, (h) => [h.workerStarts(), h.layout().stale])).toEqual([1, true]);
		await expect(badge(page)).toContainText('資料已變更，版面未重整');
	});

	test('WebGL context lost：明確錯誤與重試，搜尋仍可用', async ({ page }) => {
		await gv(page, (h) => h.loseContext());
		const alert = page.getByRole('alert').filter({ hasText: 'WebGL context lost' });
		await expect(alert).toBeVisible();
		await expect(alert).toContainText('搜尋與編輯仍可使用');
		await page.keyboard.press('ControlOrMeta+k');
		await page.getByRole('textbox', { name: '搜尋節點' }).fill('機櫃 A-03');
		await page.keyboard.press('Enter');
		await expect(
			page.getByRole('complementary', { name: '詳情' }).getByLabel('名稱', { exact: true })
		).toHaveValue('機櫃 A-03');
		await alert.getByRole('button', { name: '重試' }).click();
		await expect(alert).toHaveCount(0);
		await ready(page);
		expect(await gv(page, (h) => h.nodeCount())).toBe(2066);
	});
});

test.describe('代表性大圖（10k／20k）', () => {
	const URL = '/measure?edges=20000&seed=1';

	test('停止後座標不再變；重新整理版面才再啟動，整理中搜尋、選取可用', async ({ page }) => {
		await page.goto(URL);
		await marked(page, 'camera:interactive');
		expect(await phase(page)).toBe('running');
		await badge(page).getByRole('button', { name: '停止' }).click();
		expect(await phase(page)).toBe('stopped');
		await expect(badge(page)).toContainText('已停止整理');
		const v = await gv(page, (h) => h.version());
		await page.waitForTimeout(1_000);
		expect(await gv(page, (h) => [h.version(), h.workerStarts()])).toEqual([v, 1]);
		// 重新整理版面：從目前座標再跑一次完整預算（P1：10k 約 9–10 秒）
		await badge(page).getByRole('button', { name: '重新整理版面' }).click();
		expect(await gv(page, (h) => [h.layout().phase, h.workerStarts()])).toEqual(['running', 2]);
		await page.keyboard.press('ControlOrMeta+k');
		await page.getByRole('textbox', { name: '搜尋節點' }).fill('ToR Switch C-07');
		await page.keyboard.press('Enter');
		await expect.poll(() => gv(page, (h) => h.selected())).not.toBeNull();
		await expect(
			page.getByRole('complementary', { name: '詳情' }).getByLabel('名稱', { exact: true })
		).toHaveValue(/C-07/);
		// 搜尋完成時背景整理仍在進行（沒有被版面卡住）
		expect(await phase(page)).toBe('running');
	});

	test('整理中切頁：停止並標示，返回立即用最新座標、不自動重試', async ({ page }) => {
		await page.goto(URL);
		await marked(page, 'camera:interactive');
		await tab(page, 'edit').click();
		await toGraph(page);
		expect(await gv(page, (h) => [h.layout().phase, h.layout().reason, h.workerStarts()])).toEqual([
			'stopped',
			'detached',
			1
		]);
		await expect(badge(page)).toContainText('離開畫面時已停止整理');
	});

	test('使用者拖曳後，初始整理完成不再搶走相機；沒動過才自動入鏡', async ({ browser }) => {
		const run = async (touch: boolean) => {
			const page = await browser.newPage();
			// 擋住 layout Worker 腳本：初始整理已送出（running）但在放行前不可能完成，
			// 拖曳與取樣一定早於 done，不受平行負載影響。
			let release!: () => void;
			const gate = new Promise<void>((r) => (release = r));
			let held = false;
			await page.route('**/layout.worker-*.js', async (route) => {
				held = true;
				await gate;
				await route.continue();
			});
			await page.goto(URL);
			await marked(page, 'camera:interactive');
			await expect.poll(() => held).toBe(true);
			await expect.poll(() => phase(page)).toBe('running');
			// 首幀只做過一次瞬間整體入鏡
			expect(await gv(page, (h) => [h.autoFit(), h.fits()])).toEqual([
				true,
				[{ ids: 0, ms: 0, phase: 'seed' }]
			]);
			if (touch) {
				await drag(page);
				// 真實 pointer 輸入已讓 runtime 取消晚到的入鏡，且版面仍在整理
				expect(await gv(page, (h) => [h.layout().phase, h.autoFit()])).toEqual(['running', false]);
			}
			const before = await gv(page, (h) => ({ phase: h.layout().phase, pose: h.pose() }));
			expect(before.phase).toBe('running');
			release();
			await marked(page, 'layout:worker-done');
			expect(await phase(page)).toBe('done');
			// done 同步結算入鏡：此時的呼叫紀錄就是最終結果
			const fits = await gv(page, (h) => h.fits());
			let after: Pose | null = null;
			if (!touch) {
				// 600ms 的入鏡動畫實際移動了相機
				await expect
					.poll(async () => (await gv(page, (h) => h.pose())).position)
					.not.toEqual(before.pose.position);
				after = await gv(page, (h) => h.pose());
			}
			await page.close();
			return { fits, before, after };
		};
		const [touched, untouched] = await Promise.all([run(true), run(false)]);
		expect(touched.fits).toEqual([{ ids: 0, ms: 0, phase: 'seed' }]);
		expect(untouched.fits).toEqual([
			{ ids: 0, ms: 0, phase: 'seed' },
			{ ids: 0, ms: 600, phase: 'done' }
		]);
		expect(untouched.after!.position).not.toEqual(untouched.before.pose.position);
	});
});

// P6：分層批次繪製、逐點投影 LOD 與可靠點選。一律用真實滑鼠（page.mouse）點／拖／滾輪，
// 座標由 __graphView.project() 換算（只讀），不用相機 setter 取代操作。
/** 等幾個動畫幀（含標籤節流後的全量 pass） */
const frames = (page: Page, n = 12) =>
	page.evaluate(
		(k) =>
			new Promise<void>((r) => {
				let i = 0;
				const f = () => (++i >= k ? r() : requestAnimationFrame(f));
				requestAnimationFrame(f);
			}),
		n
	);
const lod = async (page: Page) => (await gv(page, (h) => h.lod()))!;
const projectOf = (page: Page, id: string) =>
	page.evaluate((x) => (window as unknown as { __graphView: Hook }).__graphView.project(x), id);
/** 只留滑鼠真的會落在畫布上的點（排除圖例、狀態列等浮層蓋住的位置） */
const onCanvas = (page: Page, pts: Pt[]) =>
	page.evaluate(
		(ps) =>
			ps.filter((p) => {
				const el = document.elementFromPoint(p.x, p.y);
				if (!(el instanceof HTMLCanvasElement)) return false;
				// 四周 12px 也要是畫布（避開浮層邊緣）
				return [
					[-12, 0],
					[12, 0],
					[0, -12],
					[0, 12]
				].every(([dx, dy]) => document.elementFromPoint(p.x + dx, p.y + dy) === el);
			}),
		pts
	);
/** 與 lod.pick 相同規則的預期結果：容差／投影半徑內取深度最小，再比螢幕距離 */
const expected = (pts: Pt[], x: number, y: number, tol: number) =>
	pts
		.filter((p) => Math.hypot(p.x - x, p.y - y) <= Math.max(tol, p.px))
		.sort(
			(a, b) => a.depth - b.depth || Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y)
		)[0]?.id ?? null;
/** 點下去「應該」就是自己、且周圍 gap px 內沒有別的點（避免次像素平手） */
const clean =
	(pts: Pt[], tol: number, gap = 1) =>
	(p: Pt) =>
		expected(pts, p.x, p.y, tol) === p.id &&
		pts.every((q) => q.id === p.id || Math.hypot(q.x - p.x, q.y - p.y) > gap);

test.describe('P6 LOD 與點選（正式 mock）', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await ready(page);
		await expect.poll(() => phase(page), { timeout: 60_000 }).toBe('done');
		await settle(page);
		await frames(page);
	});

	test('遠景：所有可見節點都是點、各層在預算內、標籤不重疊；圖例有系統數與 LOD 省略數', async ({
		page
	}) => {
		const s = await lod(page);
		expect(s.visibleNodes).toBe(2066);
		// 遠景點與細節互斥（升級的節點不重畫點）
		expect(s.baseNodes + s.detail).toBe(s.visibleNodes);
		expect(s.detail).toBeLessThanOrEqual(s.config.maxDetail);
		expect(s.localEdges).toBeLessThanOrEqual(s.config.maxLocalEdges);
		expect(s.labels).toBeLessThanOrEqual(s.config.maxLabels);
		const labels = await gv(page, (h) => h.labels());
		for (let i = 0; i < labels.length; i++)
			for (let j = i + 1; j < labels.length; j++) {
				const [a, b] = [labels[i], labels[j]];
				const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
				expect(overlap, `${a.id} × ${b.id}`).toBe(false);
			}
		const legend = page.getByRole('region', { name: '宇宙圖例' });
		await expect(legend.getByRole('list', { name: '系統' })).toContainText('電力 672');
		await expect(legend).toContainText('遠景點');
		await expect(legend).toContainText(`近景節點 ${s.detail.toLocaleString('en-US')}`);
		await expect(legend).toContainText('名稱標籤');
	});

	test('遠處的點（未升級細節）用真實滑鼠也點得到；選取一定有標籤；點空白取消', async ({ page }) => {
		const s = await lod(page);
		const detail = new Set(await gv(page, (h) => h.detailIds()));
		const pts = await gv(page, (h) => h.projectAll());
		const far = (
			await onCanvas(
				page,
				pts.filter((p) => !detail.has(p.id) && p.px < 4)
			)
		).find(clean(pts, s.config.pickTolerancePx));
		expect(far, '找不到可點的遠景點').toBeTruthy();
		await page.mouse.click(far!.x, far!.y);
		await expect.poll(() => gv(page, (h) => h.selected())).toBe(far!.id);
		await frames(page);
		expect((await gv(page, (h) => h.labels())).map((l) => l.id)).toContain(far!.id);
		expect(await gv(page, (h) => h.detailIds())).toContain(far!.id);
		const box = (await page.locator('main canvas').first().boundingBox())!;
		await page.mouse.click(box.x + 3, box.y + 3);
		await expect.poll(() => gv(page, (h) => h.selected())).toBe(null);
	});

	test('滾輪拉近：逐點升級細節，近處點選正確；局部連線兩端都是細節、都在預算內', async ({
		page
	}) => {
		const box = (await page.locator('main canvas').first().boundingBox())!;
		const before = (await lod(page)).detail;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -300);
		await settle(page);
		await frames(page);
		const s = await lod(page);
		expect(s.detail).toBeGreaterThan(before);
		expect(s.detail).toBeLessThanOrEqual(s.config.maxDetail);
		expect(s.localEdges).toBeLessThanOrEqual(s.config.maxLocalEdges);
		expect(s.labels).toBeLessThanOrEqual(s.config.maxLabels);
		expect(s.baseNodes + s.detail).toBe(s.visibleNodes);
		const detail = new Set(await gv(page, (h) => h.detailIds()));
		const pts = await gv(page, (h) => h.projectAll());
		const near = (
			await onCanvas(
				page,
				pts.filter((p) => detail.has(p.id) && p.px >= 6)
			)
		).find(clean(pts, s.config.pickTolerancePx));
		expect(near, '拉近後應有可點的細節節點').toBeTruthy();
		await page.mouse.click(near!.x, near!.y);
		await expect.poll(() => gv(page, (h) => h.selected())).toBe(near!.id);
	});

	test('重疊的點：真實點擊取最近（深度最小）的節點', async ({ page }) => {
		const tol = (await lod(page)).config.pickTolerancePx;
		const all = await gv(page, (h) => h.projectAll());
		const pts = await onCanvas(page, all);
		let found: { far: Pt; near: Pt } | null = null;
		const sorted = [...pts].sort((a, b) => a.x - b.x);
		for (let i = 0; i < sorted.length && !found; i++)
			for (let j = i + 1; j < sorted.length && sorted[j].x - sorted[i].x < 3; j++) {
				const [a, b] = [sorted[i], sorted[j]];
				if (Math.hypot(a.x - b.x, a.y - b.y) < 3 && Math.abs(a.depth - b.depth) > 1) {
					found = a.depth > b.depth ? { far: a, near: b } : { far: b, near: a };
					break;
				}
			}
		expect(found, '找不到重疊的點對').toBeTruthy();
		const want = expected(all, found!.far.x, found!.far.y, tol);
		expect(want).not.toBe(found!.far.id);
		await page.mouse.click(found!.far.x, found!.far.y);
		await expect.poll(() => gv(page, (h) => h.selected())).toBe(want);
	});

	test('拖曳相機不算點擊：按在節點上拖動放開，選取不變', async ({ page }) => {
		const tol = (await lod(page)).config.pickTolerancePx;
		const pts = await gv(page, (h) => h.projectAll());
		const p = (await onCanvas(page, pts)).find(clean(pts, tol, 4))!;
		expect(p).toBeTruthy();
		const pose = await gv(page, (h) => h.pose());
		await page.mouse.move(p.x, p.y);
		await page.mouse.down();
		await page.mouse.move(p.x + 80, p.y + 30, { steps: 4 });
		await page.mouse.up();
		await settle(page);
		expect(await gv(page, (h) => h.selected())).toBe(null);
		expect((await gv(page, (h) => h.pose())).position).not.toEqual(pose.position);
	});

	test('隱藏系統的節點點不到；搜尋隱藏系統的節點會自動勾回並選取', async ({ page }) => {
		const all = await gv(page, (h) => h.projectAll());
		const pose = await gv(page, (h) => h.pose());
		await page.getByRole('checkbox', { name: '網路' }).click({ modifiers: ['Alt'] });
		await expect.poll(() => gv(page, (h) => h.nodeCount())).toBe(346);
		await frames(page);
		expect(await gv(page, (h) => h.pose())).toEqual(pose);
		const shown = await gv(page, (h) => h.projectAll());
		const vis = new Set(shown.map((p) => p.id));
		const hidden = (await onCanvas(page, all)).find(
			(p) => !vis.has(p.id) && shown.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 24)
		);
		expect(hidden, '找不到被隱藏、周圍無可見點的節點').toBeTruthy();
		expect(await projectOf(page, hidden!.id)).toBe(null);
		await page.mouse.click(hidden!.x, hidden!.y);
		await frames(page);
		expect(await gv(page, (h) => h.selected())).toBe(null);
		// 既有 reveal：搜尋隱藏系統的節點，自動勾回並選取
		await page.keyboard.press('ControlOrMeta+k');
		await page.getByRole('textbox', { name: '搜尋節點' }).fill(hidden!.id);
		await page.keyboard.press('Enter');
		await expect.poll(() => gv(page, (h) => h.selected())).toBe(hidden!.id);
		await expect.poll(() => projectOf(page, hidden!.id)).not.toBe(null);
	});

	test('高亮邊誠實計數：總數＝已畫＋省略＋系統隱藏，已畫不超過上限', async ({ page }) => {
		await page.keyboard.press('ControlOrMeta+k');
		await page.getByRole('textbox', { name: '搜尋節點' }).fill('台電市電');
		await page.keyboard.press('Enter');
		await expect.poll(() => gv(page, (h) => h.selected())).toBe('台電市電');
		await page.keyboard.press('f');
		await expect(page.getByRole('region', { name: '找客戶結果' })).toBeVisible();
		await frames(page);
		const s = await lod(page);
		expect(s.highlightTotal).toBeGreaterThan(s.config.maxHighlightEdges);
		expect(s.highlightDrawn).toBe(s.config.maxHighlightEdges);
		expect(s.highlightDrawn + s.highlightOmitted + s.highlightHidden).toBe(s.highlightTotal);
		expect((await gv(page, (h) => h.highlightEdgeIds())).length).toBe(s.highlightDrawn);
		expect(s.detail).toBeLessThanOrEqual(s.config.maxDetail);
		const legend = page.getByRole('region', { name: '宇宙圖例' });
		await expect(legend).toContainText(`共 ${s.highlightTotal.toLocaleString('en-US')}`);
		await expect(legend).toContainText(`已畫 ${s.highlightDrawn.toLocaleString('en-US')}`);
	});
});
