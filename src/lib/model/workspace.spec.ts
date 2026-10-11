import { describe, expect, it } from 'vitest';
import { buildGraphIndex } from './graph-index';
import type { GEdge, Graph } from './types';
import {
	WORKSPACE_EDGE_LIMIT,
	WORKSPACE_NODE_LIMIT,
	edgeTypesAround,
	externalNeighbors,
	inducedEdgeCount,
	inducedSubgraph,
	neighborIds,
	planWorkspaceAdmission
} from './workspace';

const node = (id: string, type = '通用節點') => ({ id, type, name: id, props: {} });
let seq = 0;
const edge = (from: string, to: string, type = '供電'): GEdge => ({
	id: `e${++seq}`,
	type,
	from,
	to,
	bidirectional: false,
	props: {}
});
const ids = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);

/** 10 個 a × 100 個 b 的完全二分圖：110 個節點、1,000 條邊；extra 再加 a0→a1 一條 */
function bipartite(extra: boolean): Graph {
	const a = ids('a', 10);
	const b = ids('b', 100);
	return {
		nodes: [...a, ...b].map((id) => node(id)),
		edges: [...a.flatMap((x) => b.map((y) => edge(x, y))), ...(extra ? [edge('a0', 'a1')] : [])]
	};
}

describe('planWorkspaceAdmission', () => {
	it('去重、忽略已在工作區的節點；回報實際新增節點與新帶入邊數', () => {
		const g: Graph = { nodes: ['x', 'y', 'z'].map((id) => node(id)), edges: [edge('x', 'y')] };
		const idx = buildGraphIndex(g);
		const r = planWorkspaceAdmission(idx, ['x'], ['y', 'y', 'x', 'z']);
		expect(r).toEqual({
			ok: true,
			value: { ids: ['x', 'y', 'z'], addedIds: ['y', 'z'], rawEdgeCount: 1, addedEdgeCount: 1 }
		});
	});

	it('不存在的節點整批拒絕', () => {
		const idx = buildGraphIndex({ nodes: [node('x')], edges: [] });
		const r = planWorkspaceAdmission(idx, [], ['x', 'nope']);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain('nope');
	});

	it('剛好 200 個節點可，201 整批拒絕並說明需求與可用數', () => {
		const all = ids('n', WORKSPACE_NODE_LIMIT + 1);
		const idx = buildGraphIndex({ nodes: all.map((id) => node(id)), edges: [] });
		const ok = planWorkspaceAdmission(idx, [], all.slice(0, WORKSPACE_NODE_LIMIT));
		expect(ok.ok && ok.value.ids.length).toBe(200);
		const current = all.slice(0, 150);
		const r = planWorkspaceAdmission(idx, current, all.slice(100));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toBe('編輯頁最多 200 個節點：要新增 51 個，只剩 50 個名額');
	});

	it('原始誘導邊剛好 1,000 可，1,001 整批拒絕並說明數字', () => {
		const all = [...ids('a', 10), ...ids('b', 100)];
		const exact = planWorkspaceAdmission(buildGraphIndex(bipartite(false)), [], all);
		expect(exact.ok && exact.value.rawEdgeCount).toBe(WORKSPACE_EDGE_LIMIT);
		// 多一條 a0→a1：分兩批加入，第二批帶入 101 條
		const idx = buildGraphIndex(bipartite(true));
		const r = planWorkspaceAdmission(idx, all.slice(1), ['a0']);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toBe('編輯頁最多 1000 條關係：要帶入 101 條，只剩 100 條名額');
	});

	it('hub 批次：只算兩端都在工作區的邊；不因 hub 度數而拒絕', () => {
		const leaves = ids('l', 300);
		const g: Graph = {
			nodes: [node('hub'), ...leaves.map((id) => node(id))],
			edges: leaves.map((l) => edge('hub', l))
		};
		const idx = buildGraphIndex(g);
		const hub = planWorkspaceAdmission(idx, [], ['hub']);
		expect(hub).toEqual({
			ok: true,
			value: { ids: ['hub'], addedIds: ['hub'], rawEdgeCount: 0, addedEdgeCount: 0 }
		});
		const batch = planWorkspaceAdmission(idx, ['hub'], leaves.slice(0, 199));
		expect(batch.ok && batch.value.addedEdgeCount).toBe(199);
		const over = planWorkspaceAdmission(idx, ['hub'], leaves.slice(0, 200));
		expect(over.ok).toBe(false);
	});

	it('合併呈現的雙邊（包含＋承載）仍按兩條原始邊計數；自環算一次', () => {
		const g: Graph = {
			nodes: [node('rack', '機框'), node('host', '主機')],
			edges: [edge('rack', 'host', '包含'), edge('host', 'rack', '承載'), edge('host', 'host')]
		};
		const r = planWorkspaceAdmission(buildGraphIndex(g), [], ['rack', 'host']);
		expect(r.ok && r.value.rawEdgeCount).toBe(3);
	});

	it('預定新增的節點／邊一起計入預算（新增節點、跨工作區建邊）', () => {
		const all = ids('n', WORKSPACE_NODE_LIMIT);
		const idx = buildGraphIndex({ nodes: all.map((id) => node(id)), edges: [] });
		expect(planWorkspaceAdmission(idx, all.slice(1), [], { newNodes: 1 }).ok).toBe(true);
		const r = planWorkspaceAdmission(idx, all, [], { newNodes: 1 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toBe('編輯頁最多 200 個節點：要新增 1 個，只剩 0 個名額');
		// 缺一個端點＋新邊：端點與邊一起檢查
		const edgeOnly = planWorkspaceAdmission(idx, all.slice(0, 199), [all[199]], { newEdges: 1 });
		expect(edgeOnly).toEqual({
			ok: true,
			value: { ids: all, addedIds: [all[199]], rawEdgeCount: 1, addedEdgeCount: 1 }
		});
		// 已 1,000 條時再建一條邊：拒絕
		const fullIdx = buildGraphIndex(bipartite(false));
		const full = [...ids('a', 10), ...ids('b', 100)];
		expect(planWorkspaceAdmission(fullIdx, full, [], { newEdges: 1 }).ok).toBe(false);
	});

	it('純計算：不改輸入', () => {
		const g = bipartite(true);
		const idx = buildGraphIndex(g);
		const current = Object.freeze(['a0']);
		const req = Object.freeze(['b0', 'b1']);
		const before = JSON.stringify(g);
		planWorkspaceAdmission(idx, current, req);
		expect(JSON.stringify(g)).toBe(before);
		expect(current).toEqual(['a0']);
	});
});

describe('工作區查詢', () => {
	const g: Graph = {
		nodes: ['x', 'p', 'q', 'r', 's'].map((id) => node(id)),
		edges: [
			edge('p', 'x', '供電'),
			edge('q', 'x', '冷卻'),
			edge('x', 'r', '供電'),
			edge('x', 'p', '監測'),
			edge('x', 'x', '連線'),
			edge('s', 'r')
		]
	};
	const idx = buildGraphIndex(g);

	it('一跳鄰居：連入／連出／全部、邊類型篩選、去重、不含自己', () => {
		expect(neighborIds(idx, 'x', 'in', null)).toEqual(['p', 'q']);
		expect(neighborIds(idx, 'x', 'out', null)).toEqual(['p', 'r']);
		expect(neighborIds(idx, 'x', 'all', null)).toEqual(['p', 'q', 'r']);
		expect(neighborIds(idx, 'x', 'all', '供電')).toEqual(['p', 'r']);
		expect(neighborIds(idx, 'x', 'in', '監測')).toEqual([]);
		expect(edgeTypesAround(idx, 'x', 'all')).toEqual(['供電', '冷卻', '監測']);
		expect(edgeTypesAround(idx, 'x', 'in')).toEqual(['供電', '冷卻']);
	});

	it('外部鄰居：完整數量（不受分頁）', () => {
		expect(externalNeighbors(idx, 'x', new Set(['x', 'p']))).toEqual(['q', 'r']);
		expect(externalNeighbors(idx, 'x', new Set(['x', 'p', 'q', 'r']))).toEqual([]);
	});

	it('誘導子圖：只有兩端都在工作區的真實邊，依工作區順序', () => {
		const sub = inducedSubgraph(idx, ['r', 'x', 'p']);
		expect(sub.nodes.map((n) => n.id)).toEqual(['r', 'x', 'p']);
		expect(sub.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(
			['p>x', 'x>r', 'x>p', 'x>x'].sort()
		);
		expect(inducedEdgeCount(idx, ['r', 'x', 'p'])).toBe(4);
		expect(inducedSubgraph(idx, ['gone', 'x']).nodes.map((n) => n.id)).toEqual(['x']);
	});
});
