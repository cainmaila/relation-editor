// P8 正式驗收量測（由 measure-universe.ts 分派；共用其 INIT／frames／drag／wheel／search／環境記錄）。
//   pnpm measure:universe formal    [--edges 20000,100000] [--samples 5] [--channel chrome]
//   pnpm measure:universe workspace [--edges 100000] [--samples 3] [--channel chrome]
//   pnpm measure:universe stability [--edges 20000] [--cycles 200] [--name-input fill|assign] [--snapshots on|off] [--channel chrome]
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
import {
	BUDGET,
	judge as judgeRows,
	line,
	stabilityTrend,
	summarizeHeapSnapshot,
	workspaceVerdict,
	WORKSPACE_FORMAL,
	type JudgePlan
} from './p8-verdict.ts';

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

/** 正式門檻（計畫 §5／brief 補充；不放寬）；判定邏輯在 p8-verdict.ts（有單元自測） */
export { BUDGET };

// ---------------------------------------------------------------- 頁內探針
type P8 = {
	last: Record<string, number>;
	workers: { created: number; terminated: number; live: number };
	listeners: () => Record<string, number>;
	until: (src: string, ms: number) => Promise<{ seen: number; painted: number }>;
	flow: Flow;
};
type Card = { id: string; x: number; y: number; w: number };
/** 編輯頁（Svelte Flow）頁內定位：只認真的在 flow 容器內、沒被面板／控制項蓋住、點得到的位置 */
type Flow = {
	zoom: () => number;
	pane: () => { x: number; y: number; w: number; h: number; cx: number; cy: number };
	inFlow: (x: number, y: number) => boolean;
	/** 整張卡片都在容器內、中心點 elementFromPoint 打到它自己 */
	cards: () => Card[];
	/** 離 (x,y) 最近、打到 pane 空白處的點 */
	empty: (x: number, y: number) => { x: number; y: number } | null;
	/** 往最近一張不可見卡片平移的真拖曳：空白起點與位移 */
	toward: () => { x: number; y: number; dx: number; dy: number } | null;
	readability: (t: Card[]) => { zoom: number; cardPx: number; namePx: number; names: string[] };
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
	const root = () => document.querySelector<HTMLElement>('.svelte-flow');
	const OVER = '.svelte-flow__panel, .svelte-flow__node-toolbar, [role=menu], [role=dialog]';
	const flow: Flow = {
		zoom: () => {
			const v = document.querySelector('.svelte-flow__viewport');
			return v ? new DOMMatrix(getComputedStyle(v).transform).a : NaN;
		},
		pane: () => {
			const r = root()!.getBoundingClientRect();
			return {
				x: r.x,
				y: r.y,
				w: r.width,
				h: r.height,
				cx: r.x + r.width / 2,
				cy: r.y + r.height / 2
			};
		},
		inFlow: (x, y) => {
			const f = root();
			const el = document.elementFromPoint(x, y);
			return !!f && !!el && f.contains(el) && !el.closest(OVER);
		},
		cards: () => {
			const f = root();
			if (!f) return [];
			const p = f.getBoundingClientRect();
			return [...f.querySelectorAll<HTMLElement>('.svelte-flow__node-graph')].flatMap((el) => {
				const r = el.getBoundingClientRect();
				const c = { id: el.dataset.id!, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
				const inside =
					r.left >= p.left + 8 &&
					r.right <= p.right - 8 &&
					r.top >= p.top + 8 &&
					r.bottom <= p.bottom - 8;
				const hit = document.elementFromPoint(c.x, c.y);
				return inside &&
					flow.inFlow(c.x, c.y) &&
					hit?.closest('.svelte-flow__node-graph')?.getAttribute('data-id') === c.id
					? [c]
					: [];
			});
		},
		empty: (x, y) => {
			const p = flow.pane();
			const pts: { x: number; y: number; d: number }[] = [];
			for (let yy = p.y + 40; yy < p.y + p.h - 40; yy += 13)
				for (let xx = p.x + 40; xx < p.x + p.w - 40; xx += 17)
					pts.push({ x: xx, y: yy, d: Math.hypot(xx - x, yy - y) });
			pts.sort((a, b) => a.d - b.d);
			for (const q of pts) {
				const el = document.elementFromPoint(q.x, q.y);
				if (el?.classList.contains('svelte-flow__pane') && flow.inFlow(q.x, q.y))
					return { x: q.x, y: q.y };
			}
			return null;
		},
		toward: () => {
			const p = flow.pane();
			const seen = new Set(flow.cards().map((c) => c.id));
			let best: { x: number; y: number; d: number } | null = null;
			for (const el of document.querySelectorAll<HTMLElement>('.svelte-flow__node-graph')) {
				if (seen.has(el.dataset.id!)) continue;
				const r = el.getBoundingClientRect();
				const q = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
				const dd = Math.hypot(q.x - p.cx, q.y - p.cy);
				if (!best || dd < best.d) best = { ...q, d: dd };
			}
			if (!best) return null;
			const lim = (v: number, m: number) => Math.max(-m, Math.min(m, v));
			const dx = lim(p.cx - best.x, p.w / 2 - 80);
			const dy = lim(p.cy - best.y, p.h / 2 - 80);
			const s = flow.empty(p.cx - dx / 2, p.cy - dy / 2);
			return s && { ...s, dx, dy };
		},
		readability: (t) => {
			const z = flow.zoom();
			const names: string[] = [];
			let namePx = Infinity;
			for (const c of t) {
				const el = document.querySelector(
					`.svelte-flow__node-graph[data-id="${CSS.escape(c.id)}"] .truncate`
				);
				if (!el) continue;
				namePx = Math.min(namePx, parseFloat(getComputedStyle(el).fontSize) * z);
				if (names.length < 4) names.push(el.textContent ?? '');
			}
			return {
				zoom: z,
				cardPx: t.length ? Math.min(...t.map((c) => c.w)) : NaN,
				namePx: Number.isFinite(namePx) ? namePx : NaN,
				names
			};
		}
	};
	w.__p8 = { last, workers, listeners, until, flow };
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
		markCounts: Record<string, number>;
		markHistory(on: boolean): void;
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

/** 一組樣本依計畫應有的量（formal 與 stress 共用；stress 只是觀察） */
const planOf = (o: Omit<SampleOpts, 'name' | 'shots' | 'trace'>, samples: number): JudgePlan => ({
	nodes: o.nodes ?? 10_000,
	edges: o.edges,
	samples,
	// coldSample：max(0, searches-2) 個精確名稱＋（searches ≥ 2 時）兩個廣泛搜尋
	searches: Math.max(0, o.searches - 2) + (o.searches >= 2 ? 2 : 0),
	picks: o.picks,
	analysis: !!o.analysis
});
const judge = (xs: Sample[], plan: JudgePlan) => judgeRows(xs, plan);

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
		const o = { edges, url, timeout, searches: 6, picks: 5, analysis: true };
		const xs = await runSamples(d, 'formal', l, [o], samples, true);
		const verdict = judge(xs, planOf(o, samples));
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
					verdict: verdict.map(line)
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
				xs.filter((x) => x.edges === o.edges && x.nodes === (o.nodes ?? 10000)),
				planOf(o, r.samples)
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
						// 縮減觀察（例如 dpr2 50k 不跑分析／hub）依計畫不量的項目標 SKIP，不冒充 FAIL 或 PASS
						verdict: v.verdict.map(line)
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
	// 入場是整張入鏡（200 張卡片在 0.1 縮放下是一條細帶，讀不到字）。正式量測一律在可讀縮放：
	// 真滾輪在「確認落在 Svelte Flow 容器內」的點放大，必要時真拖曳平移把卡片帶進可見範圍；
	// 做不到就記 problem（判定 FAIL），不改相機 API、不硬塞
	const problems: string[] = [];
	const zoomNow = () => ev(page, (w) => w.__p8.flow.zoom());
	const anchor = await ev(page, (w) => {
		const c = w.__p8.flow.pane();
		const t = w.__p8.flow
			.cards()
			.sort((a, b) => Math.hypot(a.x - c.cx, a.y - c.cy) - Math.hypot(b.x - c.cx, b.y - c.cy))[0];
		return t ? { x: t.x, y: t.y, card: t.id } : w.__p8.flow.empty(c.cx, c.cy);
	});
	let wheels = 0;
	if (!anchor) problems.push('no in-pane point to zoom at');
	else {
		await page.mouse.move(anchor.x, anchor.y);
		for (; wheels < 40 && (await zoomNow()) < WORKSPACE_FORMAL.readable.minZoom; wheels++) {
			if (!(await ev(page, (w, a) => w.__p8.flow.inFlow(a.x, a.y), anchor))) {
				problems.push(`wheel point ${Math.round(anchor.x)},${Math.round(anchor.y)} left the flow`);
				break;
			}
			await page.mouse.wheel(0, -120);
			await page.waitForTimeout(60);
		}
	}
	await settle(page, 800);
	// 可讀範圍內至少要有 4 張完整可見、真的點得到的卡片（3 次拉線要不同的對）；不夠就真拖曳平移過去
	const bring = async (need: number) => {
		for (let k = 0; k < 8; k++) {
			const t = await ev(page, (w) => w.__p8.flow.cards());
			if (t.length >= need) return t;
			const step = await ev(page, (w) => w.__p8.flow.toward());
			if (!step) break;
			await page.mouse.move(step.x, step.y);
			await page.mouse.down();
			for (let i = 1; i <= 20; i++) {
				await page.mouse.move(step.x + (step.dx * i) / 20, step.y + (step.dy * i) / 20);
				await page.waitForTimeout(16);
			}
			await page.mouse.up();
			await settle(page, 300);
		}
		return ev(page, (w) => w.__p8.flow.cards());
	};
	let targets = await bring(4);
	const readable = await ev(page, (w, t) => w.__p8.flow.readability(t), targets);
	if (targets.length < 4) problems.push(`only ${targets.length} in-pane target card(s) after pans`);
	if (o.shots) await page.screenshot({ path: path.join(d.OUT, `${o.name}-workspace-zoomed.png`) });
	// 平移：全部在可讀縮放、從確認在容器內的空白處拖
	const pan = [];
	for (let k = 0; k < 5; k++) {
		const p = await ev(page, (w) => {
			const c = w.__p8.flow.pane();
			return w.__p8.flow.empty(c.cx, c.cy);
		});
		if (!p) {
			problems.push(`pan ${k}: no empty in-pane point`);
			continue;
		}
		const zoom = await zoomNow();
		const frames = await d.frames(page, async () => {
			await page.mouse.move(p.x, p.y);
			await page.mouse.down();
			for (let i = 1; i <= 60; i++) {
				await page.mouse.move(p.x + Math.sin(i / 10) * 120, p.y + Math.sin(i / 15) * 40);
				await page.waitForTimeout(16);
			}
			await page.mouse.up();
		});
		pan.push({ frames, zoom });
		await settle(page, 300);
	}
	targets = await bring(4);
	if (targets.length < 4)
		problems.push(`only ${targets.length} in-pane target card(s) before connection drags`);
	// 連線拖曳：可見卡片中心拖到另一張可見卡片（真滑鼠），量拖曳期間 frame；放開 → 建立邊選單出現
	const connect = [];
	for (let k = 0; k < 3 && targets.length >= 2; k++) {
		const a = targets[k % targets.length];
		const b = targets[(k + 1 + Math.floor(targets.length / 2)) % targets.length];
		if (a.id === b.id) continue;
		const zoom = await zoomNow();
		const hit = await ev(
			page,
			(w, ids) => ids.every((id) => w.__p8.flow.cards().some((c) => c.id === id)),
			[a.id, b.id]
		);
		if (!hit) {
			problems.push(`connect ${a.id} → ${b.id}: endpoint not in pane`);
			continue;
		}
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
		// 語意：選單是「起點 → 放開的那張卡片」，不是別對（快但錯不算）
		const pair = await page.evaluate(
			({ from, to }) => {
				const w = window as unknown as {
					__measure: { editor: { node: (id: string) => { name: string } | undefined } };
				};
				const m = document.querySelector('[role=menu][aria-label="建立邊"]');
				const a = w.__measure.editor.node(from)?.name;
				const b = w.__measure.editor.node(to)?.name;
				return !!m && !!a && !!b && (m.textContent ?? '').includes(`${a} → ${b}`);
			},
			{ from: a.id, to: b.id }
		);
		connect.push({ from: a.id, to: b.id, frames: f, menuMs, pair, zoom });
		await page.keyboard.press('Escape');
		await settle(page, 300);
	}
	// 編輯提交 → 畫面回饋：點卡片選取、改名、按儲存 → 卡片顯示新名稱
	const commits = [];
	for (let k = 0; k < o.commits; k++) {
		// 每次重新找：選取可能移動視野，只點此刻真的在容器內、點得到的卡片
		const now = await ev(page, (w) => w.__p8.flow.cards());
		const pos = now[(k * 7 + 3) % Math.max(1, now.length)];
		if (!pos) {
			commits.push({ id: `#${k}`, ms: NaN, seenMs: NaN, zoom: NaN, error: 'no in-pane card' });
			continue;
		}
		const c = { id: pos.id };
		const zoom = await zoomNow();
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
			zoom,
			ms: r.ms,
			seenMs: r.seenMs,
			...('error' in r ? { error: r.error } : {})
		});
		await settle(page, 120);
	}
	// 最後一次提交後仍選取著：可讀縮放下的亮起／暗化畫面（目視確認用）
	if (o.shots)
		await page.screenshot({ path: path.join(d.OUT, `${o.name}-workspace-selected.png`) });
	return {
		name: o.name,
		admitted,
		set: { nodes: set.ids.length, edges: set.edges },
		ws,
		dom,
		toEditMs: toEdit.ms,
		readable: { ...readable, wheels, anchor, targets: targets.length },
		problems,
		pan,
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
						readable: 'readable' in r ? r.readable : null,
						problems: 'problems' in r ? r.problems : null,
						pan: 'pan' in r ? r.pan.map((p) => [p.frames.intervalMs.p95, d.r1(p.zoom)]) : null,
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
	// --skip-stress：只重跑正式 200／1000（500 觀察沿用先前產物，不在每輪除錯重跑）
	const skipStress = d.flag('skip-stress');
	const stress500 = skipStress ? [] : await run('workspace500-stress', 500, 5000, true, 1, 10);
	// 正式：3 樣本、恰好 200／1000、15 平移、9 連線（選單是那一對）、30 提交；少一筆、壞一筆都 FAIL
	const plan = { ...WORKSPACE_FORMAL, samples };
	// 500 壓力只是觀察：規模以實際挑到的集合為準（dense 上限 5000，不一定剛好）
	const stressPlan = {
		...WORKSPACE_FORMAL,
		samples: 1,
		nodes: 500,
		edges: stress500[0]?.set.edges ?? 5000
	};
	const env = await envOf(d, l, { fixture: `10000/${edges}` });
	const out = {
		env,
		budget: BUDGET,
		formal: { plan, verdict: workspaceVerdict(formalWs, plan), samples: formalWs },
		stress500: skipStress
			? { note: 'not rerun (--skip-stress); see earlier artifact' }
			: {
					note: 'measurement-only forceWorkspace; product admission (200/1000) unchanged',
					plan: stressPlan,
					verdict: workspaceVerdict(stress500, stressPlan),
					samples: stress500
				}
	};
	await writeFile(path.join(d.OUT, `workspace-${edges}.json`), JSON.stringify(out, null, 2));
	console.log(
		JSON.stringify(
			{
				workspace: out.formal.verdict.map(line),
				stress500:
					'verdict' in out.stress500
						? out.stress500.verdict.map((v) => `observation ${line(v)}`)
						: out.stress500.note
			},
			null,
			1
		)
	);
}

