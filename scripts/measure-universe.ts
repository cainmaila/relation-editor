// P1 量測腳本（可給 P8 重用）。Node 24 直接執行 TS：
//   pnpm measure:universe layout  [--edges 20000,100000] [--seed 1] [--ticks 100]
//   pnpm measure:universe browser [--edges 20000] [--init zero|d3] [--samples 5] [--url http://localhost:4173]
//                                 [--channel chrome] [--headed] [--angle swiftshader]
// browser 模式需先 `pnpm build && pnpm preview`（production build）。結果寫到 --out（預設 .superpowers/sdd/plan/artifacts/p1）。
// 只記錄數據，不判定門檻；門檻以計畫 §5 為準。
import { mkdir, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import os from 'node:os';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { runnerImport } from 'vite';
import { chromium, type Page } from 'playwright';

type Fixture = typeof import('../src/lib/model/scale-fixture.ts');
type Sim = typeof import('../src/lib/layout-sim.ts');

const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (k: string, d: string) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 ? argv[i + 1] : d;
};
const flag = (k: string) => argv.includes(`--${k}`);
/** 只接受十進位整數字串；其他（空、1e4、NaN、Infinity…）直接報錯，不用 Number() 寬鬆轉換 */
const int = (name: string, raw: string) => {
	if (!/^\d{1,15}$/.test(raw)) throw new Error(`--${name} must be a decimal integer, got "${raw}"`);
	return Number(raw);
};
const OUT = path.resolve(opt('out', '.superpowers/sdd/plan/artifacts/p1'));
const SEED = int('seed', opt('seed', '1'));
const EDGES = opt('edges', mode === 'layout' ? '20000,100000' : '20000')
	.split(',')
	.map((x) => int('edges', x));

const q = (xs: number[], p: number) => {
	if (!xs.length) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const summary = (xs: number[]) => ({
	n: xs.length,
	min: r1(Math.min(...xs)),
	p50: r1(q(xs, 50)),
	p95: r1(q(xs, 95)),
	max: r1(Math.max(...xs)),
	sum: r1(xs.reduce((a, b) => a + b, 0))
});

/** 取不到的欄位記成 null 並列在 unavailable，同時警告；不捏造（例如不把 git 失敗當成乾淨樹） */
function environment() {
	const unavailable: string[] = [];
	const sh = (field: string, c: string) => {
		try {
			return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
		} catch (e) {
			unavailable.push(field);
			console.warn(`[measure] environment.${field} unavailable: ${(e as Error).message}`);
			return null;
		}
	};
	const commit = sh('commit', 'git rev-parse --short HEAD');
	const status = sh('dirty', 'git status --porcelain');
	return {
		at: new Date().toISOString(),
		commit,
		dirty: status === null ? null : status.length > 0,
		unavailable,
		node: process.version,
		os: `${os.type()} ${os.release()} ${os.arch()}`,
		cpu: os.cpus()[0]?.model,
		cores: os.cpus().length,
		memGB: Math.round(os.totalmem() / 2 ** 30)
	};
}

async function load() {
	const cfg = { configFile: false as const, logLevel: 'error' as const };
	const fx = (await runnerImport<Fixture>('./src/lib/model/scale-fixture.ts', cfg)).module;
	const sim = (await runnerImport<Sim>('./src/lib/layout-sim.ts', cfg)).module;
	return { fx, sim };
}

/** 版面可讀性的數值代理：與他點距離 < 節點直徑(8) 的比例、半徑分布、邊長 */
function quality(pos: Float32Array, links: [number, number][]) {
	const n = pos.length / 3;
	const D = 8;
	const cell = (v: number) => Math.floor(v / D);
	const grid = new Map<string, number[]>();
	for (let i = 0; i < n; i++) {
		const k = `${cell(pos[i * 3])},${cell(pos[i * 3 + 1])},${cell(pos[i * 3 + 2])}`;
		(grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
	}
	const dist = (i: number, j: number) =>
		Math.hypot(
			pos[j * 3] - pos[i * 3],
			pos[j * 3 + 1] - pos[i * 3 + 1],
			pos[j * 3 + 2] - pos[i * 3 + 2]
		);
	let overlapped = 0;
	for (let i = 0; i < n; i++) {
		const [gx, gy, gz] = [cell(pos[i * 3]), cell(pos[i * 3 + 1]), cell(pos[i * 3 + 2])];
		let hit = false;
		for (let a = -1; a <= 1 && !hit; a++)
			for (let b = -1; b <= 1 && !hit; b++)
				for (let c = -1; c <= 1 && !hit; c++)
					hit = (grid.get(`${gx + a},${gy + b},${gz + c}`) ?? []).some(
						(j) => j !== i && dist(i, j) < D
					);
		if (hit) overlapped++;
	}
	const c = [0, 0, 0];
	for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += pos[i * 3 + k] / n;
	const radius = Array.from({ length: n }, (_, i) =>
		Math.hypot(pos[i * 3] - c[0], pos[i * 3 + 1] - c[1], pos[i * 3 + 2] - c[2])
	);
	const len = links.map(([a, b]) => dist(a, b));
	return {
		overlapRatio: Math.round((overlapped / n) * 1000) / 1000,
		occupiedCells: grid.size,
		radius: { p50: r1(q(radius, 50)), p95: r1(q(radius, 95)), max: r1(Math.max(...radius)) },
		edgeLength: { p50: r1(q(len, 50)), p95: r1(q(len, 95)) }
	};
}

type Profile = {
	nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[];
	samples?: number[];
	timeDeltas?: number[];
};
/** cpuprofile 自身時間前幾名（函式＋檔案＋行） */
function topSelf(profile: Profile) {
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	const self = new Map<string, number>();
	(profile.samples ?? []).forEach((id, i) => {
		const f = byId.get(id)!.callFrame;
		const k = `${f.functionName || '(anon)'} ${path.basename(f.url)}:${f.lineNumber + 1}`;
		self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000);
	});
	return [...self]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 12)
		.map(([fn, ms]) => ({ fn, ms: r1(ms) }));
}

