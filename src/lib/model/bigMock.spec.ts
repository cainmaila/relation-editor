import { expect, test } from 'vitest';
import { bigMock } from './bigMock';

test('bigMock ≈ 10k nodes, ids unique, edges resolve', () => {
	const g = bigMock();
	const ids = new Set(g.nodes.map((n) => n.id));
	expect(ids.size).toBe(g.nodes.length);
	expect(g.nodes.length).toBeGreaterThan(10000);
	expect(g.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
});
