// 圖的純邏輯：未處理、找客戶、到不了客戶、連接限制、刪除檢查、分層排版。
import { CUSTOMER_TYPE, IDC_MESSAGE, ROOT_ID, edgeType, nodeType } from './config';
import type { GEdge, GNode, Graph } from './types';

const isCustomer = (g: Graph, id: string) =>
	g.nodes.find((n) => n.id === id)?.type === CUSTOMER_TYPE;

/** 不看方向連不到根節點的節點 */
export function unprocessed(g: Graph): Set<string> {
	const seen = new Set([ROOT_ID]);
	const queue = [ROOT_ID];
	while (queue.length) {
		const id = queue.shift()!;
		for (const e of g.edges) {
			const other = e.from === id ? e.to : e.to === id ? e.from : null;
			if (other && !seen.has(other)) {
				seen.add(other);
				queue.push(other);
			}
		}
	}
	return new Set(g.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id));
}

/** 沿方向能從 e 由 id 走到的下一個節點；雙向邊兩頭都能走 */
const next = (e: GEdge, id: string) =>
	e.from === id ? e.to : e.bidirectional && e.to === id ? e.from : null;
const prev = (e: GEdge, id: string) =>
	e.to === id ? e.from : e.bidirectional && e.from === id ? e.to : null;

function walk(g: Graph, starts: string[], step: (e: GEdge, id: string) => string | null) {
	const seen = new Set(starts);
	const queue = [...starts];
	while (queue.length) {
		const id = queue.shift()!;
		for (const e of g.edges) {
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
const reachesCustomer = (g: Graph) =>
	walk(
		g,
		g.nodes.filter((n) => n.type === CUSTOMER_TYPE).map((n) => n.id),
		prev
	);

/** 沿方向走不到任何客戶的節點（客戶除外） */
export function unreachable(g: Graph): Set<string> {
	const ok = reachesCustomer(g);
	return new Set(g.nodes.filter((n) => !ok.has(n.id)).map((n) => n.id));
}

export interface CustomerResult {
	customers: string[];
	/** 沿途節點：走得到、且再往下走得到客戶 */
	nodes: Set<string>;
	edges: Set<string>;
}

/** 從 start 沿邊方向找走得到的客戶 */
export function findCustomers(g: Graph, start: string): CustomerResult {
	const ok = reachesCustomer(g);
	const nodes = new Set([...walk(g, [start], next)].filter((id) => ok.has(id)));
	nodes.add(start);
	const edges = new Set(
		g.edges
			.filter((e) => nodes.has(e.from) && nodes.has(e.to) && e.from !== e.to)
			.filter((e) => e.to !== start || e.bidirectional)
			.map((e) => e.id)
	);
	const customers = g.nodes
		.filter((n) => n.id !== start && nodes.has(n.id) && isCustomer(g, n.id))
		.map((n) => n.name);
	return { customers, nodes, edges };
}

/** 通用節點不受連接限制（PRD §3） */
const matches = (list: string[] | undefined, n: GNode) => {
	const t = nodeType(n.type);
	return !list || t.system === null || list.includes(t.name) || list.includes(t.system);
};

/** 新增邊前檢查；回傳錯誤訊息或 null */
export function validateEdge(g: Graph, from: string, to: string, type: string): string | null {
	const t = edgeType(type);
	const a = g.nodes.find((n) => n.id === from)!;
	const b = g.nodes.find((n) => n.id === to)!;
	if (t.idc) return IDC_MESSAGE;
	if (from === to) return '起點與終點不可相同';
	if (!matches(t.from, a)) return `「${t.name}」只能由${t.fromLabel}連出`;
	if (!matches(t.to, b)) return `「${t.name}」只能連到${t.toLabel}`;
	// 機櫃→機框、機框→主機的包含關係屬 IDC 資料
	if (t.name === '包含' && b.readonly) return IDC_MESSAGE;
	return null;
}

/** 刪除節點前檢查；回傳錯誤訊息或 null */
export function checkDeleteNode(g: Graph, id: string): string | null {
	const n = g.nodes.find((x) => x.id === id)!;
	if (n.readonly) return IDC_MESSAGE;
	if (id === ROOT_ID) return '根節點不可刪除';
	if (g.edges.some((e) => e.readonly && (e.from === id || e.to === id)))
		return `${n.type}底下有 IDC 資料，請先在 IDC機櫃配置管理移除機框`;
	return null;
}

/** 可收疊的兄弟節點：同類型、上游完全相同（略過承載）、至少 3 個。key＝堆疊 id */
export function stacks(g: Graph): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const n of g.nodes) {
		const up = g.edges
			.filter((e) => e.to === n.id && e.type !== '承載')
			.map((e) => e.from)
			.sort();
		if (!up.length) continue;
		const key = `stack:${n.type}:${up.join('|')}`;
		groups.set(key, [...(groups.get(key) ?? []), n.id]);
	}
	return new Map([...groups].filter(([, ids]) => ids.length >= 3));
}

export type ViewEdge = GEdge & { members: string[] };

/**
 * 把收起的堆疊換成一張代表卡：成員的邊改接到堆疊，同端點同類型的邊合併成一條。
 * ponytail: 合併邊的雙向、確認狀態取第一條；成員邊屬性不同時要細分再改
 */
export function collapse(g: Graph, closed: Map<string, string[]>) {
	const owner = new Map<string, string>();
	closed.forEach((ids, key) => ids.forEach((id) => owner.set(id, key)));
	const at = (id: string) => owner.get(id) ?? id;
	const nodes: GNode[] = [
		...g.nodes.filter((n) => !owner.has(n.id)),
		...[...closed].map(([id, ids]) => {
			const type = g.nodes.find((n) => n.id === ids[0])!.type;
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
	const into = (id: string) => flow.filter((e) => e.to === id).map((e) => e.from);
	const out = (id: string) => flow.filter((e) => e.from === id).map((e) => e.to);

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
