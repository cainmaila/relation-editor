// 圖的命令、變更集與 revision 分類：所有標準圖寫入都經 applyCommand，先驗證完全部欄位才產生新狀態。
import { CONFIRM_STATES, IDC_MESSAGE, NODE_TYPES } from './config';
import { checkDeleteNode, validateEdge } from './graph';
import { buildGraphIndex, type EdgeId, type GraphIndex, type NodeId } from './graph-index';
import type { GEdge, GNode, Graph, Props } from './types';

export type { EdgeId, GraphIndex, NodeId } from './graph-index';

/** revision：任何資料變更都加一；topologyRevision：只在節點／邊增刪或方向改變時加一 */
export type Revision = { revision: number; topologyRevision: number };

export type CommandResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** 一筆命令造成的變更 ID 集合；下游只更新受影響的文件／標記 */
export interface GraphChange extends Revision {
	/** 這筆變更是否影響拓撲（=topologyRevision 有前進） */
	topology: boolean;
	upsertNodes: readonly GNode[];
	removeNodeIds: readonly NodeId[];
	upsertEdges: readonly GEdge[];
	removeEdgeIds: readonly EdgeId[];
}

/** 節點可編欄位；未給的欄位不變 */
export type NodePatch = { name?: string; props?: Props };
/** 邊可編欄位；未給的欄位不變 */
export type EdgePatch = { bidirectional?: boolean; props?: Props };

export type GraphCommand =
	| { kind: 'addNode'; node: GNode }
	| { kind: 'addEdge'; edge: GEdge }
	| { kind: 'deleteNode'; id: NodeId }
	| { kind: 'deleteEdge'; id: EdgeId }
	/** base：草稿開始時看到的物件；與目前不同代表已被其他操作改過，拒絕寫入 */
	| { kind: 'updateNode'; id: NodeId; patch: NodePatch; base?: GNode }
	| { kind: 'updateEdge'; id: EdgeId; patch: EdgePatch; base?: GEdge };

export interface GraphState extends Revision {
	graph: Graph;
	index: GraphIndex;
}

export const initialGraphState = (graph: Graph): GraphState => ({
	graph,
	index: buildGraphIndex(graph),
	revision: 0,
	topologyRevision: 0
});

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** 屬性檢查：名稱不可空白；確認狀態只能是固定值 */
function checkProps(props: Props | undefined): string | null {
	for (const [k, v] of Object.entries(props ?? {})) {
		if (!k.trim()) return '屬性名稱不可空白';
		if (k === '確認狀態' && !CONFIRM_STATES.includes(v))
			return `確認狀態只能是：${CONFIRM_STATES.join('、')}`;
	}
	return null;
}

const stale = (name: string) => `「${name}」已被其他操作變更，請重新編輯`;

type Plan = Omit<GraphChange, keyof Revision> & { graph: Graph };

