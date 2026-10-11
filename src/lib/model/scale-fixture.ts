// 效能量測用的代表性大圖（P1）：單一根、領域合法的邊、千度 hub、循環、雙向邊、孤立節點、同名不同 ID。
// 與 bigMock 不同：bigMock 只把 2F mock 複製 5 份，沒有共同根（全部變未處理），邊數也固定約 2 倍節點。
// 純函式、依 seed 決定；只給量測入口與測試用，不進正式預設資料。
import { ROOT_ID } from './config';
import type { GEdge, GNode, Graph, Props } from './types';

export interface ScaleOptions {
	/** 節點總數（預設 10,000） */
	nodes?: number;
	/** 邊總數（例如 20,000 稀疏、100,000 高邊數） */
	edges: number;
	seed?: number;
}

export interface ScaleMeta {
	seed: number;
	/** 預定的千度 hub（Switch） */
	hub: string;
	/** 預定的孤立節點（無任何邊） */
	isolates: string[];
	/** 一個有向循環（依序每段都有邊，最後回到第一個） */
	cycle: string[];
	/** 供電起點，可用來找客戶 */
	power: string;
}

const FLOORS = 5;
const ROWS = 'ABCDEFGHIJ'.split('');
const CABS_PER_ROW = 20;
const AHU_PER_FLOOR = 4;
const CUSTOMERS = 200;
const ISOLATES = 20;
const OK = '已確認';
const EST = '推定';
const HUB = 'HUB Core Switch';
const POWER = '台電市電';

/** mulberry32：小而可重現的 PRNG */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pad = (i: number, w = 2) => String(i).padStart(w, '0');

/** 固定骨架節點數：根、市電、hub、每層（樓層／UPS／2 Core／通用／AHU＋每列 3＋每櫃 6）、客戶、孤立 */
export const FIXED_NODES =
	3 + FLOORS * (5 + AHU_PER_FLOOR + ROWS.length * (3 + CABS_PER_ROW * 6)) + CUSTOMERS + ISOLATES;
/** 骨架邊數（不含每個 sensor 一條的監測邊） */
const BASE_EDGES = 1 + FLOORS * (15 + ROWS.length * (5 + CABS_PER_ROW * 13 + CABS_PER_ROW));

/**
 * 支援的 fixture 大小：涵蓋計畫的 10k／20k、10k／100k 與 50k／100k。
 * 超出範圍（或太密）一律在任何迴圈前丟 RangeError，不靜默改值。
 */
export const SCALE_LIMITS = {
	/** 至少要有一個 sensor（補邊會從 sensors 抽） */
	minNodes: FIXED_NODES + 1,
	maxNodes: 50_000,
	maxEdges: 500_000,
	/** 平均每節點最多幾條邊（太密的需求補不滿，拒絕） */
	maxEdgesPerNode: 10,
	maxSeed: 0xffff_ffff
} as const;

/** N 個節點時骨架＋每個 sensor 一條監測邊的最低邊數 */
export const minEdges = (nodes: number) => BASE_EDGES + (nodes - FIXED_NODES);

function intIn(name: string, v: number, min: number, max: number) {
	if (!Number.isSafeInteger(v) || v < min || v > max)
		throw new RangeError(`scaleFixture: ${name} must be an integer in [${min}, ${max}], got ${v}`);
	return v;
}

/** 驗證大小；不合法丟 RangeError（有限、安全整數、支援範圍、密度） */
export function validateScaleOptions({ nodes = 10_000, edges, seed = 1 }: ScaleOptions) {
	const L = SCALE_LIMITS;
	intIn('nodes', nodes, L.minNodes, L.maxNodes);
	intIn('seed', seed, 0, L.maxSeed);
	intIn('edges', edges, minEdges(nodes), Math.min(L.maxEdges, nodes * L.maxEdgesPerNode));
	return { nodes, edges, seed };
}

/** 從 URL 讀 nodes／edges／seed：只接受十進位數字字串，不用 Number() 寬鬆轉換 */
export function parseScaleQuery(q: URLSearchParams) {
	const num = (k: string, d: number) => {
		const raw = q.get(k);
		if (raw === null) return d;
		if (!/^\d{1,15}$/.test(raw))
			throw new RangeError(`scaleFixture: ${k} must be a decimal integer, got "${raw}"`);
		return Number(raw);
	};
	return validateScaleOptions({
		nodes: num('nodes', 10_000),
		edges: num('edges', 20_000),
		seed: num('seed', 1)
	});
}

