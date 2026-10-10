// 圖的純邏輯：未處理、找客戶、到不了客戶、連接限制、刪除檢查、分層排版。
import { CUSTOMER_TYPE, IDC_MESSAGE, ROOT_ID, edgeType, nodeType } from './config';
import { buildGraphIndex, edgesOf, type GraphIndex } from './graph-index';
import type { GEdge, GNode, Graph } from './types';

/** 不看方向連不到根節點的節點 */
export function unprocessed(g: Graph, idx: GraphIndex = buildGraphIndex(g)): Set<string> {
	const seen = walk(idx, idx.nodeById.has(ROOT_ID) ? [ROOT_ID] : [], (e, id) =>
		e.from === id ? e.to : e.to === id ? e.from : null
	);
	return new Set(g.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id));
}

/** 沿方向能從 e 由 id 走到的下一個節點；雙向邊兩頭都能走 */
const next = (e: GEdge, id: string) =>
	e.from === id ? e.to : e.bidirectional && e.to === id ? e.from : null;
const prev = (e: GEdge, id: string) =>
	e.to === id ? e.from : e.bidirectional && e.from === id ? e.to : null;

/** 由 starts 沿 incident 鄰接表 BFS，O(V+E) */
function walk(idx: GraphIndex, starts: string[], step: (e: GEdge, id: string) => string | null) {
	const seen = new Set(starts);
	const queue = [...starts];
	for (let i = 0; i < queue.length; i++) {
		const id = queue[i];
		for (const e of edgesOf(idx, idx.incident.get(id))) {
			const other = step(e, id);
			if (other && !seen.has(other)) {
				seen.add(other);
				queue.push(other);
			}
		}
	}
	return seen;
}

/** 沿方向走得到客戶的節點（含客戶本身） */
const reachesCustomer = (g: Graph, idx: GraphIndex) =>
	walk(
		idx,
		g.nodes.filter((n) => n.type === CUSTOMER_TYPE).map((n) => n.id),
		prev
	);

/** 沿方向走不到任何客戶的節點（客戶除外） */
export function unreachable(g: Graph, idx: GraphIndex = buildGraphIndex(g)): Set<string> {
	const ok = reachesCustomer(g, idx);
	return new Set(g.nodes.filter((n) => !ok.has(n.id)).map((n) => n.id));
}

export interface CustomerResult {
	/** 客戶名稱（顯示用） */
	customers: string[];
	/** 與 customers 同序的客戶 ID */
	customerIds: string[];
	/** 沿途節點：走得到、且再往下走得到客戶 */
	nodes: Set<string>;
	edges: Set<string>;
}

/** 從 start 沿邊方向找走得到的客戶 */
export function findCustomers(
	g: Graph,
	start: string,
	idx: GraphIndex = buildGraphIndex(g)
): CustomerResult {
	const ok = reachesCustomer(g, idx);
	const nodes = new Set([...walk(idx, [start], next)].filter((id) => ok.has(id)));
	nodes.add(start);
	// 只看沿途節點連出的邊，不掃全部邊
	const edges = new Set<string>();
	for (const id of nodes)
		for (const e of edgesOf(idx, idx.outgoing.get(id)))
			if (nodes.has(e.to) && e.from !== e.to && (e.to !== start || e.bidirectional))
				edges.add(e.id);
	const found = g.nodes.filter(
		(n) => n.id !== start && nodes.has(n.id) && n.type === CUSTOMER_TYPE
	);
	return { customers: found.map((n) => n.name), customerIds: found.map((n) => n.id), nodes, edges };
}

/** 通用節點不受連接限制（PRD §3） */
const GENERIC = '通用節點';
const matches = (list: string[] | undefined, n: GNode) => {
	const t = nodeType(n.type);
	return (
		!list ||
		t.name === GENERIC ||
		list.includes(t.name) ||
		(t.system !== null && list.includes(t.system))
	);
};

