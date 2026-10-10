import { describe, expect, test } from 'vitest';
import { ROOT_ID, edgeType, nodeType } from './config';
import { findCustomers, unprocessed, validateEdge } from './graph';
import {
	FIXED_NODES,
	SCALE_LIMITS,
	graphStats,
	minEdges,
	parseScaleQuery,
	scaleFixture,
	validateScaleOptions
} from './scale-fixture';

describe.each([20_000, 100_000])('scaleFixture 10k nodes / %i edges', (edges) => {
	const { graph, meta } = scaleFixture({ edges, seed: 7 });
	const ids = new Set(graph.nodes.map((n) => n.id));

	test('exact counts, unique ids, valid endpoints, unique edge ids', () => {
		expect(graph.nodes.length).toBe(10_000);
		expect(graph.edges.length).toBe(edges);
		expect(ids.size).toBe(graph.nodes.length);
		expect(new Set(graph.edges.map((e) => e.id)).size).toBe(graph.edges.length);
		expect(graph.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
		expect(graph.edges.every((e) => e.from !== e.to)).toBe(true);
	});

	test('single root; everything except planned isolates reaches it', () => {
		const roots = graph.nodes.filter((n) => nodeType(n.type).name === '大樓');
		expect(roots.map((n) => n.id)).toEqual([ROOT_ID]);
		expect([...unprocessed(graph)].sort()).toEqual([...meta.isolates].sort());
		const deg = graphStats(graph).degree;
		expect(meta.isolates.length).toBeGreaterThan(0);
		expect(meta.isolates.every((id) => (deg.get(id) ?? 0) === 0)).toBe(true);
	});

	test('domain-valid edge types; IDC data readonly', () => {
		const byId = new Map(graph.nodes.map((n) => [n.id, n]));
		for (const e of graph.edges) {
			const t = edgeType(e.type);
			expect(t, e.type).toBeTruthy();
			if (t.idc || e.readonly) {
				expect(e.readonly).toBe(true);
				continue;
			}
			// 非 IDC 邊必須能由編輯器規則建立
			const pair = { nodes: [byId.get(e.from)!, byId.get(e.to)!], edges: [] };
			expect(validateEdge(pair, e.from, e.to, e.type), e.id).toBeNull();
		}
		for (const n of graph.nodes) expect(!!n.readonly).toBe(!!nodeType(n.type).idc);
		expect(byId.get(meta.hub)).toBeTruthy();
	});

	test('planned hub ≥1000 degree, directed cycle, bidirectional, same-name nodes', () => {
		const s = graphStats(graph);
		expect(s.degree.get(meta.hub)).toBeGreaterThanOrEqual(1000);
		expect(s.maxDegree).toBeGreaterThanOrEqual(1000);
		expect(s.components).toBe(1 + meta.isolates.length);
		expect(graph.edges.some((e) => e.bidirectional)).toBe(true);
		// 有向循環：沿 meta.cycle 走一圈每段都有邊
		const has = new Set(graph.edges.map((e) => `${e.from}>${e.to}`));
		const c = meta.cycle;
		expect(c.length).toBeGreaterThanOrEqual(3);
		expect(c.every((id, i) => has.has(`${id}>${c[(i + 1) % c.length]}`))).toBe(true);
		const names = new Map<string, Set<string>>();
		for (const n of graph.nodes)
			(names.get(n.name) ?? names.set(n.name, new Set()).get(n.name)!).add(n.id);
		expect([...names.values()].some((s) => s.size > 1)).toBe(true);
		// 每個系統都有節點
		const systems = new Set(graph.nodes.map((n) => nodeType(n.type).system));
		expect(systems.size).toBe(8);
	});

	test('customers reachable from a power source (find-customers works at scale)', () => {
		const r = findCustomers(graph, meta.power);
		expect(r.customers.length).toBeGreaterThan(0);
	});
});

test('deterministic per seed; different seed differs', () => {
	const a = scaleFixture({ edges: 20_000, seed: 1 }).graph;
	const b = scaleFixture({ edges: 20_000, seed: 1 }).graph;
	const c = scaleFixture({ edges: 20_000, seed: 2 }).graph;
	expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
});

test('props are independent objects (no shared references)', () => {
	const { graph } = scaleFixture({ edges: 20_000, seed: 1 });
	const copy = structuredClone(graph);
	expect(copy.nodes[0].props).not.toBe(copy.nodes[1].props);
	const props = new Set([...graph.nodes, ...graph.edges].map((x) => x.props));
	expect(props.size).toBe(graph.nodes.length + graph.edges.length);
	graph.nodes[0].props.x = 'mutated';
	expect(graph.nodes[1].props.x).toBeUndefined();
});

test('rejects impossible edge budgets', () => {
	expect(() => scaleFixture({ edges: 100, seed: 1 })).toThrow();
});

describe('size validation (QA fix: reject before any loop)', () => {
	test('supported bounds cover the planned 10k/20k, 10k/100k and 50k/100k matrix', () => {
		expect(SCALE_LIMITS.maxNodes).toBeGreaterThanOrEqual(50_000);
		expect(SCALE_LIMITS.minNodes).toBe(FIXED_NODES + 1);
		expect(minEdges(10_000)).toBeLessThanOrEqual(20_000);
		expect(minEdges(50_000)).toBeLessThanOrEqual(100_000);
		for (const [nodes, edges] of [
			[10_000, 20_000],
			[10_000, 100_000],
			[50_000, 100_000]
		])
			expect(validateScaleOptions({ nodes, edges, seed: 1 })).toEqual({ nodes, edges, seed: 1 });
	});

	test('exact minimum sizes build (at least one sensor, base edge count matches)', () => {
		const n = SCALE_LIMITS.minNodes;
		const { graph } = scaleFixture({ nodes: n, edges: minEdges(n), seed: 1 });
		expect(graph.nodes.length).toBe(n);
		expect(graph.edges.length).toBe(minEdges(n));
		const g = scaleFixture({ nodes: n, edges: minEdges(n) + 50, seed: 1 }).graph;
		expect(g.edges.length).toBe(minEdges(n) + 50);
	});

	test.each([
		['nodes Infinity', { nodes: Infinity, edges: 20_000 }],
		['nodes NaN', { nodes: NaN, edges: 20_000 }],
		['nodes fractional', { nodes: 10_000.5, edges: 20_000 }],
		['nodes negative', { nodes: -1, edges: 20_000 }],
		['nodes fixed minimum leaves no sensors', { nodes: FIXED_NODES, edges: 20_000 }],
		['nodes above max', { nodes: 50_001, edges: 100_000 }],
		['nodes unsafe integer', { nodes: 2 ** 53, edges: 20_000 }],
		['edges Infinity', { nodes: 10_000, edges: Infinity }],
		['edges NaN', { nodes: 10_000, edges: NaN }],
		['edges fractional', { nodes: 10_000, edges: 20_000.5 }],
		['edges below base', { nodes: 10_000, edges: 100 }],
		['edges too dense', { nodes: 10_000, edges: 100_001 }],
		['50k nodes with only 20k edges', { nodes: 50_000, edges: 20_000 }],
		['seed NaN', { nodes: 10_000, edges: 20_000, seed: NaN }],
		['seed fractional', { nodes: 10_000, edges: 20_000, seed: 1.5 }],
		['seed negative', { nodes: 10_000, edges: 20_000, seed: -1 }],
		['seed above uint32', { nodes: 10_000, edges: 20_000, seed: 2 ** 32 }]
	])('rejects %s immediately', (_, o) => {
		const t = performance.now();
		expect(() => validateScaleOptions(o)).toThrow(RangeError);
		expect(() => scaleFixture(o)).toThrow(RangeError);
		expect(performance.now() - t).toBeLessThan(50);
	});
});

describe('parseScaleQuery (strict URL parsing, no Number() coercion)', () => {
	const q = (s: string) => parseScaleQuery(new URLSearchParams(s));

	test('defaults and valid values', () => {
		expect(q('')).toEqual({ nodes: 10_000, edges: 20_000, seed: 1 });
		expect(q('nodes=50000&edges=100000&seed=0')).toEqual({
			nodes: 50_000,
			edges: 100_000,
			seed: 0
		});
	});

	test.each([
		'nodes=Infinity',
		'nodes=NaN',
		'nodes=1e4',
		'nodes=10000.0',
		'nodes=',
		'nodes=%2010000',
		'nodes=0x2710',
		'edges=-20000',
		'edges=abc',
		'seed=1.5',
		'nodes=99999999999999999999'
	])('rejects %s', (s) => {
		expect(() => q(s)).toThrow(RangeError);
	});
});