// ---------------------------------------------------------------- 穩定性
/** 關瀏覽器失敗不吞掉：印警告，但不蓋過 try 區塊原本拋出的錯誤（finally 內呼叫） */
async function closeWarn(b: Browser, where: string) {
	try {
		await b.close();
	} catch (e) {
		console.warn(`[${where}] browser.close() failed: ${(e as Error)?.stack ?? String(e)}`);
	}
}

/** heap snapshot 只留摘要（保留來源歸因用）；原始檔約 50MB，不寫進產物 */
const RETAINER_NAMES = [
	'PerformanceMark',
	'LargestContentfulPaint',
	'InteractionContentfulPaint',
	'blink::UndoStep',
	'blink::SetCharacterDataCommand',
	'Text'
];
async function heapSummary(cdp: CDPSession) {
	const chunks: string[] = [];
	const on = (e: { chunk: string }) => chunks.push(e.chunk);
	cdp.on('HeapProfiler.addHeapSnapshotChunk', on);
	try {
		await cdp.send('HeapProfiler.collectGarbage');
		await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
	} finally {
		cdp.off('HeapProfiler.addHeapSnapshotChunk', on);
	}
	return summarizeHeapSnapshot(JSON.parse(chunks.join('')), RETAINER_NAMES);
}

/**
 * 長時間穩定性：同一頁反覆「編輯頁改名 → 全圖 → 篩選開關 → 重新整理版面 → 停止」。
 * 選取的卡片以 PERIOD 輪輪替（覆蓋不同面板）；判定只比同相位（同一張卡片、同樣面板）的量。
 * 量測本身的成長先關掉：/measure 的 marker 歷史（只留冷啟動 marker＋計數）與 __p1.longtasks 每輪清空，
 * 每輪仍記錄這些計數，證明量測本身有上限。
 * --name-input assign：以原生 setter＋input 事件改名（控制組），不經瀏覽器編輯指令；
 * 預設 fill（Playwright 真輸入，會進 Chrome 原生 undo 堆疊，見報告）。
 */