/** 同一 seed／圖／力／ticks，只換起始座標：全零 vs d3 非重合起始 */
async function layout() {
	const { fx, sim } = await load();
	const ticks = Number(opt('ticks', '100'));
	const session = new Session();
	session.connect();
	const results = [];
	let profiling = false;
	try {
		await session.post('Profiler.enable');
		await session.post('Profiler.setSamplingInterval', { interval: 200 });
		for (const edges of EDGES) {
			const { graph, meta } = fx.scaleFixture({ edges, seed: SEED });
			const { degree, ...stats } = fx.graphStats(graph);
			void degree;
			const idx = new Map(graph.nodes.map((n, i) => [n.id, i]));
			const links = graph.edges.map((e) => [idx.get(e.from)!, idx.get(e.to)!] as [number, number]);
			for (const init of ['zero', 'd3'] as const) {
				await session.post('Profiler.start');
				profiling = true;
				const t = performance.now();
				const out = sim.runLayout({ n: graph.nodes.length, links, ticks, init });
				const wall = performance.now() - t;
				const { profile } = await session.post('Profiler.stop');
				profiling = false;
				const name = `layout-${edges}-${init}`;
				await writeFile(path.join(OUT, `${name}.cpuprofile`), JSON.stringify(profile));
				await writeFile(path.join(OUT, `${name}.pos.bin`), out.pos);
				const tick = [...out.tickMs];
				const r = {
					name,
					seed: SEED,
					ticks,
					init,
					stats,
					hub: meta.hub,
					wallMs: r1(wall),
					tickMs: {
						...summary(tick),
						first5: tick.slice(0, 5).map(r1),
						last5: tick.slice(-5).map(r1)
					},
					quality: quality(out.pos, links),
					topSelf: topSelf(profile as Profile)
				};
				console.log(
					JSON.stringify({ name, wallMs: r.wallMs, tickMs: r.tickMs, quality: r.quality })
				);
				results.push(r);
			}
		}
	} finally {
		// 失敗時也停掉 profiler、斷開 inspector；清理本身的錯誤只警告，不蓋掉原本的錯誤
		if (profiling) await session.post('Profiler.stop').catch((e) => console.warn('[measure]', e));
		session.disconnect();
	}
	await writeFile(
		path.join(OUT, 'layout-results.json'),
		JSON.stringify({ env: environment(), results }, null, 2)
	);
}

