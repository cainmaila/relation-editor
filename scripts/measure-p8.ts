// P8 正式驗收量測（由 measure-universe.ts 分派；共用其 INIT／frames／drag／wheel／search／環境記錄）。
//   pnpm measure:universe formal    [--edges 20000,100000] [--samples 5] [--channel chrome]
//   pnpm measure:universe workspace [--edges 100000] [--samples 3] [--channel chrome]
//   pnpm measure:universe stability [--edges 20000] [--cycles 20] [--channel chrome]
//   pnpm measure:universe stress    [--channel chrome]   （50k／100k、原生 DPR、小視窗、SwiftShader 對照）
//   pnpm measure:universe selftest  [--channel chrome]   （harness 搜尋逾時的失敗與清理）
// 所有延遲都在頁內量：起點＝真實輸入事件的 event.timeStamp（pointerup／input／keydown），
// 終點＝畫面狀態成立後的下一個 rAF（那一幀已畫出），不是測試驅動端的 wall clock。
// 一次只開一個瀏覽器（串行），每個冷樣本新開瀏覽器程序；任何錯誤都關掉瀏覽器再往上丟。
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import {
	chromium,
	type Browser,
	type BrowserContext,
	type CDPSession,
	type Page
} from 'playwright';

type Summary = { n: number; min: number; p50: number; p95: number; max: number; sum: number };
type FramesResult = {
	frames: number;
	intervalMs: Summary;
	longTasks: number;
	longTaskMaxMs: number;
	rawIntervals: number[];
};
export type Deps = {
	OUT: string;
	SEED: number;
	EDGES: number[];
	opt: (k: string, d: string) => string;
	flag: (k: string) => boolean;
	int: (name: string, raw: string) => number;
	summary: (xs: number[]) => Summary;
	r1: (x: number) => number;
	environment: () => Record<string, unknown>;
	INIT: () => void;
	hasMark: (page: Page, name: string, timeout: number) => Promise<void>;
	frames: (page: Page, act: () => Promise<void>) => Promise<FramesResult>;
	drag: (page: Page, cx: number, cy: number) => Promise<void>;
	wheel: (page: Page, cx: number, cy: number) => Promise<void>;
	search: (
		page: Page,
		text: string,
		timeout: number
	) => Promise<{ text: string; typedAt: number; resultAt: number; latency: number }>;
};

/** 正式門檻（計畫 §5／brief 補充；不放寬） */
export const BUDGET = {
	coldMs: 2000,
	frameP95Ms: 33.3,
	searchP95Ms: 150,
	selectP95Ms: 100,
	return3dMs: 500,
	commitP95Ms: 150,
	analysisMs: 500
};

// ---------------------------------------------------------------- 頁內探針
type P8 = {
	last: Record<string, number>;
	workers: { created: number; terminated: number; live: number };
	listeners: () => Record<string, number>;
	until: (src: string, ms: number) => Promise<{ seen: number; painted: number }>;
};

/** 導航前注入：輸入事件時間戳、Worker 生滅、window／document 監聽數、「成立後下一幀」等待 */
const P8_INIT = () => {
	const w = window as unknown as { __p8: P8 };
	const last: Record<string, number> = {};
	for (const t of ['pointerdown', 'pointerup', 'click', 'input', 'keydown', 'change'])
		document.addEventListener(t, (e) => (last[t] = e.timeStamp), { capture: true });
	const workers = { created: 0, terminated: 0, live: 0 };
	const Native = window.Worker;
	window.Worker = class extends Native {
		constructor(...a: ConstructorParameters<typeof Worker>) {
			super(...a);
			workers.created++;
			workers.live++;
		}
		terminate() {
			workers.terminated++;
			workers.live--;
			super.terminate();
		}
	};
	// 只追 window／document（全域監聽最容易重複或洩漏）；同一 fn+capture 重複加入瀏覽器本來就去重
	const reg = new Map<string, Set<unknown>>();
	const key = (t: EventTarget, type: string, o?: boolean | AddEventListenerOptions) =>
		`${t === window ? 'window' : 'document'}:${type}:${typeof o === 'boolean' ? o : !!o?.capture}`;
	const add = EventTarget.prototype.addEventListener;
	const rm = EventTarget.prototype.removeEventListener;
	EventTarget.prototype.addEventListener = function (this: EventTarget, type, fn, o) {
		if ((this === window || this === document) && fn) {
			const k = key(this, type, o);
			(reg.get(k) ?? reg.set(k, new Set()).get(k)!).add(fn);
		}
		return add.call(this, type, fn, o);
	};
	EventTarget.prototype.removeEventListener = function (this: EventTarget, type, fn, o) {
		if ((this === window || this === document) && fn) reg.get(key(this, type, o))?.delete(fn);
		return rm.call(this, type, fn, o);
	};
	const listeners = () => {
		const out: Record<string, number> = {};
		for (const [k, s] of reg) if (s.size) out[k] = s.size;
		return out;
	};
	const until = (src: string, ms: number) =>
		new Promise<{ seen: number; painted: number }>((ok, fail) => {
			const cond = new Function(`return (${src})()`) as () => boolean;
			const t0 = performance.now();
			const step = (t: number) => {
				let hit: boolean;
				try {
					hit = !!cond();
				} catch {
					hit = false;
				}
				// 成立的這一幀會把新狀態畫出；下一個 rAF 時間＝該幀已送出
				if (hit) return void requestAnimationFrame((t2) => ok({ seen: t, painted: t2 }));
				if (performance.now() - t0 > ms)
					return fail(new Error(`until timeout ${ms}ms: ${src.slice(0, 120)}`));
				requestAnimationFrame(step);
			};
			requestAnimationFrame(step);
		});
	w.__p8 = { last, workers, listeners, until };
};

/** 先在頁內掛好等待（避免來回延遲吃掉），再做動作，最後取結果；起點用指定事件的 timeStamp */
async function timed(
	page: Page,
	cond: string,
	act: () => Promise<void>,
	startEvent: string,
	timeout = 10_000
) {
	await page.evaluate(
		([src, ms]) => {
			const w = window as unknown as {
				__p8: P8;
				__wait?: Promise<{ seen: number; painted: number }>;
			};
			for (const k in w.__p8.last) delete w.__p8.last[k];
			w.__wait = w.__p8.until(src as string, ms as number);
			w.__wait.catch(() => {});
		},
		[cond, timeout] as const
	);
	await act();
	const r = await page.evaluate(async (ev) => {
		const w = window as unknown as {
			__p8: P8;
			__wait: Promise<{ seen: number; painted: number }>;
		};
		const done = await w.__wait;
		return { ...done, start: w.__p8.last[ev] ?? NaN };
	}, startEvent);
	if (!Number.isFinite(r.start)) throw new Error(`no ${startEvent} event observed for ${cond}`);
	return { ms: r.painted - r.start, seenMs: r.seen - r.start, start: r.start };
}

// ---------------------------------------------------------------- 瀏覽器
type Launch = {
	channel: string;
	angle?: string;
	viewport?: { width: number; height: number };
	dpr?: number;
};
type Session = {
	b: Browser;
	ctx: BrowserContext;
	page: Page;
	cdp: CDPSession;
	errors: string[];
	pid: number | undefined;
};

async function open(d: Deps, l: Launch): Promise<Session> {
	const b = await chromium.launch({
		headless: !d.flag('headed'),
		channel: l.channel || undefined,
		args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(l.angle ? [`--use-angle=${l.angle}`] : [])]
	});
	try {
		const ctx = await b.newContext({
			viewport: l.viewport ?? { width: 1600, height: 960 },
			deviceScaleFactor: l.dpr ?? 1
		});
		const page = await ctx.newPage();
		const errors: string[] = [];
		// 瀏覽器自動請求 /favicon.ico（app 無 favicon）的 404 不算 app 錯誤；其餘一律記錄並附 URL
		page.on('console', (m) => {
			if (m.type() !== 'error') return;
			const url = m.location()?.url ?? '';
			if (/\/favicon\.ico$/.test(url)) return;
			errors.push(url ? `${m.text()} @ ${url}` : m.text());
		});
		page.on('pageerror', (e) => errors.push(String(e)));
		await page.addInitScript(d.INIT);
		await page.addInitScript(P8_INIT);
		const cdp = await ctx.newCDPSession(page);
		await cdp.send('Performance.enable');
		return { b, ctx, page, cdp, errors, pid: undefined };
	} catch (e) {
		await b.close().catch(() => {});
		throw e;
	}
}

