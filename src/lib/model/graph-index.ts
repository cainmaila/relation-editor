// 共用圖索引：ID 對應與有向／無向鄰接（只記 EdgeId），查詢與 UI 不再各自掃全部節點／邊。
import type { GEdge, GNode, Graph } from './types';

export type NodeId = string;
export type EdgeId = string;

export interface GraphIndex {
	nodeById: ReadonlyMap<NodeId, GNode>;
	edgeById: ReadonlyMap<EdgeId, GEdge>;
	/** 以此節點為 to 的邊 */
	incoming: ReadonlyMap<NodeId, readonly EdgeId[]>;
	/** 以此節點為 from 的邊 */
	outgoing: ReadonlyMap<NodeId, readonly EdgeId[]>;
	/** 兩端任一為此節點的邊（自環只記一次） */
	incident: ReadonlyMap<NodeId, readonly EdgeId[]>;
}

/** O(V+E) 建索引；每個節點都有（可能為空的）鄰接清單 */
export function buildGraphIndex(graph: Graph): GraphIndex {
	const nodeById = new Map<NodeId, GNode>();
	const edgeById = new Map<EdgeId, GEdge>();
	const incoming = new Map<NodeId, EdgeId[]>();
	const outgoing = new Map<NodeId, EdgeId[]>();
	const incident = new Map<NodeId, EdgeId[]>();
	const push = (m: Map<NodeId, EdgeId[]>, id: NodeId, e: EdgeId) => {
		const list = m.get(id);
		if (list) list.push(e);
		else m.set(id, [e]);
	};
	for (const n of graph.nodes) {
		nodeById.set(n.id, n);
		incoming.set(n.id, []);
		outgoing.set(n.id, []);
		incident.set(n.id, []);
	}
	for (const e of graph.edges) {
		edgeById.set(e.id, e);
		push(outgoing, e.from, e.id);
		push(incoming, e.to, e.id);
		push(incident, e.from, e.id);
		if (e.to !== e.from) push(incident, e.to, e.id);
	}
	return { nodeById, edgeById, incoming, outgoing, incident };
}

/** 依 ID 清單取邊；索引內的 ID 一定存在 */
export const edgesOf = (idx: GraphIndex, ids: readonly EdgeId[] | undefined): GEdge[] =>
	(ids ?? []).map((id) => idx.edgeById.get(id)!);