type P1 = {
	longtasks: { start: number; dur: number }[];
	frames: number[] | null;
	/** 下一次出現含 text 的搜尋結果列時的 performance.now()；超過 timeoutMs 沒出現就 reject */
	optionAt: (text: string, timeoutMs: number) => Promise<number>;
};
type MeasureHook = {
	/** 量測頁參數不合法時才有 */
	error?: string;
	marks: { name: string; t: number; detail?: Record<string, unknown> }[];
	stats: Record<string, unknown>;
	renderInfo: () => Record<string, number> | null;
	gpu: () => { vendor: string; renderer: string } | null;
};
type W = { __p1: P1; __measure: MeasureHook };

/** 在頁面內記 rAF 時間戳與 long task（導航前注入） */
const INIT = () => {
	const w = window as unknown as W;
	const optionAt = (text: string, timeoutMs: number) =>
		new Promise<number>((done, fail) => {
			const hit = () =>
				[...document.querySelectorAll('[role=option]')].some((o) => o.textContent?.includes(text));
			const mo = new MutationObserver(() => {
				if (hit()) {
					mo.disconnect();
					clearTimeout(timer);
					done(performance.now());
				}
			});
			const timer = setTimeout(() => {
				mo.disconnect();
				fail(new Error(`search result "${text}" did not appear within ${timeoutMs} ms`));
			}, timeoutMs);
			mo.observe(document.body, { childList: true, subtree: true, characterData: true });
		});
	w.__p1 = { longtasks: [], frames: null, optionAt };
	new PerformanceObserver((l) => {
		for (const e of l.getEntries()) w.__p1.longtasks.push({ start: e.startTime, dur: e.duration });
	}).observe({ type: 'longtask', buffered: true });
	const loop = (t: number) => {
		w.__p1.frames?.push(t);
		requestAnimationFrame(loop);
	};
	requestAnimationFrame(loop);
};

/** 等 marker；量測頁回報參數錯誤（__measure.error）時立即失敗，不等到逾時 */
async function hasMark(page: Page, name: string, timeout: number) {
	await page.waitForFunction(
		(n) => {
			const m = (window as unknown as Partial<W>).__measure;
			return !!m && (!!m.error || m.marks.some((x) => x.name === n));
		},
		name,
		{ timeout }
	);
	const error = await page.evaluate(() => (window as unknown as Partial<W>).__measure?.error);
	if (error) throw new Error(`/measure rejected the request: ${error}`);
}

/** 真實輸入期間的 frame 間隔：page.mouse 走瀏覽器輸入管線（CDP Input），不是直接設相機 */
async function frames(page: Page, act: () => Promise<void>) {
	const t0 = await page.evaluate(() => {
		(window as unknown as W).__p1.frames = [];
		return performance.now();
	});
	await act();
	const { f, lt } = await page.evaluate((t) => {
		const p = (window as unknown as W).__p1;
		const f = p.frames!;
		p.frames = null;
		return { f, lt: p.longtasks.filter((l) => l.start >= t) };
	}, t0);
	const iv = f.slice(1).map((t, i) => t - f[i]);
	return {
		frames: f.length,
		intervalMs: summary(iv),
		longTasks: lt.length,
		longTaskMaxMs: r1(Math.max(0, ...lt.map((l) => l.dur))),
		rawIntervals: iv.map(r1)
	};
}

