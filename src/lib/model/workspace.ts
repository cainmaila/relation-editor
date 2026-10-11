// 局部工作區：membership、200 節點／1,000 條原始誘導邊預算、加入 admission、一跳鄰居查詢。
// 全部是純計算，只讀索引；Editor 確認後才一次提交。
import type { CommandResult } from './graph-change';
import { edgesOf, type GraphIndex, type NodeId } from './graph-index';
import type { GEdge, GNode } from './types';

/** 首版驗收預算；收疊、合併呈現都不降低計數 */
export const WORKSPACE_NODE_LIMIT = 200;
export const WORKSPACE_EDGE_LIMIT = 1000;

export interface WorkspaceAdmission {
	/** 提交後的完整工作區（原順序＋新加入的接在後面） */
	ids: NodeId[];
	/** 實際新加入的既有節點（已去重、排除已在工作區） */
	addedIds: NodeId[];
	/** 提交後兩端都在工作區的原始邊數（含預定新增的邊） */
	rawEdgeCount: number;
	/** 這次新帶入的原始邊數（含預定新增的邊） */
	addedEdgeCount: number;
}

/** 同一次提交要新建的節點／邊（新增節點、跨工作區建邊） */
export type Proposed = { newNodes?: number; newEdges?: number };

export type Direction = 'in' | 'out' | 'all';

/** 兩端都在 ids 內的原始邊數；自環算一次 */
export function inducedEdgeCount(index: GraphIndex, ids: Iterable<NodeId>): number {
	const set = ids instanceof Set ? (ids as ReadonlySet<NodeId>) : new Set(ids);
	let n = 0;
	for (const id of set)
		for (const e of edgesOf(index, index.outgoing.get(id))) if (set.has(e.to)) n++;
	return n;
}

/**
 * 加入前的完整檢查：去重、全部節點存在、加入後節點與原始誘導邊都不超過預算。
 * 任一條件不符就整批拒絕（不自動切掉超出的部分）；不改任何輸入。
 */
export function planWorkspaceAdmission(
	index: GraphIndex,
	currentIds: readonly NodeId[],
	requestedIds: readonly NodeId[],
	proposed: Proposed = {}
): CommandResult<WorkspaceAdmission> {
	const missing = requestedIds.find((id) => !index.nodeById.has(id));
	if (missing !== undefined) return { ok: false, message: `節點不存在：${missing}` };
	const set = new Set(currentIds);
	const addedIds = [...new Set(requestedIds)].filter((id) => !set.has(id));
	const newNodes = proposed.newNodes ?? 0;
	const newEdges = proposed.newEdges ?? 0;
	const room = WORKSPACE_NODE_LIMIT - set.size;
	const want = addedIds.length + newNodes;
	if (want > room)
		return {
			ok: false,
			message: `編輯頁最多 ${WORKSPACE_NODE_LIMIT} 個節點：要新增 ${want} 個，只剩 ${Math.max(room, 0)} 個名額`
		};
	const before = inducedEdgeCount(index, set);
	for (const id of addedIds) set.add(id);
	// 只看新節點的鄰接：一端是新節點、另一端在提交後的工作區；兩端都新的邊用 ID 去重
	const brought = new Set<string>();
	for (const id of addedIds)
		for (const e of edgesOf(index, index.incident.get(id)))
			if (set.has(e.from) && set.has(e.to)) brought.add(e.id);
	const addedEdgeCount = brought.size + newEdges;
	const edgeRoom = WORKSPACE_EDGE_LIMIT - before;
	if (addedEdgeCount > edgeRoom)
		return {
			ok: false,
			message: `編輯頁最多 ${WORKSPACE_EDGE_LIMIT} 條關係：要帶入 ${addedEdgeCount} 條，只剩 ${Math.max(edgeRoom, 0)} 條名額`
		};
	return {
		ok: true,
		value: {
			ids: [...currentIds, ...addedIds],
			addedIds,
			rawEdgeCount: before + addedEdgeCount,
			addedEdgeCount
		}
	};
}

/** 工作區的誘導子圖：依工作區順序的節點，兩端都在的真實邊；O(工作區度數總和) */
export function inducedSubgraph(index: GraphIndex, ids: readonly NodeId[]) {
	const set = new Set(ids);
	const nodes: GNode[] = [];
	const edges: GEdge[] = [];
	for (const id of ids) {
		const n = index.nodeById.get(id);
		if (!n) continue;
		nodes.push(n);
		for (const e of edgesOf(index, index.outgoing.get(id))) if (set.has(e.to)) edges.push(e);
	}
	return { nodes, edges };
}

const edgesIn = (index: GraphIndex, id: NodeId, dir: Direction) =>
	edgesOf(
		index,
		dir === 'in'
			? index.incoming.get(id)
			: dir === 'out'
				? index.outgoing.get(id)
				: index.incident.get(id)
	);
const otherEnd = (e: GEdge, id: NodeId) => (e.from === id ? e.to : e.from);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 直接一跳鄰居（去重、不含自己），依 ID 排序；edgeType＝null 不篩 */
export function neighborIds(
	index: GraphIndex,
	id: NodeId,
	dir: Direction,
	edgeType: string | null
): NodeId[] {
	const out = new Set<NodeId>();
	for (const e of edgesIn(index, id, dir)) {
		if (edgeType && e.type !== edgeType) continue;
		const o = otherEnd(e, id);
		if (o !== id) out.add(o);
	}
	return [...out].sort(byId);
}

/** 該方向通往其他節點的邊類型（排序；自環不算） */
export function edgeTypesAround(index: GraphIndex, id: NodeId, dir: Direction): string[] {
	const edges = edgesIn(index, id, dir).filter((e) => otherEnd(e, id) !== id);
	return [...new Set(edges.map((e) => e.type))].sort(byId);
}

/** 不在工作區的全部直接鄰居（完整，不分頁） */
export function externalNeighbors(
	index: GraphIndex,
	id: NodeId,
	members: ReadonlySet<NodeId>
): NodeId[] {
	return neighborIds(index, id, 'all', null).filter((o) => !members.has(o));
}
