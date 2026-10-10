import { expect, test } from 'vitest';
import { runLayout } from './layout-sim';

const links: [number, number][] = [
	[0, 1],
	[1, 2],
	[2, 0],
	[2, 3]
];

test('zero init: every node starts coincident; d3 init: spread', () => {
	const zero = runLayout({ n: 5, links, ticks: 0, init: 'zero' });
	expect([...zero.pos].every((v) => v === 0)).toBe(true);
	const spread = runLayout({ n: 5, links, ticks: 0, init: 'd3' });
	expect(new Set([...spread.pos].map((v) => v.toFixed(3))).size).toBeGreaterThan(3);
});

test('deterministic per init, finite, one timing per tick', () => {
	for (const init of ['zero', 'd3'] as const) {
		const a = runLayout({ n: 5, links, ticks: 20, init });
		const b = runLayout({ n: 5, links, ticks: 20, init });
		expect([...a.pos]).toEqual([...b.pos]);
		expect(a.pos.length).toBe(15);
		expect([...a.pos].every(Number.isFinite)).toBe(true);
		expect(a.tickMs.length).toBe(20);
	}
});
