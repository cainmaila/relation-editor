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
	loseContext(): void;
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
async function drag(page: Page) {
	const box = (await page.locator('main canvas').first().boundingBox())!;
	const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 160, y + 60, { steps: 10 });
	await page.mouse.up();
	// TrackballControls 有慣性：等相機停下再讀姿態
	let prev = '';
	await expect
		.poll(
			async () => {
				// 阻尼是漸近收斂：取到整數單位
				const now = JSON.stringify(await gv(page, (h) => h.pose()), (_, v) =>
					typeof v === 'number' ? Math.round(v) : v
				);
				const still = now === prev;
				prev = now;
				return still;
			},
			{ timeout: 45_000, intervals: [500] }
		)
		.toBe(true);
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
		const pose = await gv(page, (h) => h.pose());
		await tab(page, 'edit').click();
		await toGraph(page);
		expectPose(await gv(page, (h) => h.pose()), pose);
		expect(await gv(page, (h) => h.workerStarts())).toBe(1);
	});

	test('全景只移相機，和重新整理版面不同', async ({ page }) => {
		await expect.poll(() => phase(page), { timeout: 60_000 }).toBe('done');
		await drag(page);
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
			await page.goto(URL);
			await marked(page, 'camera:interactive');
			if (touch) await drag(page);
			const pose = await gv(page, (h) => h.pose());
			await marked(page, 'layout:worker-done');
			// 自動入鏡是 600ms 動畫
			await page.waitForTimeout(1_000);
			const after = await gv(page, (h) => h.pose());
			await page.close();
			return { pose, after };
		};
		const [touched, untouched] = await Promise.all([run(true), run(false)]);
		expectPose(touched.after, touched.pose);
		expect(untouched.after.position).not.toEqual(untouched.pose.position);
	});
});
