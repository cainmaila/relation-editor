// P1 量測入口：大圖只在 /measure 載入；layout／相機各有獨立 marker，不以 DOM mounted 當可操作
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

test('/measure 載入 10k／20k 代表性圖，marker 依序出現', async ({ page }) => {
	await page.goto('/measure?edges=20000&seed=1');
	await page.waitForFunction(
		() =>
			(window as unknown as { __measure?: Hook }).__measure?.marks.some(
				(m) => m.name === 'camera:interactive'
			),
		null,
		{ timeout: 80_000 }
	);
	const h = await page.evaluate(() => (window as unknown as { __measure: Hook }).__measure);
	expect(h.stats).toMatchObject({ nodes: 10_000, edges: 20_000, components: 21 });
	expect(h.stats.maxDegree).toBeGreaterThanOrEqual(1000);
	const t = (n: string) => h.marks.find((m) => m.name === n)!.t;
	const order = [
		'app:mounted',
		'layout:start',
		'layout:worker-done',
		'layout:ready',
		'camera:interactive'
	];
	for (let i = 1; i < order.length; i++) expect(t(order[i])).toBeGreaterThan(t(order[i - 1]));
	expect(
		await page.evaluate(() =>
			(window as unknown as { __graphView: { nodeCount(): number } }).__graphView.nodeCount()
		)
	).toBe(10_000);
});
