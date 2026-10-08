// 效能實驗（spike）：Playwright 量 Svelte Flow 渲染與互動。
// 用法：node spike/render-bench.mjs <label> "<query>"   例：node spike/render-bench.mjs big "?big=1"
// 結果寫到 spike/results/render-<label>.json（多次執行取中位數見 RUNS）。
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const [, , label = 'run', query = ''] = process.argv;
const RUNS = Number(process.env.RUNS ?? 3);
const URL = `http://localhost:5171/${query}`;

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};

// 注入頁面：記錄每個 rAF 時間戳與 long task
const INIT = () => {
	window.__frames = [];
	window.__long = [];
	const loop = (t) => {
		window.__frames.push(t);
		requestAnimationFrame(loop);
	};
	requestAnimationFrame(loop);
	try {
		new PerformanceObserver((l) => {
			for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]);
		}).observe({ type: 'longtask', buffered: true });
	} catch {
		/* longtask 不支援就略過 */
	}
};

/** 區間內的 frame 間隔統計（ms） */
function frameStats(frames, from, to) {
	const ts = frames.filter((t) => t >= from && t <= to);
	const gaps = [];
	for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
	if (!gaps.length) return { frames: 0 };
	const s = [...gaps].sort((a, b) => a - b);
	return {
		frames: gaps.length,
		p50: +s[Math.floor(s.length * 0.5)].toFixed(1),
		p95: +s[Math.floor(s.length * 0.95)].toFixed(1),
		max: +s[s.length - 1].toFixed(1),
		over50ms: gaps.filter((g) => g > 50).length
	};
}

async function oneRun(browser) {
	const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	await page.addInitScript(INIT);
	await page.goto(URL, { waitUntil: 'commit' });

	const nodeCount = () => document.querySelectorAll('.svelte-flow__node').length;
	// 1) 第一個節點進 DOM
	await page.waitForFunction(() => document.querySelectorAll('.svelte-flow__node').length > 0, null, {
		polling: 'raf',
		timeout: 120_000
	});
	const tFirst = await page.evaluate(() => performance.now());

	// 2) 穩定：節點數、邊數、視野 transform 500ms 沒變（fitView 動畫結束）
	const tSettled = await page.evaluate(
		() =>
			new Promise((res) => {
				const sig = () =>
					[
						document.querySelectorAll('.svelte-flow__node').length,
						document.querySelectorAll('.svelte-flow__edge').length,
						document.querySelector('.svelte-flow__viewport')?.style.transform
					].join('|');
				let last = sig();
				let at = performance.now();
				const f = () => {
					const s = sig();
					const now = performance.now();
					if (s !== last) ((last = s), (at = now));
					if (now - at > 500) res(at);
					else requestAnimationFrame(f);
				};
				requestAnimationFrame(f);
			})
	);
	const dom = await page.evaluate(() => ({
		nodes: document.querySelectorAll('.svelte-flow__node').length,
		edges: document.querySelectorAll('.svelte-flow__edge').length,
		allElements: document.getElementsByTagName('*').length
	}));
	const heapMB = async () => {
		const m = (await cdp.send('Performance.getMetrics')).metrics;
		return +((m.find((x) => x.name === 'JSHeapUsedSize')?.value ?? 0) / 1048576).toFixed(1);
	};
	const heapIdle = await heapMB();

	const box = await page.locator('.svelte-flow').boundingBox();
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const window_ = async (fn) => {
		const t0 = await page.evaluate(() => performance.now());
		await fn();
		await page.waitForTimeout(300);
		const t1 = await page.evaluate(() => performance.now());
		const frames = await page.evaluate(() => window.__frames);
		const lt = await page.evaluate(() => window.__long);
		const inWin = lt.filter(([s]) => s >= t0 && s <= t1);
		return {
			...frameStats(frames, t0, t1),
			longTasks: inWin.length,
			longTaskTotalMs: +inWin.reduce((a, [, d]) => a + d, 0).toFixed(0)
		};
	};

	// 3) 滾輪縮放 30 格
	await page.mouse.move(cx, cy);
	const wheel = await window_(async () => {
		for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -120);
	});
	// 4) 拖曳平移（空白處）
	const pan = await window_(async () => {
		await page.mouse.move(box.x + 60, box.y + box.height - 120);
		await page.mouse.down();
		for (let i = 0; i < 30; i++) await page.mouse.move(box.x + 60 + i * 8, box.y + box.height - 120 - i * 4);
		await page.mouse.up();
	});
	// 5) 滑過節點（觸發 hoverNode → 整張 nodes 重算）
	const targets = await page.evaluate(() =>
		[...document.querySelectorAll('.svelte-flow__node')].slice(0, 20).map((el) => {
			const r = el.getBoundingClientRect();
			return [r.x + r.width / 2, r.y + r.height / 2];
		})
	);
	const hover = await window_(async () => {
		for (const [x, y] of targets) await page.mouse.move(x, y);
	});
	const heapAfter = await heapMB();

	await page.close();
	return { tFirst, tSettled, dom, heapIdle, heapAfter, wheel, pan, hover };
}

const browser = await chromium.launch({ headless: true });
const runs = [];
for (let i = 0; i < RUNS; i++) {
	runs.push(await oneRun(browser));
	console.log(`run ${i + 1}/${RUNS} done`);
}
await browser.close();

const med = (f) => median(runs.map(f));
const summary = {
	label,
	query,
	runs: RUNS,
	domNodes: runs[0].dom.nodes,
	domEdges: runs[0].dom.edges,
	domAllElements: runs[0].dom.allElements,
	tFirstMs: Math.round(med((r) => r.tFirst)),
	tSettledMs: Math.round(med((r) => r.tSettled)),
	heapIdleMB: med((r) => r.heapIdle),
	heapAfterMB: med((r) => r.heapAfter),
	wheelP95: med((r) => r.wheel.p95 ?? 0),
	wheelMax: med((r) => r.wheel.max ?? 0),
	wheelLongTaskMs: med((r) => r.wheel.longTaskTotalMs ?? 0),
	panP95: med((r) => r.pan.p95 ?? 0),
	panMax: med((r) => r.pan.max ?? 0),
	panLongTaskMs: med((r) => r.pan.longTaskTotalMs ?? 0),
	hoverP95: med((r) => r.hover.p95 ?? 0),
	hoverMax: med((r) => r.hover.max ?? 0),
	hoverLongTaskMs: med((r) => r.hover.longTaskTotalMs ?? 0)
};
console.table(summary);
mkdirSync('spike/results', { recursive: true });
writeFileSync(`spike/results/render-${label}.json`, JSON.stringify({ summary, runs }, null, 2));
