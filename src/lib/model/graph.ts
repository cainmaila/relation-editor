// 圖的純邏輯：未處理、找客戶、到不了客戶、連接限制、刪除檢查、泳道排版。
import {
	CUSTOMER_TYPE,
	IDC_MESSAGE,
	ROOT_ID,
	SYSTEMS,
	edgeType,
	nodeType,
	type System
} from './config';
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

const matches = (list: string[] | undefined, n: GNode) => {
	const t = nodeType(n.type);
	return !list || list.includes(t.name) || (t.system !== null && list.includes(t.system));
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

export type Lane = System | '通用';
/** 通用節點放空間與電力之間的中間帶 */
export const LANES: Lane[] = [SYSTEMS[0], '通用', ...SYSTEMS.slice(1)];
export const laneOf = (n: GNode): Lane => nodeType(n.type).system ?? '通用';

export const NODE_W = 160;
export const NODE_H = 44;
const GAP = 16;
/** 上下層間距，讓層間的邊看得清楚 */
const ROW_GAP = 40;
export const LANE_PAD = 24;
export const LANE_HEADER = 48;

export interface LaneBox {
	lane: Lane;
	x: number;
	width: number;
	height: number;
}

/** 泳道排版：欄內是一棵樹，深度往下、兄弟往右（父節點置中於子節點上方），同層平行的節點才不會疊成假鏈 */
export function layout(g: Graph, lanes: Lane[]) {
	const pos = new Map<string, { x: number; y: number }>();
	const boxes: LaneBox[] = [];
	let x = 0;
	for (const lane of lanes) {
		const members = g.nodes.filter((n) => laneOf(n) === lane);
		const ids = new Set(members.map((n) => n.id));
		// 承載（主機→機框）與包含反向，排版時略過以免成環
		const inner = g.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.type !== '承載');
		const depth = new Map<string, number>();
		const visiting = new Set<string>();
		const d = (id: string): number => {
			if (depth.has(id)) return depth.get(id)!;
			if (visiting.has(id)) return 0;
			visiting.add(id);
			const parents = inner.filter((e) => e.to === id).map((e) => d(e.from) + 1);
			const v = Math.max(0, ...parents);
			depth.set(id, v);
			return v;
		};
		members.forEach((n) => d(n.id));
		// 多父節點只掛在第一個「剛好淺一層」的父節點下，確保每個節點只擺一次
		const parent = new Map<string, string>();
		for (const e of inner)
			if (!parent.has(e.to) && depth.get(e.from)! + 1 === depth.get(e.to)) parent.set(e.to, e.from);
		let slot = 0;
		const place = (id: string): number => {
			const kids = members.filter((n) => parent.get(n.id) === id).map((n) => place(n.id));
			const s = kids.length ? (kids[0] + kids[kids.length - 1]) / 2 : slot++;
			pos.set(id, {
				x: x + LANE_PAD + s * (NODE_W + GAP),
				y: LANE_HEADER + depth.get(id)! * (NODE_H + ROW_GAP)
			});
			return s;
		};
		members.filter((n) => !parent.has(n.id)).forEach((n) => place(n.id));
		const width = Math.max(1, slot) * (NODE_W + GAP) - GAP + 2 * LANE_PAD;
		const rows = Math.max(-1, ...depth.values()) + 1;
		boxes.push({ lane, x, width, height: LANE_HEADER + rows * (NODE_H + ROW_GAP) + LANE_PAD });
		x += width + GAP;
	}
	const height = Math.max(0, ...boxes.map((b) => b.height));
	boxes.forEach((b) => (b.height = height));
	return { pos, boxes };
}