async function metrics(cdp: CDPSession) {
	const m = (await cdp.send('Performance.getMetrics')).metrics;
	const v = (n: string) => m.find((x) => x.name === n)?.value ?? NaN;
	return {
		heapMB: v('JSHeapUsedSize') / 2 ** 20,
		nodes: v('Nodes'),
		listeners: v('JSEventListeners'),
		documents: v('Documents')
	};
}
async function gcHeap(cdp: CDPSession) {
	await cdp.send('HeapProfiler.collectGarbage');
	await cdp.send('HeapProfiler.collectGarbage');
	return metrics(cdp);
}

type Pt = { id: string; x: number; y: number; depth: number; px: number };
type GVH = {
	ready: boolean;
	selected(): string | null;
	highlighted(): string[];
	layout(): { phase: string; tick: number };
	workerStarts(): number;
	detailIds(): string[];
	projectAll(): Pt[];
	project(id: string): Pt | null;
	position(id: string): [number, number, number] | undefined;
	pose(): {
		position: { x: number; y: number; z: number };
		target: { x: number; y: number; z: number };
	};
	lod(): Record<string, number> | null;
	render(): Record<string, number>;
	nodeCount(): number;
};
type EditorLike = {
	graph: { nodes: { id: string; name: string; readonly?: boolean }[] };
	node(id: string): { id: string; name: string } | undefined;
	incidentEdges(id: string): { id: string; from: string; to: string; readonly?: boolean }[];
	addToWork(ids: string[]): boolean;
	working: string[];
	workspaceEdgeCount: number;
	topologyRevision: number;
	unprocessed: Set<string>;
	unreachable: Set<string>;
	result: { customerIds: string[]; nodes: Set<string>; edges: Set<string> } | null;
	select(s: unknown): void;
	universe: { workerStarts: number };
	edge(id: string): { from: string; to: string; readonly?: boolean } | undefined;
	message: string;
	page: string;
};
type MW = {
	__graphView: GVH;
	__measure: {
		editor: EditorLike;
		meta: { hub: string; power: string };
		stats: Record<string, number | string>;
		marks: { name: string; t: number }[];
		gpu(): { vendor: string; renderer: string } | null;
		renderInfo(): Record<string, number> | null;
		forceWorkspace(ids: string[]): number;
	};
	__p8: P8;
};
/** 在頁內對 window 執行（函式以字串傳入，避免 tsx 轉譯 helper 名稱進不了頁面） */
const ev = <T, A = undefined>(page: Page, f: (w: MW, a: A) => T, a?: A) =>
	page.evaluate(([src, arg]) => new Function('w', 'a', `return (${src})(w, a)`)(window, arg) as T, [
		f.toString(),
		a
	] as const) as Promise<Awaited<T>>;

const canvasBox = async (page: Page) => (await page.locator('main canvas').first().boundingBox())!;
const settle = (page: Page, ms: number) => page.waitForTimeout(ms);

// ---------------------------------------------------------------- 搜尋（頁內：最後一次 input → 最新完整頁）
const SEARCH_DONE = (text: string) => `() => {
	const input = document.querySelector('input[aria-label="搜尋節點"]');
	if (!input || input.value !== ${JSON.stringify(text)}) return false;
	const lb = document.querySelector('[role=listbox][aria-label]');
	if (!lb || lb.getAttribute('aria-busy') !== 'false') return false;
	const st = lb.parentElement.querySelector('[aria-live=polite]');
	const m = st && /共 (\\d+) 筆/.exec(st.textContent);
	if (!m) return false;
	const total = +m[1];
	return total > 0 && lb.querySelectorAll('[role=option]').length === Math.min(50, total);
}`;

async function searchSample(page: Page, text: string, expectName: string | null) {
	if (!(await page.locator('input[aria-label="搜尋節點"]').isVisible()))
		await page.click('button[aria-label="搜尋節點"]');
	const input = page.locator('input[aria-label="搜尋節點"]');
	await input.waitFor();
	await input.fill('');
	await settle(page, 50);
	const t = await timed(
		page,
		SEARCH_DONE(text),
		() => page.keyboard.type(text, { delay: 20 }),
		'input'
	);
	const page1 = await page.evaluate(() =>
		[...document.querySelectorAll('[role=listbox] [role=option]')].map((o) => o.textContent ?? '')
	);
	const total = await page.evaluate(() => {
		const lb = document.querySelector('[role=listbox][aria-label]');
		return +(
			/共 (\d+) 筆/.exec(
				lb?.parentElement?.querySelector('[aria-live=polite]')?.textContent ?? ''
			)?.[1] ?? NaN
		);
	});
	return {
		text,
		ms: t.ms,
		seenMs: t.seenMs,
		total,
		rows: page1.length,
		exactOnPage1: expectName === null ? null : page1.some((r) => r.includes(expectName))
	};
}

// ---------------------------------------------------------------- 點選（頁內：pointerup → 選取＋高亮＋詳情畫出）
const SELECT_DONE = (id: string, name: string) => `() => {
	const h = window.__graphView;
	if (!h || h.selected() !== ${JSON.stringify(id)} || !h.highlighted().includes(${JSON.stringify(id)})) return false;
	const n = document.querySelector('aside[aria-label="詳情"] [aria-label="名稱"]');
	return !!n && n.value === ${JSON.stringify(name)};
}`;

type Target = Pt & { kind: string; candidates: number; behindOnRay?: number };

/**
 * 從目前畫面挑一個可點、預期結果明確的目標：
 * 候選＝點擊處在「容差或畫出半徑」內的可見節點；倍率未知（問題節點 1.6）時以上下界各算一次，
 * 兩者最近者相同才採用（預期唯一）。kind=overlap 要求上界候選 ≥2。
 */
