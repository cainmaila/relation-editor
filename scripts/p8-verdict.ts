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
	pan?: Frames[];
	panZoomed?: Frames[] | null;
	zoom?: number;
	connect?: { from: string; to: string; frames: Frames; menuMs: number; pair?: boolean }[];
	commits?: { id: string; ms: number; error?: string }[];
	consoleErrors: unknown[];
};
export type WorkspacePlan = {
	samples: number;
	nodes: number;
	edges: number;
	/** 每樣本：全圖平移＋放大後平移 */
	pans: number;
	connects: number;
	commits: number;
};
/** 正式工作區：3 樣本 × (3+2 平移、3 次連線、10 次提交) = 15／9／30 */
export const WORKSPACE_FORMAL = {
	samples: 3,
	nodes: 200,
	edges: 1000,
	pans: 5,
	connects: 3,
	commits: 10
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
			return p;
		})
	];
	const pan = xs.flatMap((x) =>
		[...(x.pan ?? []), ...(x.panZoomed ?? [])].map((f) => f?.intervalMs?.p95 ?? NaN)
	);
	const con = xs.flatMap((x) => x.connect ?? []);
	const commits = xs.flatMap((x) => x.commits ?? []);
	const wrongPair = con
		.filter((c) => c.pair === false)
		.map((c) => `connect ${c.from} → ${c.to}: menu shows another pair`);
	const errors = xs.flatMap((x) => x.consoleErrors).length;
	return [
		row(
			'2D pan frame p95 (worst drag; fit-all ×3 + after wheel ×2)',
			pan,
			S * plan.pans,
			BUDGET.frameP95Ms,
			max,
			{
				problems: base,
				extra: { zoom: xs.map((x) => x.zoom ?? null) }
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