async function drag(page: Page, cx: number, cy: number) {
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	for (let i = 1; i <= 60; i++) {
		await page.mouse.move(cx + Math.sin(i / 10) * 250, cy + Math.cos(i / 15) * 120 - 120);
		await page.waitForTimeout(16);
	}
	await page.mouse.up();
}
async function wheel(page: Page, cx: number, cy: number) {
	await page.mouse.move(cx, cy);
	for (let i = 0; i < 40; i++) {
		await page.mouse.wheel(0, i < 20 ? -120 : 120);
		await page.waitForTimeout(16);
	}
}

/**
 * 開搜尋框、真的輸入（input 事件），回傳頁內時間：輸入前 → 含該文字的結果列出現。
 * 用 CSS 選擇器而非 getByRole：大綱有約 4 萬個 DOM 節點，Playwright 角色查詢本身要數秒，會污染數據。
 */
async function search(page: Page, text: string, timeout: number) {
	await page.click('button[aria-label="搜尋節點"]', { timeout });
	const input = page.locator('input[aria-label="搜尋節點"]');
	await input.waitFor({ timeout });
	const typedAt = await page.evaluate(
		([t, ms]) => {
			const w = window as unknown as W & { __pending?: Promise<number> };
			w.__pending = w.__p1.optionAt(t, ms);
			// 避免在 evaluate 取值前 reject 變成未處理的 rejection
			w.__pending.catch(() => {});
			return performance.now();
		},
		[text, timeout] as const
	);
	await input.fill(text);
	const resultAt = await page.evaluate(
		() => (window as unknown as { __pending: Promise<number> }).__pending
	);
	await page.keyboard.press('Escape');
	return { text, typedAt: r1(typedAt), resultAt: r1(resultAt), latency: r1(resultAt - typedAt) };
}

