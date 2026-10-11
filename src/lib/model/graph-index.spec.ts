import { describe, expect, it } from 'vitest';
import { buildGraphIndex } from './graph-index';
import { graphMock, idcMock } from './mock';
import type { Graph } from './types';

const full = (): Graph => {
	const a = graphMock();
	const b = idcMock();
	return { nodes: [...a.nodes, ...b.nodes], edges: [...a.edges, ...b.edges] };
};

describe('buildGraphIndex', () => {
	it('ID 對應與鄰接表與整張圖一致', () => {
		const g = full();
		const idx = buildGraphIndex(g);
		expect(idx.nodeById.size).toBe(g.nodes.length);
		expect(idx.edgeById.size).toBe(g.edges.length);
		for (const n of g.nodes) expect(idx.nodeById.get(n.id)).toBe(n);
		for (const e of g.edges) {
			expect(idx.edgeById.get(e.id)).toBe(e);
			expect(idx.outgoing.get(e.from)).toContain(e.id);
			expect(idx.incoming.get(e.to)).toContain(e.id);
			expect(idx.incident.get(e.from)).toContain(e.id);
			expect(idx.incident.get(e.to)).toContain(e.id);
		}
		const total = (m: ReadonlyMap<string, readonly string[]>) =>
			[...m.values()].reduce((s, l) => s + l.length, 0);
		expect(total(idx.outgoing)).toBe(g.edges.length);
		expect(total(idx.incoming)).toBe(g.edges.length);
		expect(total(idx.incident)).toBe(g.edges.length * 2);
	});

	it('每個節點都有（可能為空的）鄰接清單；自環只記一次', () => {
		const g: Graph = {
			nodes: [
				{ id: 'a', type: '大樓', name: 'a', props: {} },
				{ id: 'b', type: '大樓', name: 'b', props: {} }
			],
			edges: [{ id: 'loop', type: '包含', from: 'a', to: 'a', bidirectional: false, props: {} }]
		};
		const idx = buildGraphIndex(g);
		expect(idx.incident.get('a')).toEqual(['loop']);
		expect(idx.incident.get('b')).toEqual([]);
		expect(idx.outgoing.get('b')).toEqual([]);
		expect(idx.incoming.get('b')).toEqual([]);
	});
});