async function chooseTarget(
	page: Page,
	kind: 'far' | 'overlap' | 'near' | 'behind',
	avoid: Set<string>,
	salt: number
): Promise<Target | null> {
	const box = await canvasBox(page);
	return ev(
		page,
		(w, a) => {
			const h = w.__graphView;
			const cfg = (
				h.lod() as unknown as {
					config: { pickTolerancePx: number; detailEnterPx: number; nodeRadius: number };
				}
			).config;
			const det = new Set(h.detailIds());
			const pts = h.projectAll();
			const drawn = (p: Pt, s: number) =>
				det.has(p.id) ? p.px * s : Math.min(Math.max(p.px * s, 1), cfg.detailEnterPx * s);
			// 粗格加速鄰近查詢
			const G = 24;
			const grid = new Map<string, Pt[]>();
			for (const p of pts) {
				const k = `${Math.floor(p.x / G)},${Math.floor(p.y / G)}`;
				(grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
			}
			const near = (x: number, y: number, r: number) => {
				const out: Pt[] = [];
				const c = Math.ceil(r / G);
				const gx = Math.floor(x / G);
				const gy = Math.floor(y / G);
				for (let i = -c; i <= c; i++)
					for (let j = -c; j <= c; j++)
						for (const p of grid.get(`${gx + i},${gy + j}`) ?? [])
							if (Math.hypot(p.x - x, p.y - y) <= r) out.push(p);
				return out;
			};
			const front = (xs: Pt[]) =>
				xs.reduce<Pt | null>((b, p) => (!b || p.depth < b.depth ? p : b), null);
			const within = (x: number, y: number, s: number) =>
				near(x, y, 60).filter(
					(p) => Math.hypot(p.x - x, p.y - y) <= Math.max(cfg.pickTolerancePx, drawn(p, s))
				);
			// 確定性洗牌（salt）讓每個樣本點不同目標
			let seed = a.salt * 9301 + 49297;
			const rnd = () => (seed = (seed * 233280 + 49297) % 2147483647) / 2147483647;
			const order = pts
				.map((p) => [rnd(), p] as const)
				.sort((x, y) => x[0] - y[0])
				.map((x) => x[1]);
			// 「相機後方」：與反向射線夾角小的節點（反射後會投影到點擊處附近）
			const pose = h.pose();
			const eye = [pose.position.x, pose.position.y, pose.position.z];
			const look = [pose.target.x - eye[0], pose.target.y - eye[1], pose.target.z - eye[2]];
			const behind: [number, number, number][] = [];
			if (a.kind === 'behind') {
				for (const n of w.__measure.editor.graph.nodes) {
					const p = h.position(n.id);
					if (!p) continue;
					const v = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
					if (v[0] * look[0] + v[1] * look[1] + v[2] * look[2] < 0)
						behind.push(v as [number, number, number]);
				}
			}
			for (const p of order) {
				if (a.avoid.includes(p.id)) continue;
				if (
					p.x < a.box.x + 60 ||
					p.y < a.box.y + 60 ||
					p.x > a.box.x + a.box.width - 360 ||
					p.y > a.box.y + a.box.height - 140
				)
					continue;
				const el = document.elementFromPoint(p.x, p.y);
				if (!el || el.tagName !== 'CANVAS') continue;
				if (a.kind === 'near' && !det.has(p.id)) continue;
				if (a.kind === 'far' && det.has(p.id)) continue;
				const lo = within(p.x, p.y, 1);
				const hi = within(p.x, p.y, 1.6);
				const fl = front(lo);
				const fh = front(hi);
				if (!fl || !fh || fl.id !== fh.id) continue;
				if (a.kind === 'overlap' && hi.length < 2) continue;
				if (a.kind !== 'overlap' && a.kind !== 'behind' && hi.length !== 1) continue;
				let behindOnRay = 0;
				if (a.kind === 'behind') {
					const pos = h.position(fl.id)!;
					const d = [pos[0] - eye[0], pos[1] - eye[1], pos[2] - eye[2]];
					const dl = Math.hypot(d[0], d[1], d[2]);
					const focal = (fl.px * fl.depth) / cfg.nodeRadius;
					const thr = Math.atan(12 / focal);
					for (const v of behind) {
						const vl = Math.hypot(v[0], v[1], v[2]);
						const cos = -(v[0] * d[0] + v[1] * d[1] + v[2] * d[2]) / (vl * dl);
						if (Math.acos(Math.min(1, cos)) < thr) behindOnRay++;
					}
					if (!behindOnRay) continue;
				}
				return {
					...fl,
					x: p.x,
					y: p.y,
					kind: a.kind,
					candidates: hi.length,
					behindOnRay,
					behindTotal: behind.length
				};
			}
			return null;
		},
		{ kind, avoid: [...avoid], salt, box }
	) as Promise<Target | null>;
}

async function pointerPick(page: Page, t: Target) {
	const name = await ev(page, (w, id) => w.__measure.editor.node(id)!.name, t.id);
	const r = await timed(
		page,
		SELECT_DONE(t.id, name),
		() => page.mouse.click(t.x, t.y),
		'pointerup',
		5000
	).catch((e: Error) => ({ ms: NaN, seenMs: NaN, start: NaN, error: e.message }));
	const selected = await ev(page, (w) => w.__graphView.selected());
	return {
		kind: t.kind,
		target: t.id,
		selected,
		correct: selected === t.id,
		candidates: t.candidates,
		behindOnRay: t.behindOnRay ?? 0,
		px: d1(t.px),
		ms: r.ms,
		seenMs: r.seenMs,
		...('error' in r ? { error: r.error } : {})
	};
}
const d1 = (x: number) => Math.round(x * 10) / 10;

/** 真滾輪拉近／拉遠（每格等一幀），再等阻尼停止 */
async function zoom(page: Page, cx: number, cy: number, dy: number, n: number) {
	await page.mouse.move(cx, cy);
	for (let i = 0; i < n; i++) {
		await page.mouse.wheel(0, dy);
		await page.waitForTimeout(16);
	}
	await settle(page, 1200);
}

// ---------------------------------------------------------------- 一個冷樣本（formal／stress 共用）
type SampleOpts = {
	edges: number;
	nodes?: number;
	name: string;
	shots: boolean;
	trace: boolean;
	url: string;
	timeout: number;
	searches: number;
	picks: number;
	analysis: boolean;
};

async function coldSample(d: Deps, s: Session, o: SampleOpts) {
	const { page, cdp } = s;
	const shot = (n: string) =>
		o.shots ? page.screenshot({ path: path.join(d.OUT, `${o.name}-${n}.png`) }) : Promise.resolve();
	const q = `edges=${o.edges}&seed=${d.SEED}${o.nodes ? `&nodes=${o.nodes}` : ''}`;
	await page.goto(`${o.url}/measure?${q}`);
	await d.hasMark(page, 'app:mounted', o.timeout);
	// 冷啟搜尋：App 掛上就真的開搜尋框打字（沿用 P1 helper；含驅動端來回，是上界）
	const first = await d.search(page, 'ToR Switch C-07', o.timeout);
	await d.hasMark(page, 'camera:interactive', o.timeout);
	const env = await ev(page, (w) => ({
		gpu: w.__measure.gpu(),
		stats: w.__measure.stats,
		meta: w.__measure.meta,
		dpr: devicePixelRatio,
		viewport: { w: innerWidth, h: innerHeight },
		layoutAtInteractive: w.__graphView.layout()
	}));
	const box = await canvasBox(page);
	const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
	// 背景整理中的真拖曳（冷啟實際體驗）
	const dragDuringLayout = await d.frames(page, () => d.drag(page, cx, cy));
	await d.hasMark(page, 'layout:worker-done', o.timeout);
	const marks = await ev(page, (w) =>
		Object.fromEntries(
			[...w.__measure.marks].reverse().map((m) => [m.name, Math.round(m.t * 10) / 10])
		)
	);
	const cold = {
		cameraInteractiveMs: marks['camera:interactive'],
		firstSearchResultMs: first.resultAt,
		operableAndSearchMs: Math.max(marks['camera:interactive'], first.resultAt),
		layoutDoneMs: marks['layout:worker-done'],
		layoutWorkerMs: d.r1(marks['layout:worker-done'] - marks['layout:start'])
	};
	await page.mouse.click(box.x + 20, box.y + box.height - 20); // 點空白：清選取（far 視野）
	await settle(page, 300);
	await shot('far');

	// --- 搜尋 ---
	const names = await ev(
		page,
		(w, a) => {
			const ns = w.__measure.editor.graph.nodes;
			let seed = a.salt * 7919 + 17;
			const out: string[] = [];
			while (out.length < a.n) {
				seed = (seed * 48271) % 2147483647;
				const n = ns[seed % ns.length];
				if (n.name.length >= 3 && !out.includes(n.name)) out.push(n.name);
			}
			return out;
		},
		{ n: Math.max(0, o.searches - 2), salt: o.name.length * 31 + o.edges }
	);
	const searches = [];
	for (const n of names) searches.push(await searchSample(page, n, n));
	if (o.searches >= 2) {
		searches.push(await searchSample(page, 'Switch', null)); // 廣泛：上千筆、分頁
		searches.push(await searchSample(page, 'UPS', null));
	}
	await page.keyboard.press('Escape');
	await settle(page, 200);

	// --- 真滑鼠點選：遠景、遠景重疊、拉近細節、拉近重疊、相機後方候選 ---
	const picks = [];
	const used = new Set<string>();
	const kinds: ('far' | 'overlap' | 'near' | 'behind')[] = [
		'far',
		'overlap',
		'near',
		'overlap',
		'behind'
	];
	const sel0 = await ev(page, (w) => w.__graphView.selected());
	if (sel0) used.add(sel0);
	let zoomed = 0;
	for (let i = 0; i < o.picks; i++) {
		const kind = kinds[i % kinds.length];
		const want = i % kinds.length;
		// 拉近階段：第 3 個起進近景；第 5 個（behind）再深入雲團，讓相機後方有節點
		if (want === 2 && zoomed === 0) {
			await zoom(page, cx, cy, -200, 30);
			zoomed = 1;
			await shot('near');
		}
		if (want === 4 && zoomed === 1) {
			await zoom(page, cx, cy, -200, 25);
			zoomed = 2;
		}
		const t = await chooseTarget(page, kind, used, i + o.edges + o.name.length);
		if (!t) {
			picks.push({
				kind,
				target: null,
				selected: null,
				correct: false,
				ms: NaN,
				error: 'no target'
			});
			continue;
		}
		used.add(t.id);
		picks.push(await pointerPick(page, t));
		await settle(page, 150);
	}
	if (zoomed) await zoom(page, cx, cy, 200, zoomed === 2 ? 55 : 30);
	await shot('far-after-picks');

	// --- hub：搜尋選取（千度）→ 找客戶 → 選取／追查中旋轉 ---
	let hub = null;
	let analysis = null;
	let return3d = null;
	if (o.analysis) {
		const hubInfo = await ev(page, (w) => {
			const id = w.__measure.meta.hub;
			return {
				id,
				name: w.__measure.editor.node(id)!.name,
				degree: w.__measure.editor.incidentEdges(id).length
			};
		});
		await page.click('button[aria-label="搜尋節點"]');
		const input = page.locator('input[aria-label="搜尋節點"]');
		await input.fill('');
		await page.keyboard.type(hubInfo.name, { delay: 20 });
		await page.waitForFunction(
			new Function(`return (${SEARCH_DONE(hubInfo.name)})()`) as () => boolean
		);
		// 第一列不一定是 hub：用方向鍵移到 hub 那列，再量 Enter → 選取＋高亮＋詳情
		const idx = await page.evaluate(
			(n) =>
				[...document.querySelectorAll('[role=listbox] [role=option]')].findIndex((o) =>
					o.textContent?.includes(n)
				),
			hubInfo.name
		);
		for (let k = 0; k < idx; k++) await page.keyboard.press('ArrowDown');
		const hubSel = await timed(
			page,
			SELECT_DONE(hubInfo.id, hubInfo.name),
			() => page.keyboard.press('Enter'),
			'keydown',
			5000
		);
		await settle(page, 1500); // 飛行動畫（另計）
		await shot('hub');
		const t0 = await ev(page, (w) => w.__measure.editor.topologyRevision);
		const traceShow = await timed(
			page,
			`() => { const r = document.querySelector('section[aria-label="找客戶結果"]'); const v = r && r.querySelector('[aria-label="分析版本"]'); return !!v && v.textContent.includes('拓撲版本 ${t0}'); }`,
			() =>
				page
					.getByRole('complementary', { name: '詳情' })
					.getByRole('button', { name: '找客戶' })
					.click(),
			'pointerup',
			5000
		);
		const traceSize = await ev(page, (w) => {
			const r = w.__measure.editor.result!;
			return { customers: r.customerIds.length, nodes: r.nodes.size, edges: r.edges.size };
		});
		await settle(page, 1200);
		await shot('hub-trace');
		const hubDrag = await d.frames(page, () => d.drag(page, cx, cy));
		const hubWheel = await d.frames(page, () => d.wheel(page, cx, cy));
		const lodHub = await ev(page, (w) => w.__graphView.lod());
		hub = {
			...hubInfo,
			selectMs: hubSel.ms,
			traceShowMs: traceShow.ms,
			trace: traceSize,
			drag: hubDrag,
			wheel: hubWheel,
			lod: lodHub
		};

		// --- 全圖分析：編輯頁改方向（拓撲命令）→ 最新未處理／不可達／追查重算並顯示版本 ---
		const edge = await ev(page, (w) => {
			const e = w.__measure.editor;
			for (const id of e.result!.edges) if (!e.edge(id)?.readonly) return id;
			return null;
		});
		const samples = [];
		let switchToEdit = null;
		if (edge) {
			// 準備（不計時）：兩端加入編輯頁，再選這條邊；切頁時選取得以保留
			await ev(
				page,
				(w, id) => {
					const e = w.__measure.editor;
					const x = e.edge(id)!;
					e.addToWork([x.from, x.to]);
					e.select({ kind: 'edge', id });
				},
				edge
			);
			const ws0 = await ev(page, (w) => w.__measure.editor.universe.workerStarts);
			// 切到編輯頁：量到 2D 畫布與可編輯的詳情就緒
			switchToEdit = await timed(
				page,
				`() => !!document.querySelector('.svelte-flow') && !!document.querySelector('aside[aria-label="詳情"] select[aria-label="方向"]')`,
				() =>
					page.getByRole('group', { name: '畫面' }).getByRole('button', { name: '編輯頁' }).click(),
				'pointerup',
				5000
			);
			await page.waitForFunction(
				() =>
					(
						document.querySelector(
							'aside[aria-label="詳情"] select[aria-label="方向"]'
						) as HTMLSelectElement | null
					)?.disabled === false,
				undefined,
				{ timeout: 5000 }
			);
			// 找客戶結果與未處理徽章依 PRD 只在全圖顯示：一次拓撲命令＝編輯頁儲存（commit 可見）
			// ＋ 回全圖看到最新版本（拓撲版本 N・已依最新資料重算、未處理 N）。兩段都是頁內事件→畫出的時間。
			const returns = [];
			const toEdit = async () => {
				await page
					.getByRole('group', { name: '畫面' })
					.getByRole('button', { name: '編輯頁' })
					.click();
				await page.waitForFunction(
					() =>
						(
							document.querySelector(
								'aside[aria-label="詳情"] select[aria-label="方向"]'
							) as HTMLSelectElement | null
						)?.disabled === false,
					undefined,
					{ timeout: 5000 }
				);
				await settle(page, 300);
			};
			for (let k = 0; k < 6; k++) {
				const rev = await ev(page, (w) => w.__measure.editor.topologyRevision);
				const dir = page
					.getByRole('complementary', { name: '詳情' })
					.getByRole('combobox', { name: '方向' });
				const cur = await dir.inputValue();
				const want = cur === '單向' ? '雙向' : '單向';
				await dir.selectOption(want);
				const commit = await timed(
					page,
					`() => {
						const e = window.__measure.editor;
						if (e.topologyRevision <= ${rev}) return false;
						const sel = document.querySelector('aside[aria-label="詳情"] select[aria-label="方向"]');
						return !!sel && sel.value === '${want}' && !document.querySelector('[aria-label="草稿狀態"]');
					}`,
					() =>
						page
							.getByRole('complementary', { name: '詳情' })
							.getByRole('button', { name: '儲存' })
							.click(),
					'pointerup',
					5000
				);
				const wsA = await ev(page, (w) => w.__measure.editor.universe.workerStarts);
				const view = await timed(
					page,
					`() => {
						const e = window.__measure.editor;
						const h = window.__graphView;
						if (!h || !h.ready) return false;
						const l = h.lod();
						if (!l || !(l.frames > 0) || !document.querySelector('main canvas')) return false;
						const v = document.querySelector('section[aria-label="找客戶結果"] [aria-label="分析版本"]');
						if (!v || !v.textContent.includes('拓撲版本 ' + e.topologyRevision) || !v.textContent.includes('已依最新資料重算')) return false;
						const u = document.querySelector('[aria-label^="未處理 "]');
						return !!u && u.getAttribute('aria-label') === '未處理 ' + e.unprocessed.size;
					}`,
					() =>
						page.getByRole('group', { name: '畫面' }).getByRole('button', { name: '全圖' }).click(),
					'pointerup',
					5000
				);
				const after = await ev(page, (w) => ({
					rev: w.__measure.editor.topologyRevision,
					unprocessed: w.__measure.editor.unprocessed.size,
					unreachable: w.__measure.editor.unreachable.size,
					customers: w.__measure.editor.result?.customerIds.length ?? null,
					workerStarts: w.__measure.editor.universe.workerStarts
				}));
				returns.push({
					ms: view.ms,
					workerStartsBefore: wsA,
					workerStartsAfter: after.workerStarts
				});
				samples.push({
					ms: commit.ms + view.ms,
					commitMs: commit.ms,
					returnMs: view.ms,
					...after
				});
				if (k === 0) {
					await settle(page, 800);
					await shot('back-3d-analysis');
				}
				if (k < 5) await toEdit();
				else await settle(page, 300);
			}
			const ws1 = await ev(page, (w) => w.__measure.editor.universe.workerStarts);
			return3d = {
				ms: returns[0]?.ms ?? NaN,
				samples: returns,
				workerStartsBefore: ws0,
				workerStartsAfter: ws1
			};
		}
		analysis = { edge, switchToEditMs: switchToEdit?.ms ?? null, samples };
	}

	// --- 一般遠景旋轉／滾輪（清選取後） ---
	await page.keyboard.press('Escape');
	const dragF = await d.frames(page, () => d.drag(page, cx, cy));
	const wheelF = await d.frames(page, () => d.wheel(page, cx, cy));
	const renderInfo = await ev(page, (w) => w.__measure.renderInfo());
	const lod = await ev(page, (w) => w.__graphView.lod());
	const mem = await gcHeap(cdp);
	const workers = await ev(page, (w) => ({ ...w.__p8.workers }));
	return {
		name: o.name,
		edges: o.edges,
		nodes: o.nodes ?? 10_000,
		...env,
		cold,
		marks,
		firstSearch: first,
		dragDuringLayout,
		searches,
		picks,
		hub,
		analysis,
		return3d,
		drag: dragF,
		wheel: wheelF,
		renderInfo,
		lod,
		heapAfterGcMB: d.r1(mem.heapMB),
		domNodes: mem.nodes,
		jsListeners: mem.listeners,
		workers,
		consoleErrors: [...s.errors]
	};
}

type Sample = Awaited<ReturnType<typeof coldSample>>;

/** 依門檻判定一組樣本（formal 與 stress 共用；stress 只是觀察） */
function judge(d: Deps, xs: Sample[]) {
	const all = <T>(f: (x: Sample) => T[]) => xs.flatMap(f);
	const fin = (v: number[]) => v.filter(Number.isFinite);
	const cold = xs.map((x) => x.cold.operableAndSearchMs);
	const search = fin(all((x) => x.searches.map((s) => s.ms)));
	const pickMs = all((x) => x.picks.map((p) => p.ms));
	const select = fin([...pickMs, ...xs.map((x) => x.hub?.selectMs ?? NaN)]);
	const picks = all((x) => x.picks);
	const frame = (k: 'drag' | 'wheel') => xs.map((x) => x[k].intervalMs.p95);
	const hubFrames = xs.flatMap((x) =>
		x.hub ? [x.hub.drag.intervalMs.p95, x.hub.wheel.intervalMs.p95] : []
	);
	const analysis = fin(all((x) => x.analysis?.samples.map((s) => s.ms) ?? []));
	const ret = xs.filter((x) => x.return3d);
	const p95 = (v: number[]) => d.summary(v).p95;
	const max = (v: number[]) => (v.length ? Math.max(...v) : NaN);
	const row = (
		metric: string,
		value: number,
		budget: number,
		n: number,
		extra: Record<string, unknown> = {}
	) => ({
		metric,
		value: d.r1(value),
		budget,
		n,
		pass: Number.isFinite(value) && value <= budget,
		...extra
	});
	return [
		row(
			'cold: operable field AND full search (max of samples)',
			max(cold),
			BUDGET.coldMs,
			cold.length,
			{
				samples: cold,
				layoutDoneMs: xs.map((x) => x.cold.layoutDoneMs)
			}
		),
		row(
			'pointer rotation frame interval p95 (worst sample)',
			max(frame('drag')),
			BUDGET.frameP95Ms,
			xs.length,
			{ perSample: frame('drag') }
		),
		row(
			'wheel frame interval p95 (worst sample)',
			max(frame('wheel')),
			BUDGET.frameP95Ms,
			xs.length,
			{ perSample: frame('wheel') }
		),
		row(
			'hub selected + trace: rotation/wheel p95 (worst)',
			max(hubFrames),
			BUDGET.frameP95Ms,
			hubFrames.length,
			{ perSample: hubFrames }
		),
		row('search input → latest complete page p95', p95(search), BUDGET.searchP95Ms, search.length, {
			max: d.r1(max(search)),
			failed: all((x) => x.searches).length - search.length
		}),
		row('selection → highlight + details p95', p95(select), BUDGET.selectP95Ms, select.length, {
			max: d.r1(max(select)),
			pointerPicks: picks.length,
			pointerCorrect: picks.filter((p) => p.correct).length,
			kinds: Object.fromEntries(
				['far', 'overlap', 'near', 'behind'].map((k) => [
					k,
					`${picks.filter((p) => p.kind === k && p.correct).length}/${picks.filter((p) => p.kind === k).length}`
				])
			)
		}),
		row(
			'pointer picks wrong or not attempted (count; wrong = selected ≠ target, missing = harness found no on-screen target)',
			picks.length - picks.filter((p) => p.correct).length,
			0,
			picks.length,
			{
				wrong: picks.filter((p) => !p.correct && p.target).length,
				missingTarget: picks.filter((p) => !p.target).length
			}
		),
		(() => {
			const r = ret.flatMap((x) => x.return3d!.samples);
			const unchanged =
				r.every((y) => y.workerStartsBefore === y.workerStartsAfter) &&
				ret.every((x) => x.return3d!.workerStartsBefore === x.return3d!.workerStartsAfter);
			const v = row(
				'return to 3D (max; renderer ready + new frame + latest analysis visible)',
				max(r.map((y) => y.ms)),
				BUDGET.return3dMs,
				r.length,
				{ workerStartsUnchanged: unchanged }
			);
			return { ...v, pass: v.pass && unchanged };
		})(),
		row(
			'browser analysis: topology command → latest results + revision (max)',
			max(analysis),
			BUDGET.analysisMs,
			analysis.length,
			{
				p95: d.r1(p95(analysis))
			}
		),
		row('console errors (count)', all((x) => x.consoleErrors).length, 0, xs.length, {})
	];
}

// ---------------------------------------------------------------- modes
async function runSamples(
	d: Deps,
	label: string,
	l: Launch,
	list: Omit<SampleOpts, 'name' | 'shots' | 'trace'>[],
	samples: number,
	traceFirst: boolean
) {
	const out: Sample[] = [];
	for (const o of list) {
		for (let k = 0; k < samples; k++) {
			const name = `p8-${label}-${o.nodes ?? 10000}n-${o.edges}e-s${k + 1}`;
			const s = await open(d, l);
			try {
				if (traceFirst && k === 0)
					await s.b.startTracing(s.page, {
						screenshots: false,
						categories: [
							'devtools.timeline',
							'disabled-by-default-devtools.timeline.frame',
							'blink.user_timing',
							'gpu'
						]
					});
				const r = await coldSample(d, s, {
					...o,
					name,
					shots: k === 0,
					trace: traceFirst && k === 0
				});
				if (traceFirst && k === 0) {
					const buf = await s.b.stopTracing();
					await writeFile(path.join(d.OUT, `${name}-trace.json.gz`), gzipSync(buf));
				}
				out.push(r);
				console.log(
					JSON.stringify({
						name,
						gpu: r.gpu?.renderer,
						cold: r.cold,
						search: d.summary(r.searches.map((x) => x.ms)),
						picks: r.picks.map((p) => `${p.kind}:${p.correct ? 'ok' : 'X'}:${d.r1(p.ms)}`),
						hub: r.hub && {
							sel: d.r1(r.hub.selectMs),
							trace: d.r1(r.hub.traceShowMs),
							drag: r.hub.drag.intervalMs.p95,
							wheel: r.hub.wheel.intervalMs.p95
						},
						analysis: r.analysis?.samples.map((x) => d.r1(x.ms)),
						return3d: r.return3d,
						drag: r.drag.intervalMs.p95,
						wheel: r.wheel.intervalMs.p95,
						errors: r.consoleErrors.length
					})
				);
			} catch (e) {
				throw new Error(`${name} failed: ${(e as Error).message}`, { cause: e });
			} finally {
				await s.b.close().catch((e) => console.warn(`[p8] ${name} close failed`, e));
			}
		}
	}
	return out;
}

const envOf = async (d: Deps, l: Launch, extra: Record<string, unknown> = {}) => {
	const b = await chromium.launch({ channel: l.channel || undefined, headless: true });
	const v = b.version();
	await b.close();
	return {
		...d.environment(),
		browser: v,
		channel: l.channel || 'playwright-chromium',
		angle: l.angle ?? 'default',
		viewport: l.viewport ?? { width: 1600, height: 960 },
		dpr: l.dpr ?? 1,
		seed: d.SEED,
		...extra
	};
};

async function formal(d: Deps) {
	const l: Launch = { channel: d.opt('channel', 'chrome') };
	const url = d.opt('url', 'http://localhost:4173');
	const timeout = d.int('timeout', d.opt('timeout', '180000'));
	const samples = d.int('samples', d.opt('samples', '5'));
	for (const edges of d.EDGES) {
		const xs = await runSamples(
			d,
			'formal',
			l,
			[{ edges, url, timeout, searches: 6, picks: 5, analysis: true }],
			samples,
			true
		);
		const verdict = judge(d, xs);
		const env = await envOf(d, l, {
			cold: 'each sample = new browser process (cold HTTP/JIT cache)'
		});
		await writeFile(
			path.join(d.OUT, `formal-${edges}.json`),
			JSON.stringify({ env, budget: BUDGET, verdict, samples: xs }, null, 2)
		);
		console.log(
			JSON.stringify(
				{
					formal: edges,
					verdict: verdict.map(
						(v) => `${v.pass ? 'PASS' : 'FAIL'} ${v.metric}: ${v.value}/${v.budget} (n=${v.n})`
					)
				},
				null,
				1
			)
		);
	}
}

async function stress(d: Deps) {
	const ch = d.opt('channel', 'chrome');
	const url = d.opt('url', 'http://localhost:4173');
	const timeout = d.int('timeout', d.opt('timeout', '300000'));
	const runs: {
		label: string;
		l: Launch;
		list: Omit<SampleOpts, 'name' | 'shots' | 'trace'>[];
		samples: number;
	}[] = [
		{
			label: 'stress50k',
			l: { channel: ch },
			list: [
				{ edges: 100_000, nodes: 50_000, url, timeout, searches: 6, picks: 5, analysis: true }
			],
			samples: 3
		},
		{
			label: 'dpr2',
			l: { channel: ch, dpr: 2 },
			list: [
				{ edges: 20_000, url, timeout, searches: 6, picks: 5, analysis: true },
				{ edges: 100_000, url, timeout, searches: 6, picks: 5, analysis: true },
				{ edges: 100_000, nodes: 50_000, url, timeout, searches: 2, picks: 5, analysis: false }
			],
			samples: 1
		},
		{
			label: 'small',
			l: { channel: ch, viewport: { width: 1024, height: 640 } },
			list: [{ edges: 20_000, url, timeout, searches: 6, picks: 5, analysis: true }],
			samples: 1
		},
		{
			label: 'swiftshader',
			l: { channel: ch, angle: 'swiftshader' },
			list: [{ edges: 20_000, url, timeout, searches: 6, picks: 5, analysis: true }],
			samples: 1
		}
	];
	const only = d.opt('only', '');
	for (const r of runs) {
		if (only && !only.split(',').includes(r.label)) continue;
		const xs = await runSamples(d, r.label, r.l, r.list, r.samples, false);
		const env = await envOf(d, r.l, {
			observation:
				r.label === 'swiftshader'
					? 'SOFTWARE RENDERING (SwiftShader) — not GPU evidence'
					: 'stress observation, not formal acceptance'
		});
		const verdict = r.list.map((o) => ({
			fixture: `${o.nodes ?? 10000}/${o.edges}`,
			verdict: judge(
				d,
				xs.filter((x) => x.edges === o.edges && x.nodes === (o.nodes ?? 10000))
			)
		}));
		await writeFile(
			path.join(d.OUT, `stress-${r.label}.json`),
			JSON.stringify({ env, budget: BUDGET, verdict, samples: xs }, null, 2)
		);
		for (const v of verdict)
			console.log(
				JSON.stringify(
					{
						stress: r.label,
						fixture: v.fixture,
						verdict: v.verdict.map(
							// 縮減觀察（例如 dpr2 50k 不跑分析／hub）沒量到的項目標 SKIP，不冒充 FAIL 或 PASS
							(x) =>
								`${x.n === 0 ? 'SKIP(not measured)' : x.pass ? 'PASS' : 'FAIL'} ${x.metric}: ${x.value}/${x.budget}`
						)
					},
					null,
					1
				)
			);
	}
}

// ---------------------------------------------------------------- 2D 工作區
/** 頁內貪婪挑「誘導邊最多」的節點集合，邊數不超過 maxEdges（真實 incident edges 計數） */
const dense = (page: Page, nodes: number, maxEdges: number) =>
	ev(
		page,
		(w, a) => {
			const e = w.__measure.editor;
			const S = new Set<string>([w.__measure.meta.hub]);
			let edges = 0;
			const score = new Map<string, number>();
			const bump = (id: string) => {
				for (const x of e.incidentEdges(id)) {
					const o = x.from === id ? x.to : x.from;
					if (!S.has(o)) score.set(o, (score.get(o) ?? 0) + 1);
				}
			};
			bump(w.__measure.meta.hub);
			// 恰好 a.nodes 個節點、原始邊數盡量貼近 a.maxEdges：每步挑最接近「剩餘邊數／剩餘節點」的鄰居
			while (S.size < a.nodes) {
				let best: string | null = null;
				let bs = -1;
				const need = (a.maxEdges - edges) / (a.nodes - S.size);
				for (const [id, s] of score)
					if (
						edges + s <= a.maxEdges &&
						(best === null || Math.abs(s - need) < Math.abs(bs - need))
					)
						[best, bs] = [id, s];
				if (!best) {
					// 沒有放得下的鄰居：補一個與目前集合無邊的節點
					const free = e.graph.nodes.find((n) => !S.has(n.id) && !score.has(n.id));
					if (!free) break;
					[best, bs] = [free.id, 0];
				}
				S.add(best);
				score.delete(best);
				edges += bs;
				bump(best);
			}
			return { ids: [...S], edges };
		},
		{ nodes, maxEdges }
	);

async function workspaceSample(
	d: Deps,
	s: Session,
	o: {
		edges: number;
		url: string;
		timeout: number;
		name: string;
		shots: boolean;
		size: number;
		maxEdges: number;
		force: boolean;
		commits: number;
	}
) {
	const { page } = s;
	await page.goto(`${o.url}/measure?edges=${o.edges}&seed=${d.SEED}`);
	await d.hasMark(page, 'camera:interactive', o.timeout);
	const set = await dense(page, o.size, o.maxEdges);
	// 樣本準備走 Editor（量的是之後的真滑鼠）；500 只能走 /measure 的 forceWorkspace（明確繞過產品上限）
	const admitted = o.force
		? await ev(page, (w, ids) => w.__measure.forceWorkspace(ids) > 0, set.ids)
		: await ev(page, (w, ids) => w.__measure.editor.addToWork(ids), set.ids);
	const ws = await ev(page, (w) => ({
		nodes: w.__measure.editor.working.length,
		edges: w.__measure.editor.workspaceEdgeCount,
		message: w.__measure.editor.message
	}));
	if (!admitted)
		return {
			name: o.name,
			admitted,
			ws,
			set: { nodes: set.ids.length, edges: set.edges },
			dom: null,
			toEditMs: NaN,
			pan: [],
			connect: [],
			commits: [],
			consoleErrors: [...s.errors]
		};
	const toEdit = await timed(
		page,
		`() => document.querySelectorAll('.svelte-flow__node').length > 0 && document.querySelectorAll('.svelte-flow__edge').length > 0`,
		() => page.getByRole('group', { name: '畫面' }).getByRole('button', { name: '編輯頁' }).click(),
		'pointerup',
		15_000
	);
	await settle(page, 1500);
	const dom = await page.evaluate(() => ({
		cards: document.querySelectorAll('.svelte-flow__node').length,
		edges: document.querySelectorAll('.svelte-flow__edge').length
	}));
	if (o.shots) await page.screenshot({ path: path.join(d.OUT, `${o.name}-workspace.png`) });
	const pane = (await page.locator('.svelte-flow').first().boundingBox())!;
	// 空白處（pane 本身）
	const empty = await page.evaluate((b) => {
		for (let y = b.y + 40; y < b.y + b.height - 120; y += 17)
			for (let x = b.x + 40; x < b.x + b.width - 200; x += 23) {
				const el = document.elementFromPoint(x, y);
				if (el?.classList.contains('svelte-flow__pane')) return { x, y };
			}
		return null;
	}, pane);
	const pan = [];
	for (let k = 0; k < 3 && empty; k++)
		pan.push(
			await d.frames(page, async () => {
				await page.mouse.move(empty.x, empty.y);
				await page.mouse.down();
				for (let i = 1; i <= 60; i++) {
					await page.mouse.move(
						empty.x + Math.sin(i / 10) * 160,
						empty.y + Math.cos(i / 15) * 90 - 90
					);
					await page.waitForTimeout(16);
				}
				await page.mouse.up();
			})
		);
	await settle(page, 400);
	// 入場是整張入鏡（200 張卡片很小）；真滾輪放大到卡片接近原尺寸，再量一次平移，之後在此縮放做連線與編輯
	await page.locator('.svelte-flow__controls-fitview').click();
	await settle(page, 600);
	const band = await page.evaluate(() => {
		const r = [...document.querySelectorAll('.svelte-flow__node-graph')].map((el) =>
			el.getBoundingClientRect()
		);
		const ys = r.map((x) => x.y + x.height / 2).sort((a, b) => a - b);
		const xs = r.map((x) => x.x + x.width / 2).sort((a, b) => a - b);
		return { x: xs[xs.length >> 1], y: ys[ys.length >> 1], w: r[0]?.width ?? 0 };
	});
	await page.mouse.move(band.x, band.y);
	const zoomNow = () =>
		page.evaluate(
			() =>
				new DOMMatrix(getComputedStyle(document.querySelector('.svelte-flow__viewport')!).transform)
					.a
		);
	for (let k = 0; k < 60 && (await zoomNow()) < 0.75; k++) {
		await page.mouse.wheel(0, -120);
		await page.waitForTimeout(60);
	}
	await settle(page, 800);
	const zoom = await page.evaluate(() => {
		const t = getComputedStyle(document.querySelector('.svelte-flow__viewport')!).transform;
		return new DOMMatrix(t).a;
	});
	if (o.shots) await page.screenshot({ path: path.join(d.OUT, `${o.name}-workspace-zoomed.png`) });
	const emptyZ = await page.evaluate((b) => {
		for (let y = b.y + 40; y < b.y + b.height - 120; y += 17)
			for (let x = b.x + 40; x < b.x + b.width - 200; x += 23) {
				const el = document.elementFromPoint(x, y);
				if (el?.classList.contains('svelte-flow__pane')) return { x, y };
			}
		return null;
	}, pane);
	const panZoomed = [];
	for (let k = 0; k < 2 && emptyZ; k++)
		panZoomed.push(
			await d.frames(page, async () => {
				await page.mouse.move(emptyZ.x, emptyZ.y);
				await page.mouse.down();
				for (let i = 1; i <= 60; i++) {
					await page.mouse.move(
						emptyZ.x + Math.sin(i / 10) * 120,
						emptyZ.y + Math.sin(i / 15) * 40
					);
					await page.waitForTimeout(16);
				}
				await page.mouse.up();
			})
		);
	await settle(page, 400);
	// 連線拖曳：卡片中心拖到另一張卡片（真滑鼠），量拖曳期間 frame；放開 → 建立邊選單出現
	const cards = await page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>('.svelte-flow__node-graph')]
			.map((el) => {
				const r = el.getBoundingClientRect();
				return { id: el.dataset.id!, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
			})
			.filter(
				(c) =>
					c.x > 60 &&
					c.y > 80 &&
					c.x < innerWidth - 420 &&
					c.y < innerHeight - 140 &&
					document
						.elementFromPoint(c.x, c.y)
						?.closest('.svelte-flow__node-graph')
						?.getAttribute('data-id') === c.id
			)
	);
	const connect = [];
	for (let k = 0; k < 3 && cards.length > 4; k++) {
		const a = cards[(k * 7) % cards.length];
		const b = cards[(k * 7 + Math.floor(cards.length / 2)) % cards.length];
		const f = await d.frames(page, async () => {
			await page.evaluate(() => {
				const w = window as unknown as { __p8: P8; __wait?: Promise<unknown> };
				for (const k in w.__p8.last) delete w.__p8.last[k];
				w.__wait = w.__p8.until(
					`() => !!document.querySelector('[role=menu][aria-label="建立邊"]')`,
					5000
				);
				w.__wait.catch(() => {});
			});
			await page.mouse.move(a.x, a.y);
			await page.mouse.down();
			for (let i = 1; i <= 40; i++) {
				await page.mouse.move(a.x + ((b.x - a.x) * i) / 40, a.y + ((b.y - a.y) * i) / 40);
				await page.waitForTimeout(16);
			}
			await page.mouse.up();
		});
		const menuMs = await page
			.evaluate(async () => {
				const w = window as unknown as { __p8: P8; __wait: Promise<{ painted: number }> };
				const r = await w.__wait;
				return r.painted - w.__p8.last.pointerup;
			})
			.catch(() => NaN);
		connect.push({ from: a.id, to: b.id, frames: f, menuMs });
		await page.keyboard.press('Escape');
		await settle(page, 300);
	}
	// 編輯提交 → 畫面回饋：點卡片選取、改名、按儲存 → 卡片顯示新名稱
	const commits = [];
	for (let k = 0; k < o.commits && cards.length; k++) {
		const c = cards[(k * 11 + 3) % cards.length];
		const pos = await page.evaluate((id) => {
			const el = document.querySelector<HTMLElement>(
				`.svelte-flow__node-graph[data-id="${CSS.escape(id)}"]`
			);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
		}, c.id);
		if (!pos) continue;
		await page.mouse.click(pos.x, pos.y);
		const name = page
			.getByRole('complementary', { name: '詳情' })
			.getByRole('textbox', { name: '名稱', exact: true });
		await name.waitFor();
		const nn = `P8-${k}-${Date.now() % 100000}`;
		await name.fill(nn);
		const r = await timed(
			page,
			`() => { const el = document.querySelector('.svelte-flow__node-graph[data-id="${c.id.replace(/"/g, '\\"')}"]'); return !!el && el.textContent.includes(${JSON.stringify(nn)}); }`,
			() =>
				page
					.getByRole('complementary', { name: '詳情' })
					.getByRole('button', { name: '儲存' })
					.click(),
			'pointerup',
			5000
		).catch((e: Error) => ({ ms: NaN, seenMs: NaN, start: NaN, error: e.message }));
		commits.push({
			id: c.id,
			ms: r.ms,
			seenMs: r.seenMs,
			...('error' in r ? { error: r.error } : {})
		});
		await settle(page, 120);
	}
	return {
		name: o.name,
		admitted,
		set: { nodes: set.ids.length, edges: set.edges },
		ws,
		dom,
		toEditMs: toEdit.ms,
		pan,
		zoom,
		panZoomed,
		connect,
		commits,
		consoleErrors: [...s.errors]
	};
}