async function browser() {
	const url = opt('url', 'http://localhost:4173');
	const init = opt('init', 'zero');
	const samples = int('samples', opt('samples', '5'));
	const channel = opt('channel', '');
	const timeout = int('timeout', opt('timeout', '180000'));
	const angle = opt('angle', '');
	const tag = `${init}${channel ? `-${channel}` : ''}${flag('headed') ? '-headed' : ''}${angle ? `-${angle}` : ''}`;
	const results = [];
	let browserVersion = '';
	for (const edges of EDGES) {
		for (let s = 0; s < samples; s++) {
			// 每個樣本新開瀏覽器程序＝冷啟動（無 HTTP 快取、無 JIT 快取）
			const b = await chromium.launch({
				headless: !flag('headed'),
				channel: channel || undefined,
				// --angle swiftshader：刻意走軟體渲染，對照 CI／無 GPU 環境
				args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(angle ? [`--use-angle=${angle}`] : [])]
			});
			const name = `browser-${edges}-${tag}-s${s + 1}`;
			// 任何步驟失敗都關掉這次開的瀏覽器，並帶樣本名把錯誤往上丟（不吞掉）
			try {
				browserVersion = b.version();
				const ctx = await b.newContext({
					viewport: { width: 1600, height: 960 },
					deviceScaleFactor: 1
				});
				const page = await ctx.newPage();
				const errors: string[] = [];
				page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text())));
				page.on('pageerror', (e) => errors.push(String(e)));
				await page.addInitScript(INIT);
				const cdp = await ctx.newCDPSession(page);
				await cdp.send('Performance.enable');
				await page.goto(`${url}/measure?edges=${edges}&seed=${SEED}&init=${init}`);
				// 搜尋可用：App 掛上就真的開搜尋框打字，量到結果列出現（主執行緒被佔時會反映在這裡）
				await hasMark(page, 'app:mounted', timeout);
				const domElements = await page.evaluate(() => document.getElementsByTagName('*').length);
				const first = await search(page, 'ToR Switch C-07', timeout);
				await hasMark(page, 'camera:interactive', timeout);
				const h = await page.evaluate(() => {
					const w = window as unknown as W;
					return {
						marks: w.__measure.marks,
						stats: w.__measure.stats,
						gpu: w.__measure.gpu(),
						lt: w.__p1.longtasks
					};
				});
				// layout 完成後的搜尋（10 次不同目標）
				const warm = [];
				for (const k of 'ABCDEFGHIJ')
					warm.push(await search(page, `ToR Switch ${k}-1${k.charCodeAt(0) % 10}`, timeout));
				const box = (await page.locator('canvas').first().boundingBox())!;
				const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
				if (s === 0) await page.screenshot({ path: path.join(OUT, `${name}-ready.png`) });
				const dragF = await frames(page, () => drag(page, cx, cy));
				const info = await page.evaluate(() => (window as unknown as W).__measure.renderInfo());
				const wheelF = await frames(page, () => wheel(page, cx, cy));
				if (s === 0) await page.screenshot({ path: path.join(OUT, `${name}-after-wheel.png`) });
				const metric = async (n: string) =>
					r1(
						(await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === n)!.value /
							2 ** 20
					);
				const heapUsedMB = await metric('JSHeapUsedSize');
				await cdp.send('HeapProfiler.collectGarbage');
				const heapAfterGcMB = await metric('JSHeapUsedSize');
				const t = (n: string) => h.marks.find((m) => m.name === n)?.t ?? NaN;
				const tick = h.marks.find((m) => m.name === 'layout:worker-done')?.detail?.tickMs as
					number[] | undefined;
				const r = {
					name,
					edges,
					init,
					sample: s + 1,
					gpu: h.gpu,
					stats: h.stats,
					marksMs: Object.fromEntries(h.marks.map((m) => [m.name, r1(m.t)])),
					domElementsAtMount: domElements,
					firstSearch: first,
					warmSearchMs: summary(warm.map((x) => x.latency)),
					warmSearchRaw: warm,
					layoutWorkerMs: r1(t('layout:worker-done') - t('layout:start')),
					workerTickMs: tick && { ...summary(tick), first5: tick.slice(0, 5).map(r1) },
					coldLongTasks: {
						count: h.lt.length,
						totalMs: r1(h.lt.reduce((a, l) => a + l.dur, 0)),
						maxMs: r1(Math.max(0, ...h.lt.map((l) => l.dur))),
						raw: h.lt.map((l) => ({ start: r1(l.start), dur: r1(l.dur) }))
					},
					drag: dragF,
					wheel: wheelF,
					renderInfoAfterDrag: info,
					heapUsedMB,
					heapAfterGcMB,
					consoleErrors: errors
				};
				console.log(
					JSON.stringify({
						name,
						gpu: r.gpu?.renderer,
						marks: r.marksMs,
						dom: domElements,
						search: first,
						warmSearch: r.warmSearchMs,
						worker: r.layoutWorkerMs,
						drag: r.drag.intervalMs,
						wheel: r.wheel.intervalMs,
						calls: info?.calls,
						heapAfterGcMB
					})
				);
				results.push(r);
			} catch (e) {
				throw new Error(`${name} failed: ${(e as Error).message}`, { cause: e });
			} finally {
				await b.close().catch((e) => console.warn(`[measure] ${name} browser close failed:`, e));
			}
		}
	}
	const env = {
		...environment(),
		browser: browserVersion,
		channel: channel || 'playwright-chromium',
		headed: flag('headed'),
		url,
		viewport: '1600x960',
		dpr: 1,
		seed: SEED
	};
	await writeFile(
		path.join(OUT, `browser-${EDGES.join('_')}-${tag}.json`),
		JSON.stringify({ env, results }, null, 2)
	);
}

await mkdir(OUT, { recursive: true });
if (mode === 'layout') await layout();
else if (mode === 'browser') await browser();
else {
	console.error('usage: measure-universe.ts layout|browser [options]');
	process.exit(1);
}