async function stability(d: Deps) {
	const l: Launch = { channel: d.opt('channel', 'chrome') };
	const url = d.opt('url', 'http://localhost:4173');
	const timeout = d.int('timeout', d.opt('timeout', '180000'));
	const cycles = d.int('cycles', d.opt('cycles', '200'));
	const nameInput = d.opt('name-input', 'fill');
	if (nameInput !== 'fill' && nameInput !== 'assign')
		throw new RangeError(`--name-input must be fill|assign, got ${nameInput}`);
	const snapshots = d.opt('snapshots', 'on') === 'on';
	const PERIOD = 10;
	const edges = d.EDGES[0];
	const s = await open(d, l);
	const rows = [];
	const snapAt = new Set(
		[2 * PERIOD, Math.round(cycles / 2 / PERIOD) * PERIOD, cycles].filter(
			(c) => c >= 2 * PERIOD && c <= cycles
		)
	);
	const heap: {
		cycle: number;
		offDocNodes: number;
		summary: Awaited<ReturnType<typeof heapSummary>>;
	}[] = [];
	try {
		const { page, cdp } = s;
		await page.goto(`${url}/measure?edges=${edges}&seed=${d.SEED}`);
		await d.hasMark(page, 'layout:worker-done', timeout);
		const set = await dense(page, 30, 120);
		await ev(page, (w, ids) => w.__measure.editor.addToWork(ids), set.ids);
		// 冷啟動 marker 已記錄；之後只計數（量測自身不隨輪數成長）
		const cold = await ev(page, (w) => {
			w.__measure.markHistory(false);
			return w.__measure.marks.map((m) => m.name);
		});
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
			// 編輯：點卡片、改名、儲存（卡片以 PERIOD 輪替；同相位＝同一張卡片）
			const card = page.locator('.svelte-flow__node-graph').nth(i % PERIOD);
			await card.click();
			const box = detail.getByRole('textbox', { name: '名稱', exact: true });
			if (nameInput === 'fill') await box.fill(`穩定-${i}`);
			else
				await box.evaluate((el, v) => {
					const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
					set.call(el, v);
					el.dispatchEvent(new Event('input', { bubbles: true }));
				}, `穩定-${i}`);
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
			// 量測自身的大小（每輪記錄；longtasks 由 measure-universe INIT 收集，這裡用不到，記數後清空）
			const instr = await page.evaluate(() => {
				const w = window as unknown as {
					__measure: { marks: unknown[]; markCounts: Record<string, number> };
					__p1: { longtasks: unknown[] };
				};
				const longtasks = w.__p1.longtasks.length;
				w.__p1.longtasks.length = 0;
				let docNodes = 0;
				const walk = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
				while (walk.nextNode()) docNodes++;
				return {
					docElements: document.querySelectorAll('*').length,
					docNodes,
					marks: w.__measure.marks.length,
					perfMarks: performance.getEntriesByType('mark').length,
					markEvents: Object.values(w.__measure.markCounts).reduce((a, b) => a + b, 0),
					longtasksCleared: longtasks
				};
			});
			const m = await gcHeap(cdp);
			const r = {
				cycle: i,
				ms: Date.now() - t0,
				heapAfterGcMB: Math.round(m.heapMB * 1000) / 1000,
				domNodes: m.nodes,
				docElements: instr.docElements,
				offDocNodes: m.nodes - instr.docNodes,
				jsListeners: m.listeners,
				documents: m.documents,
				instr,
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
					marks: instr.marks,
					perfMarks: instr.perfMarks,
					workers: r.workers.live,
					starts: r.workerStarts,
					errors: r.consoleErrors
				})
			);
			// 同相位 snapshot：第 2 窗結尾、中點、最後一輪（cycles 為 PERIOD 倍數時同一張卡片）
			if (snapshots && snapAt.has(i)) {
				heap.push({ cycle: i, offDocNodes: r.offDocNodes, summary: await heapSummary(cdp) });
				console.log(JSON.stringify({ snapshot: i, ...heap.at(-1)!.summary }));
			}
		}
		// document 外節點成長歸因：首末兩個同相位 snapshot 間，document 外節點增量＝原生編輯指令
		// （SetCharacterDataCommand，各持有一個 Text）增量，且 detached DOM 不變
		let explainedPerCycle: number | null = null;
		let attribution: Record<string, unknown> | null = null;
		const segments = heap.slice(1).map((b, k) => {
			const a = heap[k];
			const n = b.cycle - a.cycle;
			const code = b.summary.codeBytes - a.summary.codeBytes;
			const total = b.summary.totalSelfBytes - a.summary.totalSelfBytes;
			return {
				cycles: [a.cycle, b.cycle],
				codeBytesPerCycle: Math.round(code / n),
				nonCodeBytesPerCycle: Math.round((total - code) / n),
				counts: Object.fromEntries(
					RETAINER_NAMES.map((x) => [x, b.summary.counts[x] - a.summary.counts[x]])
				)
			};
		});
		if (heap.length >= 2) {
			const a = heap[0];
			const b = heap[heap.length - 1];
			const k = b.cycle - a.cycle;
			const dOff = b.offDocNodes - a.offDocNodes;
			const dCmd =
				b.summary.counts['blink::SetCharacterDataCommand'] -
				a.summary.counts['blink::SetCharacterDataCommand'];
			const dText = b.summary.textUnknown - a.summary.textUnknown;
			const dDetached = b.summary.detached - a.summary.detached;
			const match = k % PERIOD === 0 && dOff === dCmd && dText >= dCmd && dDetached === 0;
			if (match && dOff % k === 0) explainedPerCycle = dOff / k;
			attribution = {
				cycles: [a.cycle, b.cycle],
				dOffDocNodes: dOff,
				dNativeUndoSetCharacterData: dCmd,
				dTextUnknownDetachedness: dText,
				dDetachedDom: dDetached,
				explainedPerCycle,
				segments,
				note:
					explainedPerCycle !== null && explainedPerCycle > 0
						? 'off-document growth == Text held only by Chrome native editing undo stack (blink::UndoStep → SetCharacterDataCommand; Playwright fill; Chrome kMaximumUndoStackDepth = 1000); confirm with --name-input assign'
						: dOff === 0
							? 'no off-document growth'
							: 'off-document growth not fully explained by native undo stack'
			};
		}
		const trend = stabilityTrend(
			rows.map((r) => ({
				cycle: r.cycle,
				heapMB: r.heapAfterGcMB,
				docElements: r.docElements,
				offDocNodes: r.offDocNodes
			})),
			PERIOD,
			explainedPerCycle
		);
		// 舊的最後 N−5 輪最小平方斜率：只當參考，不是「沒有線性成長」的證明
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
		const instrMax = {
			marks: Math.max(...rows.map((r) => r.instr.marks)),
			perfMarks: Math.max(...rows.map((r) => r.instr.perfMarks))
		};
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
			instrumentation: {
				coldMarks: cold,
				// history 關閉後 marks／Performance 時間軸的上限＝不同 marker 名稱數
				maxMarks: instrMax.marks,
				maxPerfMarks: instrMax.perfMarks,
				markEvents: [first.instr.markEvents, lastR.instr.markEvents],
				pass: rows.every((r) => r.instr.marks === first.instr.marks)
			},
			heap: {
				baselineMB: d.r1(base.heapMB),
				cycle1MB: first.heapAfterGcMB,
				lastCycle: lastR.cycle,
				lastCycleMB: lastR.heapAfterGcMB,
				status: trend.heap.status,
				reason: trend.heap.reason,
				windowMeanMB: trend.windowMeanMB,
				postDeltaMB: trend.postDeltaMB,
				tailMBPerCycle: trend.tailMBPerCycle,
				legacyTailSlopeMBPerCycle: Math.round(slope * 1000) / 1000,
				limits: trend.limits,
				pass: trend.heap.status === 'PASS'
			},
			domNodes: {
				first: first.domNodes,
				last: lastR.domNodes,
				nameInput,
				docElementsSamePhaseDeltaPer10: trend.docElementsSamePhaseDelta,
				offDocSamePhaseDeltaPer10: trend.offDocSamePhaseDelta,
				status: trend.dom.status,
				reason: trend.dom.reason,
				attribution,
				pass: trend.dom.status === 'PASS' || trend.dom.status === 'ATTRIBUTED'
			}
		};
		await writeFile(
			path.join(d.OUT, `stability-${edges}${nameInput === 'assign' ? '-assign' : ''}.json`),
			JSON.stringify(
				{
					env: await envOf(d, l),
					cycles,
					period: PERIOD,
					base,
					verdict,
					heapSnapshots: heap,
					rows,
					errors: s.errors
				},
				null,
				2
			)
		);
		console.log(JSON.stringify(verdict, null, 1));
	} finally {
		await closeWarn(s.b, 'stability');
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