/** 新增邊前檢查；回傳錯誤訊息或 null */
export function validateEdge(
	g: Graph,
	from: string,
	to: string,
	type: string,
	idx: GraphIndex = buildGraphIndex(g)
): string | null {
	const t = edgeType(type);
	const a = idx.nodeById.get(from);
	const b = idx.nodeById.get(to);
	if (!a) return `節點不存在：${from}`;
	if (!b) return `節點不存在：${to}`;
	if (t.idc) return IDC_MESSAGE;
	if (from === to) return '起點與終點不可相同';
	if (!matches(t.from, a)) return `「${t.name}」只能由${t.fromLabel}連出`;
	if (!matches(t.to, b)) return `「${t.name}」只能連到${t.toLabel}`;
	// 機櫃→機框、機框→主機的包含關係屬 IDC 資料
	if (t.name === '包含' && b.readonly) return IDC_MESSAGE;
	return null;
}

/** 刪除節點前檢查；回傳錯誤訊息或 null */
export function checkDeleteNode(
	g: Graph,
	id: string,
	idx: GraphIndex = buildGraphIndex(g)
): string | null {
	const n = idx.nodeById.get(id);
	if (!n) return `節點不存在：${id}`;
	if (n.readonly) return IDC_MESSAGE;
	if (id === ROOT_ID) return '根節點不可刪除';
	if (edgesOf(idx, idx.incident.get(id)).some((e) => e.readonly))
		return `${n.type}底下有 IDC 資料，請先在 IDC機櫃配置管理移除機框`;
	return null;
}

/** 可收疊的兄弟節點：同類型、上游完全相同（略過承載）、至少 3 個。key＝堆疊 id */
export function stacks(g: Graph): Map<string, string[]> {
	const into = new Map<string, Set<string>>();
	for (const e of g.edges)
		if (e.type !== '承載') into.set(e.to, (into.get(e.to) ?? new Set()).add(e.from));
	const groups = new Map<string, string[]>();
	for (const n of g.nodes) {
		const up = [...(into.get(n.id) ?? [])].sort();
		if (!up.length) continue;
		const key = `stack:${n.type}:${up.join('|')}`;
		groups.set(key, [...(groups.get(key) ?? []), n.id]);
	}
	// 成員之間有邊會讓合併邊變自環，這類成員不收疊
	const nbr = new Map<string, Set<string>>();
	for (const e of g.edges) {
		(nbr.get(e.from) ?? nbr.set(e.from, new Set()).get(e.from)!).add(e.to);
		(nbr.get(e.to) ?? nbr.set(e.to, new Set()).get(e.to)!).add(e.from);
	}
	const linked = (ids: Set<string>, id: string) => [...(nbr.get(id) ?? [])].some((x) => ids.has(x));
	return new Map(
		[...groups]
			.map(([k, ids]) => {
				const set = new Set(ids);
				return [k, ids.filter((id) => !linked(set, id))] as const;
			})
			.filter(([, ids]) => ids.length >= STACK_MIN)
	);
}

/** 至少幾個成員才收成一疊 */
export const STACK_MIN = 3;

export type ViewEdge = GEdge & { members: string[] };

/**
 * 把收起的堆疊換成一張代表卡：成員的邊改接到堆疊，同端點同類型的邊合併成一條。
 * ponytail: 合併邊的雙向、確認狀態取第一條；成員邊屬性不同時要細分再改
 */
export function collapse(g: Graph, closed: Map<string, string[]>) {
	const owner = new Map<string, string>();
	closed.forEach((ids, key) => ids.forEach((id) => owner.set(id, key)));
	const byId = new Map(g.nodes.map((n) => [n.id, n]));
	const at = (id: string) => owner.get(id) ?? id;
	const nodes: GNode[] = [
		...g.nodes.filter((n) => !owner.has(n.id)),
		...[...closed].map(([id, ids]) => {
			const type = byId.get(ids[0])!.type;
			return { id, type, name: `${type} ×${ids.length}`, props: {} };
		})
	];
	const edges = new Map<string, ViewEdge>();
	for (const e of g.edges) {
		const [from, to] = [at(e.from), at(e.to)];
		const id = from === e.from && to === e.to ? e.id : `${e.type}:${from}>${to}`;
		const x = edges.get(id);
		if (x) x.members.push(e.id);
		else edges.set(id, { ...e, id, from, to, members: [e.id] });
	}
	return { nodes, edges: [...edges.values()], owner };
}

export const NODE_W = 160;
export const NODE_H = 44;
const GAP = 12;
/** 欄間距，留空間給層間的邊 */
const COL_GAP = 96;

/**
 * 分層排版（由左往右）：x＝沿邊方向的層級（上游在左、客戶在最右欄），y＝同層的平行節點。
 * 系統不佔位置，改由顏色區分；找客戶永遠往右走。
 */
