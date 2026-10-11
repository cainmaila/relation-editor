import { describe, expect, it } from 'vitest';
import { idsKey, pack, reconcile, seedPositions, unpack, type Position3 } from './layout';

const ids = (n: number, p = 'n') => Array.from({ length: n }, (_, i) => `${p}-${i}`);
/** 以 Float32 精度比較是否重合（renderer 實際用的精度） */
const coincident = (ps: Iterable<Position3>) => {
	const seen = new Set<string>();
	for (const p of ps) {
		const k = [...Float32Array.from(p)].join(',');
		if (seen.has(k)) return true;
		seen.add(k);
	}
	return false;
};
const dist = (p: Position3, q: Position3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

describe('seedPositions', () => {
	it('deterministic, independent of input order, finite and non-coincident (10k)', () => {
		const a = ids(10_000);
		const s1 = seedPositions(a);
		const s2 = seedPositions([...a].reverse());
		expect(s1.size).toBe(10_000);
		for (const id of ['n-0', 'n-42', 'n-9999']) expect(s1.get(id)).toEqual(s2.get(id));
		expect([...s1.values()].flat().every(Number.isFinite)).toBe(true);
		expect(coincident(s1.values())).toBe(false);
	});

	it('not degenerate: points spread in all three axes', () => {
		const s = [...seedPositions(ids(500)).values()];
		for (let k = 0; k < 3; k++) {
			const v = s.map((p) => p[k]);
			expect(Math.max(...v) - Math.min(...v)).toBeGreaterThan(50);
		}
	});
});

describe('reconcile', () => {
	const near = (g: Record<string, string[]>) => (id: string) => g[id] ?? [];

	it('keeps existing coordinates untouched and drops removed ids', () => {
		const prev = seedPositions(['a', 'b', 'c']);
		const before = structuredClone([...prev]);
		const r = reconcile(prev, ['a', 'c'], near({}));
		expect(r.positions.get('a')).toEqual(prev.get('a'));
		expect(r.positions.get('c')).toEqual(prev.get('c'));
		expect(r.positions.has('b')).toBe(false);
		expect(r.added).toEqual([]);
		expect(r.removed).toBe(1);
		// 不改動輸入
		expect([...prev]).toEqual(before);
	});

	it('places a new node near its placed neighbours, not at origin, non-coincident', () => {
		const prev = new Map<string, Position3>([
			['a', [500, 500, 500]],
			['b', [520, 500, 500]]
		]);
		const g = near({ x: ['a', 'b'], y: ['a', 'b'] });
		const r = reconcile(prev, ['a', 'b', 'x', 'y'], g);
		expect(r.added).toEqual(['x', 'y']);
		expect(dist(r.positions.get('x')!, [510, 500, 500])).toBeLessThan(60);
		expect(coincident(r.positions.values())).toBe(false);
		// 同樣的輸入同樣的結果
		expect(reconcile(prev, ['a', 'b', 'x', 'y'], g).positions).toEqual(r.positions);
	});

	it('new node whose neighbour is also new chains from it; isolated new node goes outside the field', () => {
		const prev = seedPositions(ids(100));
		const r = reconcile(prev, [...ids(100), 'x', 'y', 'z'], near({ x: ['n-3'], y: ['x'] }));
		expect(dist(r.positions.get('x')!, prev.get('n-3')!)).toBeLessThan(60);
		expect(dist(r.positions.get('y')!, r.positions.get('x')!)).toBeLessThan(60);
		const radius = Math.max(...[...prev.values()].map((p) => Math.hypot(...p)));
		expect(Math.hypot(...r.positions.get('z')!)).toBeGreaterThan(radius);
		expect([...r.positions.values()].flat().every(Number.isFinite)).toBe(true);
		expect(coincident(r.positions.values())).toBe(false);
	});
});

describe('pack / unpack / idsKey', () => {
	it('round-trips in the given order', () => {
		const s = seedPositions(['a', 'b']);
		const arr = pack(['b', 'a'], s);
		expect(arr).toBeInstanceOf(Float32Array);
		expect(arr.length).toBe(6);
		expect([...arr.slice(0, 3)]).toEqual([...Float32Array.from(s.get('b')!)]);
		expect(unpack(['b', 'a'], arr).get('a')).toEqual([...Float32Array.from(s.get('a')!)]);
	});

	it('idsKey changes with order, membership and is stable', () => {
		expect(idsKey(['a', 'b'])).toBe(idsKey(['a', 'b']));
		expect(idsKey(['a', 'b'])).not.toBe(idsKey(['b', 'a']));
		expect(idsKey(['a', 'b'])).not.toBe(idsKey(['a', 'b', 'c']));
		expect(idsKey(['ab'])).not.toBe(idsKey(['a', 'b']));
	});
});
