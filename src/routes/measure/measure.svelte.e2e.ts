// P1 量測入口：大圖只在 /measure 載入；layout／相機各有獨立 marker，不以 DOM mounted 當可操作
// P5：首幀＝決定性種子座標，相機可操作早於版面整理完成
import { expect, test } from '@playwright/test';

type Hook = {
	marks: { name: string; t: number }[];
	stats: { nodes: number; edges: number; maxDegree: number; components: number };
};

test('預設首頁仍是 mock，沒有量測探針', async ({ page }) => {
	await page.goto('/');
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as unknown as { __graphView?: { nodeCount(): number } }).__graphView?.nodeCount()
			)
		)
		.toBe(2066);
	expect(await page.evaluate(() => '__measure' in window)).toBe(false);
});

test('/measure 載入 10k／20k：種子座標先畫、相機先可操作，版面在背景整理完成', async ({ page }) => {
	await page.goto('/measure?edges=20000&seed=1');
	const marked = (name: string) =>
		page.waitForFunction(
			(n) => (window as unknown as { __measure?: Hook }).__measure?.marks.some((m) => m.name === n),
			name,
			{ timeout: 80_000 }
		);
	await marked('camera:interactive');
	// 相機可操作時版面還沒整理完（P1：整理約需 9–10 秒），不必等它
	const early = await page.evaluate(() =>
		(window as unknown as { __graphView: { layout(): { phase: string } } }).__graphView.layout()
	);
	expect(early.phase).toBe('running');
	await marked('layout:worker-done');
	const h = await page.evaluate(() => (window as unknown as { __measure: Hook }).__measure);
	expect(h.stats).toMatchObject({ nodes: 10_000, edges: 20_000, components: 21 });
	expect(h.stats.maxDegree).toBeGreaterThanOrEqual(1000);
	const t = (n: string) => h.marks.find((m) => m.name === n)!.t;
	const order = [
		'app:mounted',
		'graph:init',
		'universe:first-frame',
		'camera:interactive',
		'layout:start',
		'layout:worker-done'
	];
	for (let i = 1; i < order.length; i++) expect(t(order[i])).toBeGreaterThan(t(order[i - 1]));
	expect(h.marks.filter((m) => m.name === 'layout:progress').length).toBeGreaterThan(0);
	expect(h.marks.filter((m) => m.name === 'layout:start')).toHaveLength(1);
	expect(
		await page.evaluate(() =>
			(window as unknown as { __graphView: { nodeCount(): number } }).__graphView.nodeCount()
		)
	).toBe(10_000);
});

// QA fix：不支援的大小／參數要立即顯示錯誤，不靜默改值、不卡主執行緒、不掛 App
for (const query of [
	'nodes=Infinity',
	'nodes=NaN',
	'nodes=10000.5',
	'nodes=1e4',
	'nodes=100',
	'nodes=50001&edges=100000',
	'edges=100',
	'edges=100001',
	'edges=Infinity',
	'seed=-1',
	'init=bogus'
])
	test(`/measure?${query} 立即顯示錯誤`, async ({ page }) => {
		await page.goto(`/measure?${query}`);
		await expect(page.getByRole('alert')).toContainText('不支援的量測參數', { timeout: 5_000 });
		const h = await page.evaluate(
			() => (window as unknown as { __measure?: { error?: string } }).__measure
		);
		expect(h?.error).toBeTruthy();
		expect(await page.locator('canvas').count()).toBe(0);
	});