async function workspace(d: Deps) {
	const l: Launch = { channel: d.opt('channel', 'chrome') };
	const url = d.opt('url', 'http://localhost:4173');
	const timeout = d.int('timeout', d.opt('timeout', '180000'));
	const samples = d.int('samples', d.opt('samples', '3'));
	const edges = d.EDGES[d.EDGES.length - 1];
	const run = async (
		label: string,
		size: number,
		maxEdges: number,
		force: boolean,
		n: number,
		commits: number
	) => {
		const xs = [];
		for (let k = 0; k < n; k++) {
			const name = `p8-${label}-s${k + 1}`;
			const s = await open(d, l);
			try {
				const r = await workspaceSample(d, s, {
					edges,
					url,
					timeout,
					name,
					shots: k === 0,
					size,
					maxEdges,
					force,
					commits
				});
				console.log(
					JSON.stringify({
						name,
						ws: r.ws,
						set: r.set,
						dom: 'dom' in r ? r.dom : null,
						pan: 'pan' in r ? r.pan.map((p) => p.intervalMs.p95) : null,
						zoom: 'zoom' in r ? r.zoom : null,
						panZoomed: 'panZoomed' in r ? r.panZoomed?.map((p) => p.intervalMs.p95) : null,
						connect:
							'connect' in r
								? r.connect.map((c) => [c.frames.intervalMs.p95, d.r1(c.menuMs)])
								: null,
						commits:
							'commits' in r ? d.summary(r.commits.map((c) => c.ms).filter(Number.isFinite)) : null
					})
				);
				xs.push(r);
			} finally {
				await s.b.close().catch(() => {});
			}
		}
		return xs;
	};
	const formalWs = await run('workspace200', 200, 1000, false, samples, 10);
	const stress500 = await run('workspace500-stress', 500, 5000, true, 1, 10);
	const fin = (v: number[]) => v.filter(Number.isFinite);
	const verdict = (xs: typeof formalWs) => {
		const pan = xs.flatMap((x) =>
			'pan' in x ? [...x.pan, ...(x.panZoomed ?? [])].map((p) => p.intervalMs.p95) : []
		);
		const con = xs.flatMap((x) =>
			'connect' in x ? x.connect.map((c) => c.frames.intervalMs.p95) : []
		);
		const commit = fin(xs.flatMap((x) => ('commits' in x ? x.commits.map((c) => c.ms) : [])));
		const menu = fin(xs.flatMap((x) => ('connect' in x ? x.connect.map((c) => c.menuMs) : [])));
		const max = (v: number[]) => (v.length ? Math.max(...v) : NaN);
		const row = (metric: string, value: number, budget: number, n: number) => ({
			metric,
			value: d.r1(value),
			budget,
			n,
			pass: Number.isFinite(value) && value <= budget
		});
		return [
			row(
				'2D pan frame p95 (worst drag; fit-all + zoomed)',
				max(pan),
				BUDGET.frameP95Ms,
				pan.length
			),
			row('2D connection-drag frame p95 (worst drag)', max(con), BUDGET.frameP95Ms, con.length),
			row(
				'edit commit → visible feedback p95',
				d.summary(commit).p95,
				BUDGET.commitP95Ms,
				commit.length
			),
			row(
				'connection release → 建立邊 menu p95 (feedback)',
				d.summary(menu).p95,
				BUDGET.commitP95Ms,
				menu.length
			),
			row('console errors', xs.flatMap((x) => x.consoleErrors).length, 0, xs.length)
		];
	};
	const env = await envOf(d, l, { fixture: `10000/${edges}` });
	const out = {
		env,
		budget: BUDGET,
		formal: { verdict: verdict(formalWs), samples: formalWs },
		stress500: {
			note: 'measurement-only forceWorkspace; product admission (200/1000) unchanged',
			verdict: verdict(stress500),
			samples: stress500
		}
	};
	await writeFile(path.join(d.OUT, `workspace-${edges}.json`), JSON.stringify(out, null, 2));
	console.log(
		JSON.stringify(
			{
				workspace: out.formal.verdict.map(
					(v) => `${v.pass ? 'PASS' : 'FAIL'} ${v.metric}: ${v.value}/${v.budget} (n=${v.n})`
				),
				stress500: out.stress500.verdict.map(
					(v) => `${v.pass ? 'ok' : 'over'} ${v.metric}: ${v.value}`
				)
			},
			null,
			1
		)
	);
}