export function layout(g: Graph) {
	// 承載（主機→機框）與包含反向，排版時略過以免成環
	const flow = g.edges.filter((e) => e.type !== '承載');
	const inMap = new Map<string, string[]>();
	const outMap = new Map<string, string[]>();
	for (const e of flow) {
		(inMap.get(e.to) ?? inMap.set(e.to, []).get(e.to)!).push(e.from);
		(outMap.get(e.from) ?? outMap.set(e.from, []).get(e.from)!).push(e.to);
	}
	const into = (id: string) => inMap.get(id) ?? [];
	const out = (id: string) => outMap.get(id) ?? [];

	// 層級＝最長上游路徑；客戶固定放最後一欄
	const layer = new Map<string, number>();
	const visiting = new Set<string>();
	const d = (id: string): number => {
		if (layer.has(id)) return layer.get(id)!;
		if (visiting.has(id)) return 0;
		visiting.add(id);
		const v = Math.max(0, ...into(id).map((p) => d(p) + 1));
		layer.set(id, v);
		return v;
	};
	const rest = g.nodes.filter((n) => n.type !== CUSTOMER_TYPE);
	rest.forEach((n) => d(n.id));
	const last = Math.max(-1, ...rest.map((n) => layer.get(n.id)!)) + 1;
	g.nodes.forEach((n) => n.type === CUSTOMER_TYPE && layer.set(n.id, last));

	const cols: string[][] = [];
	g.nodes.forEach((n) => (cols[layer.get(n.id)!] ??= []).push(n.id));
	for (let i = 0; i < cols.length; i++) cols[i] ??= [];

	// 同欄排序：重心法來回掃幾次，減少交叉
	const idx = new Map<string, number>();
	cols.forEach((c) => c.forEach((id, i) => idx.set(id, i)));
	const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
	for (let k = 0; k < 4; k++) {
		const down = k % 2 === 0;
		for (const col of down ? cols : [...cols].reverse()) {
			const bc = (id: string) => {
				const nb = (down ? into(id) : out(id)).map((x) => idx.get(x)!);
				return nb.length ? avg(nb) : idx.get(id)!;
			};
			const key = new Map(col.map((id) => [id, bc(id)]));
			col.sort((a, b) => key.get(a)! - key.get(b)!);
			col.forEach((id, i) => idx.set(id, i));
		}
	}

	// y：盡量對齊上游（反向再對齊下游），同欄依序往下推開不重疊
	const y = new Map<string, number>();
	const settle = (col: string[], want: (id: string) => number | null) => {
		let min = -Infinity;
		for (const id of col) {
			const v = Math.max(want(id) ?? y.get(id) ?? min, min === -Infinity ? 0 : min);
			y.set(id, v);
			min = v + NODE_H + GAP;
		}
	};
	const near = (ids: string[]) => {
		const ys = ids.filter((i) => y.has(i)).map((i) => y.get(i)!);
		return ys.length ? avg(ys) : null;
	};
	cols.forEach((c) => settle(c, (id) => near(into(id))));
	// 源頭（沒有上游）往下游的位置靠
	[...cols]
		.reverse()
		.forEach((c) => settle(c, (id) => (into(id).length ? y.get(id)! : near(out(id)))));

	const pos = new Map<string, { x: number; y: number }>();
	cols.forEach((c, i) =>
		c.forEach((id) => pos.set(id, { x: i * (NODE_W + COL_GAP), y: y.get(id)! }))
	);
	return { pos };
}

type XY = { x: number; y: number };

/** 沿用 prev 的位置；新節點用 next 的欄，與同欄卡片重疊就排到該欄最下方 */
export function pin(prev: Map<string, XY>, next: Map<string, XY>) {
	const out = new Map<string, XY>();
	for (const id of next.keys()) if (prev.has(id)) out.set(id, prev.get(id)!);
	for (const [id, p] of next) {
		if (out.has(id)) continue;
		const col = [...out.values()].filter((q) => q.x === p.x);
		const hit = col.some((q) => Math.abs(q.y - p.y) < NODE_H + GAP);
		out.set(id, hit ? { x: p.x, y: Math.max(...col.map((q) => q.y)) + NODE_H + GAP } : p);
	}
	return out;
}
