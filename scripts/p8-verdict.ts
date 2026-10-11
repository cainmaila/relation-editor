// P8 判定（純函式；measure-p8.ts 與單元自測共用）。
// 原則：每一筆預定要量的樣本都要在、都要是有限數值、語意都要對（選對、搜到、選單是那一對卡片），
// 少一筆、壞一筆、選錯一次、規模不對，該列就 FAIL——不能因為「剩下的數字很快」而 PASS。
// 縮減觀察（依設計本來就不量的項目，expected = 0）標 SKIP，不冒充 PASS 或 FAIL。

export type Status = 'PASS' | 'FAIL' | 'SKIP';
export type Row = {
	metric: string;
	value: number;
	budget: number;
	/** 實際有效（有限數值且語意正確）的樣本數 */
	n: number;
	/** 依量測計畫應有的樣本數 */
	expected: number;
	status: Status;
	pass: boolean;
	/** FAIL 的原因（空＝通過或 SKIP） */
	problems: string[];
	[k: string]: unknown;
};

const r1 = (x: number) => Math.round(x * 10) / 10;
/** nearest-rank 百分位（與 measure-universe.ts 的 summary 相同算法） */
export const pct = (xs: number[], p: number) => {
	if (!xs.length) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const max = (v: number[]) => (v.length ? Math.max(...v) : NaN);
const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * 一列判定：raw 是所有預定樣本（含壞的）；壞樣本（非有限數值）與語意錯誤都記為 problem。
 * expected = 0 → SKIP（設計上不量）；有 problem、筆數不符或數值超標 → FAIL。
 */
export function row(
	metric: string,
	raw: unknown[],
	expected: number,
	budget: number,
	agg: (v: number[]) => number,
	o: { problems?: string[]; extra?: Record<string, unknown> } = {}
): Row {
	const good = raw.filter(ok);
	const problems = [...(o.problems ?? [])];
	const bad = raw.length - good.length;
	if (bad) problems.push(`${bad} sample(s) missing/non-finite`);
	if (raw.length !== expected)
		problems.push(`recorded ${raw.length} sample(s), expected ${expected}`);
	const value = good.length ? agg(good) : NaN;
	if (expected > 0 && !Number.isFinite(value)) problems.push('no valid value');
	if (expected > 0 && Number.isFinite(value) && value > budget)
		problems.push(`${r1(value)} > budget ${budget}`);
	const status: Status =
		expected === 0 && raw.length === 0 && problems.length === 0
			? 'SKIP'
			: problems.length
				? 'FAIL'
				: 'PASS';
	return {
		metric,
		value: r1(value),
		budget,
		n: good.length,
		expected,
		status,
		pass: status === 'PASS',
		problems,
		...o.extra
	};
}

export const BUDGET = {
	coldMs: 2000,
	frameP95Ms: 33.3,
	searchP95Ms: 150,
	selectP95Ms: 100,
	return3dMs: 500,
	commitP95Ms: 150,
	analysisMs: 500
};

// ---------------------------------------------------------------- 3D 全圖（formal／stress 共用）
type Frames = { intervalMs: { p95: number } } | null | undefined;
export type JudgeSample = {
	nodes: number;
	edges: number;
	cold: { operableAndSearchMs: number; layoutDoneMs?: number };
	searches: {
		text: string;
		ms: number;
		total: number;
		rows: number;
		exactOnPage1: boolean | null;
	}[];
	picks: {
		kind: string;
		target: string | null;
		selected?: string | null;
		correct: boolean;
		ms: number;
	}[];
	hub: {
		id: string;
		selectMs: number;
		traceShowMs?: number;
		drag: Frames;
		wheel: Frames;
	} | null;
	analysis: { samples: { ms: number }[] } | null;
	return3d: {
		samples: { ms: number; workerStartsBefore: number; workerStartsAfter: number }[];
		workerStartsBefore: number;
		workerStartsAfter: number;
	} | null;
	drag: Frames;
	wheel: Frames;
	consoleErrors: unknown[];
};
/** 一組樣本依量測計畫應有的量 */
export type JudgePlan = {
	nodes: number;
	edges: number;
	samples: number;
	searches: number;
	picks: number;
	/** 有沒有 hub 選取／追查與全圖分析（每樣本 6 次拓撲命令與回 3D） */
	analysis: boolean;
};
/** coldSample 每樣本固定做 6 次拓撲命令＋回 3D */
export const ANALYSIS_PER_SAMPLE = 6;
const p95f = (k: 'drag' | 'wheel') => (x: { [q in 'drag' | 'wheel']: Frames }) =>
	x[k]?.intervalMs?.p95 ?? NaN;

export function judge(xs: JudgeSample[], plan: JudgePlan): Row[] {
	const S = plan.samples;
	const all = <T>(f: (x: JudgeSample) => T[]) => xs.flatMap(f);
	const scale = xs
		.filter((x) => x.nodes !== plan.nodes || x.edges !== plan.edges)
		.map((x) => `sample is ${x.nodes}/${x.edges}, expected ${plan.nodes}/${plan.edges}`);
	const coverage = xs.length !== S ? [`${xs.length} sample(s), expected ${S}`] : [];
	const base = [...coverage, ...scale];

	const searches = all((x) => x.searches);
	const searchBad = searches.flatMap((s) =>
		s.exactOnPage1 === false
			? [`search "${s.text}": exact name not on page 1`]
			: !(s.total > 0) || !(s.rows > 0)
				? [`search "${s.text}": no results (total ${s.total}, rows ${s.rows})`]
				: []
	);
	const picks = all((x) => x.picks);
	const wrong = picks.filter((p) => p.target && !p.correct);
	const missing = picks.filter((p) => !p.target);
	const hubs = xs.filter((x) => x.hub);
	const hubFrames = hubs.flatMap((x) => [p95f('drag')(x.hub!), p95f('wheel')(x.hub!)]);
	const analysis = all((x) => x.analysis?.samples.map((s) => s.ms) ?? []);
	const ret = all((x) => x.return3d?.samples ?? []);
	const restarted =
		ret.some((y) => y.workerStartsBefore !== y.workerStartsAfter) ||
		xs.some((x) => x.return3d && x.return3d.workerStartsBefore !== x.return3d.workerStartsAfter);
	const hubN = plan.analysis ? S : 0;
	const aN = plan.analysis ? S * ANALYSIS_PER_SAMPLE : 0;
	const errors = all((x) => x.consoleErrors).length;
	return [
		row(
			'cold: operable field AND full search (max of samples)',
			xs.map((x) => x.cold.operableAndSearchMs),
			S,
			BUDGET.coldMs,
			max,
			{ problems: base, extra: { layoutDoneMs: xs.map((x) => x.cold.layoutDoneMs) } }
		),
		row(
			'pointer rotation frame interval p95 (worst sample)',
			xs.map(p95f('drag')),
			S,
			BUDGET.frameP95Ms,
			max,
			{
				problems: base
			}
		),
		row(
			'wheel frame interval p95 (worst sample)',
			xs.map(p95f('wheel')),
			S,
			BUDGET.frameP95Ms,
			max,
			{
				problems: base
			}
		),
		row(
			'hub selected + trace: rotation/wheel p95 (worst)',
			hubFrames,
			hubN * 2,
			BUDGET.frameP95Ms,
			max,
			{
				problems: [
					...base,
					...(hubs.length !== hubN ? [`${hubs.length} hub run(s), expected ${hubN}`] : [])
				]
			}
		),
		row(
			'search input → latest complete page p95',
			searches.map((s) => s.ms),
			S * plan.searches,
			BUDGET.searchP95Ms,
			(v) => pct(v, 95),
			{ problems: [...base, ...searchBad] }
		),
		row(
			'selection → highlight + details p95 (pointer picks + hub search-select)',
			[...picks.map((p) => p.ms), ...hubs.map((x) => x.hub!.selectMs)],
			S * plan.picks + hubN,
			BUDGET.selectP95Ms,
			(v) => pct(v, 95),
			{
				problems: [
					...base,
					...(hubs.length !== hubN ? [`${hubs.length} hub select(s), expected ${hubN}`] : []),
					...wrong.map((p) => `pick ${p.kind}: selected ${p.selected ?? 'nothing'} ≠ ${p.target}`),
					...missing.map((p) => `pick ${p.kind}: harness found no on-screen target`)
				],
				extra: {
					pointerPicks: picks.length,
					pointerCorrect: picks.filter((p) => p.correct).length,
					kinds: Object.fromEntries(
						['far', 'overlap', 'near', 'behind'].map((k) => [
							k,
							`${picks.filter((p) => p.kind === k && p.correct).length}/${picks.filter((p) => p.kind === k).length}`
						])
					)
				}
			}
		),
		row(
			'return to 3D (max; renderer ready + new frame + latest analysis visible)',
			ret.map((y) => y.ms),
			aN,
			BUDGET.return3dMs,
			max,
			{
				problems: [...base, ...(restarted ? ['analysis worker restarted on return to 3D'] : [])],
				extra: { workerStartsUnchanged: !restarted }
			}
		),
		row(
			'browser analysis: topology command → latest results + revision (max)',
			analysis,
			aN,
			BUDGET.analysisMs,
			max,
			{ problems: base, extra: { p95: r1(pct(analysis.filter(ok), 95)) } }
		),
		row('console errors (count)', [errors], 1, 0, max, { problems: base })
	];
}

// ---------------------------------------------------------------- 2D 工作區
export type WorkspaceSample = {
	name: string;
	admitted: boolean;
	ws: { nodes: number; edges: number };
	set: { nodes: number; edges: number };
	dom: { cards: number; edges: number } | null;
	/** 量測前真滾輪放大後的狀態：縮放、最窄目標卡片寬、名稱實際字級、可見目標數 */
	readable?: { zoom: number; cardPx: number; namePx: number; targets?: number };
	/** harness 做不到的事（滾輪點不在容器內、可見卡片不足、找不到空白處…）＝FAIL */
	problems?: string[];
	pan?: { frames: Frames; zoom: number }[];
	connect?: {
		from: string;
		to: string;
		frames: Frames;
		menuMs: number;
		pair?: boolean;
		zoom?: number;
	}[];
	commits?: { id: string; ms: number; error?: string; zoom?: number }[];
	consoleErrors: unknown[];
};
export type WorkspacePlan = {
	samples: number;
	nodes: number;
	edges: number;
	/** 每樣本平移次數（全部在可讀縮放） */
	pans: number;
	connects: number;
	commits: number;
	readable: typeof READABLE;
};
/**
 * 可讀編輯縮放：卡片 160px、名稱 12px（GraphNode w-40／text-xs）。
 * 0.75 時卡片 120px、名稱 9px；整張入鏡的 0.1（16px 細帶）不算編輯驗收
 */
export const READABLE = { minZoom: 0.75, maxZoom: 1.5, minCardPx: 120, minNamePx: 9 };
/** 正式工作區：3 樣本 × (5 平移、3 次連線、10 次提交) = 15／9／30，全部在可讀縮放 */
export const WORKSPACE_FORMAL = {
	samples: 3,
	nodes: 200,
	edges: 1000,
	pans: 5,
	connects: 3,
	commits: 10,
	readable: READABLE
};

export function workspaceVerdict(xs: WorkspaceSample[], plan: WorkspacePlan): Row[] {
	const S = plan.samples;
	const base = [
		...(xs.length !== S ? [`${xs.length} sample(s), expected ${S}`] : []),
		...xs.flatMap((x) => {
			const p: string[] = [];
			if (!x.admitted) p.push(`${x.name}: workspace not admitted`);
			if (x.set.nodes !== plan.nodes || x.set.edges !== plan.edges)
				p.push(
					`${x.name}: chosen set ${x.set.nodes}/${x.set.edges}, expected ${plan.nodes}/${plan.edges}`
				);
			if (x.ws.nodes !== plan.nodes || x.ws.edges !== plan.edges)
				p.push(
					`${x.name}: admitted ${x.ws.nodes}/${x.ws.edges}, expected ${plan.nodes}/${plan.edges}`
				);
			if (!x.dom || x.dom.cards !== plan.nodes || x.dom.edges !== plan.edges)
				p.push(
					`${x.name}: rendered ${x.dom ? `${x.dom.cards}/${x.dom.edges}` : 'nothing'}, expected ${plan.nodes}/${plan.edges}`
				);
			const R = plan.readable;
			const z = x.readable;
			const inRange = (v: unknown) => ok(v) && v >= R.minZoom && v <= R.maxZoom;
			if (!z) p.push(`${x.name}: readable edit scale not recorded`);
			else {
				if (!inRange(z.zoom))
					p.push(`${x.name}: zoom ${r1(z.zoom * 100) / 100} outside ${R.minZoom}–${R.maxZoom}`);
				if (!ok(z.cardPx) || z.cardPx < R.minCardPx)
					p.push(`${x.name}: card ${z.cardPx}px < ${R.minCardPx}px`);
				if (!ok(z.namePx) || z.namePx < R.minNamePx)
					p.push(`${x.name}: name ${z.namePx}px < ${R.minNamePx}px`);
			}
			// 每一次操作都要在可讀縮放（數字快但縮到 0.1 不算）
			const at = (what: string, v: unknown) =>
				inRange(v) ? [] : [`${x.name}: ${what} at zoom ${ok(v) ? Math.round(v * 100) / 100 : v}`];
			(x.pan ?? []).forEach((f, i) => p.push(...at(`pan ${i}`, f?.zoom)));
			(x.connect ?? []).forEach((c) => p.push(...at(`connect ${c.from} → ${c.to}`, c.zoom)));
			(x.commits ?? []).forEach((c) => p.push(...at(`commit ${c.id}`, c.zoom)));
			p.push(...(x.problems ?? []).map((q) => `${x.name}: ${q}`));
			return p;
		})
	];
	const pan = xs.flatMap((x) => (x.pan ?? []).map((f) => f?.frames?.intervalMs?.p95 ?? NaN));
	const con = xs.flatMap((x) => x.connect ?? []);
	const commits = xs.flatMap((x) => x.commits ?? []);
	const wrongPair = con
		.filter((c) => c.pair === false)
		.map((c) => `connect ${c.from} → ${c.to}: menu shows another pair`);
	const errors = xs.flatMap((x) => x.consoleErrors).length;
	return [
		row(
			'2D pan frame p95 (worst drag; all at readable zoom)',
			pan,
			S * plan.pans,
			BUDGET.frameP95Ms,
			max,
			{
				problems: base,
				extra: {
					readable: xs.map((x) => x.readable?.zoom ?? null),
					cardPx: xs.map((x) => x.readable?.cardPx ?? null),
					namePx: xs.map((x) => x.readable?.namePx ?? null)
				}
			}
		),
		row(
			'2D connection-drag frame p95 (worst drag)',
			con.map((c) => c.frames?.intervalMs?.p95 ?? NaN),
			S * plan.connects,
			BUDGET.frameP95Ms,
			max,
			{ problems: base }
		),
		row(
			'edit commit → visible feedback p95',
			commits.map((c) => c.ms),
			S * plan.commits,
			BUDGET.commitP95Ms,
			(v) => pct(v, 95),
			{
				problems: [
					...base,
					...commits.flatMap((c) => (c.error ? [`commit ${c.id}: ${c.error}`] : []))
				]
			}
		),
		row(
			'connection release → 建立邊 menu p95 (feedback)',
			con.map((c) => c.menuMs),
			S * plan.connects,
			BUDGET.commitP95Ms,
			(v) => pct(v, 95),
			{ problems: [...base, ...wrongPair] }
		),
		row('console errors', [errors], 1, 0, max, { problems: base })
	];
}

/** 一行文字（log／報告用）：PASS／FAIL／SKIP 與原因 */
export const line = (v: Row) =>
	`${v.status} ${v.metric}: ${v.value}/${v.budget} (n=${v.n}/${v.expected})${v.problems.length ? ` — ${v.problems.slice(0, 4).join('; ')}${v.problems.length > 4 ? ` (+${v.problems.length - 4})` : ''}` : ''}`;

// ---------------------------------------------------------------- 長時間穩定性（同狀態比較）
/**
 * docElements：document 內元素數（querySelectorAll('*')）；offDocNodes：CDP Nodes 指標減掉
 * document 內 TreeWalker 走得到的節點數（含文字）＝ document 外仍活著的節點（UA shadow、被持有的 Text…）。
 */
export type StabilityRow = {
	cycle: number;
	heapMB: number;
	docElements: number;
	offDocNodes: number;
};
type Range = { min: number; max: number; n: number };
export type StabilityTrend = {
	period: number;
	windows: number;
	/** 每個週期窗（period 輪）的平均 heap；第 1 窗是暖機（每個輪替選取第一次出現） */
	windowMeanMB: number[];
	/** 暖機後相鄰窗的平均差（第 2→3 窗起）；線性洩漏＝這串差不收斂、維持同一正值 */
	postDeltaMB: number[];
	/** 後半 postDelta 平均換算成每輪（只是這次量到的尾端趨勢，不是上限保證） */
	tailMBPerCycle: number;
	heap: { status: 'PASS' | 'FAIL' | 'INCONCLUSIVE'; reason: string };
	/** 同相位（cycle 與 cycle−period，同一張卡片／同樣面板）差；只取第 2 窗之後 */
	docElementsSamePhaseDelta: Range;
	offDocSamePhaseDelta: Range;
	dom: { status: 'PASS' | 'ATTRIBUTED' | 'FAIL' | 'INCONCLUSIVE'; reason: string };
	limits: string;
};

/** 量測解析度下限：一個窗（period 輪）平均 heap 的差 ≤ 0.05 MB 視為與 GC／JIT 雜訊無法區分 */
export const HEAP_WINDOW_FLOOR_MB = 0.05;

/**
 * 計畫要求「沒有線性的保留 heap 成長」。單一斜率門檻證明不了這件事，所以改成同狀態比較：
 * 輪替選取的週期 = period，只比較同相位（同一張卡片、同樣面板）的量，避免把不同面板大小當成長。
 * heap：暖機窗之後相鄰窗平均差要收斂（後半平均 ≤ 前半平均的一半，或已低於解析度下限）→ PASS；
 * 不收斂 → FAIL；窗數不足（< 4，即暖機後至少 3 窗、2 個差）→ INCONCLUSIVE。
 * DOM：document 內元素同相位差必須全為 0（否則 FAIL）；document 外節點同相位差 0 → PASS，
 * 非 0 但每輪成長量恰好等於 heap snapshot 歸因到的來源（explainedPerCycle）→ ATTRIBUTED
 * （不算產品洩漏，但要另附控制組）；否則 FAIL。
 */
export function stabilityTrend(
	rows: StabilityRow[],
	period = 10,
	explainedPerCycle: number | null = null
): StabilityTrend {
	const byCycle = new Map(rows.map((r) => [r.cycle, r]));
	const windows = Math.floor(rows.length / period);
	const windowMeanMB: number[] = [];
	for (let w = 0; w < windows; w++) {
		const xs = rows.slice(w * period, (w + 1) * period).map((r) => r.heapMB);
		windowMeanMB.push(xs.reduce((a, b) => a + b, 0) / xs.length);
	}
	const postDeltaMB = windowMeanMB.slice(2).map((m, k) => m - windowMeanMB[k + 1]);
	const half = Math.floor(postDeltaMB.length / 2);
	const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
	const early = mean(postDeltaMB.slice(0, half));
	const late = mean(postDeltaMB.slice(half));
	const tailMBPerCycle = late / period;
	const heap: StabilityTrend['heap'] =
		windows < 4
			? { status: 'INCONCLUSIVE', reason: `${windows} window(s) of ${period}; need ≥ 4` }
			: late <= HEAP_WINDOW_FLOOR_MB
				? {
						status: 'PASS',
						reason: `late window delta ${late.toFixed(3)} MB ≤ resolution floor ${HEAP_WINDOW_FLOOR_MB}`
					}
				: late <= early / 2
					? {
							status: 'PASS',
							reason: `decelerating: late ${late.toFixed(3)} ≤ ½ early ${early.toFixed(3)} MB/window`
						}
					: {
							status: 'FAIL',
							reason: `not converging: late ${late.toFixed(3)} vs early ${early.toFixed(3)} MB/window`
						};
	const same = (f: (r: StabilityRow) => number): Range => {
		const v: number[] = [];
		for (const r of rows) {
			const prev = byCycle.get(r.cycle - period);
			if (r.cycle > 2 * period && prev) v.push(f(r) - f(prev));
		}
		return {
			min: v.length ? Math.min(...v) : NaN,
			max: v.length ? Math.max(...v) : NaN,
			n: v.length
		};
	};
	const docElementsSamePhaseDelta = same((r) => r.docElements);
	const offDocSamePhaseDelta = same((r) => r.offDocNodes);
	const zero = (x: Range) => x.min === 0 && x.max === 0;
	const dom: StabilityTrend['dom'] = !docElementsSamePhaseDelta.n
		? { status: 'INCONCLUSIVE', reason: 'no same-phase pairs after warm-up' }
		: !zero(docElementsSamePhaseDelta)
			? {
					status: 'FAIL',
					reason: `in-document elements change at the same phase (${docElementsSamePhaseDelta.min}..${docElementsSamePhaseDelta.max} per ${period} cycles)`
				}
			: zero(offDocSamePhaseDelta)
				? {
						status: 'PASS',
						reason: 'same-phase in-document and off-document node counts identical'
					}
				: explainedPerCycle !== null &&
					  offDocSamePhaseDelta.min === offDocSamePhaseDelta.max &&
					  offDocSamePhaseDelta.max === explainedPerCycle * period
					? {
							status: 'ATTRIBUTED',
							reason: `off-document +${explainedPerCycle}/cycle exactly matches heap-snapshot attributed retainer`
						}
					: {
							status: 'FAIL',
							reason: `off-document nodes +${offDocSamePhaseDelta.min}..${offDocSamePhaseDelta.max} per ${period} cycles unexplained`
						};
	return {
		period,
		windows,
		windowMeanMB: windowMeanMB.map((x) => Math.round(x * 1000) / 1000),
		postDeltaMB: postDeltaMB.map((x) => Math.round(x * 1000) / 1000),
		tailMBPerCycle: Math.round(tailMBPerCycle * 10000) / 10000,
		heap,
		docElementsSamePhaseDelta,
		offDocSamePhaseDelta,
		dom,
		limits: `${rows.length} cycles in one page: cannot exclude growth below ~${Math.max(late, HEAP_WINDOW_FLOOR_MB).toFixed(2)} MB per ${period} cycles, nor leaks that only appear past this horizon or in states not exercised`
	};
}

// ---------------------------------------------------------------- heap snapshot 摘要（保留來源歸因）
type HeapSnapshot = {
	snapshot: {
		meta: {
			node_fields: string[];
			node_types: [string[], ...unknown[]];
		};
	};
	nodes: number[];
	strings: string[];
};
export type HeapSummary = {
	totalSelfBytes: number;
	codeBytes: number;
	/** V8 detachedness = 2（已從 document 拔掉的 DOM 物件） */
	detached: number;
	/** detachedness = 0（未知；document 外、例如被原生編輯 undo 堆疊持有的 Text） */
	textUnknown: number;
	counts: Record<string, number>;
};

/** 只數指定名稱的節點數（native 名稱如 PerformanceMark、blink::UndoStep），外加總 self size 與 detached */
export function summarizeHeapSnapshot(s: HeapSnapshot, names: string[]): HeapSummary {
	const f = s.snapshot.meta.node_fields;
	const types = s.snapshot.meta.node_types[0];
	const F = f.length;
	const [it, iname, isz, idet] = ['type', 'name', 'self_size', 'detachedness'].map((k) =>
		f.indexOf(k)
	);
	const want = new Set(names);
	const counts: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
	let totalSelfBytes = 0;
	let codeBytes = 0;
	let detached = 0;
	let textUnknown = 0;
	for (let k = 0; k < s.nodes.length; k += F) {
		const name = s.strings[s.nodes[k + iname]];
		const size = s.nodes[k + isz];
		totalSelfBytes += size;
		if (types[s.nodes[k + it]] === 'code') codeBytes += size;
		const det = idet >= 0 ? s.nodes[k + idet] : -1;
		if (det === 2) detached++;
		if (name === 'Text' && det === 0) textUnknown++;
		if (want.has(name)) counts[name]++;
	}
	return { totalSelfBytes, codeBytes, detached, textUnknown, counts };
}
