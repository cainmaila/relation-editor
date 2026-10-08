// 效能實驗用：把 2F mock（含 IDC）複製到多層樓（id、name 加樓層前綴），湊出上萬節點。
import { graphMock, idcMock } from './mock';
import type { Graph } from './types';

export function bigMock(floors = 5): Graph {
	const a = graphMock();
	const b = idcMock();
	const base: Graph = { nodes: [...a.nodes, ...b.nodes], edges: [...a.edges, ...b.edges] };
	const nodes: Graph['nodes'] = [];
	const edges: Graph['edges'] = [];
	for (let f = 2; f < 2 + floors; f++) {
		const p = (s: string) => `${f}F|${s}`;
		for (const n of base.nodes) nodes.push({ ...n, id: p(n.id), name: p(n.name) });
		for (const e of base.edges) {
			const from = p(e.from);
			const to = p(e.to);
			edges.push({ ...e, id: `${e.type}:${from}>${to}`, from, to });
		}
	}
	return { nodes, edges };
}