/** 驗證並算出新圖；不改動輸入 */
function plan(s: GraphState, cmd: GraphCommand): CommandResult<Plan> {
	const { graph, index } = s;
	const none = { upsertNodes: [], removeNodeIds: [], upsertEdges: [], removeEdgeIds: [] };
	switch (cmd.kind) {
		case 'addNode': {
			const n = cmd.node;
			if (index.nodeById.has(n.id)) return fail(`節點已存在：${n.id}`);
			const t = NODE_TYPES.find((x) => x.name === n.type);
			if (!t) return fail(`未知的節點類型：${n.type}`);
			if (t.idc) return fail(IDC_MESSAGE);
			if (!n.name.trim()) return fail('名稱不可空白');
			const err = checkProps(n.props);
			if (err) return fail(err);
			return {
				ok: true,
				value: {
					...none,
					topology: true,
					upsertNodes: [n],
					graph: { ...graph, nodes: [...graph.nodes, n] }
				}
			};
		}
		case 'addEdge': {
			const e = cmd.edge;
			if (index.edgeById.has(e.id)) return fail(`邊已存在：${e.id}`);
			const err = validateEdge(graph, e.from, e.to, e.type, index) ?? checkProps(e.props);
			if (err) return fail(err);
			return {
				ok: true,
				value: {
					...none,
					topology: true,
					upsertEdges: [e],
					graph: { ...graph, edges: [...graph.edges, e] }
				}
			};
		}
		case 'deleteNode': {
			const err = checkDeleteNode(graph, cmd.id, index);
			if (err) return fail(err);
			const removeEdgeIds = index.incident.get(cmd.id) ?? [];
			const gone = new Set(removeEdgeIds);
			return {
				ok: true,
				value: {
					...none,
					topology: true,
					removeNodeIds: [cmd.id],
					removeEdgeIds,
					graph: {
						nodes: graph.nodes.filter((n) => n.id !== cmd.id),
						edges: graph.edges.filter((e) => !gone.has(e.id))
					}
				}
			};
		}
		case 'deleteEdge': {
			const e = index.edgeById.get(cmd.id);
			if (!e) return fail(`邊不存在：${cmd.id}`);
			if (e.readonly) return fail(IDC_MESSAGE);
			return {
				ok: true,
				value: {
					...none,
					topology: true,
					removeEdgeIds: [cmd.id],
					graph: { ...graph, edges: graph.edges.filter((x) => x.id !== cmd.id) }
				}
			};
		}
		case 'updateNode': {
			const cur = index.nodeById.get(cmd.id);
			if (!cur) return fail(`節點不存在：${cmd.id}`);
			if (cmd.base && cmd.base !== cur) return fail(stale(cur.name));
			if (cur.readonly) return fail(IDC_MESSAGE);
			const { name, props } = cmd.patch;
			if (name !== undefined && !name.trim()) return fail('名稱不可空白');
			const err = checkProps(props);
			if (err) return fail(err);
			const next: GNode = {
				...cur,
				...(name !== undefined && { name: name.trim() }),
				...(props && { props: { ...props } })
			};
			return {
				ok: true,
				value: {
					...none,
					topology: false,
					upsertNodes: [next],
					graph: { ...graph, nodes: graph.nodes.map((n) => (n === cur ? next : n)) }
				}
			};
		}
		case 'updateEdge': {
			const cur = index.edgeById.get(cmd.id);
			if (!cur) return fail(`邊不存在：${cmd.id}`);
			if (cmd.base && cmd.base !== cur) return fail(stale(cmd.id));
			if (cur.readonly) return fail(IDC_MESSAGE);
			const { bidirectional, props } = cmd.patch;
			const err = checkProps(props);
			if (err) return fail(err);
			const next: GEdge = {
				...cur,
				...(bidirectional !== undefined && { bidirectional }),
				...(props && { props: { ...props } })
			};
			return {
				ok: true,
				value: {
					...none,
					// 方向影響找客戶／無客戶路徑，屬拓撲
					topology: next.bidirectional !== cur.bidirectional,
					upsertEdges: [next],
					graph: { ...graph, edges: graph.edges.map((e) => (e === cur ? next : e)) }
				}
			};
		}
	}
}

/** 換掉 ID 對應中被更新的項目；沒有更新就沿用原 Map */
function replaceById<V extends { id: string }>(m: ReadonlyMap<string, V>, xs: readonly V[]) {
	if (!xs.length) return m;
	const out = new Map(m);
	for (const x of xs) out.set(x.id, x);
	return out;
}

/** 套用命令：失敗時回傳原因、輸入狀態完全不變；成功時回傳新狀態與變更集 */
export function applyCommand(
	s: GraphState,
	cmd: GraphCommand
): CommandResult<{ state: GraphState; change: GraphChange }> {
	const r = plan(s, cmd);
	if (!r.ok) return r;
	const p = r.value;
	const revision = s.revision + 1;
	const topologyRevision = s.topologyRevision + (p.topology ? 1 : 0);
	// 增刪改了鄰接，整張重建（O(V+E)）；欄位變更只換 ID 對應，鄰接只記 ID 可沿用
	const index =
		cmd.kind === 'updateNode' || cmd.kind === 'updateEdge'
			? {
					...s.index,
					nodeById: replaceById(s.index.nodeById, p.upsertNodes),
					edgeById: replaceById(s.index.edgeById, p.upsertEdges)
				}
			: buildGraphIndex(p.graph);
	const { graph, ...rest } = p;
	return {
		ok: true,
		value: {
			state: { graph, index, revision, topologyRevision },
			change: { ...rest, revision, topologyRevision }
		}
	};
}