// ---------------------------------------------------------------- 穩定性
async function stability(d: Deps) {
	const l: Launch = { channel: d.opt('channel', 'chrome') };
	const url = d.opt('url', 'http://localhost:4173');
	const timeout = d.int('timeout', d.opt('timeout', '180000'));
	const cycles = d.int('cycles', d.opt('cycles', '20'));
	const edges = d.EDGES[0];
	const s = await open(d, l);
	const rows = [];
	try {
		const { page, cdp } = s;
		await page.goto(`${url}/measure?edges=${edges}&seed=${d.SEED}`);
		await d.hasMark(page, 'layout:worker-done', timeout);
		const set = await dense(page, 30, 120);
		await ev(page, (w, ids) => w.__measure.editor.addToWork(ids), set.ids);
		const base = {
			...(await gcHeap(cdp)),
			workers: await ev(page, (w) => ({ ...w.__p8.workers })),
			listeners: await ev(page, (w) => w.__p8.listeners())
		};
		const nav = page.getByRole('group', { name: '畫面' });
		const detail = page.getByRole('complementary', { name: '詳情' });
		const badge = page.getByRole('group', { name: '版面狀態' });
		const systems = page.locator('fieldset label');
		for (let i = 1; i <= cycles; i++) {
			const t0 = Date.now();
			// 切換 → 編輯頁
			await nav.getByRole('button', { name: '編輯頁' }).click();
			await page.locator('.svelte-flow__node-graph').first().waitFor();
			// 編輯：點卡片、改名、儲存
			const card = page.locator('.svelte-flow__node-graph').nth(i % 10);
			await card.click();
			await detail.getByRole('textbox', { name: '名稱', exact: true }).fill(`穩定-${i}`);
			await detail.getByRole('button', { name: '儲存' }).click();
			await page
				.locator('.svelte-flow__node-graph', { hasText: `穩定-${i}` })
				.first()
				.waitFor();
			// 回全圖
			await nav.getByRole('button', { name: '全圖' }).click();
			await page.waitForFunction(() => (window as unknown as MW).__graphView?.ready === true);
			// 篩選：關一個系統再打開
			const n0 = await ev(page, (w) => w.__graphView.nodeCount());
			const sys = systems.nth(i % 3);
			await sys.click();
			await page.waitForFunction(
				(n) => (window as unknown as MW).__graphView.nodeCount() !== n,
				n0
			);
			await sys.click();
			await page.waitForFunction(
				(n) => (window as unknown as MW).__graphView.nodeCount() === n,
				n0
			);
			// 重新整理版面 → 停止（取消）
			await badge.getByRole('button', { name: '重新整理版面' }).click();
			await page.waitForFunction(
				() =>
					document.querySelector('[aria-label="版面狀態"]')?.getAttribute('data-phase') ===
					'running'
			);
			await settle(page, 300);
			await badge.getByRole('button', { name: '停止' }).click();
			await page.waitForFunction(
				() =>
					document.querySelector('[aria-label="版面狀態"]')?.getAttribute('data-phase') ===
					'stopped'
			);
			await settle(page, 300);
			const m = await gcHeap(cdp);
			const r = {
				cycle: i,
				ms: Date.now() - t0,
				heapAfterGcMB: d.r1(m.heapMB),
				domNodes: m.nodes,
				jsListeners: m.listeners,
				documents: m.documents,
				workers: await ev(page, (w) => ({ ...w.__p8.workers })),
				workerStarts: await ev(page, (w) => w.__measure.editor.universe.workerStarts),
				listeners: await ev(page, (w) => w.__p8.listeners()),
				consoleErrors: s.errors.length
			};
			rows.push(r);
			console.log(
				JSON.stringify({
					cycle: i,
					heap: r.heapAfterGcMB,
					nodes: r.domNodes,
					jsl: r.jsListeners,
					workers: r.workers,
					starts: r.workerStarts,
					errors: r.consoleErrors
				})
			);
		}
		// 線性成長：最後 15 輪的最小平方斜率（MB／輪）與總增量
		const tail = rows.slice(5);
		const n = tail.length;
		const mx = tail.reduce((a, r) => a + r.cycle, 0) / n;
		const my = tail.reduce((a, r) => a + r.heapAfterGcMB, 0) / n;
		const slope =
			tail.reduce((a, r) => a + (r.cycle - mx) * (r.heapAfterGcMB - my), 0) /
			tail.reduce((a, r) => a + (r.cycle - mx) ** 2, 0);
		const first = rows[0];
		const lastR = rows[rows.length - 1];
		const sameListeners = JSON.stringify(first.listeners) === JSON.stringify(lastR.listeners);
		const verdict = {
			consoleErrors: { value: s.errors.length, pass: s.errors.length === 0 },
			orphanWorkers: {
				value: lastR.workers.live,
				afterCycle1: first.workers.live,
				baseline: base.workers.live,
				// 每輪重新整理會開一個 layout Worker、停止會 terminate；live 不隨輪數增加
				pass:
					lastR.workers.live <= first.workers.live &&
					lastR.workers.created - lastR.workers.terminated === lastR.workers.live
			},
			duplicateListeners: {
				first: first.listeners,
				last: lastR.listeners,
				jsListeners: [first.jsListeners, lastR.jsListeners],
				pass: sameListeners
			},
			heap: {
				baselineMB: d.r1(base.heapMB),
				cycle1MB: first.heapAfterGcMB,
				cycle20MB: lastR.heapAfterGcMB,
				slopeMBPerCycle: Math.round(slope * 1000) / 1000,
				// 非線性：最後 15 輪斜率 < 0.1 MB／輪（20 輪 < 2MB）
				pass: slope < 0.1
			},
			domNodes: { first: first.domNodes, last: lastR.domNodes }
		};
		await writeFile(
			path.join(d.OUT, `stability-${edges}.json`),
			JSON.stringify(
				{ env: await envOf(d, l), cycles, base, verdict, rows, errors: s.errors },
				null,
				2
			)
		);
		console.log(JSON.stringify(verdict, null, 1));
	} finally {
		await s.b.close().catch(() => {});
	}
}

