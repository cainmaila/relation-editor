import { describe, expect, it } from 'vitest';
import {
	checkDeleteNode,
	collapse,
	findCustomers,
	layout,
	pin,
	NODE_H,
	stacks,
	unprocessed,
	unreachable,
	validateEdge
} from './graph';
import { buildGraphIndex } from './graph-index';
import { graphMock, idcMock } from './mock';
import { nodeType, type System } from './config';
import type { Graph } from './types';

const full = (): Graph => {
	const a = graphMock();
	const b = idcMock();
	return { nodes: [...a.nodes, ...b.nodes], edges: [...a.edges, ...b.edges] };
};

/** 只看勾選系統：節點在勾選系統或通用；邊兩端都在才顯示 */
const visible = (g: Graph, systems: System[]) => {
	const nodes = g.nodes.filter((n) => {
		const s = nodeType(n.type).system;
		return s === null || systems.includes(s);
	});
	const ids = new Set(nodes.map((n) => n.id));
	return { nodes, edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
};

const cust = (g: Graph, id: string) => findCustomers(g, id).customers.sort();
/** 客戶甲乙丙與客戶 01～40，共 43 位 */
const ALL_CUSTOMERS = [
	...Array.from({ length: 40 }, (_, i) => `客戶 ${String(i + 1).padStart(2, '0')}`),
	'客戶丙',
	'客戶乙',
	'客戶甲'
];

const removeEdge = (g: Graph, from: string, to: string) => {
	g.edges = g.edges.filter((e) => !(e.from === from && e.to === to));
};

describe('看圖', () => {
	it('情境 1：2,066 個節點，無未處理', () => {
		const g = full();
		expect(g.nodes).toHaveLength(2066);
		expect(new Set(g.nodes.map((n) => n.id)).size).toBe(2066);
		expect(unprocessed(g).size).toBe(0);
	});

	it('情境 2：只勾電力 672 節點 671 邊；只勾空間 345 節點 344 邊（不含通用）', () => {
		const p = visible(full(), ['電力']);
		expect(p.nodes.filter((n) => n.type !== '通用節點')).toHaveLength(672);
		expect(p.edges).toHaveLength(671);
		const s = visible(full(), ['空間']);
		expect(s.nodes.filter((n) => n.type !== '通用節點')).toHaveLength(345);
		expect(
			s.edges.filter((e) => e.type === '包含' && !e.from.startsWith('2F A 排監視'))
		).toHaveLength(344);
	});

	it('情境 3：空間＋電力多 654 條跨系統邊；加空調再多 2 條', () => {
		const cross = (v: Graph) =>
			v.edges.filter((e) => {
				const sys = (id: string) => nodeType(v.nodes.find((n) => n.id === id)!.type).system;
				return sys(e.from) !== sys(e.to) && sys(e.from) !== null && sys(e.to) !== null;
			});
		expect(cross(visible(full(), ['空間', '電力']))).toHaveLength(654);
		expect(cross(visible(full(), ['空間', '電力', '空調']))).toHaveLength(656);
	});

	it('情境 4：通用節點連入 3 監測、連出 2 包含', () => {
		const v = visible(full(), ['空間', '消防', 'CCTV']);
		const G = '2F A 排監視與偵測範圍';
		expect(v.edges.filter((e) => e.to === G && e.type === '監測')).toHaveLength(3);
		expect(v.edges.filter((e) => e.from === G && e.type === '包含')).toHaveLength(2);
	});

	it('情境 5：機櫃 A-01 直接相連 7 條邊', () => {
		const g = full();
		expect(g.edges.filter((e) => e.from === '機櫃 A-01' || e.to === '機櫃 A-01')).toHaveLength(7);
	});
});

describe('編輯', () => {
	it('情境 8/9：新節點未處理，連邊後解除', () => {
		const g = full();
		g.nodes.push({ id: 'x', type: '攝影機', name: '攝影機 CAM-04', props: {} });
		expect([...unprocessed(g)]).toEqual(['x']);
		expect(validateEdge(g, 'x', '2F A 排監視與偵測範圍', '監測')).toBeNull();
		g.edges.push({
			id: 'ex',
			type: '監測',
			from: 'x',
			to: '2F A 排監視與偵測範圍',
			bidirectional: false,
			props: {}
		});
		expect(unprocessed(g).size).toBe(0);
		expect(cust(g, 'x')).toEqual(['客戶乙', '客戶甲']);
	});

	it('情境 10：連接限制', () => {
		const g = full();
		expect(validateEdge(g, '機櫃 A-01', 'UPS-1', '供電')).toBe('「供電」只能由電力設備連出');
		expect(validateEdge(g, '偵測器 SD-01', '客戶甲', '監測')).toBe(
			'「監測」只能連到空間或通用節點'
		);
	});

	it('情境 10 例外：通用節點不受連接限制，找客戶結果不變', () => {
		const g = full();
		const G = '2F A 排監視與偵測範圍';
		expect(validateEdge(g, '空調箱 AHU-2F-1', G, '冷卻')).toBeNull();
		expect(validateEdge(g, 'A 排', G, '包含')).toBeNull();
		expect(validateEdge(g, G, '機櫃 A-01', '供電')).toBeNull();
		expect(validateEdge(g, G, '客戶甲', '服務')).toBe('由 IDC機櫃配置管理維護');
		for (const [id, from, type] of [
			['c1', '空調箱 AHU-2F-1', '冷卻'],
			['c2', 'A 排', '包含']
		])
			g.edges.push({ id, type, from, to: G, bidirectional: false, props: {} });
		expect(cust(g, '空調箱 AHU-2F-1')).toEqual(ALL_CUSTOMERS);
	});

	it('情境 12：刪除與未處理', () => {
		const g = full();
		removeEdge(g, '空調箱 AHU-2F-1', '2F');
		expect(unprocessed(g).size).toBe(0);
		removeEdge(g, '2F', 'Core Switch-2');
		g.edges = g.edges.filter((e) => e.from !== 'Core Switch-2');
		expect([...unprocessed(g)]).toEqual(['Core Switch-2']);
		expect(checkDeleteNode(g, '機櫃 A-01')).toBe(
			'機櫃底下有 IDC 資料，請先在 IDC機櫃配置管理移除機框'
		);
		expect(checkDeleteNode(g, '偵測器 SD-02')).toBeNull();
	});

	it('情境 13：IDC 唯讀', () => {
		const g = full();
		expect(checkDeleteNode(g, '客戶甲')).toBe('由 IDC機櫃配置管理維護');
		expect(validateEdge(g, 'ToR Switch A-04', '主機 H-05', '連線')).toBeNull();
		expect(validateEdge(g, '機框 A-01-F1', '客戶乙', '服務')).toBe('由 IDC機櫃配置管理維護');
	});
});

describe('找客戶', () => {
	it('情境 15：台電市電 → 全部 43 位客戶，含空調支線', () => {
		const r = findCustomers(full(), '台電市電');
		expect(r.customers.sort()).toEqual(ALL_CUSTOMERS);
		for (const id of ['UPS-1', '空調箱 AHU-2F-1', '2F', 'A 排', '機櫃 A-04', '機框 A-04-F1'])
			expect(r.nodes.has(id)).toBe(true);
		expect(r.nodes.has('偵測器 SD-01')).toBe(false);
	});

	it('情境 16：精確', () => {
		const g = full();
		expect(cust(g, '機櫃 PDU A-02-A')).toEqual(['客戶乙']);
		expect(cust(g, '偵測器 SD-01')).toEqual(['客戶乙', '客戶甲']);
		expect(cust(g, '主機 H-02')).toEqual(['客戶乙']);
		expect(cust(g, 'Core Switch-1')).toEqual(ALL_CUSTOMERS);
		expect(cust(g, 'ToR Switch A-02')).toEqual(['客戶乙']);
	});

	it('情境 17：到不了客戶', () => {
		const g = full();
		expect(unreachable(g).size).toBe(0);
		g.nodes.push({ id: 'b', type: 'Switch', name: 'Switch B', props: {} });
		g.edges.push({
			id: 'e1',
			type: '連線',
			from: '匯聚 Switch AGG-A',
			to: 'b',
			bidirectional: false,
			props: {}
		});
		expect(unprocessed(g).size).toBe(0);
		expect([...unreachable(g)]).toEqual(['b']);
		g.edges.push({
			id: 'e2',
			type: '連線',
			from: 'b',
			to: '主機 H-03',
			bidirectional: false,
			props: {}
		});
		expect(unreachable(g).size).toBe(0);
		expect(cust(g, 'b')).toEqual(['客戶乙']);
	});

	it('情境 18：刪邊後 PDU 到不了客戶', () => {
		const g = full();
		removeEdge(g, '機櫃 PDU A-04-A', '機櫃 A-04');
		expect([...unreachable(g)]).toEqual(['機櫃 PDU A-04-A']);
	});

	it('雙向邊兩頭都能走', () => {
		const g = full();
		const e = g.edges.find((x) => x.from === 'Core Switch-1' && x.to === '匯聚 Switch AGG-A')!;
		e.bidirectional = true;
		expect(findCustomers(g, '匯聚 Switch AGG-A').nodes.has('Core Switch-1')).toBe(true);
	});
});

it('layout：每個節點都有位置，沿供電方向由左往右，客戶在最右欄', () => {
	const { pos } = layout(full());
	expect(pos.size).toBe(2066);
	const x = (id: string) => pos.get(id)!.x;
	expect(x('台電市電')).toBeLessThan(x('UPS-1'));
	expect(x('UPS-1')).toBeLessThan(x('樓層 PDU 2F-A'));
	expect(x('樓層 PDU 2F-A')).toBeLessThan(x('機櫃 PDU A-04-B'));
	const maxX = Math.max(...[...pos.values()].map((p) => p.x));
	['客戶甲', '客戶乙', '客戶丙'].forEach((c) => expect(x(c)).toBe(maxX));
});

it('layout：平行的兄弟節點同一欄，卡片不重疊', () => {
	const { pos } = layout(full());
	const cabs = ['機櫃 A-01', '機櫃 A-02', '機櫃 A-03', '機櫃 A-04'].map((id) => pos.get(id)!);
	expect(new Set(cabs.map((p) => p.x)).size).toBe(1);
	expect(new Set(cabs.map((p) => p.y)).size).toBe(4);
	// 同欄依 y 排序後，相鄰卡片不重疊
	const cols = Map.groupBy(pos.values(), (p) => p.x);
	for (const col of cols.values()) {
		const ys = col.map((p) => p.y).sort((a, b) => a - b);
		ys.slice(1).forEach((y, i) => expect(y - ys[i] >= NODE_H).toBe(true));
	}
});

it('收疊：每排機櫃 PDU、16 條排、16 台樓層 PDU 各收成一張，機櫃與 ToR 上游各不同不收', () => {
	const g = full();
	const st = stacks(g);
	expect(st.size).toBe(18);
	const key = 'stack:機櫃 PDU:樓層 PDU 2F-A';
	expect(st.get(key)).toHaveLength(44);
	expect(st.get('stack:列:2F')).toHaveLength(16);
	expect(st.get('stack:樓層 PDU:UPS-1')).toHaveLength(16);
	expect([...st.keys()].some((k) => k.startsWith('stack:機櫃:'))).toBe(false);
	const members = [...st.values()].flat().length;
	const v = collapse(g, st);
	expect(v.nodes).toHaveLength(2066 - members + 18);
	expect(v.nodes.find((n) => n.id === key)!.name).toBe('機櫃 PDU ×44');
	const into = v.edges.filter((e) => e.to === key);
	expect(into.map((e) => [e.from, e.members.length])).toEqual([['stack:樓層 PDU:UPS-1', 44]]);
	expect(v.edges.filter((e) => e.from === key).map((e) => e.members.length)).toEqual(
		Array(22).fill(2)
	);
	expect(v.edges.flatMap((e) => e.members).sort()).toEqual(g.edges.map((e) => e.id).sort());
	expect(layout(v).pos.size).toBe(v.nodes.length);
});

it('收疊：重複上游不影響分組，成員互連不收疊（避免自環）', () => {
	const n = (id: string) => ({ id, type: 'T', name: id, props: {} });
	const e = (id: string, type: string, from: string, to: string) => ({ id, type, from, to });
	const g = {
		nodes: ['X', 'a', 'b', 'c', 'd'].map(n),
		edges: [
			e('1', '供電', 'X', 'a'),
			e('2', '供電', 'X', 'b'),
			e('3', '供電', 'X', 'c'),
			e('4', '連線', 'X', 'c'), // c 有兩條平行邊，仍與 a、b 同組
			e('5', '供電', 'X', 'd'),
			e('6', '承載', 'd', 'a') // 承載不計入上游；d、a 互連，兩者不收疊
		]
	} as unknown as Graph;
	expect([...stacks(g).values()]).toEqual([]);
	g.edges.pop();
	expect([...stacks(g).values()]).toEqual([['a', 'b', 'c', 'd']]);
	const v = collapse(g, stacks(g));
	expect(v.edges.every((x) => x.from !== x.to)).toBe(true);
});

it('pin：既有節點沿用舊位置，新節點重疊時排到該欄最下方', () => {
	const prev = new Map([
		['a', { x: 0, y: 0 }],
		['b', { x: 0, y: 100 }]
	]);
	const next = new Map([
		['a', { x: 256, y: 50 }],
		['b', { x: 0, y: 0 }],
		['c', { x: 0, y: 0 }], // 和 a 重疊
		['d', { x: 512, y: 0 }]
	]);
	expect(pin(prev, next)).toEqual(
		new Map([
			['a', { x: 0, y: 0 }],
			['b', { x: 0, y: 100 }],
			['c', { x: 0, y: 100 + NODE_H + 12 }],
			['d', { x: 512, y: 0 }]
		])
	);
});

describe('共用索引', () => {
	it('查詢可接受預先建好的索引，結果與自行建索引相同', () => {
		const g = full();
		const idx = buildGraphIndex(g);
		expect(unprocessed(g, idx)).toEqual(unprocessed(g));
		expect(unreachable(g, idx)).toEqual(unreachable(g));
		expect(findCustomers(g, 'UPS-1', idx)).toEqual(findCustomers(g, 'UPS-1'));
		expect(validateEdge(g, '偵測器 SD-01', '機櫃 A-03', '監測', idx)).toBe(
			validateEdge(g, '偵測器 SD-01', '機櫃 A-03', '監測')
		);
		expect(checkDeleteNode(g, '機櫃 A-01', idx)).toBe(checkDeleteNode(g, '機櫃 A-01'));
	});

	it('找客戶同時回傳客戶 ID，與名稱一一對應', () => {
		const g = full();
		const r = findCustomers(g, 'UPS-1');
		expect(r.customerIds.map((id) => g.nodes.find((n) => n.id === id)!.name)).toEqual(r.customers);
	});

	it('雙向邊、有向環與相連邊刪除後的走訪', () => {
		const node = (id: string, type = '通用節點') => ({ id, type, name: id, props: {} });
		const edge = (id: string, from: string, to: string, bidirectional = false) => ({
			id,
			type: '包含',
			from,
			to,
			bidirectional,
			props: {}
		});
		const g: Graph = {
			nodes: [node('TPKC 大樓', '大樓'), node('a'), node('b'), node('c', '客戶')],
			edges: [
				edge('r', 'TPKC 大樓', 'a'),
				edge('ab', 'a', 'b'),
				edge('ba', 'b', 'a'),
				edge('cb', 'c', 'b', true)
			]
		};
		// 環不會無限走；雙向邊讓 b 走得到客戶 c
		expect(findCustomers(g, 'a').customers).toEqual(['c']);
		expect(unreachable(g).size).toBe(0);
		const cut: Graph = { ...g, edges: g.edges.filter((e) => e.id !== 'cb') };
		expect(unprocessed(cut, buildGraphIndex(cut))).toEqual(new Set(['c']));
		expect(unreachable(cut, buildGraphIndex(cut))).toEqual(new Set(['TPKC 大樓', 'a', 'b']));
	});
});

describe('P7 全圖追查（純圖語意）', () => {
	const node = (id: string, type = '通用節點', name = id) => ({ id, type, name, props: {} });
	const edge = (id: string, from: string, to: string, bidirectional = false) => ({
		id,
		type: '包含',
		from,
		to,
		bidirectional,
		props: {}
	});
	const g = (nodes: Graph['nodes'], edges: Graph['edges']): Graph => ({ nodes, edges });

	it('單向 A→B→客戶：順向找得到，逆向找不到；起點是客戶時不算自己', () => {
		const x = g(
			[node('a'), node('b'), node('c', '客戶')],
			[edge('ab', 'a', 'b'), edge('bc', 'b', 'c')]
		);
		expect(findCustomers(x, 'a')).toMatchObject({ customerIds: ['c'] });
		expect([...findCustomers(x, 'a').edges]).toEqual(['ab', 'bc']);
		const rev = g(x.nodes, [edge('ba', 'b', 'a'), edge('bc', 'b', 'c')]);
		expect(findCustomers(rev, 'a')).toMatchObject({ customerIds: [], edges: new Set() });
		expect(findCustomers(x, 'c')).toMatchObject({ customerIds: [], nodes: new Set(['c']) });
	});

	it('雙向邊：兩頭都能走，且邊只記一次', () => {
		const x = g(
			[node('a'), node('b'), node('c', '客戶')],
			[edge('ba', 'b', 'a', true), edge('bc', 'b', 'c')]
		);
		const r = findCustomers(x, 'a');
		expect(r.customerIds).toEqual(['c']);
		expect([...r.edges].sort()).toEqual(['ba', 'bc']);
	});

	it('循環：不會無限走；環上的每條邊都在結果裡（回到起點的單向邊除外）', () => {
		const x = g(
			[node('a'), node('b'), node('d'), node('c', '客戶')],
			[edge('ab', 'a', 'b'), edge('bd', 'b', 'd'), edge('da', 'd', 'a'), edge('dc', 'd', 'c')]
		);
		const r = findCustomers(x, 'a');
		expect(r.customerIds).toEqual(['c']);
		expect([...r.nodes].sort()).toEqual(['a', 'b', 'c', 'd']);
		expect([...r.edges].sort()).toEqual(['ab', 'bd', 'dc']);
	});

	it('孤立／無客戶：結果只有起點，沒有邊與客戶', () => {
		const x = g([node('a'), node('b'), node('c', '客戶')], [edge('ab', 'a', 'b')]);
		expect(findCustomers(x, 'a')).toEqual({
			customers: [],
			customerIds: [],
			nodes: new Set(['a']),
			edges: new Set()
		});
		expect(findCustomers(x, 'c').edges.size).toBe(0);
	});

	it('重複：平行邊各自保留 ID；同名不同 ID 的客戶分開列出', () => {
		const x = g(
			[node('a'), node('c1', '客戶', '客戶甲'), node('c2', '客戶', '客戶甲')],
			[edge('a1', 'a', 'c1'), edge('a1b', 'a', 'c1'), edge('a2', 'a', 'c2')]
		);
		const r = findCustomers(x, 'a');
		expect(r.customerIds).toEqual(['c1', 'c2']);
		expect(r.customers).toEqual(['客戶甲', '客戶甲']);
		expect([...r.edges].sort()).toEqual(['a1', 'a1b', 'a2']);
	});

	it('唯讀 IDC 資料：沿唯讀的承載／服務邊照樣追查（2,066 mock 已知答案）', () => {
		const m = full();
		const r = findCustomers(m, '主機 H-02');
		expect(r.customers).toEqual(['客戶乙']);
		expect([...r.edges].every((id) => m.edges.find((e) => e.id === id)!.readonly)).toBe(true);
		expect(r.nodes.has('機框 A-01-F2')).toBe(true);
	});

	it('10k 代表圖：結果完整（每個客戶 ID 唯一），與預先建好的索引一致', async () => {
		const { scaleFixture } = await import('./scale-fixture');
		const { graph: big, meta } = scaleFixture({ edges: 20_000 });
		const idx = buildGraphIndex(big);
		const r = findCustomers(big, meta.power, idx);
		expect(r).toEqual(findCustomers(big, meta.power));
		expect(new Set(r.customerIds).size).toBe(r.customerIds.length);
		expect(r.customerIds).toHaveLength(200);
		// 完整路徑邊數遠超過繪製上限 2,000：結果不受畫面限制
		expect(r.edges.size).toBeGreaterThan(2000);
		for (const id of r.edges) {
			const e = idx.edgeById.get(id)!;
			expect(r.nodes.has(e.from) && r.nodes.has(e.to)).toBe(true);
		}
	});
});