export function scaleFixture(options: ScaleOptions): {
	graph: Graph;
	meta: ScaleMeta;
} {
	const { nodes: N, edges: E, seed } = validateScaleOptions(options);
	const rand = rng(seed);
	const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
	const nodes: GNode[] = [];
	const edges: GEdge[] = [];
	const edgeIds = new Set<string>();

	const node = (type: string, id: string, name: string, props: Props = {}, readonly = false) => {
		const n: GNode = { id, type, name, props: { ...props } };
		if (readonly) n.readonly = true;
		nodes.push(n);
		return id;
	};
	const edge = (
		type: string,
		from: string,
		to: string,
		props: Props = {},
		opt: { readonly?: boolean; bidirectional?: boolean } = {}
	) => {
		const id = `${type}:${from}>${to}`;
		if (from === to || edgeIds.has(id)) return false;
		edgeIds.add(id);
		const e: GEdge = {
			id,
			type,
			from,
			to,
			bidirectional: !!opt.bidirectional,
			props: { ...props }
		};
		if (opt.readonly) e.readonly = true;
		edges.push(e);
		return true;
	};

	// ---- 節點 ----
	node('大樓', ROOT_ID, ROOT_ID);
	node('台電市電', POWER, POWER);
	node('Switch', HUB, HUB);
	const space: string[] = [];
	const tors: string[] = [];
	const hosts: string[] = [];
	const torRings: string[][] = [];
	type Floor = {
		id: string;
		ups: string;
		cores: string[];
		generic: string;
		ahus: string[];
		rows: { id: string; pdu: string; agg: string; cabs: string[] }[];
	};
	const floors: Floor[] = [];
	for (let f = 1; f <= FLOORS; f++) {
		const fl = `${f}F`;
		const p = (s: string) => `${fl}/${s}`;
		const F: Floor = {
			id: node('樓層', fl, fl),
			ups: node('UPS', p('UPS-1'), 'UPS-1'),
			cores: [1, 2].map((k) => node('Switch', p(`Core Switch-${k}`), `Core Switch-${k}`)),
			generic: node('通用節點', p('監視與偵測範圍'), '監視與偵測範圍'),
			ahus: Array.from({ length: AHU_PER_FLOOR }, (_, k) =>
				node('空調箱', p(`AHU-${k + 1}`), `空調箱 AHU-${k + 1}`)
			),
			rows: []
		};
		space.push(F.id);
		for (const r of ROWS) {
			const row = {
				id: node('排', p(`${r} 排`), `${r} 排`),
				pdu: node('樓層 PDU', p(`樓層 PDU ${r}`), `樓層 PDU ${r}`),
				agg: node('Switch', p(`AGG-${r}`), `匯聚 Switch AGG-${r}`),
				cabs: [] as string[]
			};
			space.push(row.id);
			const ring: string[] = [];
			for (let c = 1; c <= CABS_PER_ROW; c++) {
				const name = `${r}-${pad(c)}`;
				const cab = node('機櫃', p(`機櫃 ${name}`), `機櫃 ${name}`, { '總 U 數': '42' });
				row.cabs.push(cab);
				space.push(cab);
				for (const l of ['A', 'B'])
					node('機櫃 PDU', p(`機櫃 PDU ${name}-${l}`), `機櫃 PDU ${name}-${l}`, {
						額定電流: '32A'
					});
				const tor = node('Switch', p(`ToR ${name}`), `ToR Switch ${name}`);
				tors.push(tor);
				ring.push(tor);
				node('機框', p(`機框 ${name}-F1`), `機框 ${name}-F1`, {}, true);
				hosts.push(node('主機', p(`主機 ${name}`), `主機 ${name}`, {}, true));
			}
			torRings.push(ring);
			F.rows.push(row);
		}
		floors.push(F);
	}
	const customers = Array.from({ length: CUSTOMERS }, (_, i) =>
		node('客戶', `客戶/${pad(i + 1, 3)}`, `客戶 ${pad(i + 1, 3)}`, {}, true)
	);
	const isolates = Array.from({ length: ISOLATES }, (_, i) =>
		node('通用節點', `孤立/${pad(i + 1)}`, `孤立通用節點 ${pad(i + 1)}`)
	);
	const fixed = nodes.length;
	const sensorCount = N - fixed;
	if (fixed !== FIXED_NODES || sensorCount < 1)
		throw new Error(`scaleFixture: skeleton has ${fixed} nodes, expected ${FIXED_NODES}`);
	const sensors: { id: string; floor: Floor }[] = [];
	for (let i = 0; i < sensorCount; i++) {
		const floor = floors[i % FLOORS];
		const cam = i % 3 === 0;
		const name = cam ? `攝影機 CAM-${pad(i + 1, 4)}` : `偵測器 SD-${pad(i + 1, 4)}`;
		sensors.push({ id: node(cam ? '攝影機' : '偵測器', `${floor.id}/${name}`, name), floor });
	}

	// ---- 基礎邊：每個非孤立節點都連得到根 ----
	let ci = 0;
	edge('包含', ROOT_ID, HUB, { 確認狀態: OK });
	for (const F of floors) {
		edge('包含', ROOT_ID, F.id, { 確認狀態: OK });
		edge('供電', POWER, F.ups, { 確認狀態: EST });
		edge('包含', F.id, F.generic, { 確認狀態: EST });
		edge('包含', F.generic, F.rows[0].cabs[0], { 確認狀態: EST });
		for (const c of F.cores) edge('包含', F.id, c, { 確認狀態: OK });
		// 雙向：同層兩台 Core 互連
		edge('連線', F.cores[0], F.cores[1], { 確認狀態: OK }, { bidirectional: true });
		F.ahus.forEach((ahu, k) => {
			edge('供電', F.ups, ahu, { 確認狀態: EST });
			edge('冷卻', ahu, F.rows[k].id, { 確認狀態: EST });
		});
		for (const row of F.rows) {
			edge('包含', F.id, row.id, { 確認狀態: OK });
			edge('包含', row.id, row.agg, { 確認狀態: OK });
			edge('供電', F.ups, row.pdu, { 確認狀態: EST });
			for (const c of F.cores) edge('連線', c, row.agg, { 確認狀態: OK });
			for (const cab of row.cabs) {
				const name = cab.slice(cab.indexOf('機櫃 ') + 3);
				const p = (s: string) => `${F.id}/${s}`;
				const tor = p(`ToR ${name}`);
				const frame = p(`機框 ${name}-F1`);
				const host = p(`主機 ${name}`);
				edge('包含', row.id, cab, { 確認狀態: OK });
				edge('包含', cab, tor, { 確認狀態: OK });
				for (const l of ['A', 'B']) {
					const pdu = p(`機櫃 PDU ${name}-${l}`);
					edge('供電', row.pdu, pdu, { 確認狀態: EST });
					edge('供電', pdu, cab, { 確認狀態: OK, 路別: l });
				}
				edge('連線', row.agg, tor, { 確認狀態: OK });
				edge('連線', HUB, tor, { 確認狀態: EST });
				edge('連線', tor, host, { 確認狀態: EST });
				const ro = { readonly: true };
				edge('包含', cab, frame, { 確認狀態: OK }, ro);
				edge('包含', frame, host, { 確認狀態: OK }, ro);
				edge('承載', host, frame, { 確認狀態: OK }, ro);
				edge('服務', frame, customers[ci++ % CUSTOMERS], { 確認狀態: OK }, ro);
			}
		}
	}
	// 有向循環：每排 ToR 首尾相連
	for (const ring of torRings)
		ring.forEach((t, i) => edge('連線', t, ring[(i + 1) % ring.length], { 確認狀態: EST }));
	for (const s of sensors)
		edge('監測', s.id, pick(s.floor.rows).cabs[0 | (rand() * CABS_PER_ROW)], {
			確認狀態: EST
		});

	if (edges.length !== minEdges(N))
		throw new Error(`scaleFixture: base has ${edges.length} edges, expected ${minEdges(N)}`);

	// ---- 補邊到指定數量：仍依領域規則（監測、跨櫃連線、ToR→主機） ----
	// 候選空間遠大於上限（ToR×主機就 100 萬），重複只會偶發；仍設嘗試上限，補不滿就明確失敗。
	let budget = (E - edges.length) * 20 + 1000;
	while (edges.length < E) {
		if (budget-- <= 0)
			throw new Error(`scaleFixture: could not reach ${E} unique edges (stuck at ${edges.length})`);
		const r = rand();
		if (r < 0.5) edge('監測', pick(sensors).id, pick(space), { 確認狀態: EST });
		else if (r < 0.8) edge('連線', pick(tors), pick(tors), { 確認狀態: EST });
		else edge('連線', pick(tors), pick(hosts), { 確認狀態: EST });
	}

	return {
		graph: { nodes, edges },
		meta: { seed, hub: HUB, isolates, cycle: torRings[0], power: POWER }
	};
}

/** 量測要記的圖統計：N、E、最大 degree、連通分量數 */
export function graphStats(g: Graph) {
	const degree = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
	const parent = new Map<string, string>(g.nodes.map((n) => [n.id, n.id]));
	const find = (x: string): string => {
		let r = x;
		while (parent.get(r) !== r) r = parent.get(r)!;
		while (parent.get(x) !== r) {
			const nx = parent.get(x)!;
			parent.set(x, r);
			x = nx;
		}
		return r;
	};
	for (const e of g.edges) {
		degree.set(e.from, degree.get(e.from)! + 1);
		degree.set(e.to, degree.get(e.to)! + 1);
		parent.set(find(e.from), find(e.to));
	}
	let maxDegree = 0;
	let maxDegreeId = '';
	for (const [id, d] of degree) if (d > maxDegree) [maxDegree, maxDegreeId] = [d, id];
	const roots = new Set(g.nodes.map((n) => find(n.id)));
	return {
		nodes: g.nodes.length,
		edges: g.edges.length,
		maxDegree,
		maxDegreeId,
		components: roots.size,
		isolated: [...degree.values()].filter((d) => d === 0).length,
		degree
	};
}