// ---------------------------------------------------------------- harness 自測：搜尋逾時
async function selftest(d: Deps) {
	const l: Launch = { channel: d.opt('channel', 'chrome') };
	const url = d.opt('url', 'http://localhost:4173');
	const s = await open(d, l);
	let closed = false;
	s.b.on('disconnected', () => (closed = true));
	let out: Record<string, unknown>;
	try {
		const { page } = s;
		await page.goto(`${url}/measure?edges=20000&seed=1`);
		await d.hasMark(page, 'camera:interactive', 60_000);
		const t0 = Date.now();
		let rejected: string | null = null;
		try {
			await d.search(page, '不存在的節點-zzz-404', 1500);
		} catch (e) {
			rejected = (e as Error).message;
		}
		const elapsed = Date.now() - t0;
		// 逾時後頁面仍可用：下一次搜尋正常回來、沒有未處理 rejection 進 console
		await page.keyboard.press('Escape');
		const ok = await d.search(page, 'ToR Switch C-07', 10_000);
		out = {
			rejected,
			elapsedMs: elapsed,
			nextSearch: ok,
			consoleErrors: [...s.errors],
			pass:
				!!rejected &&
				/did not appear within 1500 ms/.test(rejected) &&
				elapsed < 6000 &&
				s.errors.length === 0
		};
	} finally {
		await s.b.close().catch(() => {});
	}
	// 瀏覽器確實關閉（disconnected 事件）
	out = { ...out, browserClosed: closed, browserConnectedAfterClose: s.b.isConnected() };
	await writeFile(
		path.join(d.OUT, 'selftest-search-timeout.json'),
		JSON.stringify({ env: d.environment(), ...out }, null, 2)
	);
	console.log(JSON.stringify(out));
}

export async function p8(mode: string, d: Deps) {
	if (mode === 'formal') return formal(d);
	if (mode === 'workspace') return workspace(d);
	if (mode === 'stability') return stability(d);
	if (mode === 'stress') return stress(d);
	if (mode === 'selftest') return selftest(d);
	throw new Error(`unknown p8 mode ${mode}`);
}
